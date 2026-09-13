# 2026-09-13 快驴采购录入开发设计记录

## 背景

门店账期对账需要补充“快驴采购录入”能力。快驴采购属于实际食材采购支出，应计入当前账期支出，并纳入毛利计算中的食材成本。

此前已明确另一个口径：`食材成本 / 快驴充值` 是预充值款，非实际支出，需要从本期支出和毛利计算中排除。本次新增的 `食材成本 / 快驴采购` 与 `快驴充值` 不同，属于实际采购，应计入支出和食材成本。

## 页面设计

入口位于门店账套工作区顶部导航，与 `审批单对账` 同级。

新增模块：`快驴采购录入`

访问路径复用对账页面，通过查询参数切换模块：

```text
/finance/reconciliation?store_id={store_id}&ledger_period={YYYY-MM}&module=kuailv
```

页面顶部展示：

- 当前门店
- 当前账期
- 账期状态
- 账期选择器
- 当月累计采购金额
- 采购记录数

录入表单字段：

- 采购日期
- 入账月份
- 采购金额
- 凭证上传
- 备注

采购日期与入账月份相互独立，可以录入任意日期。入账月份决定这笔费用进入哪个账期报表。

采购记录支持编辑和删除，编辑时可以调整采购日期、入账月份、采购金额和备注。

## 账期选择设计

快驴采购录入需要支持账期选择，行为对齐营业收入录入。

前端加载账期列表，生成账期选项，并把当前 URL 中的 `ledger_period` 加入选项，避免当前账期还没有账套时无法显示。

切换账期后：

- URL 中的 `ledger_period` 更新
- 顶部归属账期同步更新
- 新增记录时入账月份默认使用当前账期
- 快驴采购记录列表重新加载
- 总计采购金额重新统计

如果选择的账期还没有实际账套，后端在录入快驴采购时自动创建 open 账期。

如果账期已封账，后端禁止录入。

## 凭证上传设计

凭证支持多文件上传。

前端上传控件：

- 支持多选
- 不限制为图片或 PDF
- 支持图片、PDF、Office、表格、文本、压缩包等常见凭证文件
- 单个凭证文件大小不能超过 500KB

提交时先创建快驴采购支出记录，再把选择的凭证逐个上传到该支出记录下。

附件资源关系：

```text
resource_type = expense_item
resource_id = 快驴采购支出记录 ID
```

## 凭证查看交互

快驴采购记录列表中的凭证列已优化为统一查看入口。

列表展示：

- 未上传：显示 `未上传`
- 已上传：显示附件数量标签和 `查看` 按钮

点击 `查看` 后打开凭证弹窗，弹窗展示：

- 文件名
- 文件类型
- 图片缩略图
- 打开或下载操作

不同来源和格式的处理：

- 本地上传的图片、PDF：通过下载接口生成 Blob URL，在新窗口打开
- 本地上传的 Office、压缩包等文件：触发下载
- 钉钉来源附件：继续使用临时访问 URL 打开

## 报表归属

快驴采购金额按入账月份 `ledger_period` 自动计入对应账期的 `食材成本 / 快驴采购`，并参与本期支出、食材成本和毛利计算。采购日期仅作为业务记录日期，不决定报表归属。

## 后端数据设计

本次没有新增数据库表，复用 `expense_items` 作为快驴采购记录。

快驴采购支出记录字段约定：

```text
source = kuailv_purchase
category_l1 = 食材成本
category_l2 = 快驴采购
payment_status = no_bank_flow
ledger_period = 入账月份
expense_date = 采购日期
amount = 采购金额
remark = 备注
```

新增/确保费用分类：

- 一级分类：`食材成本`
- 二级分类：`快驴采购`

如果分类不存在，创建并启用；如果分类停用，自动恢复为启用。

## API 设计

新增快驴采购列表接口：

```http
GET /api/expense-items/kuailv-purchases?store_id={store_id}&ledger_period={YYYY-MM}
```

返回当前门店、当前账期的快驴采购记录，按采购日期和创建时间倒序排列。

新增快驴采购创建接口：

```http
POST /api/expense-items/kuailv-purchases
```

请求体：

```json
{
  "store_id": "...",
  "ledger_period": "2026-08",
  "purchase_date": "2026-08-15",
  "amount": "260.00",
  "remark": "可选备注"
}
```

创建逻辑：

1. 校验采购日期月份必须等于 `ledger_period`
2. 检查账期
   - 不存在则自动创建 open 账期
   - 已封账则拒绝录入
3. 确保 `食材成本 / 快驴采购` 分类存在且启用
4. 创建 `source = kuailv_purchase` 的 `expense_items` 记录
5. 写入审计日志

## 统计口径

门店账期工作区总览统计增加快驴采购金额。

快驴采购计入：

- 本期支出
- 食材成本
- 毛利计算
- 支出分类汇总

毛利计算：

```text
毛利 = 营业收入 - 食材成本
```

其中食材成本包含：

- 已确认审批单中的 `食材成本`，但排除 `食材成本 / 快驴充值`
- 手工录入的 `食材成本 / 快驴采购`

本期支出包含：

- 已确认审批单支出，排除 `食材成本 / 快驴充值`
- 营业收入手续费
- 快驴采购录入金额

## 前端共享类型与 API Client

新增共享类型：

- `KuailvPurchase`
- `KuailvPurchaseCreate`

新增 API Client：

```ts
apiClient.expenseItems.kuailvPurchases.list(params)
apiClient.expenseItems.kuailvPurchases.create(payload)
```

## 涉及文件

- `apps/admin-web/app/components/StoreLedgerWorkspaceNav.tsx`
- `apps/admin-web/app/finance/reconciliation/page.tsx`
- `apps/api/app/modules/expense/router.py`
- `apps/api/app/modules/store_ledgers/router.py`
- `apps/api/app/schemas.py`
- `apps/api/tests/test_store_ledgers.py`
- `packages/shared-api-client/src/index.ts`
- `packages/shared-types/src/index.ts`

## 验证记录

已执行并通过：

```bash
pnpm --filter @fin-hub/admin-web typecheck
pnpm lint
apps/api/.venv/bin/pytest apps/api/tests/test_store_ledgers.py
git diff --check
```

后端测试结果：

```text
10 passed, 1 warning
```

## 注意事项

- 快驴采购录入属于实际采购支出，分类为 `食材成本 / 快驴采购`。
- `食材成本 / 快驴充值` 仍按预充值处理，不计入本期支出，也不计入毛利中的食材成本。
- 快驴采购记录目前复用 `expense_items`，后续如果需要独立审批、编辑、删除、批量导入或更复杂的凭证管理，可以再扩展独立业务表或增加专用操作接口。
