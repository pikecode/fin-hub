# fin-hub 架构与交互规划

生成时间：2026-08-28

依据：

- `docs/moshuo-prd-analysis.md`
- `docs/moshuo-api-usage-summary.md`
- `docs/moshuo-interaction-summary.md`
- 原始 PRD：`/Users/ompeak/Downloads/蘑说财务管理系统-产品需求文档.pdf`

> 本文档是面向新版 Web 后台和后续小程序的系统设计建议。目标是把 PRD 转化为可开发、可演进、可迁移的架构和交互蓝图。

## 1. 设计原则

### 1.1 业务原则

- 一个门店一个月份形成一个账套。
- 支出明细行是支出做账、分类、供应商、付款匹配、报表聚合的最小单元。
- 报销单是展示聚合对象，不是对账最小对象。
- 银行流水是资金实际发生凭证。
- 匹配关系是业务数据和资金流水之间的审计凭证。
- 系统只推荐匹配，不自动确认。
- 封账后禁止写入，重开必须留痕。

### 1.2 技术原则

- 数据模型先行，页面围绕账套上下文组织。
- 同步、导入、匹配、封账都必须可重试、可追溯、幂等。
- 服务层统一执行业务约束，前端只负责交互提示。
- 所有金额使用定点数，不使用浮点数作为存储或计算真源。
- 敏感配置不落前端，不写日志，不进入导出报表。
- 阶段一接口应支撑阶段二报表和阶段三小程序，不重复建模。

## 2. 推荐技术架构

### 2.1 总体形态

推荐采用 Web 后台 + 服务端 API + 关系型数据库 + 对象存储/本地文件存储。

建议技术栈：

| 层 | 建议 |
|---|---|
| 前端 | React + TypeScript + Ant Design / Shadcn UI 二选一 |
| 后端 | Node.js NestJS 或 Python FastAPI |
| 数据库 | PostgreSQL |
| 文件 | 本地文件系统起步，后续可迁移对象存储 |
| 后台任务 | BullMQ / Celery / RQ，按后端栈选择 |
| 缓存 | Redis，可先不用，后续用于任务状态和 token 缓存 |
| 小程序 API | 复用后端，只开放只读报表接口 |

如果当前团队更熟悉 Python，建议用 FastAPI。旧桌面版的钉钉同步、表单解析、附件下载和匹配算法可以迁移成本更低。

### 2.2 逻辑分层

```text
Frontend Web
  ├─ 账套工作台页面
  ├─ 钉钉配置与字段映射
  ├─ 银行流水导入
  ├─ 收入录入
  ├─ 单据/明细行管理
  ├─ 匹配工作台
  └─ 报表

Backend API
  ├─ Auth
  ├─ Store & Ledger
  ├─ DingTalk Integration
  ├─ Expense Documents
  ├─ Bank Transactions
  ├─ Revenue
  ├─ Matching
  ├─ Category & Supplier
  ├─ Report
  ├─ File
  └─ Audit Log

Workers
  ├─ 钉钉模板同步
  ├─ 钉钉审批实例同步
  ├─ 附件下载/缩略图
  ├─ 银行流水导入解析
  ├─ 历史数据迁移
  └─ 报表导出

Database + File Storage
```

## 3. 核心领域模型

### 3.1 门店与账套

`stores`

- `id`
- `name`
- `dingtalk_dept_id`
- `status`: active/inactive
- `contact_person`
- `phone`
- `address`
- `created_at`
- `updated_at`

`ledgers`

- `id`
- `store_id`
- `period`: YYYY-MM
- `status`: open/closed
- `closed_at`
- `closed_by`
- `reopened_at`
- `reopened_by`
- `version`
- `created_at`
- `updated_at`

设计要点：

- `store_id + period` 唯一。
- 账套是所有做账页面的全局上下文。
- 所有写操作必须检查账套是否封账。

### 3.2 钉钉模板与字段映射

`dingtalk_apps`

- `id`
- `corp_id`
- `app_key`
- `app_secret_encrypted`
- `admin_user_id`
- `drive_union_id`
- `status`

`approval_templates`

- `id`
- `process_code`
- `name`
- `is_enabled`
- `mapping_status`
- `last_sync_at`
- `last_watermark_at`
- `raw_snapshot`

`template_field_mappings`

- `id`
- `template_id`
- `standard_field`
- `source_field_id`
- `source_field_name`
- `source_path`
- `field_type`
- `is_required`
- `sort_order`

新版标准字段建议：

