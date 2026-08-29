# 后台管理第一阶段实现说明

生成时间：2026-08-28

## 1. 本阶段目标

本阶段把后台管理端从静态看板推进到可联调的业务入口。

已完成：

- 后台登录页和会话检查
- 页面壳和侧边导航
- 首页 API 数据加载
- 门店管理页面
- 门店账套页面
- 匹配工作台页面
- 营业收入页面
- 支出明细页面
- 银行流水页面
- 钉钉配置页面
- 系统设置页面

## 2. 页面清单

### 2.0 登录

路径：`/login`

数据来源：

- `POST /api/auth/login`

当前能力：

- 管理员账号密码登录。
- 登录成功后进入后台首页。
- 默认开发账号为 `admin / admin123456`。

### 2.1 首页仪表盘

路径：`/`

数据来源：

- `GET /api/stores`
- `GET /api/ledgers`
- `GET /api/expense-items`
- `GET /api/bank-transactions`
- `GET /api/matches`

当前能力：

- 汇总待匹配流水。
- 汇总未分类支出明细。
- 汇总缺供应商明细。
- 汇总打开状态账套。
- 展示门店账套列表。
- API 不可用时显示错误提示和空表格。

### 2.2 门店管理

路径：`/stores`

数据来源：

- `GET /api/stores`
- `POST /api/stores`

当前能力：

- 查看门店列表。
- 新增门店。
- 录入钉钉部门 ID、联系人、电话、地址。

### 2.3 门店账套

路径：`/ledgers`

数据来源：

- `GET /api/stores`
- `GET /api/ledgers`
- `POST /api/ledgers`
- `GET /api/ledgers/{ledger_id}/close-check`
- `POST /api/ledgers/{ledger_id}/close`
- `POST /api/ledgers/{ledger_id}/reopen`

当前能力：

- 查看账套列表。
- 新建门店月份账套。
- 封账前展示未完成事项阻断原因。
- 封账。
- 重开账套。

### 2.4 匹配工作台

路径：`/matching`

数据来源：

- `GET /api/stores`
- `GET /api/expense-items?payment_status=unpaid,partial_paid`
- `GET /api/bank-transactions?direction=expense`
- `GET /api/matches`
- `POST /api/matches`
- `POST /api/matches/auto-suggest`
- `POST /api/matches/{match_id}/confirm`
- `POST /api/matches/{match_id}/reject`

当前能力：

- 查看未付款和部分付款支出。
- 查看支出方向银行流水。
- 展示支出已确认金额、支出剩余待匹配金额和流水剩余可匹配金额。
- 查看候选、确认、拒绝状态的匹配记录。
- 自动生成候选匹配。
- 手工创建候选匹配。
- 确认候选匹配。
- 拒绝候选匹配。

业务约束：

- 候选匹配不会改变付款状态。
- 确认匹配后才会更新支出明细付款状态和银行流水已匹配金额。
- 已拒绝的匹配不能再确认。
- 已确认的匹配不能再拒绝。
- 跨门店、跨账期不能创建匹配。
- 支出匹配只能使用支出方向银行流水。
- 支持多笔流水匹配一条支出，也支持一笔流水拆分匹配多条支出；超出支出剩余金额或流水剩余金额会被接口拒绝。
- “收入匹配”标签页展示收入流水、收入记录和收入匹配记录。
- 收入候选匹配按渠道、收入日期范围和实收金额合计创建。
- 确认收入匹配后更新收入流水已匹配金额。

后续补充：

- 多笔流水匹配一条支出或一笔流水拆分匹配多条支出。

### 2.5 营业收入

路径：`/revenue`

数据来源：

- `GET /api/stores`
- `GET /api/ledgers`
- `GET /api/revenue-channels`
- `GET /api/revenue-records`
- `POST /api/revenue-records`
- `PATCH /api/revenue-records/{record_id}`

当前能力：

- 查看营业收入记录。
- 按门店、账期、渠道筛选。
- 基于打开状态账套新增收入。
- 收入渠道从启用渠道主数据下拉选择。
- 编辑收入日期、渠道、经营收入、实收金额、手续费和备注。
- 封账账套不允许新增或编辑收入，约束由 API 执行。

### 2.6 收入渠道

路径：`/revenue-channels`

数据来源：

- `GET /api/revenue-channels`
- `POST /api/revenue-channels`
- `PATCH /api/revenue-channels/{channel_id}`

当前能力：

- 查看渠道名称、排序、是否需要匹配银行流水和启停状态。
- 新增、编辑收入渠道。
- 启用、停用收入渠道。
- 停用渠道不会再出现在收入录入下拉中，历史收入仍可筛选查看。

### 2.7 支出明细

路径：`/expenses`

数据来源：

- `GET /api/stores`
- `GET /api/ledgers`
- `GET /api/expense-items`
- `POST /api/expense-items`

当前能力：

- 查看支出明细列表。
- 按门店、账期、付款状态筛选支出明细。
- 基于打开状态账套新增手工支出。
- 录入日期、说明、金额、一级分类、供应商、收款账号。
- 封账账套不允许新增支出，约束由 API 执行。
- 通过“凭证”入口查看支出附件。
- 未封账支出可上传凭证，已归档凭证可下载。
- 钉钉同步占位凭证显示为待下载状态，可点击“归档”下载到本地文件存储。

