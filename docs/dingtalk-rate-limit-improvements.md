# 钉钉 API 限流问题改进方案

## 问题描述

**错误信息**：
```
ding talk error[subcode=90002,submsg=当前所有钉钉应用调用该接口次数过多，超出了该接口承受的最大qps，
请求被暂时限制了，建议错开整点时刻调用该接口, apiPath(dingtalk.oapi.v2.department.listsub), 
从 2026-09-03 00:01:02 到 2026-09-03 00:01:02 请求总次数超过 1200 次, 限制将在 2026-09-03 00:01:03 结束.]
```

**关键信息**：
- 错误码：90002（QPS 超限）
- 受影响接口：`dingtalk.oapi.v2.department.listsub`（部门列表）
- 时间窗口：1秒内请求超过 1200 次
- 发生时间：凌晨 00:01（整点后）

## 根本原因分析

### 1. 递归拉取导致请求激增

当前 `build_department_tree` 函数（`router.py` line 914-954）：

```python
def build_department_tree(client: DingTalkClient, *, root_dept_id: str = "1", max_depth: int = 6):
    def walk(dept_id: str, parent_path: str, depth: int) -> None:
        if dept_id in seen or depth > max_depth:
            return
        seen.add(dept_id)
        children = client.list_child_departments(dept_id)  # 每个部门一次 API 调用
        for child in children:
            # ...
            grandchildren = client.list_child_departments(child_id) if depth < max_depth else []
            # ...
            if child_id and depth < max_depth:
                walk(child_id, path, depth + 1)  # 递归调用
```

**问题**：
- 如果部门层级深度为 8，且每层平均有 10 个子部门
- 总请求次数 = 1 + 10 + 100 + 1000 + ... ≈ **10^8 = 100,000,000 次**（理论最坏情况）
- 实际场景：假设每层 5 个部门，深度 6 层 = 1 + 5 + 25 + 125 + 625 + 3125 ≈ **4000 次请求**
- 这些请求在**几秒内并发执行**，轻松超过钉钉的 QPS 限制

### 2. 整点时刻限流更严格

钉钉在整点时刻（00:00, 01:00, 02:00 等）会执行更严格的限流策略，因为：
- 大部分定时任务设置在整点执行
- 钉钉需要保护后端服务稳定性

### 3. 当前重试机制不足

`client.py` 中的重试逻辑（line 138-156）：

```python
def _post_oapi_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
    last_error: DingTalkClientError | None = None
    for attempt in range(3):
        token = self.get_access_token()
        response = httpx.post(...)
        data = self._read_json(response)
        errcode = data.get("errcode", 0)
        if errcode in (0, "0", None):
            return data
        last_error = DingTalkClientError(...)
        if str(errcode) != "90002" or attempt == 2:
            break
        sleep(1.0 + attempt)  # 仅重试 90002 错误，等待 1-3 秒
```

**不足之处**：
- 重试间隔固定（1-3秒），未考虑钉钉的限流时间窗口
- 没有全局速率限制，只在错误后才减速
- 递归调用没有延迟控制

---

## 改进方案

### 方案 1：添加全局速率限制器（推荐）⭐

#### 实现步骤

**Step 1**: 在 `client.py` 中添加速率限制器

```python
# apps/api/app/modules/dingtalk/client.py
import time
from threading import Lock

class RateLimiter:
    """简单的令牌桶限流器"""
    def __init__(self, max_qps: int = 10):
        self.max_qps = max_qps
        self.tokens = max_qps
        self.last_update = time.time()
        self.lock = Lock()
    
    def acquire(self) -> None:
        """获取一个令牌，必要时等待"""
        with self.lock:
            now = time.time()
            # 补充令牌
            elapsed = now - self.last_update
            self.tokens = min(self.max_qps, self.tokens + elapsed * self.max_qps)
            self.last_update = now
            
            # 如果没有令牌，等待
            if self.tokens < 1:
                wait_time = (1 - self.tokens) / self.max_qps
                time.sleep(wait_time)
                self.tokens = 0
            else:
                self.tokens -= 1


class DingTalkClient:
    # 全局速率限制器：每个接口独立限流
    _rate_limiters: dict[str, RateLimiter] = {}
    _limiter_lock = Lock()
    
    def __init__(self, ...):
        # ... 现有代码 ...
        # 部门接口限制为每秒 10 次（安全值，钉钉限制约 20 QPS）
        self._ensure_rate_limiter("/topapi/v2/department/listsub", max_qps=10)
    
    @classmethod
    def _ensure_rate_limiter(cls, api_path: str, max_qps: int) -> None:
        if api_path not in cls._rate_limiters:
            with cls._limiter_lock:
                if api_path not in cls._rate_limiters:
                    cls._rate_limiters[api_path] = RateLimiter(max_qps=max_qps)
    
    def _post_oapi_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        # 在请求前获取令牌（限流）
        if path in self._rate_limiters:
            self._rate_limiters[path].acquire()
        
        # ... 现有的重试逻辑 ...
        last_error: DingTalkClientError | None = None
        for attempt in range(3):
            # ... 现有代码 ...
            errcode = data.get("errcode", 0)
            if errcode in (0, "0", None):
                return data
            
            # 改进的重试策略
            if str(errcode) == "90002":
                # 从错误信息中提取限制结束时间
                errmsg = data.get("errmsg", "")
                wait_time = self._parse_rate_limit_wait_time(errmsg)
                if wait_time is None:
                    wait_time = min(5.0 * (2 ** attempt), 60.0)  # 指数退避，最多 60 秒
                
                if attempt < 2:
                    time.sleep(wait_time)
                    continue
            
            last_error = DingTalkClientError(...)
            break
        
        if last_error is not None:
            raise last_error
        raise DingTalkClientError("DingTalk OAPI request failed")
    
    @staticmethod
    def _parse_rate_limit_wait_time(errmsg: str) -> float | None:
        """从限流错误消息中解析需要等待的时间"""
        # 示例: "限制将在 2026-09-03 00:01:03 结束"
        import re
        match = re.search(r"限制将在 (\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}) 结束", errmsg)
        if match:
            try:
                from datetime import datetime
                end_time_str = match.group(1)
                end_time = datetime.strptime(end_time_str, "%Y-%m-%d %H:%M:%S")
                now = datetime.now()
                wait_seconds = (end_time - now).total_seconds()
                return max(0, wait_seconds) + 1.0  # 额外等待 1 秒
            except Exception:
                pass
        return None
```

