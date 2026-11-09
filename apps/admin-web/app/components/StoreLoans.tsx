"use client";
import { Alert, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Select, Table, message } from "antd";
import { useEffect, useState } from "react";
import type { BankTransaction } from "@fin-hub/shared-types";
import dayjs from "dayjs";
import { apiClient } from "../lib/api";
import { RecordImages } from "./RecordImages";
type Event = { active: boolean; id: string; kind: string; date: string; amount: string; remark: string; bank_transaction_id: string };
type Loan = { id: string; borrower: string; reason: string; amount: string; repaid: string; remaining: string; status: string; events: Event[] };
export function StoreLoans({ storeId, onChanged }: { storeId?: string; onChanged: () => Promise<void> }) {
  const [rows, setRows] = useState<Loan[]>([]), [open, setOpen] = useState(false), [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<Event | null>(null), [revokeReason, setRevokeReason] = useState("");
  const [repaying, setRepaying] = useState<Loan | null>(null), [receipt, setReceipt] = useState<string | null>(null);
  const [banks, setBanks] = useState<BankTransaction[]>([]);
  const [requestKey, setRequestKey] = useState(""); const [form] = Form.useForm();
  const reload = async () => { if (storeId) setRows(await apiClient.request<Loan[]>(`/api/store-loans?store_id=${encodeURIComponent(storeId)}`)); };
  useEffect(() => { let active = true; setRows([]); if (storeId) apiClient.request<Loan[]>(`/api/store-loans?store_id=${encodeURIComponent(storeId)}`).then(data => { if (active) setRows(data); }).catch(e => { if (active) message.error(e.message); }); return () => { active = false; }; }, [storeId]);
  if (!storeId) return null;
  const start = (loan: Loan | null) => { setRepaying(loan); setRequestKey(crypto.randomUUID()); form.resetFields(); form.setFieldsValue({ occurred_on: dayjs() }); setOpen(true); setBanks([]); apiClient.bankTransactions.list(`?store_id=${encodeURIComponent(storeId)}&direction=${loan ? "income" : "expense"}&page_size=100`).then(page => setBanks(page.items.filter(b => b.payment_status === "paid" && !b.direct_posting_type && (!b.special_type || b.special_type === "loan_repayment") && Number(b.matched_amount || 0) === 0))).catch(e => message.error(e.message)); };
  return <Card title="借出与还款登记" extra={<Button onClick={() => start(null)}>登记借出</Button>}>
    <Table rowKey="id" size="small" dataSource={rows} columns={[
      { title: "借款人", dataIndex: "borrower" }, { title: "原因", dataIndex: "reason" }, { title: "借出本金", dataIndex: "amount" },
      { title: "已归还", dataIndex: "repaid" }, { title: "未还本金", dataIndex: "remaining" }, { title: "状态", dataIndex: "status" },
      { title: "操作", render: (_, loan) => <Button disabled={Number(loan.remaining) <= 0} onClick={() => start(loan)}>登记还款</Button> }
    ]} expandable={{ expandedRowRender: loan => <Table rowKey="id" pagination={false} dataSource={loan.events} columns={[
      { title: "类型", render: (_, event) => event.kind === "lend" ? "借出" : "还款" }, { title: "日期", dataIndex: "date" }, { title: "金额", dataIndex: "amount" }, { title: "说明", dataIndex: "remark" },
      { title: "付款凭证", render: (_, event) => <Button onClick={() => setReceipt(event.id)}>查看 / 上传</Button> },
      { title: "状态 / 操作", render: (_, event) => event.active ? <Button danger onClick={() => { setRevoking(event); setRevokeReason(""); }}>撤销登记</Button> : "已撤销" }
    ]} /> }} />
    <Modal title={repaying ? `登记还款 · ${repaying.borrower}` : "登记借出"} open={open} onCancel={() => setOpen(false)} confirmLoading={busy} onOk={async () => {
      try { const v = await form.validateFields(); setBusy(true); const payload = { ...v, occurred_on: v.occurred_on.format("YYYY-MM-DD"), amount: String(v.amount), bank_transaction_id: v.bank_transaction_id?.trim() || null, request_key: requestKey, ...(!repaying ? { store_id: storeId } : {}) };
        const result = await apiClient.request<{ event_id: string }>(repaying ? `/api/store-loans/${repaying.id}/repayments` : "/api/store-loans", { method: "POST", body: JSON.stringify(payload) });
        setOpen(false); setReceipt(result.event_id); await Promise.all([reload(), onChanged()]); message.success("登记成功");
      } catch (e) { if (e instanceof Error) message.error(e.message); } finally { setBusy(false); }
    }}>
      <Alert type="info" showIcon message="本金不计入经营利润。未选择已有流水时，保存会新增一笔实际收付款流水。" />
      <Form name="store-loan-movement" form={form} layout="vertical">
        {!repaying && <Form.Item name="borrower" label="借款人" rules={[{ required: true, whitespace: true }]}><Input maxLength={120} /></Form.Item>}
        <Form.Item name="occurred_on" label="实际发生日期" rules={[{ required: true }]}><DatePicker disabledDate={d => d.isAfter(dayjs(), "day")} /></Form.Item>
        <Form.Item name="amount" label="本金金额" rules={[{ required: true }]}><InputNumber style={{ width: "100%" }} min={0.01} max={repaying ? Number(repaying.remaining) : undefined} precision={2} /></Form.Item>
        <Form.Item name="bank_transaction_id" label="关联已有流水（可选；留空则新增流水）"><Select allowClear showSearch optionFilterProp="label" options={banks.map(bank => ({ value: bank.id, label: `${bank.occurred_at.slice(0,10)} · ${bank.counterparty_name || "无对方户名"} · ¥${bank.amount} · ${bank.summary || ""}` }))} onChange={id => { const bank = banks.find(b => b.id === id); if (bank) form.setFieldsValue({ occurred_on: dayjs(bank.occurred_at), amount: Number(bank.amount) }); }} /></Form.Item>
        <Form.Item name="remark" label="原因 / 说明" rules={[{ required: true, whitespace: true }]}><Input.TextArea maxLength={2000} /></Form.Item>
      </Form>
    </Modal>
    <Modal title="撤销借还款登记" open={!!revoking} confirmLoading={busy} onCancel={() => !busy && setRevoking(null)} onOk={async () => {
      if (!revoking || !revokeReason.trim()) { message.error("请填写撤销原因"); return; }
      try { setBusy(true); await apiClient.request(`/api/store-loans/events/${revoking.id}/revoke`, { method: "POST", body: JSON.stringify({ reason: revokeReason }) }); setRevoking(null); await Promise.all([reload(), onChanged()]); } catch(e) { message.error(e instanceof Error ? e.message : "撤销失败"); } finally { setBusy(false); }
    }}><Alert type="warning" message="撤销会重新计算未还本金；登记时自动新增的流水同步作废，关联的已有流水保留并恢复原属性。" /><Input.TextArea value={revokeReason} onChange={e => setRevokeReason(e.target.value)} placeholder="必填：撤销原因" /></Modal>
    <Modal title="付款 / 还款图片凭证" open={!!receipt} footer={null} onCancel={() => setReceipt(null)}>{receipt && <RecordImages resourceType="loan_event" resourceId={receipt} />}</Modal>
  </Card>;
}
