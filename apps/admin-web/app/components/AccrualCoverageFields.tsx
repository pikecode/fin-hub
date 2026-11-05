"use client";
import { Alert, Checkbox, Form, Input, InputNumber, Select } from "antd";
import { useEffect, useState } from "react";
import { apiClient } from "../lib/api";

export function AccrualCoverageFields({ storeId }: { storeId: string }) {
  const enabled = Form.useWatch("accrual_enabled");
  const [rows, setRows] = useState<{ id: string; period: string; remark: string; entry_type: string; amount: string }[]>([]);
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true; setLoading(true); setError(undefined);
    void apiClient.request<typeof rows>(`/api/accruals?store_id=${encodeURIComponent(storeId)}`).then(result => { if (active) setRows(result.filter(row => row.entry_type === "accrual")); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [storeId, enabled]);
  return <>
    <Form.Item name="accrual_enabled" valuePropName="checked"><Checkbox>关联已有计提（已覆盖部分不重复计入费用）</Checkbox></Form.Item>
    {enabled ? <>
      <Alert showIcon type="info" message="填写审批单的本次覆盖额；原计提月份不变，未覆盖部分仍正常入账。差额需要另行补提或冲销。" />
      {error ? <Alert type="error" message={error} /> : null}
      <Form.Item name="accrual_original_id" label="原计提" rules={[{ required: true }, { validator: () => loading || error ? Promise.reject(new Error("计提加载未完成，请重试")) : Promise.resolve() }]}><Select loading={loading} disabled={loading || !!error} showSearch optionFilterProp="label" options={rows.map(row => ({ value: row.id, label: `${row.period} · ${row.remark} · ${row.amount}` }))} /></Form.Item>
      <Form.Item name="accrual_amount" label="本次覆盖金额" rules={[{ required: true }]}><InputNumber stringMode min="0.01" precision={2} /></Form.Item>
      <Form.Item name="accrual_remark" label="关联原因" rules={[{ required: true, whitespace: true }]}><Input.TextArea maxLength={2000} /></Form.Item>
      <Form.Item name="accrual_confirm_category_difference" valuePropName="checked"><Checkbox>分类不同时，确认覆盖部分保留原计提分类</Checkbox></Form.Item>
    </> : null}
  </>;
}
