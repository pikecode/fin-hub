# 钉钉同步页面 (http://localhost:3000/dingtalk) 完整同步逻辑分析

## 一、页面概览

**页面路径**: `http://localhost:3000/dingtalk`
**源文件**:
- 前端: `apps/admin-web/app/dingtalk/page.tsx` (2277 行)
- 后端: `apps/api/app/modules/dingtalk/router.py` (3408 行)

**核心功能**: 钉钉数据同步工作台 - 统一管理部门、审批模板、审批实例的同步和映射配置

---

## 二、数据流架构

### 2.1 总体数据流

```
钉钉 OpenAPI
    ↓
DingTalkClient (密钥认证)
    ↓
后端 Router 层 (业务逻辑处理)
    ↓
数据库 (存储同步结果)
    ↓
前端 API Client (axios)
    ↓
React 状态管理 (useState hooks)
    ↓
UI 渲染 (Tabs + Cards + Tables)
```

### 2.2 主要数据模型

| 模型 | 来源 | 用途 |
|------|------|------|
| **DingTalkConfig** | 用户配置 | 存储 Corp ID、App Key、App Secret |
| **DingTalkAutoSyncSetting** | 后端自动生成 | 自动同步计划时间、启用状态 |
| **DingTalkDepartment** | 钉钉 OpenAPI | 部门快照，存储部门ID、层级、是否门店候选 |
| **ApprovalTemplate** | 钉钉 OpenAPI | 审批模板，存储 Process Code、字段映射配置 |
| **ApprovalInstance** | 钉钉 OpenAPI | 审批实例，存储申请人、状态、原始 JSON 数据 |
| **TemplateFieldMapping** | 用户配置 | 将钉钉字段映射到系统字段（金额、门店等） |
| **SyncJob** | 后端异步任务 | 同步执行日志，记录进度和结果 |

---

## 三、核心同步流程

### 3.1 初始化流程 (Page Load)

```typescript
// 前端: apps/admin-web/app/dingtalk/page.tsx:696-734
async function loadData() {
  // 1. 并行加载三个核心数据
  const results = await Promise.allSettled([
    apiClient.dingtalk.readConfig(),           // 获取钉钉配置
    apiClient.dingtalk.readAutoSyncSetting(),  // 获取自动同步设置
    apiClient.dingtalk.listSyncJobs("?page_size=50"),  // 获取同步任务历史
  ]);

  // 2. 处理结果，汇总错误
  if (errors.length) {
    setErrorMessage(errors.join("；"));
  }
}

// useEffect Hook 在组件挂载时执行
useEffect(() => {
  loadData();
}, []);
```

**后端处理** (`apps/api/app/modules/dingtalk/router.py`):

```python
@router.get("/config", response_model=ApiEnvelope[DingTalkConfigRead])
def read_config(session: Session = Depends(get_session)):
    # 1. 获取或创建配置（单例模式）
    config = get_or_create_config(session)

    # 2. 隐藏敏感信息
    return ApiEnvelope(data=mask_config(config))

def get_or_create_config(session: Session) -> DingTalkConfig:
    config = session.scalar(select(DingTalkConfig).order_by(DingTalkConfig.created_at.asc()))
    if config is None:
        config = DingTalkConfig()
        session.add(config)
        session.commit()
    return config
```

**特点**:
- ✅ 使用 `Promise.allSettled` 并行加载，容错性好
- ⚠️ 一次性加载了同步任务历史，可能不必要（初始 Tab 不显示任务）

---

### 3.2 自动同步流程

#### 前端触发