- 门店。
- 支出日期。
- 金额。
- 支出详情。
- 一级分类。
- 二级分类。
- 申请人。
- 凭证人。
- 收款账户。
- 报销图片。
- 报销凭证文档。
- 备注。

表格字段映射必须支持“顶层字段 + 表格内列字段”的路径表达。

### 3.3 报销单与支出明细行

`expense_documents`

- `id`
- `source`: dingtalk/manual/migration
- `dingtalk_instance_id`
- `template_id`
- `store_id`
- `approval_no`
- `applicant_name`
- `applicant_user_id`
- `applicant_dept_id`
- `submit_at`
- `approved_at`
- `approval_status`
- `raw_payload`
- `voided_at`
- `created_at`
- `updated_at`

`expense_items`

- `id`
- `document_id`
- `store_id`
- `ledger_period`
- `expense_date`
- `description`
- `amount`
- `category_l1_id`
- `category_l2_id`
- `supplier_id`
- `payee_account`
- `entry_status`: pending/entered
- `payment_status`: unpaid/partial_paid/paid/no_bank_flow
- `source_row_index`
- `is_manual`
- `created_at`
- `updated_at`

设计要点：

- `expense_items` 是报表和匹配真源。
- 审批单对账状态由明细行付款状态聚合推导。
- 手动录入支出也进入 `expense_items`。
- 支出明细行要保留来源行号，方便从钉钉表格行追溯。

### 3.4 附件

`attachments`

- `id`
- `owner_type`: expense_document/expense_item/bank_transaction/manual_note
- `owner_id`
- `file_name`
- `file_type`
- `file_path`
- `thumbnail_path`
- `source_url`
- `dingtalk_space_id`
- `dingtalk_file_id`
- `download_status`: downloaded/placeholder/failed
- `failure_reason`
- `created_at`

设计要点：

- 图片类凭证下载原图和缩略图。
- 钉盘文档权限不足时保留占位元数据。
- 文件访问必须走鉴权接口，不允许猜 URL 直取。

### 3.5 银行流水

`bank_import_batches`

- `id`
- `store_id`
- `ledger_period`
- `file_name`
- `file_hash`
- `row_count`
- `imported_count`
- `duplicate_count`
- `status`
- `created_by`
- `created_at`

`bank_transactions`

- `id`
- `store_id`
- `ledger_period`
- `transaction_date`
- `amount`
- `direction`: in/out
- `summary`
- `counterparty`
- `account_no`
- `fingerprint`
- `match_status`: unmatched/partial_matched/matched/ignored
- `import_batch_id`
- `created_at`
- `updated_at`

设计要点：

- 指纹建议：交易日期 + 金额 + 收支方向 + 摘要 + 对手方。
- 允许用户强制导入疑似重复，但必须留痕。
- 已匹配流水禁止改金额和方向。

### 3.6 营业收入

`revenue_channels`

- `id`
- `name`
- `is_default`
- `requires_bank_match`
- `is_active`
- `sort_order`

`revenue_records`

- `id`
- `store_id`
- `ledger_period`
- `channel_id`
- `business_date`
- `gross_amount`
- `net_amount`
- `fee_amount`
- `fee_rate`
- `notes`
- `match_status`
- `created_at`
- `updated_at`

设计要点：

- 报表营业收入取 `gross_amount`。
- 银行流水匹配取 `net_amount`。
- `requires_bank_match=false` 的渠道不进入待对账统计。

### 3.7 分类与供应商

`expense_categories`

- `id`
- `parent_id`
- `name`
- `requires_supplier`
- `is_active`
- `sort_order`

`suppliers`

- `id`
- `name`
- `contact_person`
- `phone`
- `settlement_cycle`: monthly/half_monthly/weekly/cash
- `settlement_day`
- `is_active`

`supplier_store_scopes`

- `supplier_id`
- `store_id`

设计要点：

- 分类全公司统一。
- 二级分类可标记是否必须选择供应商。
- 供应商默认全门店可用，也可限制门店范围。

### 3.8 匹配关系

`match_relations`

- `id`
- `bank_transaction_id`
- `target_type`: expense_item/revenue_range/tail_difference
- `target_id`
- `allocated_amount`
- `revenue_channel_id`
- `revenue_start_date`
- `revenue_end_date`
- `difference_amount`
- `difference_category_id`
- `status`: confirmed/rejected/reversed
- `confirmed_by`
- `confirmed_at`
- `reversed_by`
- `reversed_at`
- `notes`

设计要点：

