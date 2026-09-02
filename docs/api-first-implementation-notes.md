# API 第一阶段实现说明

生成时间：2026-08-28

## 1. 本阶段目标

本阶段先把新版系统的领域骨架落到代码和数据库迁移中，支撑后台管理端、小程序端后续联调。

重点不是一次性完成钉钉同步、银行流水解析和智能匹配算法，而是先固定：

- 领域模型
- 数据库表结构
- API 路由命名
- 前端共享类型
- 基础读写动作
- 账套封账约束入口

## 2. 已实现模块

### 2.0 认证与当前用户

路由前缀：`/api/auth`

接口：

- `POST /api/auth/login`
- `POST /api/auth/logout`
- `POST /api/auth/change-password`
- `GET /api/auth/me`
- `GET /api/auth/me/stores`

说明：

- `me` 返回当前后台用户、角色、功能权限和门店范围。
- `me/stores` 返回当前用户可维护门店；管理员返回全部门店，非管理员返回 `user_store_permissions` 授权门店。
- `me/stores` 要求当前用户具备 `stores.view` 权限。

### 2.1 门店

路由前缀：`/api/stores`

接口：

- `GET /api/stores`
- `POST /api/stores`

对应表：

- `stores`

用途：

- 维护门店基础信息。
- 关联钉钉部门。
- 作为账套、支出明细、银行流水的上层归属。

### 2.2 账套

路由前缀：`/api/ledgers`

接口：

- `GET /api/ledgers`
- `POST /api/ledgers`
- `GET /api/ledgers/{ledger_id}/close-check`
- `POST /api/ledgers/{ledger_id}/close`
- `POST /api/ledgers/{ledger_id}/reopen`

对应表：

- `ledgers`

关键约束：

- `store_id + period` 唯一。
- 封账后业务写入接口应拒绝。
- 封账前会检查未付款/部分付款支出、未完全匹配银行流水、需要银行对账但未确认匹配的营业收入、待确认候选匹配。
- `close-check` 返回 `unmatched_revenue_record_count` 和 `unmatched_revenue_amount`，用于后台展示收入侧封账阻断指标。
- 关账、重开都会增加 `version` 并记录操作人和时间。

### 2.2.1 门店套帐工作台

路由前缀：`/api/store-ledgers`

接口：

- `GET /api/store-ledgers/{store_id}/workspace?period=YYYY-MM&preview_size=8`

说明：

- 返回单门店套帐工作台所需的门店、账期列表、当前账期、汇总指标和最近业务记录。
- 未传 `period` 时默认使用该门店最近账期；门店暂无账套时默认当前月份。
- 指标包含收入、实收、手续费、银行流水、未匹配流水、审批单、待处理审批、收入匹配和待确认收入匹配。
- 当选中账期存在账套时，返回 `close_check`，字段同 `/api/ledgers/{ledger_id}/close-check`，用于单门店工作台直接展示封账预检状态。
- 接口按当前后台用户的门店范围校验访问权限。

### 2.3 支出明细

路由前缀：`/api/expense-items`

接口：

- `GET /api/expense-items`
- `POST /api/expense-items`

过滤：

- `payment_status` 支持单值或逗号多值，例如 `unpaid,partial_paid`。

对应表：

- `expense_items`

说明：

- 支出明细是报销、分类、供应商、付款匹配和报表聚合的最小业务单元。
- 目前支持手工创建，后续钉钉审批同步也应落到同一张表。
- 创建时会检查对应门店月份账套是否存在且未封账。

### 2.4 营业收入

路由前缀：

- `/api/revenue-channels`
- `/api/revenue-records`

接口：

- `GET /api/revenue-channels`
- `POST /api/revenue-channels`
- `PATCH /api/revenue-channels/{channel_id}`
- `GET /api/revenue-records`
- `POST /api/revenue-records`
- `PATCH /api/revenue-records/{record_id}`

对应表：

- `revenue_channels`
- `revenue_records`

说明：

