"use client";
import { Alert, Button, DatePicker, Descriptions, Form, Input, InputNumber, Modal, Space, Spin, Table, Typography, message } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useEffect, useRef, useState } from "react";
import type { AuditLog, DividendOpeningBalance, DividendOpeningUpdate } from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";
import { apiClient } from "../lib/api";

const labels = { opening_remaining: "期初剩余未分配利润", historical_profit: "历史累计利润", historical_distribution: "历史累计分红", preopening_investment: "筹建投入资金", preopening_expense_override: "筹建费用总支出", operating_capital: "累计运营增资" };
type FormValues = Omit<DividendOpeningUpdate, "version" | "start_period"> & { start_period: dayjs.Dayjs };
const isolationHelp = "数据隔离月份是使用系统计算的第一个月份（包含该月）。例如选择2026年9月，2026年8月及以前的系统财务数据不会再次计入分红累计，由本次录入的期初数据代表。原始审批、报表和分红记录会保留。";

export function DividendOpeningSettings({ storeId, opening, disabled, onSaved }: { storeId: string; opening?: DividendOpeningBalance | null; disabled?: boolean; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initial, setInitial] = useState<DividendOpeningBalance | null>(null);
  const [confirmation, setConfirmation] = useState<DividendOpeningUpdate | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [history, setHistory] = useState<AuditLog[]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const generation = useRef(0);
  const [form] = Form.useForm<FormValues>();
  useEffect(() => () => { generation.current += 1; }, []);
  useEffect(() => { generation.current += 1; setOpen(false); setConfirmation(null); setHistoryOpen(false); setHistory([]); setLoaded(false); }, [storeId]);
  async function load() {
    if (loading || saving) return;
    setOpen(true); setLoading(true); setLoaded(false); setError(null); form.resetFields();
    const version = ++generation.current;
    try {
      const result = await apiClient.dividends.openingBalance(storeId);
      if (version !== generation.current) return;
      setInitial(result);
      form.setFieldsValue({ start_period: result.start_period ? dayjs(result.start_period + "-01") : undefined,
        opening_remaining: result.opening_remaining ?? undefined, historical_profit: result.historical_profit ?? undefined,
        historical_distribution: result.historical_distribution ?? undefined, operating_capital: result.operating_capital ?? undefined,
        preopening_investment: result.preopening_investment, preopening_expense_override: result.preopening_expense_override, reason: "" });
      setLoaded(true);
    } catch (reason) { if (version === generation.current) setError(reason instanceof Error ? reason.message : "期初数据加载失败"); }
    finally { if (version === generation.current) setLoading(false); }
  }
  async function prepare() {
    if (!loaded || !initial || saving) return;
    const values = await form.validateFields().catch(() => null);
    if (!values) return;
    setConfirmation({ ...values, start_period: values.start_period.format("YYYY-MM"), version: initial.version, preopening_expense_override: values.preopening_expense_override ?? null, reason: values.reason.trim() });
  }
  async function save() {
    if (!confirmation || saving) return;
    const version = generation.current;
    setSaving(true); setError(null);
    try {
      await apiClient.dividends.saveOpeningBalance(storeId, confirmation);
      if (version !== generation.current) return;
      setConfirmation(null); setOpen(false); onSaved(); message.success("期初数据已保存，累计金额已按隔离月份重新计算");
    } catch (reason) { if (version === generation.current) { setConfirmation(null); setError(reason instanceof Error ? reason.message : "保存失败"); } }
    finally { if (version === generation.current) setSaving(false); }
  }
  async function loadHistory() {
    if (historyLoading) return;
    setHistoryOpen(true); setHistoryLoading(true); setHistoryError(null);
    const version = generation.current;
    try { const rows = await apiClient.dividends.openingHistory(storeId); if (version === generation.current) setHistory(rows); }
    catch (reason) { if (version === generation.current) setHistoryError(reason instanceof Error ? reason.message : "修改记录加载失败"); }
    finally { if (version === generation.current) setHistoryLoading(false); }
  }
  function changes(record: AuditLog) {
    try {
      const metadata = JSON.parse(record.metadata_json || "{}");
      return <Descriptions column={1} size="small"><Descriptions.Item label="修改原因">{metadata.reason || "—"}</Descriptions.Item>
        {([['start_period','数据隔离月份'], ...Object.entries(labels)] as [string,string][]).map(([field,label]) => <Descriptions.Item key={field} label={label}>{metadata.before?.[field] ?? "未录入"} → {metadata.after?.[field] ?? "自动取报表"}</Descriptions.Item>)}
      </Descriptions>;
    } catch { return record.summary || "—"; }
  }
  return <>
    <Space size={8}><Button type="primary" loading={loading} onClick={() => void load()} disabled={disabled || !storeId || saving}>{opening?.configured ? "维护期初数据" : "录入历史数据"}</Button><Button loading={historyLoading} onClick={() => void loadHistory()} disabled={disabled || !storeId || saving}>修改记录</Button></Space>
    <Modal title={opening?.configured ? "维护期初数据" : "录入历史期初数据"} open={open} width={700} onOk={() => void prepare()} okText="核对并保存" cancelText="取消" okButtonProps={{ disabled: !loaded || saving }} onCancel={() => { if (!saving) { generation.current += 1; setOpen(false); } }} maskClosable={!saving} keyboard={!saving} closable={!saving} cancelButtonProps={{ disabled: saving }}>
      <Alert type="info" showIcon message="一次录入系统启用前的历史数据；所选月份起，净利润和分配按系统记录自动累计。不会删除原有记录。" style={{ marginBottom: 16 }} />
      {error ? <Alert type="error" showIcon message={error} action={!saving ? <Button size="small" onClick={() => void load()}>重新加载</Button> : undefined} style={{ marginBottom: 16 }} /> : null}
      <Spin spinning={loading}><Form form={form} layout="vertical" disabled={loading || saving}>
        <Form.Item name="start_period" label={<Space>数据隔离月份<Button type="text" size="small" aria-label="数据隔离月份说明" icon={<InfoCircleOutlined />} onClick={() => setHelpOpen(true)} /></Space>} rules={[{ required: true, message: "请选择第一个纳入计算的月份" }]}>
          <DatePicker picker="month" locale={zhCN.DatePicker} format="YYYY年MM月" allowClear={false} style={{ width: "100%" }} />
        </Form.Item>
        <div className="dividend-opening-fields">{Object.entries(labels).map(([field,label]) => <Form.Item key={field} name={field} label={label} rules={field === "preopening_expense_override" ? [] : [{ required: true, message: `请填写${label}，没有则填0` }]} extra={field === "preopening_expense_override" ? "留空取筹建报表；填0则明确使用0。" : field === "opening_remaining" || field === "historical_profit" ? "亏损可填负数，金额为隔离月之前的值。" : undefined}>
          <InputNumber stringMode min={field === "opening_remaining" || field === "historical_profit" ? "-999999999999.99" : "0"} max="999999999999.99" precision={2} addonAfter="元" style={{ width: "100%" }} />
        </Form.Item>)}</div>
        <Form.Item name="reason" label="录入 / 修改原因" rules={[{ required: true, whitespace: true, message: "请填写原因，便于追溯" }]}><Input.TextArea maxLength={1000} showCount rows={2} placeholder="例如：首次启用系统，按财务确认金额建立期初" /></Form.Item>
      </Form></Spin>
    </Modal>
    <Modal title="确认期初数据" open={Boolean(confirmation)} onOk={() => void save()} confirmLoading={saving} onCancel={() => { if (!saving) setConfirmation(null); }} cancelButtonProps={{ disabled: saving }} maskClosable={!saving} keyboard={!saving} closable={!saving} okText="确认保存" cancelText="返回修改">
      <Alert showIcon type="warning" message="保存后将重新计算隔离月份及后续月份的累计金额。已有锁定 / 封账记录时会阻止修改。" style={{ marginBottom: 16 }} />
      <Descriptions size="small" column={1}><Descriptions.Item label="自此月份起计算">{confirmation ? formatPeriod(confirmation.start_period) : "—"}</Descriptions.Item>
        {Object.entries(labels).map(([field,label]) => <Descriptions.Item key={field} label={label}>{confirmation?.[field as keyof typeof labels] == null ? "自动取筹建报表" : formatMoney(confirmation[field as keyof typeof labels]!)}</Descriptions.Item>)}
      </Descriptions>
    </Modal>
    <Modal title="数据隔离月份说明" open={helpOpen} footer={<Button type="primary" onClick={() => setHelpOpen(false)}>知道了</Button>} onCancel={() => setHelpOpen(false)}><Typography.Paragraph>{isolationHelp}</Typography.Paragraph></Modal>
    <Modal title="期初数据修改记录" open={historyOpen} onCancel={() => setHistoryOpen(false)} footer={null} width={820}>
      {historyError ? <Alert type="error" showIcon message={historyError} action={<Button onClick={() => void loadHistory()}>重试</Button>} /> : null}
      <Table rowKey="id" loading={historyLoading} dataSource={history} pagination={{ pageSize: 8 }} expandable={{ expandedRowRender: changes }} columns={[{ title: "时间", dataIndex: "created_at", render: (value: string) => dayjs(value.endsWith('Z') ? value : value+'Z').format("YYYY-MM-DD HH:mm") }, { title: "操作人", dataIndex: "actor" }, { title: "说明", dataIndex: "summary" }]} locale={{ emptyText: "暂无修改记录" }} />
    </Modal>
  </>;
}