- 匹配关系支持多对多。
- 收入按渠道 + 日期范围建立关联。
- 拒绝匹配也要落库，避免重复推荐。
- 解除关联建议不要物理删除，改为 `reversed`，审计更完整。

### 3.9 操作日志

`audit_logs`

- `id`
- `operator_id`
- `operator_name`
- `action`
- `object_type`
- `object_id`
- `ledger_id`
- `before_json`
- `after_json`
- `ip`
- `user_agent`
- `created_at`

必须记录：

- 归属账期调整。
- 分类变更。
- 供应商关联变更。
- 匹配确认。
- 解除关联。
- 封账。
- 重开。
- 流水导入。
- 批次撤销。
- 流水编辑。
- 钉钉同步。

## 4. 模块边界

### 4.1 Auth 模块

阶段一：

- 单管理员密码登录。
- 可选“当前操作人”选择/输入。

预留：

- 用户表。
- 角色表。
- 门店授权。
- 股东小程序账号绑定。

### 4.2 Ledger 模块

职责：

- 门店账套创建。
- 账套状态读取。
- 封账。
- 重开。
- 写入守卫。

统一方法：

- `assertLedgerWritable(storeId, period)`
- `closeLedger(storeId, period)`
- `reopenLedger(storeId, period)`

### 4.3 DingTalk 模块

职责：

- 凭证管理。
- Token 刷新。
- 模板同步。
- 字段目录提取。
- 审批实例同步。
- 表单解析。
- 附件下载。

关键要求：

- 水位按最后修改时间推进。
- 同步必须幂等。
- 失败不推进水位。
- 原始 JSON 必须保留。

### 4.4 Import 模块

职责：

- 银行流水文件上传。
- 列映射。
- 预览校验。
- 指纹去重。
- 确认导入。
- 批次撤销。

导入流程：

```text
上传文件 → 解析表头 → 用户映射列 → 预览校验 → 去重提示 → 确认导入 → 生成批次
```

### 4.5 Matching 模块

职责：

- 候选搜索。
- 推荐打分。
- 分摊校验。
- 尾差校验。
- 确认关联。
- 解除关联。
- 拒绝推荐。
- 状态重算。

推荐算法：

- 金额完全一致优先。
- 日期接近加分。
- 金额容差内低分展示。
- 分期付款按剩余金额和日期差提示。
- 拒绝过的组合不再推荐。

### 4.6 Report 模块

职责：

- 读取已归集数据。
- 收支明细。
- 利润汇总。
- 分类汇总。
- 趋势分析。
- 导出。

原则：

- 阶段二不新增采集能力。
- 报表不修正数据，只提示未完成项。
- 未封账账套必须标注“数据未最终确认”。

## 5. 页面信息架构

### 5.1 阶段一 Web 后台页面

建议页面结构：

```text
登录

首页仪表盘

总管理
  ├─ 门店管理
  ├─ 支出分类
  ├─ 供应商管理
  └─ 钉钉同步设置
       ├─ API 凭证
       ├─ 审批模板
       └─ 字段映射

门店账套
  ├─ 账套列表
  └─ 账套工作台
       ├─ 账套首页
       ├─ 营业收入
       ├─ 银行流水
       ├─ 单据管理
       ├─ 匹配工作台
       └─ 供应商列表

系统
  ├─ 操作日志
  ├─ 数据备份
  └─ 系统设置
```

### 5.2 阶段二页面

```text
报表
  ├─ 收支明细表
  ├─ 利润汇总表
  ├─ 分类汇总表
  ├─ 门店趋势分析
  └─ 报表导出
```

### 5.3 阶段三页面

```text
小程序
  ├─ 微信登录
  ├─ 门店列表
  ├─ 门店报表
  ├─ 月份切换
  └─ 近 N 月趋势
```

## 6. 关键页面交互设计

### 6.1 首页仪表盘

目标：

- 让财务人员一眼看到待办。

内容：

- 当前默认做账月份。
- 待匹配流水数。
- 未分类明细行数。
- 未设归属账期支出数。
- 同步失败数。
- 待封账账套数。

交互：

- 每个指标可点击跳转到对应处理页。
- 默认按上一个月份展示。
- 顶部可切换月份。

### 6.2 账套列表

目标：

- 以“门店 + 月份”为入口进入做账。

内容：

- 年月选择器，默认上一个月。
- 门店搜索。
- 门店卡片/表格。
- 账套状态：待做账、封账。
- 待办摘要。

卡片字段：

