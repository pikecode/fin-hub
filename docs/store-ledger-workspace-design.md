# 门店套帐工作台设计说明

生成时间：2026-09-01

## 1. 改造目标

后台交互从“功能菜单入口”调整为“门店套帐入口”：

- 运维或财务人员先选择自己维护的门店。
- 进入单门店后再处理银行流水、审批单、对账和营业收入。
- 营业收入按渠道逐日维护，并与银行收入流水做对账关联。
- 后续报表以 `store_id + period` 为稳定聚合口径。

## 2. 导航结构

左侧菜单采用树形结构：

- 工作台
- 门店套帐
  - 套帐首页
  - 银行流水管理
  - 审批单管理
  - 营业收入管理
  - 对账管理
  - 账套管理
- 基础数据
  - 门店资料
  - 收入渠道
  - 费用分类
  - 供应商
- 数据同步
  - 钉钉同步
  - 任务中心
- 报表与审计
  - 财务报表
  - 操作日志
- 系统管理
  - 用户管理
  - 股东授权
  - 系统设置

交互规则：

- 在 `/store-ledgers` 页面点击子菜单时，进入门店入口页并带 `module` 参数，用于提示用户下一步要处理的模块。
- 在 `/store-ledgers/{storeId}` 或子页面内点击子菜单时，保持当前门店上下文，进入对应模块。
- 门店套帐内集中放置账期处理相关入口，基础档案、同步、报表和系统能力独立成树，降低主流程干扰。

## 3. 页面设计

### 3.1 门店套帐入口

路径：`/store-ledgers`

展示内容：

- 当前可维护门店卡片。
- 每个卡片展示门店状态、最近账期、收入、未匹配流水、待处理审批。
- 卡片操作直接进入银行流水、审批单、对账或营业收入。
- 支持只看启用门店或查看全部门店。

权限口径：

- 当前页面使用 `GET /api/auth/me/stores`。
- API 根据当前用户角色和可管理门店过滤。
- 管理员默认看到全部门店。
- 财务人员默认只看到 `user_store_permissions` 授权门店。

### 3.2 单门店套帐工作台

路径：`/store-ledgers/{storeId}`

展示内容：

- 门店基本信息和当前账期。
- 账期切换。
- 银行流水、审批单、对账、营业收入四个业务入口。
- 当前账期最近流水、收入和审批单摘要。

设计原则：

- `store_id` 固定在 URL 中，避免用户在处理业务时频繁重复选择门店。
- `period` 作为查询参数传递，方便刷新、分享和后续报表钻取。
- 各业务页仍复用现有基础页面，先通过查询参数带入门店和账期，降低重复实现成本。

### 3.3 审批单管理

路径：`/store-ledgers/{storeId}/approvals`

当前能力：

- 按门店获取钉钉审批实例。
- 按账期筛选提交日期。
- 查看审批编号、申请人、部门、状态、提交时间和审批完成时间。
- 提供同步入口跳转到钉钉配置页面。

API 支撑：

- `GET /api/dingtalk/approval-instances?store_id={storeId}&page_size=500`

## 4. 营业收入模型

营业收入按渠道管理，收入记录每天一条：

- `store_id`：门店。
- `ledger_period`：账期。
- `revenue_date`：收入日期。
- `channel`：收入渠道，例如美团、抖音、微信、现金。
- `gross_amount`：经营收入。
- `net_amount`：实收金额。
- `fee_amount`：手续费，前端按 `gross_amount - net_amount` 推算，API 仍保存字段。
- `fee_rate`：展示推算字段，公式为 `fee_amount / gross_amount`。
- `remark`：备注。

当前约束：

- `store_id + ledger_period + revenue_date + channel` 唯一。
- 封账账套不允许新增或编辑收入。
- 渠道必须为启用状态。
- 营业收入列表展示对账状态；在门店和账期上下文明确时，可判断单日收入是否已关联收入流水。
- 账套封账预检会把 `requires_bank_match=true` 渠道下未确认关联银行流水的日收入作为阻断项，并汇总未对账实收金额。

## 5. 收入对账

营业收入需要与银行流水建立关联：

- 对账入口：`/store-ledgers/{storeId}/matching`。
- 当前复用 `/finance/reconciliation?store_id={storeId}`。
- 收入匹配使用银行收入流水和收入记录 `net_amount` 合计。
- 确认匹配后更新银行流水已匹配金额。
- 营业收入列表提供“关联流水”快捷动作，当前支持一条日收入记录关联一条收入方向银行流水。
- 快捷动作会创建收入匹配候选并立即确认，金额以该日收入记录的 `net_amount` 为准。
- 同一门店、账期、渠道、日期范围内已有候选或已确认收入匹配时，API 会拒绝重复创建匹配，避免同一收入被重复对账。

后续增强建议：

- 支持一个收入渠道一段日期合并匹配一笔银行入账。
- 报表增加收入渠道手续费、费率、未对账金额、对账完成率。

## 6. 性能设计

当前实现：

- 门店入口按页面级并发请求加载门店、账套和看板汇总。
- 单门店工作台使用 `GET /api/store-ledgers/{storeId}/workspace?period=YYYY-MM` 聚合加载门店、账期、指标和最近业务记录。
- 列表接口使用 `page_size` 限制，避免一次性拉取全部历史数据。

后续优化：

- 审批单接口增加 `ledger_period` 或 `submit_start_at/submit_end_at` 服务端过滤。
- 收入匹配接口已支持按 `store_id` 和 `ledger_period` 过滤；后续可返回银行流水摘要，减少前端二次映射。
- 收入、流水和匹配表增加组合索引：
  - `store_id, ledger_period`
  - `store_id, ledger_period, direction`
  - `store_id, ledger_period, revenue_date, channel`
- 报表使用按账期预聚合或物化汇总表，封账时固化最终口径。

## 7. 已落地路由

- `/store-ledgers`
- `/store-ledgers/{storeId}`
- `/store-ledgers/{storeId}/bank`
- `/store-ledgers/{storeId}/approvals`
- `/store-ledgers/{storeId}/matching`
- `/store-ledgers/{storeId}/revenue`

其中银行流水、营业收入和对账页面当前通过门店上下文跳转复用已有页面，后续可以逐步内嵌成真正的单门店子工作台。

## 8. 聚合接口

路径：`GET /api/store-ledgers/{storeId}/workspace?period=YYYY-MM&preview_size=8`

返回内容：

- `store`：门店信息。
- `period`：当前选中的账期；未传时默认门店最近账期。
- `ledgers`：门店最近账期列表。
- `selected_ledger`：当前账期对应账套；没有创建账套时为空。
- `metrics`：收入、实收、手续费、流水数、未匹配流水、审批数、待处理审批、收入匹配数。
- `bank_transactions`：最近银行流水。
- `revenue_records`：最近营业收入。
- `approval_instances`：当前账期审批单。
- `revenue_matches`：当前账期收入匹配记录。

## 9. 验收参考

- 人工验收清单：`docs/store-ledger-e2e-acceptance-checklist.md`
- API 主流程回归：`apps/api/tests/test_store_ledger_acceptance.py`
