"use client";

import { Alert, Button, Cascader, Checkbox, DatePicker, Form, Input, InputNumber, Modal, Select, Space, Table, Tag, Typography, message } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalInstance, ExpenseCategory, Ledger } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { apiClient } from "../lib/api";

interface Entry { id: string; store_id: string; period: string; entry_type: "accrual" | "supplement" | "reversal"; original_id: string | null; category_l1: string; category_l2: string; amount: string; remark: string; }
interface Link { id: string; original_id: string; approval_id: string; approval_no?: string; amount: string; whole_approval?: boolean; active: boolean; remark: string; }
const labels = { accrual: "计提", supplement: "补提", reversal: "冲销" };

export function AccrualManagement({ storeId, period, onChanged }: { storeId: string; period: string; onChanged: () => Promise<void> }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [links, setLinks] = useState<Link[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const categoryOptions = useMemo(() => categories
    .filter(root => !root.parent_id && root.status === "active" && !["门店预充值", "备用金/借款", "异常费用"].includes(root.name))
    .map(root => ({ value: root.name, label: root.name, children: categories
      .filter(child => child.parent_id === root.id && child.status === "active" && !(root.name === "食材成本" && child.name === "快驴充值"))
      .map(child => ({ value: child.name, label: child.name })) }))
    .filter(root => root.children.length > 0), [categories]);
  const [approvals, setApprovals] = useState<ApprovalInstance[]>([]);
  const [editing, setEditing] = useState<Entry | null>(null);
  const [mode, setMode] = useState<Entry["entry_type"] | "link" | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [all, setAll] = useState(true);
  const [removing, setRemoving] = useState<Entry | null>(null);
  const [deleteReason, setDeleteReason] = useState("");
  const [revoke, setRevoke] = useState<Link | null>(null);
  const [reason, setReason] = useState("");
  const [form] = Form.useForm();
  const requestKey = useRef("");
  const request = useRef(0);
  const searchRequest = useRef(0);
  const targetMonth = Form.useWatch("month", form)?.format("YYYY-MM");
  const targetLedger = ledgers.find(row => row.period === targetMonth);
  const selectedOriginal = Form.useWatch("original_id", form);
  const roots = entries.filter(row => row.entry_type === "accrual");
  const effective = (root: Entry) => entries.filter(row => row.id === root.id || row.original_id === root.id).reduce((sum, row) => sum + (row.entry_type === "reversal" ? -1 : 1) * Number(row.amount), 0);
  const covered = (root: Entry) => links.filter(row => row.active && row.original_id === root.id).reduce((sum, row) => sum + Number(row.amount), 0);

  async function load() {
    const id = ++request.current;
    setLoading(true);
    try {
      const query = `?store_id=${encodeURIComponent(storeId)}`;
      const [rows, associated, categoryPage, ledgerPage] = await Promise.all([
        apiClient.request<Entry[]>(`/api/accruals${query}`),
        apiClient.request<Link[]>(`/api/accruals/links${query}`),
        apiClient.categories.list("?page_size=500"),
        apiClient.ledgers.list(`?store_id=${encodeURIComponent(storeId)}&page_size=500`),
      ]);
      if (id === request.current) { setEntries(rows); setLedgers(ledgerPage.items); setLinks(associated); setCategories(categoryPage.items); setError(undefined); }
    } catch (e) { if (id === request.current) setError(e instanceof Error ? e.message : "加载失败"); }
    finally { if (id === request.current) setLoading(false); }
  }
  async function searchApprovals(keyword = "") {
    const id = ++searchRequest.current;
    try {
      const result = await apiClient.dingtalk.listApprovalInstances(`?${new URLSearchParams({ store_id: storeId, keyword, include_matched: "true", page_size: "100" })}`);
      if (id === searchRequest.current) setApprovals(result.items);
    } catch (e) { message.error(e instanceof Error ? e.message : "审批搜索失败"); }
  }
  useEffect(() => { void load(); setMode(null); setRevoke(null); setRemoving(null); return () => { ++request.current; ++searchRequest.current; }; }, [storeId, period]);
  useEffect(() => { setAll(true); }, [storeId]);

  function open(next: NonNullable<typeof mode>, root?: Entry) {
    setEditing(null); form.resetFields(); setError(undefined); requestKey.current = crypto.randomUUID();
    const currentMonth = dayjs(`${period}-01`);
    const month = root && ledgers.find(row => row.period === period)?.status === "closed" ? currentMonth.add(1, "month") : currentMonth;
    form.setFieldsValue({ month, original_id: root?.id });
    setMode(next);
    if (next === "link") void searchApprovals();
  }
  function openEdit(row: Entry) {
    form.resetFields(); setError(undefined); setEditing(row); setMode(row.entry_type);
    form.setFieldsValue({ month: dayjs(`${row.period}-01`), original_id: row.original_id,
      category: [row.category_l1, row.category_l2], amount: row.amount, remark: row.remark });
  }
  async function createTargetLedger() {
    if (!targetMonth || busy) return;
    setBusy(true);
    try {
      const ledger = await apiClient.ledgers.create({ store_id: storeId, period: targetMonth });
      setLedgers(rows => [...rows.filter(row => row.period !== ledger.period), ledger]);
      setError(undefined); message.success(`${targetMonth} 账期已创建，可继续提交`);
      await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "创建账期失败"); }
    finally { setBusy(false); }
  }
  async function save() {
    const values = await form.validateFields();
    if (busy) return;
    if (mode !== "link" && !targetLedger) { setError("所选入账月份尚未创建账期，请先点击创建所选账期"); return; }
    if (mode !== "link" && targetLedger?.status !== "open") { setError("所选账期已封账，请选择后续开放账期"); return; }
    setBusy(true);
    try {
      if (editing) {
        const fields = { period: values.month.format("YYYY-MM"), category_l1: values.category[0], category_l2: values.category[1], amount: String(values.amount), remark: values.remark };
        const { period: oldPeriod, category_l1, category_l2, amount, remark } = editing;
        await apiClient.request(`/api/accruals/${editing.id}`, { method: "PATCH", body: JSON.stringify({ ...fields,
          expected: { period: oldPeriod, category_l1, category_l2, amount, remark }, reason: values.edit_reason }) });
      } else if (mode === "link") {
        await apiClient.request("/api/accruals/links/batch", { method: "POST", body: JSON.stringify({ original_id: values.original_id, approval_ids: values.approval_ids, remark: values.remark, confirm_category_difference: values.confirm_category_difference, request_key: requestKey.current }) });
      } else {
        const root = roots.find(row => row.id === values.original_id);
        const category = mode === "accrual" ? values.category : [root?.category_l1, root?.category_l2];
        await apiClient.request("/api/accruals", { method: "POST", body: JSON.stringify({ store_id: storeId, period: values.month.format("YYYY-MM"), entry_type: mode, original_id: mode === "accrual" ? null : values.original_id, category_l1: category[0], category_l2: category[1], amount: String(values.amount), remark: values.remark, request_key: requestKey.current }) });
      }
      if (mode !== "link" && values.month.format("YYYY-MM") !== period) setAll(true);
      setMode(null); setEditing(null); message.success(mode === "link" ? "审批覆盖已保存" : `已保存至 ${values.month.format("YYYY-MM")}，费用按本次入账月份统计`); await load(); await onChanged();
    } catch (e) { setError(e instanceof Error ? e.message : "保存失败"); }
    finally { setBusy(false); }
  }
  const selected = roots.find(row => row.id === selectedOriginal);
  return <Space direction="vertical" style={{ width: "100%" }} size="middle">
    <Alert type="info" showIcon message="计提先确认费用，审批和付款后续关联；补提增加支出，冲销减少支出。正式报表以封账为准。" />
    {error && !mode ? <Alert type="error" showIcon message={error} /> : null}
    <Space wrap><Button type="primary" disabled={loading} onClick={() => open("accrual")}>新增计提</Button><Button onClick={() => { setAll(!all); }}>{all ? "查看当前账期" : "查看全部账期"}</Button><Button onClick={() => void load()}>刷新</Button><Tag>{all ? "全部账期" : period}</Tag></Space>
    <Table<Entry> rowKey="id" loading={loading} dataSource={entries.filter(row => all || row.period === period)} scroll={{ x: 1000 }} columns={[
      { title: "入账月份", dataIndex: "period" },
      { title: "类型", render: (_, row) => <Tag color={row.entry_type === "reversal" ? "red" : "blue"}>{labels[row.entry_type]}</Tag> },
      { title: "费用分类", render: (_, row) => `${row.category_l1} / ${row.category_l2}` },
      { title: "金额", render: (_, row) => formatMoney((row.entry_type === "reversal" ? -1 : 1) * Number(row.amount)) },
      { title: "备注 / 原计提", render: (_, row) => <>{row.remark}{row.original_id ? <Typography.Paragraph type="secondary">{roots.find(root => root.id === row.original_id)?.remark || row.original_id}</Typography.Paragraph> : null}</> },
      { title: "有效计提 / 关联审批金额（全部月份）", render: (_, row) => row.entry_type === "accrual" ? `${formatMoney(effective(row))} / ${formatMoney(covered(row))}` : "—" },
      { title: "操作", render: (_, row) => <Space><Button size="small" disabled={ledgers.find(ledger => ledger.period === row.period)?.status !== "open"} onClick={() => openEdit(row)}>编辑</Button><Button size="small" danger disabled={ledgers.find(ledger => ledger.period === row.period)?.status !== "open"} onClick={() => { setRemoving(row); setDeleteReason(""); }}>删除</Button>{row.entry_type === "accrual" ? <><Button size="small" onClick={() => open("supplement", row)}>补提</Button><Button size="small" danger onClick={() => open("reversal", row)}>冲销</Button><Button size="small" onClick={() => open("link", row)}>关联审批</Button></> : null}</Space> },
    ]} />
    <Typography.Title level={5}>审批计提覆盖记录</Typography.Title>
    <Table<Link> rowKey="id" dataSource={links} columns={[
      { title: "原计提", render: (_, row) => roots.find(root => root.id === row.original_id)?.remark || row.original_id },
      { title: "审批", render: (_, row) => row.approval_no || approvals.find(a => a.id === row.approval_id)?.approval_no || row.approval_id },
      { title: "入账处理", render: (_, row) => row.whole_approval ? `整单不入账（关联时 ${formatMoney(row.amount)}）` : `历史部分覆盖 ${formatMoney(row.amount)}` }, { title: "原因", dataIndex: "remark" },
      { title: "状态", render: (_, row) => row.active ? "有效" : "已解除" },
      { title: "操作", render: (_, row) => <Button disabled={!row.active} danger size="small" onClick={() => { setReason(""); setRevoke(row); }}>解除覆盖</Button> },
    ]} />
    <Modal title={editing ? `编辑${labels[editing.entry_type]}` : mode === "link" ? "关联已计提审批费用" : mode ? labels[mode] : "计提"} open={!!mode} onCancel={() => !busy && setMode(null)} confirmLoading={busy} onOk={() => void save()} maskClosable={!busy} closable={!busy}>
      {error ? <Alert type="error" message={error} /> : null}
      {editing ? <Alert showIcon type="info" style={{ marginBottom: 16 }} message="仅可编辑未封账记录，修改会保留审计记录。" description="修改分类会同步更新原计提及同组补提、冲销；同组存在封账记录或有效审批覆盖时不可修改分类。" /> : null}
      <Form form={form} layout="vertical" disabled={busy}>
        {mode !== "accrual" ? <Form.Item name="original_id" label="原计提" rules={[{ required: true }]}><Select disabled={!!editing} showSearch optionFilterProp="label" options={roots.map(row => ({ value: row.id, label: `${row.period} · ${row.remark} · 关联审批 ${formatMoney(covered(row))}` }))} /></Form.Item> : null}
        {selected ? <Typography.Paragraph type="secondary">原分类：{selected.category_l1} / {selected.category_l2}；有效金额 {formatMoney(effective(selected))}</Typography.Paragraph> : null}
        {mode === "link" ? <><Form.Item name="approval_ids" label="审批单（可多选，输入单号搜索）" rules={[{ required: true }]}><Select mode="multiple" showSearch filterOption={false} onSearch={value => void searchApprovals(value)} options={approvals.map(a => ({ value: a.id, label: `${a.approval_no || a.id} · ${a.title || "审批单"}` }))} /></Form.Item><Form.Item name="confirm_category_difference" valuePropName="checked"><Checkbox>如审批分类不同，确认保留原计提分类，不改写历史</Checkbox></Form.Item></> : <><Form.Item name="month" label="本次入账月份" extra={mode === "supplement" || mode === "reversal" ? "可选择原计提月份或之后的开放账期；本次调整只计入所选月份。" : undefined} rules={[{ required: true }]}><DatePicker picker="month" onChange={() => setError(undefined)} disabledDate={value => !!selected && value.format("YYYY-MM") < selected.period} /></Form.Item>{targetMonth && !targetLedger ? <Alert type="warning" showIcon style={{ marginBottom: 16 }} message={`${targetMonth} 尚未创建账期`} description="先创建该月账期，再提交本次计提或调整。" action={<Button loading={busy} onClick={() => void createTargetLedger()}>创建所选账期</Button>} /> : targetLedger?.status !== "open" && targetMonth ? <Alert type="warning" showIcon style={{ marginBottom: 16 }} message="所选账期已封账，请选择后续开放账期" /> : null}</>}
        {mode === "accrual" || editing ? <Form.Item name="category" label="二级费用分类" extra="计提仅支持经营费用；异常费用、门店预充值、备用金/借款及快驴充值不参与计提。" rules={[{ required: true }, { validator: (_, value) => value?.length === 2 && categoryOptions.some(root => root.value === value[0] && root.children.some(child => child.value === value[1])) ? Promise.resolve() : Promise.reject(new Error("请选择有效的经营费用二级分类")) }]}><Cascader options={categoryOptions} /></Form.Item> : null}
        {mode === "link" ? <Alert type="info" showIcon message="选中的审批单整单不重复计入报表，仍可正常匹配银行流水。金额差异请通过补提或冲销调整。" style={{ marginBottom: 16 }} /> : <Form.Item name="amount" label="金额" rules={[{ required: true }]}><InputNumber stringMode min="0.01" precision={2} style={{ width: "100%" }} /></Form.Item>}
        {editing ? <Form.Item name="edit_reason" label="修改原因" rules={[{ required: true, whitespace: true }]}><Input.TextArea maxLength={2000} /></Form.Item> : null}
        <Form.Item name="remark" label="备注 / 原因" rules={[{ required: true, whitespace: true }]}><Input.TextArea maxLength={2000} /></Form.Item>
      </Form>
    </Modal>
    <Modal title="删除计提 / 调整记录" open={!!removing} confirmLoading={busy} okText="确认删除" okButtonProps={{ danger: true }} onCancel={() => !busy && setRemoving(null)} onOk={async () => {
      if (!removing || busy) return;
      if (!deleteReason.trim()) { message.warning("请填写删除原因"); return; }
      setBusy(true);
      try {
        const { period: entryPeriod, category_l1, category_l2, amount, remark } = removing;
        await apiClient.request(`/api/accruals/${removing.id}`, { method: "DELETE", body: JSON.stringify({
          expected: { period: entryPeriod, category_l1, category_l2, amount, remark }, reason: deleteReason }) });
        setRemoving(null); message.success("已删除，修改留痕已保存"); await load(); await onChanged();
      } catch (e) { message.error(e instanceof Error ? e.message : "删除失败"); }
      finally { setBusy(false); }
    }}>
      <Alert type="warning" showIcon message="删除会更正该月份的费用及累计数据，并保留原值与删除原因的审计记录。" description="已封账不可删除；存在补提、冲销或审批覆盖历史的原计提需先核对。" style={{ marginBottom: 16 }} />
      <Typography.Paragraph>{removing ? `${removing.period} · ${labels[removing.entry_type]} · ${formatMoney(removing.amount)} · ${removing.remark}` : ""}</Typography.Paragraph>
      <Input.TextArea disabled={busy} maxLength={2000} value={deleteReason} onChange={e => setDeleteReason(e.target.value)} placeholder="必填：删除原因" />
    </Modal>
    <Modal title="解除计提覆盖" open={!!revoke} confirmLoading={busy} onCancel={() => !busy && setRevoke(null)} onOk={() => {
      if (!reason.trim() || !revoke || busy) { if (!reason.trim()) message.warning("请填写解除原因"); return; }
      setBusy(true); void apiClient.request(`/api/accruals/links/${revoke.id}/revoke`, { method: "POST", body: JSON.stringify({ reason }) }).then(async () => { setRevoke(null); await load(); await onChanged(); }).catch(e => message.error(e.message)).finally(() => setBusy(false));
    }}><Alert type="warning" message="解除覆盖后，已对账审批将恢复正常费用计入；封账月份禁止操作。" /><Input.TextArea value={reason} onChange={e => setReason(e.target.value)} placeholder="必填：解除原因" /></Modal>
  </Space>;
}