### 2.8 银行流水

路径：`/bank`

数据来源：

- `GET /api/stores`
- `GET /api/ledgers`
- `GET /api/bank-transactions`
- `POST /api/bank-transactions`
- `PATCH /api/bank-transactions/{transaction_id}`
- `POST /api/bank-transactions/import/preview`
- `POST /api/bank-transactions/import`

当前能力：

- 查看银行流水列表。
- 按门店、账期、方向筛选银行流水。
- 基于打开状态账套新增手工流水。
- 编辑银行流水基础信息。
- 录入发生时间、方向、金额、对方户名、对方账号、流水号和摘要。
- 封账账套不允许新增流水，约束由 API 执行。
- 上传 CSV / XLSX 导入银行流水。
- 导入前预览可导入行、重复行和错误行。
- 显示导入条数、重复跳过条数和行级错误。

### 2.9 财务报表

路径：`/reports`

数据来源：

- `GET /api/stores`
- `GET /api/ledgers`
- `GET /api/reports/store-summaries`
- `GET /api/reports/store-comparison`
- `GET /api/reports/ledger-trends`
- `GET /api/reports/ledger-detail`
- `GET /api/reports/ledger-detail.csv`
- `GET /api/reports/ledger-detail.xlsx`

当前能力：

- 查看门店账套汇总。
- 按账套查看收入、支出、利润。
- 查看同账期门店收入、支出、利润横向对比和总计。
- 查看最近账期收入、支出和利润趋势。
- 查看营业收入明细、费用分类、供应商支出、待处理支出和未匹配流水。
- 导出账套 CSV 明细。
- 导出账套 Excel 多工作表明细。

### 2.10 股东授权

路径：`/shareholder-grants`

数据来源：

- `GET /api/shareholder-grants`
- `POST /api/shareholder-grants`
- `PATCH /api/shareholder-grants/{grant_id}`
- `GET /api/stores`

当前能力：

- 新增股东授权，设置授权码、可查看门店和到期日期。
- 编辑授权名称、授权码、门店范围和到期日期。
- 启用或停用授权。
- 列表展示授权门店、启停/过期状态、到期时间和最后使用时间。
- 到期授权不能登录，已签发 token 也会被服务端拒绝。

### 2.11 钉钉同步设置

路径：`/dingtalk`

数据来源：

- `GET /api/dingtalk/config`
- `PUT /api/dingtalk/config`
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

当前能力：

- 查看钉钉配置状态。
- 保存 Corp ID、App Key、App Secret、管理员 User ID、钉盘 Union ID。
- App Secret 不回显明文。
- 查看审批模板。
- 测试钉钉 OpenAPI 连接。
- 同步审批模板。
- 发起审批实例同步，可指定审批模板、同步时间窗口、每页数量和最大页数。
- 查看同步窗口、分页游标和错误信息。
- 对存在分页游标的失败同步任务点击“续跑”。
- 手工新增审批模板。
- 查看和维护字段映射。
- 字段映射来源字段支持从候选下拉选择，并自动回填字段 ID、字段路径和字段类型。

### 2.12 系统设置

路径：`/settings`

数据来源：

- `GET /api/health`
- `GET /api/dingtalk/config`
- `GET /api/system/readiness`
- `GET /api/system/database-backup/status`
- `GET /api/system/database-backup/download`

当前能力：

- 查看后台 API 地址和当前运行环境。
- 查看后端生产就绪状态和阻断项。
- 查看登录方式、股东访问方式。
- 查看钉钉 Corp ID、App Key、App Secret 配置状态。
- 查看管理员 User ID、钉盘 Union ID、同步状态。
- 查看数据库类型和备份能力。
- 下载 SQLite 数据库备份。
- 展示 API、数据库、密钥、跨域、文件存储、钉钉同步等交付检查项。
- 展示密钥和股东授权码的安全约定。

## 3. 前端结构

新增：

- `apps/admin-web/app/components/AppShell.tsx`
- `apps/admin-web/app/lib/api.ts`
- `apps/admin-web/app/stores/page.tsx`
- `apps/admin-web/app/ledgers/page.tsx`
- `apps/admin-web/app/matching/page.tsx`
- `apps/admin-web/app/revenue-channels/page.tsx`
- `apps/admin-web/app/revenue/page.tsx`
- `apps/admin-web/app/reports/page.tsx`
- `apps/admin-web/app/dingtalk/page.tsx`
- `apps/admin-web/app/settings/page.tsx`

共享 API client：

- `packages/shared-api-client`

共享类型：

- `packages/shared-types`

## 4. 下一步建议

已补充：

- API 容器迁移和 seed 启动链路。
- 小程序只读报表接口。
- 小程序门店和报表页面接入 API。

下一步建议：

1. 把门店、账套页面拆出可复用 hooks，例如 `useStores`、`useLedgers`。
2. 增加导入预览和字段映射。
3. 增加更细的对账推荐规则，例如日期窗口、供应商相似度和尾差提示。