```typescript
// 前端: line 884-905
async function runAutoSync() {
  setIsLoading(true);
  try {
    const result = await apiClient.dingtalk.runAutoSync();

    // 1. 重新加载主配置
    await loadData();

    // 2. 串行重新加载所有已打开的 Tab
    if (loadedTabKeys.includes("departments")) await loadDepartmentsTab(true);
    if (loadedTabKeys.includes("templates")) await loadTemplatesTab(true);
    if (loadedTabKeys.includes("instances")) await loadInstancesTab(true);

    // 3. 显示结果
    if (result.job.status === "failed") {
      message.error(result.job.error_message);
    } else {
      message.success(`自动同步完成：处理 ${result.job.processed_count} 条...`);
    }
  } finally {
    setIsLoading(false);
  }
}
```

**性能问题** ⚠️:
- 同步后执行串行 refresh: `await loadData()` → `await loadDepartmentsTab()` → `await loadTemplatesTab()` → `await loadInstancesTab()`
- 如果各请求耗时 1 秒，总耗时 4+ 秒
- 建议改为 `Promise.all([...])` 并行刷新

#### 后端实现

```python
# 后端: 自动同步的核心逻辑
async def run_auto_sync_core(session: Session) -> dict:
    job = SyncJob(
        job_type="dingtalk_auto_sync",
        status=SyncJobStatus.RUNNING.value,
        started_at=utc_now(),
    )
    session.add(job)
    session.flush()

    # 按顺序执行三个阶段
    # 1. 拉取部门 (pull_departments_core)
    # 2. 同步模板 (sync_templates_core)
    # 3. 同步审批 (start_approval_sync_core)

    job.status = SyncJobStatus.SUCCEEDED.value
    job.finished_at = utc_now()
    session.commit()
    return result
```

---

### 3.3 部门同步流程

#### 3.3.1 拉取部门 (Pull Departments)

**前端** (line 922-938):
```typescript
async function pullDepartments() {
  const result = await apiClient.dingtalk.pullDepartments("?root_dept_id=1&max_depth=8");
  const preview = await apiClient.dingtalk.previewDepartmentSync();
  setDepartmentPreview(preview);
  message.success(`拉取 ${result.pulled_count} 个，新增 ${result.created_count} 个...`);
}
```

**后端** (`pull_departments_core`):
```python
def pull_departments_core(session: Session, root_dept_id: str = "1", max_depth: int = 6):
    # 1. 调用钉钉 API 构建部门树
    pulled_departments = build_department_tree(
        dingtalk_client(config),
        root_dept_id=root_dept_id,
        max_depth=max_depth,
    )

    # 2. 批量插入/更新部门到数据库
    result = upsert_dingtalk_departments(
        session,
        pulled_departments,
        root_dept_id=root_dept_id,
        max_depth=max_depth,
    )

    # 3. 返回汇总结果
    return {
        "pulled_count": len(pulled_departments),
        "created_count": result["created_count"],
        "updated_count": result["updated_count"],
        "deactivated_count": result["deactivated_count"],
    }
```

**部门树构建** (`build_department_tree`):
```python
def build_department_tree(client: DingTalkClient, root_dept_id: str = "1", max_depth: int = 6):
    def walk(dept_id: str, parent_path: str, depth: int):
        if dept_id in seen or depth > max_depth:
            return
        seen.add(dept_id)

        # 获取子部门
        children = client.list_child_departments(dept_id)

        # ⚠️ 添加延迟避免触发钉钉 QPS 限流（每次请求后 sleep(0.15)）
        sleep(0.15)

        for child in children:
            # ... 递归构建

    walk(root_dept_id, "", 0)
    return rows
```

**部门候选判断** (`looks_like_store_department`):
```python
def looks_like_store_department(name: str, path: str, child_names: list[str]) -> bool:
    # 1. 必须在 "门店运营部" 下
    if "门店运营部" not in path:
        return False

    # 2. 排除运营部、财务等非门店部门
    non_store_words = ("运营部", "门店群", "区", "部门", "前厅", "后厨", "财务"...)
    if any(word in name for word in non_store_words):
        return False

    # 3. 子部门中有 "前厅" 或 "后厨" 表示是真实门店
    has_front_or_kitchen = any("前厅" in child_name or "后厨" in child_name for child_name in child_names)

    return has_front_or_kitchen or "店" in name or "城" in name
```

