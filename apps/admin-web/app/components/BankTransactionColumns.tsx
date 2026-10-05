import type { ColumnsType } from "antd/es/table";
import { Tag } from "antd";
import type { BankTransaction } from "@fin-hub/shared-types";
import { MoneyDisplay } from "./MoneyDisplay";
import { StatusBadge } from "./StatusBadge";

export type BankTransactionViewColumn = ColumnsType<BankTransaction>[number] & { key: string };

function bankMatchStatus(transaction: BankTransaction) {
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
