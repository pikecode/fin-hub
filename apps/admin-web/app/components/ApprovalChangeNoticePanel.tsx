"use client";
import { Alert, Button, Input, Modal, Space, Table, Tag, Typography, message } from "antd";
import { useEffect, useRef, useState } from "react";
import { apiClient } from "../lib/api";

interface Notice {
  id: string; approval_id: string; approval_no: string; status: string; version: number;
  before: Record<string, unknown>; after: Record<string, unknown>; changed_fields: string[];
  periods: string[]; closed_periods: string[]; detected_at: string; review_note?: string;
}
interface Result { items: Notice[]; pending_count: number; total: number; }
function readable(value: unknown): string {
  if (value == null) return "未提供";
  if (Array.isArray(value)) return value.map(item => typeof item === "object" && item ? `${item.name || item.id || "字段"}：${typeof item.value === "string" ? item.value : JSON.stringify(item.value ?? item)}` : String(item)).join("\n");
  return typeof value === "object" ? JSON.stringify(value, null, 2) : String(value);
}

export function ApprovalChangeNoticePanel({ storeId, onReviewed }: { storeId: string; onReviewed: () => Promise<void> }) {
  const [data, setData] = useState<Result>({ items: [], pending_count: 0, total: 0 });
  const [page, setPage] = useState(1);
  const [history, setHistory] = useState(false);
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<Notice | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stale, setStale] = useState(false);
  const request = useRef(0);
  async function load() {
    const id = ++request.current;
    try {
      const result = await apiClient.request<Result>(`/api/approval-change-notices?${new URLSearchParams({ store_id: storeId, page: String(page), page_size: "10", include_reviewed: String(history) })}`);
      if (id === request.current) { setData(result); setError(undefined); }
    } catch (e) { if (id === request.current) setError(e instanceof Error ? e.message : "变更提醒加载失败"); }
  }
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    const interval = window.setInterval(refresh, 60000);
    return () => { ++request.current; window.removeEventListener("focus", refresh); window.clearInterval(interval); };
  }, [storeId, page, history]);
  useEffect(() => { setDetail(null); setOpen(false); setPage(1); setData({ items: [], pending_count: 0, total: 0 }); setError(undefined); }, [storeId]);
  async function review() {
    if (!detail || busy || stale) return;
    if (!note.trim()) { message.warning("请填写核对结果及报表更正方式，或无需调整原因"); return; }
    setBusy(true);
    try {
      await apiClient.request(`/api/approval-change-notices/${detail.id}/review`, { method: "POST", body: JSON.stringify({ version: detail.version, note }) });
      setDetail(null); setPage(1); await load(); await onReviewed(); message.success("核对结果已记录；报表未被自动修改");
    } catch (e) { setStale(true); message.error(e instanceof Error ? e.message : "提交失败"); await load(); }
    finally { setBusy(false); }
  }
  return <div style={{ marginBottom: 16 }}>
    {error ? <Alert type="warning" showIcon message="审批变更提醒暂未加载成功" description={error} action={<Button onClick={() => void load()}>重试</Button>} /> : data.pending_count > 0 ?
      <Alert type="error" showIcon message={<strong>注意：{data.pending_count} 张已对账审批发生变更，待核对财务报表</strong>}
        description="包含当前门店全部账期。撤销、金额或表单修改可能影响已出报表；请核对后更正，并填写处理说明。封账月份需解封更正或在后续开放账期调整。"
        action={<Button danger type="primary" onClick={() => setOpen(true)}>立即核对</Button>} /> :
      <Button size="small" onClick={() => { setHistory(true); setPage(1); setOpen(true); }}>审批变更核对记录</Button>}
    <Modal title="已对账审批变更 · 财务核对" open={open} onCancel={() => setOpen(false)} footer={null} width={1050}>
      <Space style={{ marginBottom: 12 }}><Button onClick={() => { setHistory(!history); setPage(1); }}>{history ? "仅看待核对" : "包含已核对记录"}</Button><Button onClick={() => void load()}>刷新</Button><Typography.Text type="secondary">钉钉同步发现后提醒，历史已对账审批每日分批复查</Typography.Text></Space>
      <Table<Notice> rowKey="id" dataSource={data.items} pagination={{ current: page, pageSize: 10, total: data.total, onChange: setPage }} columns={[
        { title: "审批单号", dataIndex: "approval_no" },
        { title: "变化内容", render: (_, row) => <Space wrap>{row.changed_fields.map(field => <Tag key={field} color="red">{field}</Tag>)}</Space> },
        { title: "影响月份", render: (_, row) => row.periods.join("、") || "待核对" },
        { title: "封账月份", render: (_, row) => row.closed_periods.map(p => <Tag key={p} color="orange">{p} 已封账</Tag>) },
        { title: "状态", render: (_, row) => <Tag color={row.status === "pending" ? "red" : "green"}>{row.status === "pending" ? "待核对" : "已人工核对"}</Tag> },
        { title: "发现时间（北京时间）", dataIndex: "detected_at", render: value => new Date(/[Zz]|[+-]\d{2}:\d{2}$/.test(String(value)) ? String(value) : `${value}Z`).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) },
        { title: "操作", render: (_, row) => <Button danger={row.status === "pending"} onClick={() => { setDetail(row); setNote(""); setStale(false); }}>查看与核对</Button> },
      ]} />
    </Modal>
    <Modal title={`审批变更核对 · ${detail?.approval_no || ""}`} open={!!detail} onCancel={() => !busy && setDetail(null)} width={1000} confirmLoading={busy}
      okText={detail?.status === "reviewed" ? "已核对" : "确认已核对并记录说明"} okButtonProps={{ disabled: detail?.status === "reviewed" || stale }} onOk={() => void review()}>
      <Alert type="warning" showIcon message="这里只记录核对结论，不自动解除对账、不修改或冲销费用。请先完成必要的财务更正。" />
      {stale ? <Alert type="error" message="提交未成功，请关闭并重新打开最新提醒后再核对。" /> : null}
      <Typography.Paragraph>影响月份：{detail?.periods.join("、")}；已封账：{detail?.closed_periods.join("、") || "无"}</Typography.Paragraph>
      <Table rowKey="field" pagination={false} size="small" dataSource={detail ? [...new Set([...Object.keys(detail.before), ...Object.keys(detail.after)])].filter(field => detail.changed_fields.includes(field) || field === "说明").map(field => ({ field, before: readable(detail.before[field]), after: readable(detail.after[field]) })) : []}
        columns={[{ title: "字段", dataIndex: "field", width: 130 }, { title: "变更前", dataIndex: "before", render: value => <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 280, overflow: "auto" }}>{value}</div> }, { title: "最新来源", dataIndex: "after", render: value => <div style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 280, overflow: "auto" }}>{value}</div> }]} />
      {detail?.status === "reviewed" ? <Typography.Paragraph>核对说明：{detail.review_note}</Typography.Paragraph> : <Input.TextArea value={note} onChange={e => setNote(e.target.value)} maxLength={2000} rows={4} placeholder="必填：核对结论、报表更正方式/调整账期，或无需调整原因" style={{ marginTop: 16 }} />}
    </Modal>
  </div>;
}
