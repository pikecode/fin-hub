# 银行流水功能增强修改总结

## 修改背景

本次围绕银行流水录入、编辑、筛选和对账范围进行了完善，支持付款状态、流水属性、月份筛选和发生日期筛选，并明确往来款与股东分红的处理规则。

## 付款情况

银行流水新增和批量录入支持付款情况：

- 已实付
- 未实付

默认值为“已实付”。已匹配流水仍允许编辑付款状态，方便审批单已经提交但实际尚未付款的场景。账套封账后，银行流水不允许编辑。

## 流水属性

新增和编辑银行流水支持两个互斥属性：

- 往来款
- 股东分红

默认两个属性都不选。用户选择任一属性后，保存前会弹窗确认，并提示该流水不会进入审批单对账或收入对账。

后端使用 `special_type` 字段保存属性：

```text
null                    普通流水
current_account         往来款
shareholder_dividend    股东分红
```

流水属性不改变银行流水金额，只影响匹配范围和匹配状态展示。

## 匹配状态

往来款和股东分红不创建实际匹配记录，但在银行流水列表中默认视为“已匹配”，避免进入待匹配队列。

- 未匹配筛选不展示往来款和股东分红
- 已匹配筛选包含往来款和股东分红
- 审批单对账过滤特殊流水
- 收入对账过滤特殊流水
- 自动匹配接口过滤特殊流水
- 后端匹配接口拒绝特殊流水，避免绕过页面直接匹配

## 银行流水筛选

银行流水列表支持按以下条件查询：

- 账期月份
- 发生日期范围
- 收入或支出类型
- 流水属性：普通流水、往来款、股东分红
- 匹配状态
- 对方户名
- 对方账号

账期月份默认使用 URL 中的 `ledger_period`，没有传入时使用当前月份；用户可以切换到其他月份。发生日期筛选使用独立的日期范围，不要求发生日期和账期月份相同。

## 月度累计金额

列表顶部显示当前筛选结果的累计金额：

- 本月收入累计
- 本月支出累计

累计金额基于当前月份、发生日期和其他筛选条件过滤后的流水计算。

## 数据库调整

在 `bank_transactions` 表新增：

```text
special_type VARCHAR(32) NULL
```

迁移版本：

```text
20260913_0025
```

已有流水默认为普通流水，即 `special_type = NULL`。付款状态字段使用此前的 `payment_status`，默认值为 `paid`。

## 主要修改文件

- `apps/api/app/models.py`
  - 增加银行流水特殊属性模型字段。
- `apps/api/app/schemas.py`
  - 增加特殊属性请求和返回字段。
- `apps/api/app/modules/bank/router.py`
  - 支持特殊属性筛选、发生日期筛选和匹配状态处理。
- `apps/api/app/modules/matching/router.py`
  - 排除并拒绝特殊流水匹配。
- `apps/admin-web/app/bank/page.tsx`
  - 增加月份、日期范围、流水属性筛选和累计金额展示。
  - 增加特殊属性确认弹窗。
- `apps/admin-web/app/finance/reconciliation/page.tsx`
  - 审批单对账过滤特殊流水。
- `apps/admin-web/app/finance/revenue-reconciliation/page.tsx`
  - 收入对账过滤特殊流水。
- `apps/admin-web/app/components/BankTransactionColumns.tsx`
  - 展示流水属性和特殊流水的匹配状态。
- `apps/api/alembic/versions/20260913_0025_bank_transaction_special_type.py`
  - 新增数据库字段及索引。

## 验证结果

执行银行流水相关测试：

```bash
apps/api/.venv/bin/pytest apps/api/tests/test_bank_import.py
```

结果：

```text
18 passed
```

前端类型检查和 `git diff --check` 均已通过。