- 门店名称。
- 收入录入状态。
- 流水导入笔数。
- 待匹配流水数。
- 未分类明细行数。
- 封账状态。

操作：

- 进入账套。
- 封账。
- 重开。

### 6.3 账套首页

目标：

- 成为单门店单月份的工作台。

内容：

- 当前门店与月份固定显示。
- 收入合计。
- 流水收入/支出合计。
- 待匹配笔数。
- 未分类明细行数。
- 未设归属账期数。
- 供应商未付金额。

交互：

- 数据块点击进入对应页面。
- 封账前展示检查清单。
- 封账按钮应展示二次确认和影响说明。

封账检查建议：

- 是否存在待匹配流水。
- 是否存在未分类支出明细。
- 是否存在无归属账期支出。
- 是否存在同步失败未处理。
- 是否存在需供应商但未关联供应商的支出。

是否允许带问题封账需要业务确认。建议默认允许但强提醒，并记录日志。

### 6.4 钉钉同步设置

页面分区：

- API 凭证。
- 模板列表。
- 字段映射状态。
- 同步状态。

交互：

- 保存凭证。
- 测试连接。
- 刷新模板。
- 启用/停用模板。
- 进入字段映射。
- 手动同步某模板。

规则：

- 字段映射未完成不允许启用。
- 未启用模板不参与同步。
- 停用模板不删除历史数据。

### 6.5 字段映射

目标：

- 把不同审批模板统一解析为支出明细行。

交互设计：

- 左侧标准字段池。
- 右侧钉钉字段树。
- 支持普通字段映射。
- 支持表格字段展开到行内列。
- 必填字段缺失时显示阻断提示。
- 保存后可选择是否重解析历史单据。

字段类型：

- 文本。
- 金额。
- 日期。
- 人员。
- 部门。
- 附件。
- 表格列。

### 6.6 单据管理

目标：

- 管理审批单和支出明细行，把支出归到正确账期、分类和供应商。

列表层级：

- 默认展示支出明细行列表。
- 可按审批单折叠/展开。
- 支持整单勾选，实际操作应用到明细行。

筛选：

- 模板。
- 对账状态。
- 是否已分类。
- 是否已设归属账期。
- 是否需供应商但未关联。
- 申请人。
- 金额范围。
- 关键字。

批量操作：

- 批量设置归属账期。
- 批量设置分类。
- 批量关联供应商。
- 批量忽略/作废处理。

详情弹窗：

- 左侧原始审批字段。
- 右侧凭证区。
- 下方支出明细行表格。
- 每条明细行可单独分类、改归属账期、选供应商、查看匹配状态。

### 6.7 银行流水

目标：

- 安全导入和维护资金流水。

导入交互：

1. 上传 Excel/CSV。
2. 显示文件预览。
3. 映射列：交易日期、金额、收支方向、摘要、对手方。
4. 系统校验日期、金额、方向。
5. 计算指纹并标出疑似重复。
6. 用户确认导入。
7. 生成导入批次。

列表交互：

- 月份筛选。
- 匹配状态筛选。
- 收支方向筛选。
- 金额容差搜索。
- 行内编辑。
- 已匹配流水禁止改金额和方向。
- 批次撤销。

金额容差搜索：

- 输入金额后按可配置容差查找。
- 默认规则：`max(金额 * 5%, 下限)`，并设置绝对上限。

### 6.8 营业收入

目标：

- 按渠道、按日期快速录入收入。

页面结构：

- 渠道卡片。
- 当前渠道当月日历/表格编辑器。
- 汇总条。

字段：

- 日期。
- 经营收入。
- 实收金额。
- 手续费。
- 手续费率。
- 备注。
- 行状态。

交互：

- 新增渠道。
- 配置是否产生银行流水。
- 点击渠道进入编辑器。
- Excel 粘贴多行多列。
- 起止日期批量填充。
- 未保存关闭二次确认。
- 自动计算手续费和费率。

### 6.9 匹配工作台

目标：

- 将银行流水与支出明细行/收入记录快速确认关联。

布局：

- 左侧：当前账套银行流水列表。
- 右侧：当前流水匹配区。

左侧字段：

- 日期。
- 金额。
- 方向。
- 摘要。
- 匹配状态。
- 关联摘要。

支出匹配交互：

1. 选择一笔支出流水。
2. 系统推荐未匹配支出明细行。
3. 用户查看候选置信度、金额、日期、供应商、凭证。
4. 勾选一条或多条明细行。
5. 输入/调整分摊金额。
6. 实时显示已选合计、流水金额、差额。
7. 差额超限阻止确认。
8. 差额在容忍范围内，生成尾差记录。
9. 确认关联。
10. 自动跳到下一笔未匹配流水。

