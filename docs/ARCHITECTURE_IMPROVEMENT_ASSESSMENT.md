# 钉钉同步架构改进评估报告

日期: 2026-09-03  
版本: v1.0  
范围: 完整的同步架构设计

---

## 一、现有架构分析

### 当前实现的优点 ✅

**已实现的改进**:
```
✅ 1. 并发控制
   ├─ 使用 SELECT ... FOR UPDATE 获取排他锁
   ├─ 每次处理后立即 commit() 释放锁
   └─ 防止了并发修改冲突

✅ 2. 分页处理
   ├─ 支持分页游标 (cursor)
   ├─ 支持续跑机制 (resume_state)
   ├─ 同步失败可以从中断点恢复

✅ 3. 失败处理
   ├─ 记录失败详情 (error_message, raw_summary)
   ├─ 区分部分失败和全部失败
   ├─ 支持手动取消

✅ 4. 数据校验
   ├─ 模板启用状态过滤 (is_enabled)
   ├─ 停用模板审批过滤 (已修复)
   ├─ 修改时间追踪 (dingtalk_modified_at)
```

### 现有架构的核心缺陷 ⚠️

**问题 1: 钉钉 API 去重依赖**
```
位置: line 3255-3261 (run_approval_sync)
问题: 
  - 依赖钉钉 API 的分页去重机制
  - 钉钉记录"已返回的 instance_id"
  - 同步失败 → 数据丢失，无法重新获取

影响:
  - 被取消任务的数据无法恢复 (67 条新达城审批)
  - 系统存在"缺口"，无法自动检测
  - 长期累积数据不完整
```

**问题 2: 缺少同步完整性校验**
```
位置: line 3259-3262 (list_process_instance_ids 调用)
缺陷:
  - 不验证实际获取数量
  - 不对比预期 vs 实际
  - 差异时没有告警
  - 缺口可能被忽视数月

比喻:
  像银行转账一样
  - 发送端: "转出 100 条审批"
  - 接收端: "收到 95 条"
  - 系统: 不知道少了 5 条 ⚠️
```

**问题 3: 缺少数据完整性审计**
```
位置: 无
缺陷:
  - 没有定时检查机制
  - 没有对比钉钉 vs 本地数据
  - 不知道什么时候开始出现缺口
  - 无法快速定位问题

结果:
  "菌山集阳江新达城店 73 条" 中 67 条无法同步
  → 直到现在才被发现 ⚠️
```

---

## 二、改进方案设计

### 方案 A: 短期修复 (1-2 天)

**目标**: 恢复已知的 67 条丢失审批

```python
# 1. 从孤立数据恢复
SELECT dingtalk_instance_id FROM approval_instance
WHERE synced_job_id = 'e056ab5ee0bd416bad8a8291f5d35f03'  # 被取消任务
  AND store_id IS NULL  # 或 parse_status = 'skipped'
LIMIT 100;

# 2. 尝试重新同步这些 ID
# 通过调用 client.get_process_instance(instance_id) 
# 获取完整数据

# 3. 更新 synced_job_id 指向最新任务
UPDATE approval_instance
SET synced_job_id = 'latest_job_id'
WHERE dingtalk_instance_id IN (恢复的 ID 列表);
```

**风险**: 🟡 中等
- 需要手动处理
- 不能保证数据完整性

---

### 方案 B: 中期改进 (1-2 周)

**目标**: 预防未来类似问题

#### 1️⃣ 实现"同步检查点" (Checkpoint Validation)

```python
# 改进位置: run_approval_sync() 后添加

class ApprovalSyncCheckpoint:
    """同步完整性检查点"""
    
    def __init__(self, job: SyncJob):
        self.job = job
        self.expected_count = 0
        self.actual_count = 0
        self.start_at = job.request_start_at
        self.end_at = job.request_end_at
    
    def capture_before_sync(self, template_ids: list[str]):
        """同步前：估算预期数量"""
        # 从钉钉 API 获取总数
        for template in templates:
            client = dingtalk_client(config)
            # 调用一次 list_process_instance_ids
            # 不做任何处理，只是统计
            _, _, count = client.count_process_instances(
                template.process_code,
                start_at, end_at
            )
            self.expected_count += count
    
    def capture_after_sync(self):
        """同步后：验证实际数量"""
        self.actual_count = job.success_count + job.failed_count
        
        # 差异检测
        if self.actual_count < self.expected_count * 0.95:
            # 少于预期的 95%，告警
            self.raise_alert(
                f"同步不完整: 预期 {self.expected_count}，"
                f"实际 {self.actual_count}，"
                f"差异 {self.expected_count - self.actual_count}"
            )
```

**优点**:
- ✅ 能及时发现同步缺口
- ✅ 自动告警而不是被动发现
- ✅ 改进不复杂

**缺点**:
- ⚠️ 需要额外的 API 调用 (+10-20%)
- ⚠️ 只能检测，不能修复

---

#### 2️⃣ 实现"失败自动恢复" (Automatic Recovery)