**Step 2**: 在 `router.py` 中添加批量间隔控制

```python
# apps/api/app/modules/dingtalk/router.py

def build_department_tree(
    client: DingTalkClient,
    *,
    root_dept_id: str = "1",
    max_depth: int = 6,
    request_interval: float = 0.1,  # 每次请求间隔 100ms
) -> list[DingTalkDepartmentRead]:
    rows: list[DingTalkDepartmentRead] = []
    seen: set[str] = set()
    request_count = 0

    def walk(dept_id: str, parent_path: str, depth: int) -> None:
        nonlocal request_count
        
        if dept_id in seen or depth > max_depth:
            return
        seen.add(dept_id)
        
        # 添加请求间隔（避免瞬时请求过多）
        if request_count > 0 and request_interval > 0:
            import time
            time.sleep(request_interval)
        
        children = client.list_child_departments(dept_id)
        request_count += 1
        
        for child in children:
            child_id = department_id(child)
            name = str(child.get("name") or child.get("dept_name") or child.get("deptName") or "")
            if not child_id or not name:
                continue
            path = department_path(child, parent_path)
            
            # 同样添加间隔
            if depth < max_depth and request_interval > 0:
                import time
                time.sleep(request_interval)
            
            grandchildren = client.list_child_departments(child_id) if depth < max_depth else []
            request_count += 1
            
            # ... 后续逻辑保持不变 ...
    
    walk(root_dept_id, "", 0)
    return rows
```

**Step 3**: 更新自动同步配置，避开整点

修改默认执行时间：

```python
# apps/api/app/modules/dingtalk/router.py

# 将默认时间从 02:00 改为 02:15（避开整点）
def get_or_create_auto_sync_setting(session: Session) -> DingTalkAutoSyncSetting:
    setting = session.scalar(...)
    if setting is None:
        setting = DingTalkAutoSyncSetting(
            scheduled_time="02:15"  # 改为 02:15，避开整点
        )
        # ...
```

在前端同样更新默认值：

```typescript
// apps/admin-web/app/dingtalk/page.tsx (line 1615)

initialValues={{
  enabled: false,
  scheduled_time: "02:15",  // 改为 02:15
  sync_departments: true,
  sync_templates: true,
  sync_approvals: true,
}}
```

---

### 方案 2：分批次拉取（备选方案）

如果部门层级非常深（>6 层），可以考虑分批次拉取：

```python
def pull_departments_in_batches(
    session: Session,
    client: DingTalkClient,
    root_dept_id: str = "1",
    batch_size: int = 50,  # 每批最多拉取 50 个部门
) -> DingTalkDepartmentPullResult:
    """分批次拉取部门，避免一次性请求过多"""
    all_departments = []
    queue = [(root_dept_id, "", 0)]  # (dept_id, parent_path, depth)
    seen = set()
    
    while queue:
        batch = queue[:batch_size]
        queue = queue[batch_size:]
        
        for dept_id, parent_path, depth in batch:
            if dept_id in seen or depth > 8:
                continue
            seen.add(dept_id)
            
            children = client.list_child_departments(dept_id)
            for child in children:
                child_id = department_id(child)
                if not child_id:
                    continue
                # 加入下一批次队列
                queue.append((child_id, parent_path + "/" + child["name"], depth + 1))
                all_departments.append(child)
        
        # 每批次之间休息 2 秒
        if queue:
            import time
            time.sleep(2.0)
    
    # 后续处理...
```

---