收入匹配交互：

1. 选择一笔收入流水。
2. 选择收入渠道。
3. 选择经营日期范围。
4. 系统汇总实收金额。
5. 显示与流水金额差额。
6. 确认后占用该渠道日期范围。
7. 后续选择范围时高亮已占用日期。

辅助操作：

- 手动搜索关联。
- 拒绝匹配。
- 无单据支出。
- 解除关联。
- 查看原始凭证。

跨月建议：

- 默认推荐同账套数据。
- 允许同门店跨月手动搜索。
- 跨月匹配必须展示“流水交易月”和“支出归属月”。

### 6.10 供应商

总部供应商页：

- 供应商列表。
- 新增/编辑/停用供应商。
- 账期配置。
- 适用门店范围。
- 全部门店应付汇总。

账套内供应商页：

- 仅展示本门店可用供应商。
- 本门店已付/未付金额。
- 点击供应商查看支出明细。
- 提供未关联供应商明细行的反向关联入口。

### 6.11 操作日志

目标：

- 在单密码阶段提供审计补偿。

筛选：

- 操作时间。
- 操作类型。
- 操作对象。
- 门店。
- 账套。
- 操作人。

详情：

- 变更前。
- 变更后。
- 关联对象。

交互：

- 只读。
- 不可删除。
- 支持导出。

### 6.12 报表

阶段二页面：

- 收支明细表。
- 利润汇总表。
- 分类汇总表。
- 门店分析。

通用规则：

- 筛选维度：门店 + 月份。
- 月份口径：支出归属账期。
- 未封账显示数据未最终确认。
- 未分类支出不进入分类汇总，但必须醒目提示。

导出：

- 支持 HTML 交互报表。
- 凭证内嵌或打包。
- 离线可查看。

## 7. API 设计草案

### 7.1 账套

- `GET /api/ledgers?period=YYYY-MM`
- `GET /api/ledgers/{ledgerId}`
- `POST /api/ledgers/{ledgerId}/close`
- `POST /api/ledgers/{ledgerId}/reopen`
- `GET /api/ledgers/{ledgerId}/dashboard`

### 7.2 钉钉

- `GET /api/dingtalk/config`
- `PUT /api/dingtalk/config`
- `POST /api/dingtalk/test`
- `POST /api/dingtalk/templates/sync`
- `GET /api/dingtalk/templates`
- `PUT /api/dingtalk/templates/{templateId}/enable`
- `GET /api/dingtalk/templates/{templateId}/mapping`
- `PUT /api/dingtalk/templates/{templateId}/mapping`
- `POST /api/dingtalk/templates/{templateId}/sample-fields`
- `POST /api/dingtalk/templates/{templateId}/sync-instances`

### 7.3 单据与明细行

- `GET /api/expense-documents`
- `GET /api/expense-documents/{id}`
- `GET /api/expense-items`
- `PATCH /api/expense-items/{id}`
- `POST /api/expense-items/batch-classify`
- `POST /api/expense-items/batch-period`
- `POST /api/expense-items/batch-supplier`
- `POST /api/expense-items/manual`

### 7.4 银行流水

- `POST /api/bank-imports/upload`
- `POST /api/bank-imports/preview`
- `POST /api/bank-imports/confirm`
- `POST /api/bank-imports/{batchId}/rollback`
- `GET /api/bank-transactions`
- `POST /api/bank-transactions`
- `PATCH /api/bank-transactions/{id}`
- `DELETE /api/bank-transactions/{id}`

### 7.5 收入

- `GET /api/revenue-channels`
- `POST /api/revenue-channels`
- `PATCH /api/revenue-channels/{id}`
- `GET /api/revenue-records`
- `PUT /api/revenue-records/batch`

### 7.6 匹配

- `GET /api/matching/transactions`
- `GET /api/matching/transactions/{transactionId}/suggestions`
- `POST /api/matching/transactions/{transactionId}/confirm`
- `POST /api/matching/transactions/{transactionId}/reject`
- `POST /api/matching/transactions/{transactionId}/unlink`
- `POST /api/matching/manual-expense`
- `GET /api/matching/revenue-range-total`

### 7.7 报表

- `GET /api/reports/income-expense`
- `GET /api/reports/profit`
- `GET /api/reports/category-summary`
- `GET /api/reports/store-analysis`
- `POST /api/reports/export`
- `GET /api/reports/export-tasks/{taskId}`

