import type { ColumnType } from "antd/es/table";
import type { BankTransaction } from "@fin-hub/shared-types";
import { MoneyDisplay } from "./MoneyDisplay";
import { StatusBadge } from "./StatusBadge";

export type BankTransactionViewColumn = ColumnType<BankTransaction> & { key: string };

export function getBankTransactionViewColumns(): BankTransactionViewColumn[] {
  return [
    {
      key: "occurred_at",
      title: "发生时间",
      dataIndex: "occurred_at",
      width: 160,
      render: (value: string) => value?.replace("T", " ").slice(0, 16) || "-",
    },
    {
      key: "direction",
      title: "类型",
      dataIndex: "direction",
      width: 80,
      render: (value: "income" | "expense") => (
        <StatusBadge status={value === "income" ? "income" : "expense"} text={value === "income" ? "收入" : "支出"} />
      ),
    },
    {
      key: "amount",
      title: "金额",
      dataIndex: "amount",
      width: 120,
      align: "right",
      render: (value, record) => <MoneyDisplay value={value} colorize={record.direction === "income"} />,
      sorter: (left, right) => Number(left.amount) - Number(right.amount),
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
