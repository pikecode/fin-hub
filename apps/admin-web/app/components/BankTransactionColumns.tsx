import type { ColumnsType } from "antd/es/table";
import { Space, Tag, Tooltip } from "antd";
import type { BankTransaction } from "@fin-hub/shared-types";
import { MoneyDisplay } from "./MoneyDisplay";
import { StatusBadge } from "./StatusBadge";

export type BankTransactionViewColumn = ColumnsType<BankTransaction>[number] & { key: string };

function bankMatchStatus(transaction: BankTransaction) {
  if (transaction.payment_settlement_status === "open") return { label: "实付核对中", color: "warning" as const };
  if (transaction.payment_settlement_status === "completed" && Number(transaction.matched_amount || 0) === 0 && !transaction.special_type) return { label: "已核对/待对账", color: "processing" as const };
  if (transaction.direct_posting_type) return { label: "已直接入账", color: "success" as const };
  if (transaction.special_type) return { label: "已匹配", color: "success" as const };
  const matchedAmount = Number(transaction.matched_amount || 0);
  if (matchedAmount <= 0) return { label: "未匹配", color: "default" as const };
  return { label: "已匹配", color: "success" as const };
}

function bankDirectionCell(direction: "income" | "expense", target: "income" | "expense") {
  if (direction !== target) return "-";
  return <StatusBadge status={direction === "income" ? "income" : "expense"} text={direction === "income" ? "收入" : "支出"} size="small" />;
}

const bankPaymentStatusLabels: Record<string, { label: string; color: string }> = {
  paid: { label: "已实付", color: "success" },
  unpaid: { label: "未实付", color: "warning" },
  unreceived: { label: "未实收", color: "processing" },
};

const bankSpecialTypeLabels: Record<string, string> = {
  current_account: "往来款",
  shareholder_dividend: "股东分红",
  shareholder_capital: "股东注资",
  other_income_expense: "其他收支",
  counter_refund: "退款",
  loan_repayment: "借还款",
};

export function getBankTransactionViewColumns(): BankTransactionViewColumn[] {
  return [
    {
      key: "occurred_at",
      title: "发生日期",
      dataIndex: "occurred_at",
      width: 120,
      render: (value: string) => value?.slice(0, 10) || "-",
    },
    { key: "ledger_period", title: "所属账期", dataIndex: "ledger_period", width: 105 },
    { key: "accounting_periods", title: "入账月份", width: 190, render: (_, row) => {
      const periods = row.accounting_periods ?? (row.direct_posting_type ? [row.occurred_at.slice(0, 7)] : []);
      return <Tooltip title={row.direct_posting_type ? "直接入账按发生月份统计；银行流水列表不受账期限制" : "按已确认对账的入账月份展示，实付核对组以对账记录为准"}><Space wrap size={4}>{periods.length ? periods.map(period => <Tag key={period}>{period}</Tag>) : row.special_type ? "特殊流水" : Number(row.matched_amount || 0) > 0 ? "以对账记录为准" : "待对账"}</Space></Tooltip>;
    } },
    {
      key: "direction",
      title: "类型",
      children: [
        {
          key: "direction_income",
          title: "收入",
          dataIndex: "direction",
          width: 88,
          align: "center",
          render: (value: "income" | "expense") => bankDirectionCell(value, "income"),
        },
        {
          key: "direction_expense",
          title: "支出",
          dataIndex: "direction",
          width: 88,
          align: "center",
          render: (value: "income" | "expense") => bankDirectionCell(value, "expense"),
        },
      ],
    },
    {
      key: "counterparty_name",
      title: "对方户名",
      dataIndex: "counterparty_name",
      width: 160,
      ellipsis: true,
      render: (value: string | null | undefined) => value || "-",
    },
    {
      key: "counterparty_account",
      title: "对方账号",
      dataIndex: "counterparty_account",
      width: 160,
      ellipsis: true,
      render: (value: string | null | undefined) => value || "-",
    },
    {
      key: "amount",
      title: "金额",
      dataIndex: "amount",
      width: 120,
      align: "right",
      render: (value, record) => <MoneyDisplay value={Number(value)} colorize={record.direction === "income"} />,
      sorter: (left, right) => Number(left.amount) - Number(right.amount),
    },
    {
      key: "running_balance",
      title: "余额",
      dataIndex: "running_balance",
      width: 130,
      align: "right",
      render: (value: string | null | undefined) => value ? <MoneyDisplay value={Number(value)} /> : "-",
      sorter: (left, right) => Number(left.running_balance || 0) - Number(right.running_balance || 0),
    },
    {
      key: "payment_status",
      title: "付款情况",
      dataIndex: "payment_status",
      width: 96,
      render: (value: string | null | undefined) => {
        const status = bankPaymentStatusLabels[value || "paid"] ?? bankPaymentStatusLabels.paid;
        return <Tag color={status.color}>{status.label}</Tag>;
      },
    },
    {
      key: "direct_posting_type",
      title: "直接入账",
      dataIndex: "direct_posting_type",
      width: 130,
      render: (value: string | null) => value ? <Tag color="cyan">{({ bank_interest: "银行结息", other_income: "其他收入", bank_fee: "银行手续费", bank_sms_fee: "银行短信费", bank_other_expense: "银行其他支出" } as Record<string, string>)[value] || value}</Tag> : "—",
    },
    {
      key: "special_type",
      title: "流水属性",
      dataIndex: "special_type",
      width: 110,
      render: (value: string | null | undefined) =>
        value ? <Tag color="purple">{bankSpecialTypeLabels[value] ?? value}</Tag> : <Tag>普通</Tag>,
    },
    {
      key: "match_status",
      title: "匹配状态",
      width: 96,
      render: (_, record) => {
        const status = bankMatchStatus(record);
        return <Tag color={status.color}>{status.label}</Tag>;
      },
    },
    {
      key: "summary",
      title: "备注",
      dataIndex: "summary",
      ellipsis: true,
      render: (value: string | null | undefined) => value || "-",
    },
  ];
}