- 收入渠道作为主数据维护，字段包含名称、排序、是否需要匹配银行流水和启停状态。
- 营业收入按门店、账期、日期、渠道录入。
- 字段包含经营收入、实收金额、手续费和备注。
- `store_id + ledger_period + revenue_date + channel` 唯一。
- 创建和编辑时会检查对应账套是否未封账。
- 创建和编辑收入记录时会校验渠道存在且处于启用状态。

### 2.5 银行流水

路由前缀：`/api/bank-transactions`

接口：

- `GET /api/bank-transactions`
- `POST /api/bank-transactions`
- `PATCH /api/bank-transactions/{transaction_id}`
- `POST /api/bank-transactions/import/preview`
- `POST /api/bank-transactions/import`
- `POST /api/bank-transactions/import-csv`

对应表：

- `bank_transactions`

说明：

- 银行流水是资金发生凭证。
- 当前支持手工创建、编辑、CSV/XLSX 导入预览、重复流水跳过、行级错误返回。
- 创建时会检查对应账套是否未封账。
- 编辑时会检查账套未封账、金额不低于已匹配金额、流水号不与其他流水重复。
- 导入预览不落库，使用与正式导入相同的解析规则。

### 2.6 支出与流水匹配

路由前缀：`/api/matches`

接口：

- `GET /api/matches`
- `POST /api/matches`
- `POST /api/matches/auto-suggest`
- `POST /api/matches/{match_id}/confirm`
- `POST /api/matches/{match_id}/reject`
- `GET /api/matches/revenue`
- `POST /api/matches/revenue`
- `POST /api/matches/revenue/{match_id}/confirm`
- `POST /api/matches/revenue/{match_id}/reject`

对应表：

- `expense_bank_matches`
- `revenue_bank_matches`

说明：

- 匹配状态分为 `candidate`、`confirmed`、`rejected`。
- 系统允许创建候选匹配。
- 系统支持自动生成候选匹配，但不会自动确认。
- 确认匹配后会更新银行流水已匹配金额，并按支出已确认累计金额更新支出明细付款状态。
- 支出匹配支持一条支出分多笔银行流水确认，也支持一笔银行流水拆分确认到多条支出。
- 收入匹配使用所选渠道和日期范围内的收入记录 `net_amount` 合计。
- 收入匹配确认后更新收入方向银行流水已匹配金额。
- 收入匹配不改变报表收入口径，报表仍取 `gross_amount`。
- 后续智能推荐算法只生成候选，不直接确认。

已实现保护：

- 支出明细和银行流水必须属于同一门店。
- 支出明细和银行流水必须属于同一账期。
- 支出匹配只能使用支出方向银行流水。
- 匹配金额不能超过支出剩余可匹配金额。
- 匹配金额不能超过银行流水剩余可匹配金额。
- 已拒绝匹配不能确认。
- 已确认匹配不能拒绝。
- 自动候选当前处理同门店、同账期、剩余金额完全一致的未付款/部分付款支出与支出方向流水。
- 收入匹配要求银行流水为收入方向，且匹配金额等于收入日期范围内的实收合计。
- 封账检查会把支出候选和收入候选一起计入待确认候选匹配。
- 封账检查会按收入渠道 `requires_bank_match` 判断需要对账的日收入；只有已确认且日期范围覆盖该收入日的收入流水匹配才视为已对账。
- 收入匹配列表支持 `store_id` 和 `ledger_period` 查询参数，并按当前用户门店范围过滤。
- 收入匹配创建时会阻止同一门店、账期、渠道、日期范围的候选或已确认匹配重复创建。

### 2.7 附件与凭证

路由前缀：`/api/attachments`

接口：

- `GET /api/attachments`
- `POST /api/attachments?resource_type=expense_item&resource_id={id}`
- `GET /api/attachments/{attachment_id}/download`
- `POST /api/attachments/{attachment_id}/download-dingtalk`

对应表：

- `attachments`

说明：