---

#### 3.3.2 门店落库 (Sync Departments to Stores)

**流程**:
```python
def sync_departments_to_stores_core(session: Session) -> DingTalkDepartmentSyncResult:
    departments = load_local_departments(session)

    for department in departments:
        if not department.is_store_candidate:
            continue

        # 1. 按 dept_id 查找现有门店
        store = session.scalar(
            select(Store).where(Store.dingtalk_dept_id == department.dept_id)
        )

        # 2. 未找到则按名称查找
        if store is None:
            store = session.scalar(
                select(Store).where(Store.name == department.name)
            )

        # 3. 还未找到则新建门店
        if store is None:
            store = Store(name=department.name, dingtalk_dept_id=department.dept_id)
            session.add(store)
            created_count += 1
        else:
            # 更新关联
            if store.dingtalk_dept_id != department.dept_id:
                store.dingtalk_dept_id = department.dept_id
                updated_count += 1
```

**特点**:
- ✅ 三层查询保证不重复创建门店
- ⚠️ 缺少确认对话框，可能误操作

---

### 3.4 审批模板同步

```python
def sync_templates_core(session: Session) -> dict[str, int]:
    config = get_or_create_config(session)

    if should_use_real_dingtalk():
        # 真实环境：调用钉钉 API 获取模板
        processes = dingtalk_client(config).list_processes_by_user(config.admin_user_id)
    else:
        # 演示环境：使用种子模板
        processes = [
            ("seed-expense-approval", "门店费用报销"),
            ("seed-purchase-approval", "采购付款申请"),
        ]

    now = utc_now()
    for process_code, name, raw_snapshot in processes:
        template = session.scalar(
            select(ApprovalTemplate).where(ApprovalTemplate.process_code == process_code)
        )

        if template is None:
            # 新建模板
            template = ApprovalTemplate(
                process_code=process_code,
                name=name,
                last_sync_at=now,
                raw_snapshot=raw_snapshot,
            )
            session.add(template)
        else:
            # 更新已有模板
            template.name = name
            template.raw_snapshot = raw_snapshot
            template.last_sync_at = now

    config.last_template_sync_at = now
    return {"pulled": len(processes), "created": created, "updated": updated}
```

---

### 3.5 审批实例同步

#### 前端流程

```typescript
// 打开同步模态框
function openSyncModal() {
  syncForm.setFieldsValue({
    template_id: selectedTemplate?.id,
    start_at: dayjs().subtract(7, "day"),
    end_at: undefined,
    sync_to_now: true,  // 默认同步到当前时间
    skip_existing: true,
  });
  setIsSyncModalOpen(true);
}

// 触发同步
async function startApprovalSync(values: ApprovalSyncFormValues) {
  // 1. 时间范围校验
  const endAt = values.sync_to_now ? dayjs() : values.end_at;
  if (endAt.diff(values.start_at, "day", true) > 120) {
    message.error("单次范围不能超过 120 天");
    return;
  }

  // 2. 调用后端 API
  const job = await apiClient.dingtalk.startApprovalSync({
    template_id: values.template_id,
    start_at: values.start_at?.toISOString(),
    end_at: values.sync_to_now ? undefined : values.end_at?.toISOString(),
    skip_existing: values.skip_existing ?? true,
  });

  // 3. 刷新实例列表
  await loadInstancesTab(true);

  // 4. 根据结果显示消息
  if (job.next_cursor) {
    message.warning("审批列表已同步一部分，可在同步任务中续跑");
  } else if (job.status === "failed") {
    message.error(job.error_message);
  } else {
    message.success("审批列表增量同步完成");
  }
}
```

#### 后端实现