### 7.8 审计

- `GET /api/audit-logs`
- `GET /api/audit-logs/{id}`

## 8. 后台任务设计

任务类型：

- `dingtalk.template_sync`
- `dingtalk.instance_sync`
- `dingtalk.attachment_download`
- `bank.import_parse`
- `bank.import_confirm`
- `report.export`
- `migration.legacy_sqlite`

任务状态：

- pending
- running
- success
- partial_success
- failed
- cancelled

前端交互：

- 启动任务后返回 `taskId`。
- 前端轮询或 WebSocket/SSE 订阅进度。
- 支持取消。
- 部分成功展示失败明细和重试入口。

## 9. 状态机

### 9.1 账套状态

```text
open → closed
closed → open
```

规则：

- `closed` 后禁止写入。
- `reopen` 必须二次确认。
- 每次状态变化写操作日志。

### 9.2 支出明细行状态

入账状态：

```text
pending_period → entered
```

付款状态：

```text
unpaid → partial_paid → paid
unpaid → no_bank_flow
```

分类状态：

```text
unclassified → classified
```

供应商状态：

```text
not_required
required_missing → linked
```

### 9.3 银行流水状态

```text
unmatched → partial_matched → matched
unmatched → ignored
matched → unmatched   # 解除关联后
partial_matched → unmatched
```

### 9.4 收入记录状态

```text
empty → saved → modified
unmatched → matched
not_required
```

## 10. 迁移策略

### 10.1 迁移来源

旧系统：

- SQLite 数据库：`data/moshuo.db`
- 报销单：约 1150 张。
- 附件：约 4039 个。
- 门店：19 个。
- 模板：37 个。

### 10.2 迁移步骤

1. 读取旧库 schema 和数据。
2. 迁移门店。
3. 迁移模板和字段映射。
4. 迁移报销单主表为 `expense_documents`。
5. 从旧报销单生成至少一条 `expense_items`。
6. 如果 `raw_form_data` 可解析表格，则拆成多条明细行。
7. 迁移附件。
8. 迁移收入。
9. 迁移银行流水。
10. 转换旧 `transaction_links` 到新 `match_relations`。
11. 校验金额总账。

### 10.3 迁移校验

必须校验：

- 门店数量。
- 报销单数量。
- 附件数量。
- 收入金额合计。
- 流水金额合计。
- 已匹配金额合计。
- 每月每店报表金额与旧系统一致或差异可解释。

迁移脚本必须可重复执行。

## 11. 开发里程碑

### M1 项目基础

- 技术栈确定。
- 数据库 schema 初版。
- 登录。
- 基础布局。
- 操作日志基础能力。

### M2 门店账套

- 门店管理。
- 账套列表。
- 账套首页。
- 封账/重开。
- 写入守卫。

### M3 钉钉集成

- 凭证配置。
- 测试连接。
- 模板同步。
- 字段映射。
- 审批同步。
- 附件下载。

### M4 支出明细

- 审批单列表。
- 明细行生成。
- 归属账期调整。
- 分类。
- 供应商关联。
- 手动支出。

### M5 银行流水

- 文件上传。
- 列映射。
- 预览校验。
- 去重。
- 批次导入。
- 流水列表编辑。

### M6 营业收入

- 渠道管理。
- 逐日录入。
- Excel 粘贴。
- 手续费计算。
- 对账状态。

### M7 匹配工作台

- 候选推荐。
- 明细行匹配。
- 收入范围匹配。
- 分摊。
- 尾差。
- 拒绝匹配。
- 解除关联。

### M8 报表

- 收支明细。
- 利润汇总。
- 分类汇总。
- 导出。

### M9 历史迁移

- 旧 SQLite 迁移。
- 附件迁移。
- 迁移校验。

### M10 小程序与权限

- 角色权限。
- 股东账号。
- 小程序只读报表。
- 门店授权。

## 12. 立即建议

开发前先完成三件事：

1. 确认会计口径：权责发生制、跨月付款匹配、尾差、手续费。
2. 确认新版数据模型，尤其是 `expense_items` 和 `match_relations`。
3. 从旧系统抽取钉钉同步和解析模块，做成后端服务内的适配层。

第一版不要优先做视觉复杂度，应优先跑通“一个门店一个月”的闭环：

```text
钉钉同步 → 明细行分类/归属 → 银行流水导入 → 收入录入 → 匹配确认 → 封账 → 报表
```

这个闭环跑通后，再扩展报表、小程序和权限系统。
