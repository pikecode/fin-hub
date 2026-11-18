import { Table, Typography } from "antd";
import type { BankTransactionDuplicateCheckResult } from "@fin-hub/shared-types";

type Detail = NonNullable<BankTransactionDuplicateCheckResult["duplicate_details"]>[number];
export interface DuplicateRow {
  row_number: number;
  occurred_at: string;
  direction: string;
  amount: string;
  counterparty_name?: string | null;
  summary?: string | null;
  detail?: Detail;
}
export function DuplicateDetails({ message, rows, rowNumbers }: { message: string; rows: DuplicateRow[]; rowNumbers?: number[] }) {
  return <><Typography.Paragraph>{message}</Typography.Paragraph><Table<DuplicateRow>
    size="small" rowKey="row_number" dataSource={rows} scroll={{ x: 950, y: 360 }} pagination={{ defaultPageSize: 10 }}
    columns={[
      { title: "录入行号", dataIndex: "row_number", width: 85 },
      { title: "日期", dataIndex: "occurred_at", width: 110, render: value => value.slice(0, 10) },
      { title: "对方户名", dataIndex: "counterparty_name", width: 140 },
      { title: "收支", dataIndex: "direction", width: 65, render: value => value === "income" ? "收入" : "支出" },
      { title: "金额", dataIndex: "amount", width: 100 },
      { title: "备注", dataIndex: "summary", width: 180 },
      { title: "重复来源", width: 290, render: (_, row) => <>
        {row.detail?.existing_records.map(record => <div key={record.id}>
          {record.is_archived ? "已归档记录" : <a href={`/bank?store_id=${record.store_id}&transaction_id=${record.id}`} target="_blank" rel="noopener noreferrer">查看已有流水</a>}
          {`：${record.occurred_at.slice(0, 10)} · ${record.direction === "income" ? "收入" : "支出"} ${record.amount} · ${record.summary || "无备注"}`}
          <div>流水号：{record.bank_serial_no || "无"} · 记录ID：{record.id}</div>
        </div>)}
        {row.detail?.earlier_indices.length ? <div>与本批第 {row.detail.earlier_indices.map(index => rowNumbers?.[index] ?? index + 1).join("、")} 行重复</div> : null}
        {!row.detail ? "与已有流水或本批其他行重复" : null}
      </> },
    ]} /><Typography.Text type="secondary">请核对后再选择是否继续导入。此处仅展示疑似重复，不会自动删除或跳过。</Typography.Text></>;
}