```python
# 审批实例同步的核心逻辑
def start_approval_sync_core(
    session: Session,
    template_id: str,
    start_at: datetime,
    end_at: datetime | None,
    skip_existing: bool,
):
    job = SyncJob(
        job_type="dingtalk_approval_sync",
        status=SyncJobStatus.RUNNING.value,
        started_at=utc_now(),
        request_start_at=start_at,
        request_end_at=end_at or utc_now(),
    )
    session.add(job)
    session.flush()

    # 分页获取审批实例
    end_timestamp = int((end_at or utc_now()).timestamp() * 1000)
    start_timestamp = int(start_at.timestamp() * 1000)

    ids, next_cursor = client.list_process_instance_ids(
        template.process_code,
        start_timestamp,
        end_timestamp,
        cursor=0,
        size=AUTO_SYNC_APPROVAL_PAGE_SIZE,
    )

    for instance_id in ids:
        raw_instance = client.get_process_instance(instance_id)
        instance = save_sample_approval_instance(session, template, raw_instance)
        # ... 解析审批和生成支出明细

    # 记录进度
    job.processed_count = len(ids)
    job.success_count = success_count
    job.failed_count = failed_count
    job.next_cursor = next_cursor  # 若有下一页则记录游标

    return job
```

**续跑审批同步** (`resumeApprovalSync`):
```typescript
async function resumeApprovalSync(job: SyncJob) {
  const nextJob = await apiClient.dingtalk.resumeApprovalSync(job.id, {
    started_by: "admin",
    page_size: 20,
    max_pages: 20,
    skip_existing: true,
  });

  if (nextJob.next_cursor) {
    message.warning("已处理一部分，可继续续跑");
  } else {
    message.success("审批同步续跑完成");
  }
}
```

---

### 3.6 审批解析流程

#### 字段映射配置

```typescript
// 打开解析规则 Drawer
async function openMappingDrawer(template: ApprovalTemplate) {
  setIsMappingDrawerOpen(true);
  await loadMappings(template);
}

// 加载模板的字段映射和候选字段
async function loadMappings(template: ApprovalTemplate) {
  const [data, candidates] = await Promise.all([
    apiClient.dingtalk.listMappings(template.id),
    apiClient.dingtalk.listFieldCandidates(template.id),
  ]);
  setMappings(data);
  setFieldCandidates(candidates);
}

// 保存字段映射
async function saveBusinessFieldMapping(field: BusinessFieldOption, fieldKey?: string) {
  const payload: TemplateFieldMappingCreate = {
    standard_field: field.value,  // 如 "amount", "store", "expense_date"
    display_label: field.label,
    source_field_name: candidate.source_field_name,
    source_field_id: candidate.source_field_id,
    source_path: candidate.source_path,
    field_type: candidate.field_type,
  };

  if (existing) {
    await apiClient.dingtalk.updateMapping(template.id, existing.id, payload);
  } else {
    await apiClient.dingtalk.upsertMapping(template.id, payload);
  }
}
```

#### 字段候选提取

```python
def collect_approval_form_field_candidates(raw_instance: dict[str, Any]) -> list[TemplateFieldCandidate]:
    candidates: list[TemplateFieldCandidate] = []

    # 1. 提取根字段（固定字段）
    root_fields = [
        ("business_id", "审批编号", "TextField"),
        ("originator_userid", "发起人 User ID", "TextField"),
        ("originator_dept_name", "发起部门", "TextField"),
        # ...
    ]
    for key, label, field_type in root_fields:
        if key not in raw_instance:
            continue
        candidates.append(TemplateFieldCandidate(
            source_field_id=key,
            source_field_name=label,
            source_path=f"root:{key}",
            field_type=field_type,
            sample_value=raw_instance.get(key),
        ))

    # 2. 提取表单组件字段
    components = raw_instance.get("form_component_values") or []
    for component in components:
        field_name = component.get("name")
        field_type = component.get("componentType")  # "TextField", "MoneyField", "TableField"

        # 如果是表格字段，提取单元格
        if field_type == "TableField":
            for row in component.get("value", []):
                for cell in row.get("rowValue", []):
                    candidates.append(TemplateFieldCandidate(
                        source_field_name=f"{field_name}.{cell.get('name')}",
                        source_path=f"table:{field_name}:{cell.get('id')}",
                        sample_value=cell.get("value"),
                    ))
        else:
            # 普通字段
            candidates.append(TemplateFieldCandidate(
                source_field_name=field_name,
                source_path=f"field:{field_name}",
                sample_value=component.get("value"),
            ))

    return unique_field_candidates(candidates)
```

