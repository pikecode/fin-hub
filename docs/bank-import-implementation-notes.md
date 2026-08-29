# 银行流水导入与维护实现说明

生成时间：2026-08-29

## 1. 本阶段目标

本阶段实现银行流水导入与维护闭环：

- 后台上传 CSV / XLSX。
- API 预览 CSV / XLSX，提前识别可导入、重复和错误行。
- API 解析 CSV / XLSX。
- 写入银行流水。
- 重复流水跳过。
- 使用 `sync_jobs` 记录导入任务。
- 支持后台编辑已导入或手工新增的银行流水。

当前支持 `.csv`、`.xlsx`、`.xlsm`。

## 2. API

接口：

- `POST /api/bank-transactions/import/preview`
- `POST /api/bank-transactions/import`
- `POST /api/bank-transactions/import-csv`
- `PATCH /api/bank-transactions/{transaction_id}`

`import-csv` 为兼容旧前端保留，新开发优先使用 `import`。

`import/preview` 用于导入前校验：

- 不写入银行流水。
- 不创建 `sync_jobs`。
- 返回前 20 条有效预览行。
- 返回全部行级错误。
- 标记已存在重复流水。
- 使用与正式导入相同的解析规则。

编辑字段：

- `occurred_at`
- `direction`
- `amount`
- `counterparty_name`
- `counterparty_account`
- `summary`
- `bank_serial_no`

编辑约束：

- 所属账套已封账时拒绝编辑。
- 金额不能低于该流水已匹配金额。
- 修改后的非空流水号不能与其他银行流水重复。

表单字段：

- `store_id`
- `ledger_period`
- `started_by`
- `file`

支持文件：

- `.csv`
- `.xlsx`
- `.xlsm`

支持表头：

- 时间：`occurred_at`、`发生时间`、`交易时间`、`日期`
- 方向：`direction`、`方向`、`收支方向`
- 金额：`amount`、`金额`、`交易金额`
- 对方户名：`counterparty_name`、`对方户名`、`交易对方`
- 对方账号：`counterparty_account`、`对方账号`
- 摘要：`summary`、`摘要`、`备注`
- 流水号：`bank_serial_no`、`流水号`、`交易流水号`

## 3. 去重规则

优先按 `bank_serial_no` 判断重复。

没有流水号时，按以下组合判断：

- 门店
- 账期
- 发生时间
- 方向
- 金额
- 对方户名

## 4. 后台页面

页面：

- `/bank`

新增能力：

- 选择打开状态账套。
- 手工新增银行流水。
- 编辑银行流水基础信息。
- 选择 CSV / XLSX 文件。
- 预览导入结果。
- 上传导入。
- 显示导入条数和跳过重复条数。
- 显示行级错误明细。

## 5. 行级错误

导入返回 `row_errors`：

```json
[
  {
    "row_number": 3,
    "message": "Unsupported direction: 错误方向"
  }
]
```

存在错误行时：

- 有效行仍会导入。
- `sync_jobs.status` 标记为 `failed`。
- `sync_jobs.error_message` 保存前 5 条错误摘要。
- 后台页面显示错误行号和原因。

## 6. 下一步

1. 增加导入预览和字段映射。
2. 增加导入批次回滚。
3. 把银行流水导入任务从 `sync_jobs` 抽象为统一任务中心页面。