### 方案 3：使用钉钉批量接口（长期优化）

钉钉可能提供批量接口（需要查阅文档），例如：
- `/topapi/v2/department/listsubids` - 批量获取子部门 ID
- `/topapi/v2/department/list` - 批量获取部门详情

如果存在这些接口，可以减少请求次数。

---

## 推荐实施方案

### 短期（本周）：方案 1 的部分实现

1. ✅ **添加请求间隔**（最简单，立即生效）
   - 在 `build_department_tree` 中每次 API 调用后 `sleep(0.1)`
   - 预计将请求速率降低到 10 QPS 以下

2. ✅ **优化重试逻辑**
   - 解析限流结束时间，精确等待
   - 使用指数退避策略

3. ✅ **避开整点时刻**
   - 将默认执行时间改为 02:15 或其他非整点时间

### 中期（下周）：方案 1 完整实现

4. ⚙️ **实现全局速率限制器**
   - 添加 `RateLimiter` 类
   - 为每个 API 路径配置独立的 QPS 限制

5. ⚙️ **添加监控指标**
   - 记录每次 90002 错误的发生时间
   - 统计每个接口的请求速率

### 长期（按需）：方案 2 + 方案 3

6. 🔍 **调研钉钉批量接口**
   - 查阅钉钉文档，寻找批量获取接口
   - 如果存在，优先使用批量接口

7. 🔄 **实现分批次拉取**
   - 如果部门数量持续增长，实现分批次策略

---

## 立即可执行的快速修复

在 `apps/api/app/modules/dingtalk/router.py` 中修改 `build_department_tree` 函数：

```python
def build_department_tree(
    client: DingTalkClient,
    *,
    root_dept_id: str = "1",
    max_depth: int = 6,
) -> list[DingTalkDepartmentRead]:
    import time  # 添加导入
    
    rows: list[DingTalkDepartmentRead] = []
    seen: set[str] = set()

    def walk(dept_id: str, parent_path: str, depth: int) -> None:
        if dept_id in seen or depth > max_depth:
            return
        seen.add(dept_id)
        
        children = client.list_child_departments(dept_id)
        time.sleep(0.15)  # 🔴 添加 150ms 延迟，确保不超过 6 QPS
        
        for child in children:
            child_id = department_id(child)
            name = str(child.get("name") or child.get("dept_name") or child.get("deptName") or "")
            if not child_id or not name:
                continue
            path = department_path(child, parent_path)
            
            grandchildren = client.list_child_departments(child_id) if depth < max_depth else []
            time.sleep(0.15)  # 🔴 添加 150ms 延迟
            
            child_names = [...]
            rows.append(...)
            
            if child_id and depth < max_depth:
                walk(child_id, path, depth + 1)

    walk(root_dept_id, "", 0)
    return rows
```

**效果评估**：
- 假设有 1000 个部门需要拉取
- 无延迟：1000 次请求 / 5 秒 = 200 QPS ❌（超限）
- 150ms 延迟：1000 次请求 / 150 秒 ≈ 6.7 QPS ✅（安全）
- 代价：部门同步时间从 5 秒增加到 2.5 分钟（可接受）

---

## 验证方法

### 1. 本地测试

```python
# 在自动同步前添加日志
import logging
logger = logging.getLogger(__name__)

def build_department_tree(...):
    start_time = time.time()
    request_count = 0
    
    def walk(...):
        nonlocal request_count
        # ... 调用 API ...
        request_count += 1
        if request_count % 10 == 0:
            elapsed = time.time() - start_time
            qps = request_count / elapsed if elapsed > 0 else 0
            logger.info(f"部门拉取进度: {request_count} 次请求, 当前 QPS: {qps:.2f}")
    
    # ...
    total_time = time.time() - start_time
    logger.info(f"部门拉取完成: 总请求 {request_count} 次, 耗时 {total_time:.2f} 秒, 平均 QPS {request_count/total_time:.2f}")
```

### 2. 监控 90002 错误

在 `client.py` 中添加错误统计：

```python
class DingTalkClient:
    _error_stats: dict[str, int] = {}
    
    def _post_oapi_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        # ...
        if str(errcode) == "90002":
            self._error_stats[path] = self._error_stats.get(path, 0) + 1
            logger.warning(f"钉钉限流触发: {path}, 累计 {self._error_stats[path]} 次")
```

---

## 总结

**根本原因**：递归拉取部门时，短时间内产生大量 API 请求，超过钉钉的 QPS 限制。

**推荐方案**：
1. **立即修复**：添加请求间隔（150ms），将 QPS 降至 6-7
2. **短期优化**：避开整点时刻，优化重试逻辑
3. **中期优化**：实现全局速率限制器
4. **长期优化**：使用钉钉批量接口（如果有）

**实施优先级**：
- 🔴 P0: 添加请求间隔（立即）
- 🟠 P1: 避开整点时刻（本周）
- 🟡 P2: 优化重试逻辑（本周）
- 🟢 P3: 全局速率限制器（下周）