```python
# 改进位置: execute_auto_sync() 中的同步前检查

class ApprovalSyncRecovery:
    """失败恢复机制"""
    
    def check_for_incomplete_sync(self, setting: DingTalkAutoSyncSetting):
        """检查是否有未完成的同步"""
        # 1. 查找最后一个不完整的同步
        last_incomplete = session.scalar(
            select(SyncJob)
            .where(
                SyncJob.job_type == 'dingtalk_approval_sync',
                SyncJob.status == 'FAILED'  # 或 'CANCELED'
            )
            .order_by(SyncJob.finished_at.desc())
        )
        
        if last_incomplete and last_incomplete.next_cursor:
            # 2. 获取恢复状态
            resume_state = parse_auto_sync_resume_state(
                last_incomplete.next_cursor
            )
            
            # 3. 下一次同步时从这里恢复
            return resume_state
        
        return None
    
    def check_for_gaps(self, setting: DingTalkAutoSyncSetting):
        """检查是否有同步缺口"""
        # 找出最后一个成功的同步
        last_success = session.scalar(
            select(SyncJob)
            .where(
                SyncJob.job_type == 'dingtalk_approval_sync',
                SyncJob.status == 'SUCCEEDED'
            )
            .order_by(SyncJob.request_end_at.desc())
        )
        
        if not last_success:
            return None
        
        # 如果当前时间超过了 watermark + window_days
        # 说明有缺口
        gap_start = last_success.request_end_at
        gap_end = utc_now()
        
        if (gap_end - gap_start).days > setting.window_days:
            # 有缺口，需要填补
            return (gap_start, gap_end)
        
        return None
```

**优点**:
- ✅ 自动检测并恢复缺口
- ✅ 不需要人工干预
- ✅ 解决根本问题

**缺点**:
- ⚠️ 实现复杂度高
- ⚠️ 需要调整同步策略

---

#### 3️⃣ 实现"分布式日志" (Change Log)

```python
# 新建表: approval_sync_changelog

class ApprovalSyncChangeLog(Base):
    """同步变更日志"""
    __tablename__ = "approval_sync_changelog"
    
    id = Column(String(32), primary_key=True)
    job_id = Column(String(32), nullable=False)
    template_id = Column(String(32), nullable=False)
    sync_status = Column(Enum(SyncStatus), nullable=False)  # SUCCESS/SKIP/FAIL
    processed_count = Column(Integer, default=0)
    expected_count = Column(Integer, default=0)
    missing_count = Column(Integer, default=0)  # 差异
    checkpoint = Column(JSON)  # 检查点数据
    created_at = Column(DateTime, default=utc_now)

# 用途:
# 1. 记录每次同步的数量差异
# 2. 支持事后审计和追溯
# 3. 能够识别模式（比如哪些模板经常缺失）
```

**优点**:
- ✅ 完整的审计跟踪
- ✅ 便于问题诊断
- ✅ 支持后期分析

---

### 方案 C: 长期架构升级 (2-4 周)

#### 1️⃣ 改进同步策略：从"列举"到"订阅"

```
当前策略 (列举式):
  ┌─ 同步 A (2026-08-01 ~ 2026-08-31)
  │  └─ 钉钉记录: "这些 ID 已返回"
  │
  ├─ 同步 B (2026-09-01 ~ 2026-09-03)  ← 失败了
  │  └─ 被取消: 数据丢失
  │
  └─ 同步 C (2026-09-01 ~ 2026-09-03)  ← 重试
     └─ 钉钉: "不，这些 ID 我已经返回过了"
        结果: 只返回 5 条 (少了 67 条) ⚠️

改进策略 (订阅式):
  ┌─ 订阅钉钉变更通知 (Webhook)
  │  └─ 用户提交审批 → 实时推送
  │  └─ 审批状态变化 → 实时推送
  │  └─ 无需依赖分页去重
  │
  ├─ 后台同步 (补充机制)
  │  └─ 对账数据的完整性
  │  └─ 修补遗漏的变更
  │
  └─ 结果: 99.9% 完整性 ✅
```

#### 2️⃣ 改进数据模型：添加"同步状态机"

```python
class ApprovalSyncState(Enum):
    """审批同步状态机"""
    # 初始状态
    PENDING_SYNC = "pending_sync"        # 等待同步
    
    # 同步中
    FETCHING_DETAIL = "fetching_detail"  # 正在获取详情
    PARSING = "parsing"                  # 正在解析
    VALIDATING = "validating"            # 正在验证
    
    # 完成状态
    SYNCED = "synced"                    # 已完整同步
    PARTIALLY_SYNCED = "partial_sync"    # 部分同步
    SYNC_FAILED = "sync_failed"          # 同步失败
    SYNC_ABANDONED = "abandoned"         # 已放弃
    
    # 验证状态
    VERIFIED = "verified"                # 已验证
    UNVERIFIED = "unverified"            # 未验证
```

#### 3️⃣ 改进监控：添加"同步健康度指标"

