# 钉钉审批实例同步第一阶段实现说明

生成时间：2026-08-29

## 1. 本阶段目标

本阶段实现审批实例同步的任务状态机和落库链路：

- 发起审批同步任务。
- 记录同步任务状态。
- 记录审批实例。
- 根据审批实例生成支出明细。
- 后台可查看任务和实例。
- 支持默认 mock 同步和真实钉钉 OpenAPI 同步。

默认 `DINGTALK_SYNC_MODE=mock` 时仍生成开发样例审批实例。
配置 `DINGTALK_SYNC_MODE=real` 时，系统会按已启用模板分页拉取审批实例 ID，再读取实例详情并保存原始 payload。未传同步窗口时默认拉取最近 31 天。

## 2. 数据表

新增：

- `sync_jobs`
- `approval_instances`

迁移文件：

- `apps/api/alembic/versions/20260829_0004_approval_sync.py`
- `apps/api/alembic/versions/20260829_0012_sync_job_window.py`

## 3. API

路由前缀：`/api/dingtalk`

接口：

- `POST /api/dingtalk/approval-sync`
- `POST /api/dingtalk/sync-jobs/{job_id}/resume`
- `GET /api/dingtalk/sync-jobs`
- `GET /api/dingtalk/approval-instances`

同步行为：

- 读取已启用审批模板。
- 创建 `dingtalk_approval_sync` 类型任务。
- 同步请求支持 `start_at`、`end_at`、`page_size`、`max_pages`。
- 任务记录请求窗口 `request_start_at`、`request_end_at`、分页游标 `next_cursor` 和 `raw_summary`。
- 如果达到 `max_pages` 仍存在后续游标，任务标记为 `failed`，并保留 `process_code:cursor` 形式的 `next_cursor`，避免误认为全量同步完成。
- 可通过 `POST /api/dingtalk/sync-jobs/{job_id}/resume` 从失败任务的 `next_cursor` 继续同步，续跑会创建新的同步任务记录。
- mock 模式为每个模板生成开发样例审批实例。
- real 模式分页调用钉钉审批实例 ID 列表和实例详情接口。
- 审批实例会按字段映射生成 `source=dingtalk` 的支出明细。
- 更新钉钉配置的 `last_instance_sync_at`。

字段映射转换规则：

- `store` 或 `store_name`：匹配门店名称或钉钉部门 ID。
- `expense_date`：生成支出日期和账期。
- `amount`：生成支出金额。
- `description`：生成支出说明。
- `category_l1`、`category_l2`、`supplier_name`、`payee_account`：写入支出辅助字段。
- `voucher_images`、`voucher_files`：生成钉钉来源的附件占位记录，可通过附件归档接口下载。
- 审批实例缺少门店、金额或日期时会保存实例，但不会生成支出明细，任务计为失败项。

## 4. 后台页面

页面：

- `/dingtalk`

新增能力：

- 启动审批实例同步。
- 启动同步时可指定审批模板、同步时间窗口、每页数量和最大页数。
- 查看同步任务列表。
- 查看同步窗口、分页游标和错误信息。
- 对存在分页游标的失败任务执行续跑。
- 查看审批实例列表。
- 测试钉钉 OpenAPI 连接。

## 5. 下一步

1. 基于上次成功任务的自动增量水位。
2. 单实例失败重试。
3. 模板字段候选自动生成。
4. 钉钉接口限流与重试策略。
5. 附件批量归档和失败重试。