- 当前上传资源支持 `expense_item`。
- 文件本体存储在 `FILE_STORAGE_ROOT/attachments`。
- 已封账账套下的支出不允许上传新凭证。
- 钉钉同步可创建 `source=dingtalk` 的凭证占位记录，并支持归档下载。
- 上传动作写入审计日志 `attachment.upload`。

### 2.8 钉钉配置

路由前缀：`/api/dingtalk`

接口：

- `GET /api/dingtalk/config`
- `PUT /api/dingtalk/config`
- `POST /api/dingtalk/connection-test`
- `GET /api/dingtalk/templates`
- `POST /api/dingtalk/templates`
- `POST /api/dingtalk/templates/sync`
- `GET /api/dingtalk/templates/{template_id}/field-candidates`
- `GET /api/dingtalk/templates/{template_id}/mappings`
- `POST /api/dingtalk/templates/{template_id}/mappings`
- `POST /api/dingtalk/approval-sync`
- `POST /api/dingtalk/sync-jobs/{job_id}/resume`
- `GET /api/dingtalk/sync-jobs`
- `GET /api/dingtalk/approval-instances`

审批同步请求：

- `template_id`：可选，指定单个模板。
- `start_at`、`end_at`：可选，指定同步时间窗口。
- `page_size`：默认 20，最大 100。
- `max_pages`：默认 20，最大 200。

同步任务返回：

- `request_start_at`、`request_end_at`：实际同步窗口。
- `next_cursor`：分页游标；同步完整时为空。
- `raw_summary`：模板级同步摘要。
- 续跑接口读取上一任务的 `next_cursor`、`request_start_at` 和 `request_end_at`，创建新任务继续拉取后续分页。

审批实例列表：

- `GET /api/dingtalk/approval-instances` 支持 `store_id` 查询参数，用于门店套帐内的审批单管理。
- 门店账期过滤当前由前端按提交时间月份处理，后续建议在接口增加 `ledger_period` 或时间窗口参数。

字段候选：

- `field-candidates` 从审批模板快照和最近审批实例 payload 中提取可映射字段。
- 候选字段包含来源字段 ID、字段名称、字段路径和字段类型。

对应表：

- `dingtalk_configs`

安全约定：

- API 不返回 `app_secret` 明文。
- `app_secret` 使用 `SECRET_KEY` 派生密钥加密存储；生产环境建议接入 KMS、Secret Manager 或等效服务端密钥加密方案。

### 2.9 报表

路由前缀：`/api/reports`

接口：

- `GET /api/reports/store-summaries`
- `GET /api/reports/store-comparison?period={period}`
- `GET /api/reports/ledger-periods?store_id={store_id}`
- `GET /api/reports/ledger-trends?store_id={store_id}&limit={limit}`
- `GET /api/reports/ledger-summary?store_id={store_id}&period={period}`
- `GET /api/reports/ledger-detail?store_id={store_id}&period={period}`
- `GET /api/reports/ledger-detail.csv?store_id={store_id}&period={period}`
- `GET /api/reports/ledger-detail.xlsx?store_id={store_id}&period={period}`

说明：

- `store-summaries` 返回每个门店最近账套的汇总，用于小程序门店列表；股东 token 访问时只返回已封账账套。
- `store-comparison` 返回同一账期各门店汇总和总计，按利润倒序排列；股东 token 访问时只返回授权门店的已封账账套。
- `ledger-periods` 返回指定门店的可查看账期列表；股东 token 访问时只返回已封账账套。
- `ledger-trends` 返回指定门店或全部门店最近若干账期的汇总趋势；股东 token 访问时只返回授权门店的已封账账套。
- `ledger-summary` 返回单门店单月份报表汇总，用于小程序报表详情。
- `ledger-detail` 返回营业收入、收入渠道汇总、分类、供应商、待付款支出和未匹配流水明细。
- `ledger-detail.csv` 返回后台可下载的账套 CSV 明细。
- `ledger-detail.xlsx` 返回 Excel 多工作表明细，包含账套汇总、营业收入、收入渠道汇总、支出明细和银行流水。
- 股东 token 访问 `ledger-summary`、`ledger-detail`、`ledger-detail.csv` 和 `ledger-detail.xlsx` 时，只允许读取已封账账套。
- 当前收入优先取 `revenue_records.gross_amount` 合计；没有收入记录时兼容旧数据，取 `bank_transactions.direction=income` 金额合计。
- 当前支出取 `expense_items.amount` 的金额合计。
- 利润为收入减支出。
- 收入渠道汇总字段 `revenue_channel_breakdown` 包含经营收入、实收金额、手续费、费率、已对账、未对账和对账完成率。

