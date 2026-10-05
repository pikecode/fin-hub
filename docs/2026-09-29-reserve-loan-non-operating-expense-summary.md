# 备用金/借款非经营支出口径调整总结

日期：2026-09-29

## 背景

费用分类中已有 `门店预充值` 分类，该分类用于记录预充值类资金流转，不属于门店真实经营支出，因此在门店总览、财务报表和利润计算中需要排除。

本次新增同类口径：`备用金/借款` 也属于资金往来或借款性质，不应计入经营支出，不应影响毛利、净利润和支出分类统计。

## 调整后的统计口径

以下分类按“非经营支出”处理：

- 一级分类：`门店预充值`
- 一级分类：`备用金/借款`
- 历史兼容：一级分类 `食材成本` 且二级分类 `快驴充值`

这些分类可以正常录入、匹配、保留业务记录，但不进入经营报表口径。

## 影响范围

### 门店总览 / 账套统计

页面示例：

- `/store-ledgers/{store_id}?period=YYYY-MM`

影响指标：

- 本期支出
- 食材成本
- 毛利 / 毛利率
- 净利润 / 净利润率
- 支出分类统计

`备用金/借款` 与 `门店预充值` 一样，会从上述指标中排除。

### 财务报表

页面示例：

- `/reports`
- `/store-ledgers/{store_id}/report?period=YYYY-MM`

影响内容：

- 报表总支出
- 分类支出统计
- 各类别支出占比
- 费用明细列表
- 待支付费用数量统计

`备用金/借款` 不显示在经营支出分类统计和费用明细中。

### 审批单 / 银行流水业务记录

本次调整不删除原始数据，也不限制录入和匹配：

- 审批单仍可选择 `备用金/借款`
- 银行流水仍可匹配相关审批单
- 原始业务记录仍保留
- 只是在经营统计和财务报表中不作为支出参与计算

## 技术实现

新增统一分类判断模块：

- `apps/api/app/modules/expense_classification.py`

核心口径：

```python
FOOD_COST_CATEGORY_L1 = "食材成本"
PREPAID_FOOD_COST_CATEGORY_L2 = "快驴充值"
STORE_PREPAID_CATEGORY_L1 = "门店预充值"
RESERVE_FUND_LOAN_CATEGORY_L1 = "备用金/借款"
NON_OPERATING_EXPENSE_CATEGORY_L1 = {STORE_PREPAID_CATEGORY_L1, RESERVE_FUND_LOAN_CATEGORY_L1}
```

并提供统一判断：

```python
def is_non_operating_expense(category_l1, category_l2=None):
    ...
```

### 修改文件

- `apps/api/app/modules/store_ledgers/router.py`
  - 门店总览和账套利润计算改用统一的非经营支出判断。
- `apps/api/app/modules/reports/router.py`
  - 财务报表、分类统计、费用明细改用统一的非经营支出判断。
- `apps/api/tests/test_store_ledgers.py`
  - 补充 `备用金/借款` 的排除测试。

## 验证结果

已执行专项测试：

```bash
cd apps/api
.venv/bin/pytest tests/test_store_ledgers.py::test_store_ledger_workspace_excludes_prepaid_kuailv_food_cost
```

结果：通过。

已执行变更文件语法和基础检查：

```bash
cd apps/api
.venv/bin/python -m py_compile app/modules/expense_classification.py app/modules/store_ledgers/router.py app/modules/reports/router.py
.venv/bin/ruff check app/modules/expense_classification.py app/modules/store_ledgers/router.py app/modules/reports/router.py --select F,E9,I
```

结果：通过。

## 提交记录

本次实现已提交：

```text
d0fac09 fix: exclude reserve loans from operating expense reports
```
