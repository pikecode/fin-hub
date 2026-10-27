"use client";
import { Alert, Button, DatePicker, Form, Input, InputNumber, Space, Switch, Typography } from "antd";
import zhCN from "antd/locale/zh_CN";
import type { Dayjs } from "dayjs";
import { formatMoney } from "@fin-hub/shared-utils";

export interface AccountingFormValues {
  accounting_month?: Dayjs;
  multi_accounting?: boolean;
  accounting_version?: number;
  accounting_allocations?: { month?: Dayjs; amount?: string | null }[];
}

export function accountingPayload(values: AccountingFormValues, approvalTotal: string, configured: boolean) {
  if (values.multi_accounting) return { accounting_allocations: (values.accounting_allocations || []).map((row) => ({ period: row.month!.format("YYYY-MM"), amount: String(row.amount) })), accounting_version: values.accounting_version ?? 0 };
  if (configured) return { accounting_allocations: [{ period: values.accounting_month!.format("YYYY-MM"), amount: approvalTotal }], accounting_version: values.accounting_version ?? 0 };
  return {};
}

export function ApprovalAccountingFields({ approvalTotal, allowMultiple, configured, disabled }: { approvalTotal: string; allowMultiple: boolean; configured: boolean; disabled?: boolean }) {
  const form = Form.useFormInstance();
  const multiple = Form.useWatch("multi_accounting", form);
  const rows: AccountingFormValues['accounting_allocations'] = Form.useWatch("accounting_allocations", form);
  const total = (rows || []).reduce((sum, row) => sum + Math.round(Number(row.amount || 0) * 100), 0);
  const expected = Math.round(Number(approvalTotal || 0) * 100);
  return <div className="approval-accounting-fields">
    <Form.Item name="accounting_version" hidden><Input /></Form.Item>
    <Form.Item name="multi_accounting" label="分多个账期入账" valuePropName="checked">
      <Switch disabled={disabled || !allowMultiple} checkedChildren="已开启" unCheckedChildren="单账期" onChange={(checked) => {
        if (checked && (rows?.length || 0) < 2) form.setFieldValue('accounting_allocations', [{ month: form.getFieldValue('accounting_month') }, {}]);
        if (!checked && !form.getFieldValue('accounting_month')) form.setFieldValue('accounting_month', rows?.[0]?.month);
      }} />
    </Form.Item>
    {configured ? <Alert showIcon type="info" message="这是整个审批单的入账方案。修改会同步影响该审批单所有已匹配流水和相应月份报表。" style={{ marginBottom: 12 }} /> : null}
    {multiple ? <>
      <Typography.Paragraph type="secondary">按审批单总额 {formatMoney(approvalTotal)} 分配，各月合计必须一致；银行实际匹配金额不受影响。</Typography.Paragraph>
      <Form.List name="accounting_allocations" rules={[{ validator: async (_, values: AccountingFormValues['accounting_allocations']) => {
        if (!values || values.length < 2) throw new Error('多账期入账至少需要两个月份');
        const periods=values.map((row) => row.month?.format('YYYY-MM')).filter(Boolean);
        if (new Set(periods).size !== periods.length) throw new Error('入账月份不能重复');
        if (values.every((row) => row.amount != null) && values.reduce((sum,row) => sum + Math.round(Number(row.amount || 0)*100),0) !== expected) throw new Error('各账期入账金额合计必须等于审批单总额');
      } }]}>
        {(fields, { add, remove }, { errors }) => <>
          {fields.map((field) => <div className="approval-accounting-fields__row" key={field.key}>
            <Form.Item name={[field.name, 'month']} rules={[{ required: true, message: '请选择月份' }]}><DatePicker picker="month" locale={zhCN.DatePicker} format="YYYY年MM月" placeholder="入账月份" disabled={disabled} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name={[field.name, 'amount']} rules={[{ required: true, message: '请填写入账金额' }, { validator: async (_, value) => { if (value != null && Number(value) <= 0) throw new Error('金额须大于0'); } }]}><InputNumber stringMode min="0.01" max="999999999999.99" precision={2} addonAfter="元" placeholder="当月入账金额" disabled={disabled} style={{ width: '100%' }} /></Form.Item>
            <Button type="link" danger disabled={disabled || fields.length <= 2} onClick={() => remove(field.name)}>移除</Button>
          </div>)}
          <Space><Button disabled={disabled || fields.length >= 60} onClick={() => add({})}>＋ 添加账期</Button><Typography.Text type={total === expected ? 'success' : 'danger'}>合计 {formatMoney(total/100)} / 审批总额 {formatMoney(approvalTotal)}</Typography.Text></Space>
          <Form.ErrorList errors={errors} />
        </>}
      </Form.List>
    </> : <Form.Item name="accounting_month" label="入账月份" rules={[{ required: true, message: '请选择入账月份' }]}>
      <DatePicker picker="month" locale={zhCN.DatePicker} format="YYYY年MM月" placeholder="请选择入账月份" disabled={disabled} style={{ width: '100%' }} />
    </Form.Item>}
  </div>;
}