#### 审批映射和支出明细生成

```python
def build_approval_parse_preview(
    session: Session,
    template: ApprovalTemplate,
    instance: ApprovalInstance,
) -> ApprovalParsePreview:
    raw_instance = json.loads(instance.raw_payload)

    # 1. 应用映射，获取标准字段值
    mapped = mapped_values_for_template(session, template.id, raw_instance)

    # 2. 解析关键字段
    store_text = mapped.get("store") or find_form_value(raw_instance, "支出门店", "门店")
    amount = parse_decimal(mapped.get("amount"))
    expense_date = parse_date(mapped.get("expense_date"))

    # 3. 解析支出明细
    table_value = mapped.get("expense_table")
    expense_rows = expense_rows_from_table(table_value)  # 从表格中解析

    # 如果无表格数据，则使用安装分期
    if not expense_rows:
        expense_rows = installment_rows_from_form(raw_instance, amount)

    # 4. 校验必需字段
    missing_fields = []
    if store is None:
        missing_fields.append("store")
    if not expense_rows:
        missing_fields.append("amount")
    if expense_date is None:
        missing_fields.append("expense_date")

    return ApprovalParsePreview(
        store_name=store.name if store else None,
        expense_date=expense_date,
        rows=expense_rows,
        can_create_expense=not missing_fields,
        missing_fields=missing_fields,
    )
```

---

## 四、性能优化建议

### 4.1 并行化刷新

**当前** (串行，4+ 秒):
```typescript
await loadData();
if (loadedTabKeys.includes("departments")) await loadDepartmentsTab(true);
if (loadedTabKeys.includes("templates")) await loadTemplatesTab(true);
if (loadedTabKeys.includes("instances")) await loadInstancesTab(true);
```

**优化后** (并行，1 秒):
```typescript
await Promise.all([
  loadData(),
  loadedTabKeys.includes("departments") ? loadDepartmentsTab(true) : Promise.resolve(),
  loadedTabKeys.includes("templates") ? loadTemplatesTab(true) : Promise.resolve(),
  loadedTabKeys.includes("instances") ? loadInstancesTab(true) : Promise.resolve(),
].filter(Boolean));
```

### 4.2 减少重复请求

| 重复位置 | 建议 |
|---------|------|
| `loadData()` 加载配置 | 所有 Tab 共享，只在初始加载 |
| `loadTemplatesTab` 和 `loadInstancesTab` 都加载模板 | 共享模板状态，避免重复 |
| `loadInstancesTab` 加载同步任务 | 只在 "实例" Tab 需要时加载 |

### 4.3 细粒度 Loading 状态

**当前**: 全局 `isLoading` 状态，所有操作共用

**优化**:
```typescript
const [loadingStates, setLoadingStates] = useState({
  autoSync: false,
  pullDepartments: false,
  syncDepartments: false,
  syncTemplates: false,
  syncApprovals: false,
});
```

---

## 五、用户体验问题

### 5.1 缺少进度反馈

长时间操作（1-10 分钟）缺少进度提示：

| 操作 | 耗时 | 建议 |
|------|------|------|
| 部门拉取 | 2-5 分钟 | 显示"正在拉取，已完成 X 个..." |
| 自动同步 | 5-10 分钟 | 显示当前阶段："正在同步部门..." → "正在同步模板..." → "正在同步审批..." |
| 审批同步 | 5-10 分钟 | 轮询任务状态，显示进度 |

