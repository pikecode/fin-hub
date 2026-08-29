# 报表与审计实现说明

更新时间：2026-08-29

## 财务报表

后台页面：

- `/reports`

已实现能力：

- 查看各门店最新账套汇总。
- 选择门店账套查看收入、支出、利润。
- 展示待付款支出数、未匹配银行流水数。
- 展示营业收入明细、费用分类支出、供应商支出、待处理支出、未匹配银行流水。
- 导出当前账套 CSV 明细。

API：

- `GET /api/reports/store-summaries`
- `GET /api/reports/store-comparison?period=`
- `GET /api/reports/ledger-periods?store_id=`
- `GET /api/reports/ledger-trends?store_id=&limit=`
- `GET /api/reports/ledger-summary?store_id=&period=`
- `GET /api/reports/ledger-detail?store_id=&period=`
- `GET /api/reports/ledger-detail.csv?store_id=&period=`
- `GET /api/reports/ledger-detail.xlsx?store_id=&period=`

访问控制：

- 后台登录用户可查看全部门店报表。
- 股东小程序需携带 `Authorization: Bearer <token>`。
- 股东 token 只能查看授权门店。
- 股东 token 只能查看已封账账套；未封账账套在 `store-summaries`、`store-comparison`、`ledger-periods` 和 `ledger-trends` 中不返回，详情和导出请求返回 `403`。
- 未登录且未携带有效 token 的请求返回 `401`。

当前口径：

- 收入：优先取营业收入记录的经营收入 `gross_amount` 合计；没有收入记录时兼容旧数据，取收入方向银行流水金额合计。
- 支出：支出明细金额合计。
- 利润：收入减支出。
- 待付款支出：`unpaid`、`partial_paid` 状态的支出明细。
- 未匹配流水：支出方向银行流水中 `matched_amount < amount` 的记录。

`ledger-detail` 额外返回：

- `category_breakdown`：按一级费用分类聚合支出。
- `revenue_records`：最多 50 条营业收入明细。
- `supplier_breakdown`：按供应商聚合支出。
- `pending_expense_items`：最多 20 条待付款或部分付款支出。
- `pending_bank_transactions`：最多 20 条未完全匹配的银行流水，包含收入和支出方向。

`ledger-trends` 返回：

- `store_id`、`store_name`。
- `items`：按账期升序排列的账套汇总，默认最近 6 期，最大 24 期。

`store-comparison` 返回：

- `period`：对比账期，未传时取当前可见最新账期。
- `items`：同一账期各门店汇总，按利润倒序排列。
- `total_income_amount`、`total_expense_amount`、`total_profit_amount`：对比范围内总计。

`ledger-detail.csv` 导出内容：

- 账套汇总。
- 营业收入。
- 营业收入明细。
- 支出明细。
- 银行流水。
- CSV 使用 UTF-8 BOM，便于 Excel 直接打开中文。

`ledger-detail.xlsx` 导出内容：

- 账套汇总工作表。
- 营业收入工作表。
- 支出明细工作表。
- 银行流水工作表。
- 冻结首行并按内容设置列宽。

后续建议：

- 增加费用分类和供应商维度的趋势报表。
- 增加报表口径配置，区分权责发生制和收付实现制。

## 股东小程序报表

页面：

- `pages/stores/index`：展示可查看门店的最新账套摘要。
- `pages/report/index`：展示单个门店账套详情。

已实现能力：

- 查看收入、支出、利润。
- 查看授权门店横向对比总计和排名。
- 切换门店已封账账期。
- 查看最近账期收入和利润趋势。
- 查看费用分类支出构成。
- 查看供应商支出构成。
- 查看待处理支出。
- 查看未匹配银行流水。

## 操作日志

后台页面：

- `/audit`

API：

- `GET /api/audit-logs?page=&page_size=&actor=&action=&resource_type=`

数据库表：

- `audit_logs`

字段：

- `actor`：操作者。
- `action`：动作，例如 `ledger.close`、`match.confirm`。
- `resource_type`：资源类型。
- `resource_id`：资源 ID。
- `summary`：中文摘要。
- `metadata_json`：动作元数据。
- `created_at`：发生时间。

已接入审计的动作：

- 新增门店：`store.create`
- 新增账套：`ledger.create`
- 封账：`ledger.close`
- 反封账：`ledger.reopen`
- 新增费用分类：`category.create`
- 新增供应商：`supplier.create`
- 新增支出：`expense_item.create`
- 更新支出：`expense_item.update`
- 上传附件：`attachment.upload`
- 归档钉钉附件：`attachment.dingtalk_download`
- 新增收入渠道：`revenue_channel.create`
- 更新收入渠道：`revenue_channel.update`
- 新增营业收入：`revenue_record.create`
- 更新营业收入：`revenue_record.update`
- 新增银行流水：`bank_transaction.create`
- 更新银行流水：`bank_transaction.update`
- 导入银行流水 CSV：`bank_transaction.import_csv`
- 创建匹配候选：`match.create`
- 自动生成匹配候选：`match.auto_suggest`
- 确认匹配：`match.confirm`
- 驳回匹配：`match.reject`
- 创建收入匹配候选：`revenue_match.create`
- 确认收入匹配：`revenue_match.confirm`
- 驳回收入匹配：`revenue_match.reject`
- 新增股东授权：`shareholder_grant.create`
- 更新股东授权：`shareholder_grant.update`
- 导出数据库备份：`system.database_backup.download`

操作者来源：

- 登录后台后发起的写操作，会优先使用登录态用户名作为 `actor`。
- 封账、反封账、银行导入、匹配确认仍保留显式操作者参数，便于批处理和导入任务记录来源；当存在登录态时，登录用户优先。
- 后台写操作接口要求登录，允许 `admin`、`finance` 角色执行。

当前限制：

- 暂未记录查询类操作，避免日志量过大。
- 暂未做日志归档和清理策略。
