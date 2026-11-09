"use client";
import { Alert, Button, Cascader, DatePicker, Form, Input, InputNumber, Modal, Space, Typography } from "antd";
import dayjs from "dayjs";
import { useRef, useState } from "react";
import { apiClient } from "../lib/api";
import { RecordImages } from "./RecordImages";
interface Line { id: string; category_l1: string; category_l2: string; amount: string; remark: string }
export function AccrualDocumentEditor({ storeId, period, options, onChanged }: { storeId: string; period: string; options: { value: string; label: string; children: { value: string; label: string }[] }[]; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [saved, setSaved] = useState<{ id: string; amount: string; lines: Line[] } | null>(null);
  const [form] = Form.useForm(); const key = useRef("");
  return <><Button type="primary" onClick={() => { key.current = crypto.randomUUID(); setSaved(null); setError(""); form.resetFields(); form.setFieldsValue({ month: dayjs(period), lines: [{}] }); setOpen(true); }}>新增计提单（多明细）</Button>
    <Modal title="多明细计提单" width={850} open={open} confirmLoading={busy} okText={saved ? "完成" : "保存计提单"} onCancel={() => !busy && setOpen(false)} onOk={async () => {
      if (saved) { setOpen(false); return; }
      try { const values = await form.validateFields(); setBusy(true); setError("");
        const result = await apiClient.request<{ id: string; amount: string; lines: Line[] }>("/api/accruals/documents", { method: "POST", body: JSON.stringify({ store_id: storeId, period: values.month.format("YYYY-MM"), remark: values.remark, request_key: key.current, lines: values.lines.map((l: { category: string[]; amount: string; remark: string }) => ({ category_l1: l.category[0], category_l2: l.category[1], amount: String(l.amount), remark: l.remark })) }) });
        setSaved(result); await onChanged();
      } catch (e) { setError(e instanceof Error ? e.message : "请检查表单"); } finally { setBusy(false); }
    }}>
      {error && <Alert type="error" message={error} />}
      {saved ? <><Alert type="success" message={`计提单已保存，合计 ${saved.amount} 元。可为各费用行上传图片凭证。`} />{saved.lines.map(line => <div key={line.id} style={{ marginTop: 20 }}><Typography.Paragraph>{line.category_l1} / {line.category_l2} · {line.remark} · {line.amount} 元</Typography.Paragraph><RecordImages resourceType="expense_item" resourceId={line.id} /></div>)}</> : <Form name="accrual-document" form={form} layout="vertical">
        <Form.Item name="month" label="入账月份（须为已创建的开放账期）" rules={[{ required: true }]}><DatePicker picker="month" /></Form.Item>
        <Form.Item name="remark" label="计提单说明" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
        <Form.List name="lines" rules={[{ validator: async (_, rows) => { if (!rows?.length) throw new Error("至少一条费用"); } }]}>{(fields, { add, remove }, { errors }) => <>{fields.map(field => <Space key={field.key} align="start" wrap>
          <Form.Item name={[field.name, "category"]} label="二级分类" rules={[{ required: true }]}><Cascader options={options} style={{ width: 250 }} /></Form.Item>
          <Form.Item name={[field.name, "amount"]} label="金额" rules={[{ required: true }]}><InputNumber stringMode min="0.01" precision={2} /></Form.Item>
          <Form.Item name={[field.name, "remark"]} label="费用说明" rules={[{ required: true, whitespace: true }]}><Input /></Form.Item><Button onClick={() => remove(field.name)}>移除</Button>
        </Space>)}<Form.ErrorList errors={errors} /><Button onClick={() => add()}>添加费用行</Button></>}</Form.List>
      </Form>}
    </Modal></>;
}