**实现方案**:
```typescript
const [syncProgress, setSyncProgress] = useState({
  visible: false,
  stage: "",
  progress: 0,  // 0-100
});

async function runAutoSync() {
  setSyncProgress({ visible: true, stage: "正在拉取部门...", progress: 0 });
  await pullDepartmentsInternal();

  setSyncProgress({ visible: true, stage: "正在同步模板...", progress: 33 });
  await syncTemplatesInternal();

  setSyncProgress({ visible: true, stage: "正在同步审批...", progress: 66 });
  await syncApprovalsInternal();

  setSyncProgress({ visible: false, stage: "", progress: 100 });
}

// 轮询审批同步进度
async function pollApprovalSyncStatus(jobId: string) {
  const interval = setInterval(async () => {
    const job = await apiClient.dingtalk.getSyncJob(jobId);
    const progress = (job.processed_count / job.total_count) * 100;
    setSyncProgress({
      visible: true,
      stage: `正在同步审批 (${job.processed_count}/${job.total_count})`,
      progress,
    });
    if (job.status !== "running") {
      clearInterval(interval);
      setSyncProgress({ visible: false, stage: "", progress: 0 });
    }
  }, 2000);
}
```

### 5.2 缺少操作确认

高风险操作直接执行，建议添加确认对话框：

```typescript
async function syncDepartments() {
  Modal.confirm({
    title: "门店落库",
    content: `确定要将 ${departmentPreview.create_count} 个新部门落库为门店吗？`,
    okText: "确定",
    cancelText: "取消",
    onOk: async () => {
      // 执行同步
    },
  });
}
```

---

## 六、总结

### 🎯 架构亮点

✅ **清晰的分层架构**:
- 前端：UI 层 + 状态管理 + API 客户端
- 后端：路由 + 业务逻辑 + 数据访问

✅ **完善的错误处理**:
- 前端：错误消息统一显示
- 后端：异常转 HTTP 状态码

✅ **灵活的数据同步**:
- 支持真实和演示两种环境
- 支持续跑机制处理大数据集

### ⚠️ 主要问题

1. **性能**: 自动同步后串行刷新，可并行化
2. **UX**: 长时间操作缺少进度反馈，用户体验差
3. **代码重复**: Tab 加载逻辑重复，可抽象为通用函数
4. **状态管理**: 全局 `isLoading` 过于粗粒度

### 🚀 关键改进方向

| 优先级 | 项目 | 工作量 |
|-------|------|--------|
| P0 | 并行化自动同步刷新 | 1h |
| P1 | 添加进度反馈 (Modal + 轮询) | 2h |
| P2 | 细粒度 Loading 状态 | 1h |
| P2 | 添加操作确认对话框 | 1h |
| P3 | 代码重构 (Tab 加载抽象) | 2h |

---

## 七、附录：关键参数表

### 钉钉 API 限制

| 参数 | 值 | 说明 |
|------|-----|------|
| `root_dept_id` | "1" | 部门树根节点，固定为 1 |
| `max_depth` | 8 | 最大深度限制，避免无限递归 |
| `AUTO_SYNC_APPROVAL_PAGE_SIZE` | 20 | 每页审批数量 |
| `AUTO_SYNC_APPROVAL_MAX_PAGES` | 100 | 最多页数 |
| `APPROVAL_SYNC_MAX_WINDOW_DAYS` | 120 | 单次同步最大时间跨度 |
| `APPROVAL_SYNC_MAX_LOOKBACK_DAYS` | 365 | 最大回溯天数 |
| **API 限流延迟** | 0.15 秒 | 避免 90002 错误 |

### 自动同步时间

- **默认时间**: 02:15 （避开整点时刻的限流高峰）
- **时区**: `Asia/Shanghai` (北京时间)