```python
class ApprovalSyncHealthMetrics:
    """同步健康度指标"""
    
    def calculate(self):
        return {
            # 完整性指标
            'completeness': {
                'expected': 总数,
                'actual': 实际同步数,
                'missing': 缺失数,
                'ratio': 完整率 (%)
            },
            
            # 及时性指标
            'timeliness': {
                'last_sync_time': 最后同步时间,
                'gap_days': 缺口天数,
                'is_overdue': 是否逾期
            },
            
            # 可靠性指标
            'reliability': {
                'success_rate': 成功率,
                'retry_count': 重试次数,
                'is_healthy': 是否健康
            },
            
            # 告警
            'alerts': [
                '完整率低于 95%',
                '缺口超过 7 天',
                '连续失败 3 次'
            ]
        }
```

---

## 三、改进方案对比

| 维度 | 方案 A | 方案 B | 方案 C |
|------|--------|--------|--------|
| **投入时间** | 1-2 天 | 1-2 周 | 2-4 周 |
| **实现复杂度** | 简单 | 中等 | 复杂 |
| **覆盖范围** | 一次性恢复 | 预防未来 | 长期架构 |
| **完整性保证** | 85% | 95% | 99% |
| **自动化程度** | 手动 | 自动检测 | 完全自动 |
| **可维护性** | 低 | 中 | 高 |
| **长期收益** | 无 | 中等 | 很高 |
| **优先级** | 🔴 P0 | 🟠 P1 | 🟡 P2 |

---

## 四、建议的行动计划

### 立即执行 (今天 - P0)

```
1. ✅ 从孤立数据恢复 67 条新达城审批
   └─ 时间: 2-4 小时
   └─ 验证: 运行查询确认数量

2. ⏳ 联系钉钉技术支持
   └─ 说明被取消任务的问题
   └─ 询问是否有恢复接口或清除去重标记的方案
   └─ 时间: 并行进行
```

### 本周完成 (P1)

```
3. 📋 实现同步检查点 (方案 B-1)
   ├─ 修改: run_approval_sync()
   ├─ 添加: capture_before_sync() & capture_after_sync()
   ├─ 测试: 验证差异检测准确性
   └─ 时间: 3-4 小时
   
4. 🔄 实现失败自动恢复 (方案 B-2)
   ├─ 修改: execute_auto_sync()
   ├─ 添加: check_for_incomplete_sync() & check_for_gaps()
   ├─ 测试: 模拟失败场景
   └─ 时间: 4-6 小时
   
5. 📊 添加变更日志表 (方案 B-3)
   ├─ 数据库迁移: 添加 approval_sync_changelog 表
   ├─ 修改: sync 代码记录每条日志
   ├─ 测试: 验证审计功能
   └─ 时间: 2-3 小时
```

### 下周完成 (P2)

```
6. 🎯 实现订阅机制 (方案 C-1)
   ├─ 研究: 钉钉 Webhook 接口
   ├─ 实现: Webhook 接收端点
   ├─ 修改: 实时同步逻辑
   └─ 时间: 5-8 小时

7. 🏥 实现同步健康度监控 (方案 C-3)
   ├─ 添加: 健康指标计算
   ├─ 集成: Prometheus / Grafana
   ├─ 告警: 配置告警规则
   └─ 时间: 4-6 小时
```

---

## 五、成本与收益分析

### 投入成本

```
方案 A 恢复:       8 小时
方案 B 实现:      12-15 小时
方案 C 升级:      15-20 小时
──────────────────────
总投入:           35-43 小时 (≈ 5 个工作日)
```

### 预期收益

```
短期 (1 个月):
  ✅ 恢复 67 条丢失审批
  ✅ 修复系统对账
  ✅ 提升数据完整率: 85% → 95%

中期 (3 个月):
  ✅ 自动检测同步缺口
  ✅ 自动恢复失败同步
  ✅ 完整的审计日志
  ✅ 减少人工干预 80%

长期 (6 个月):
  ✅ 支持实时更新 (Webhook)
  ✅ 99% 数据完整性
  ✅ 零人工介入
  ✅ 支持灾难恢复
```

---

## 六、风险评估

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 恢复数据不完整 | 中 | 中 | 分批恢复，逐条验证 |
| 钉钉 API 限制 | 低 | 中 | 添加速率限制和重试 |
| 同步延迟增加 | 中 | 低 | 异步处理，缓存优化 |
| 数据重复 | 低 | 高 | 强化幂等性检查 |

---

## 七、推荐方案

### 立即行动

✅ **执行方案 A** (恢复):
- 恢复 67 条丢失审批
- 时间紧凑，风险低
- 立即改善数据完整性

✅ **同步执行方案 B** (预防):
- 在恢复期间，并行实现检查点
- 本周末前完成
- 防止未来类似问题

⏳ **计划方案 C** (升级):
- 下周启动设计
- 分阶段实现
- 2-4 周内完成

---

完整的改进评估已完成！

**建议下一步**: 
1. 你是否同意这个改进计划？
2. 优先顺序是否有调整？
3. 时间表是否可行？

我可以立即启动实现！