### 2.10 股东授权

路由前缀：

- `/api/shareholder-auth`
- `/api/shareholder-grants`

接口：

- `POST /api/shareholder-auth/login`
- `GET /api/shareholder-auth/me`
- `GET /api/shareholder-grants`
- `POST /api/shareholder-grants`
- `PATCH /api/shareholder-grants/{grant_id}`

说明：

- 股东通过授权码换取 Bearer Token。
- 小程序使用 `GET /api/shareholder-auth/me` 获取当前授权名称和门店范围。
- 报表接口按股东授权门店过滤。
- 股东报表接口只开放已封账账套，后台登录用户仍可查看打开状态账套。
- 股东授权支持 `expires_at` 到期时间；为空表示长期有效，过期授权不能登录，已签发 token 也会被拒绝。
- 后台授权管理仅 `admin` 可访问。

### 2.11 系统设置与备份

路由前缀：`/api/system`

接口：

- `GET /api/system/readiness`
- `GET /api/system/database-backup/status`
- `GET /api/system/database-backup/download`

说明：

- 仅 `admin` 角色可访问。
- `readiness` 返回环境、是否生产就绪和检查项列表。
- 当前检查项包括数据库类型、`SECRET_KEY` 强度、`CORS_ORIGINS`、文件存储路径和钉钉同步模式配置。
- PostgreSQL 返回不支持后台直导，生产环境应使用数据库原生备份。
- 兼容下载入口返回 409，并提示使用 `pg_dump`、托管数据库快照或云厂商备份策略。

## 3. 共享契约

已更新：

- `packages/shared-types`
- `packages/shared-api-client`

前端和小程序应优先使用共享类型，不要在页面内重复定义接口字段。

共享客户端目前提供：

- `stores.list/create`
- `ledgers.list/create/closeCheck/close/reopen`
- `revenueChannels.list/create/update`
- `revenueRecords.list/create/update`
- `expenseItems.list/create`
- `attachments.list/upload/download/downloadDingtalk`
- `bankTransactions.list/create/update`
- `bankTransactions.previewImport/importFile/importCsv`
- `matches.list/create/autoSuggest/confirm/reject`
- `matches.listRevenue/createRevenue/confirmRevenue/rejectRevenue`
- `system.databaseBackupStatus/downloadDatabaseBackup`
- `dingtalk.readConfig/updateConfig`
- `dingtalk.listTemplates/createTemplate/syncTemplates`
- `dingtalk.listMappings/upsertMapping`
- `reports.storeSummaries/ledgerSummary/ledgerDetail/exportLedgerDetailCsv`

## 4. 数据库迁移

迁移入口：

```bash
cd apps/api
alembic upgrade head
```

迁移文件：

- `apps/api/alembic/versions/20260828_0001_initial_domain.py`
- `apps/api/alembic/versions/20260829_0008_revenue_records.py`

## 5. 下一步建议

已补充：

- Docker API 启动时自动执行数据库迁移。
- `SEED_DEV_DATA=true` 时写入开发样例数据。
- API 集成测试覆盖门店、账套、封账限制和匹配确认。
- 钉钉审批模板与解析规则 API。
- 银行流水 CSV/XLSX 导入 API。
- 银行流水导入行级错误回显。

下一步建议：

1. 增加钉钉审批实例同步任务表。
2. 增加银行流水导入预览和字段映射。
3. 增加报表分类明细接口。
