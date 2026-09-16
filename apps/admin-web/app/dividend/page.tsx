"use client";

import { Alert, Button, Card, DatePicker, Dropdown, Empty, Form, Input, InputNumber, Modal, Select, Space, Statistic, Table, Tag, Typography, message } from "antd";
import zhCN from "antd/locale/zh_CN";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { AuditLog, DividendWorkspace, Store } from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";
import { getStores } from "../lib/referenceData";
import { useClientSearchParams } from "../lib/searchParams";

dayjs.locale("zh-cn");

function money(value: string) {
  return formatMoney(value);
}

const ALL_STORES = "__all__";

function addValues(...values: Array<string | number | undefined>) {
  return values.reduce<number>((sum, value) => sum + Number(value || 0), 0).toFixed(2);
}

function mergeMonths(rows: Array<DividendWorkspace["current"]>) {
  const first = rows[0];
  const entries = new Map<string, DividendWorkspace["current"]["entries"][number]>();
  rows.flatMap((row) => row.entries).forEach((entry) => {
    const key = `${entry.entry_type}:${entry.shareholder_name}`;
    const previous = entries.get(key);
    entries.set(key, previous ? { ...previous, amount: addValues(previous.amount, entry.amount), holding_ratio: addValues(previous.holding_ratio, entry.holding_ratio) } : { ...entry, id: key });
  });
  return {
    ...first,
    id: `all:${first.period}`,
    store_id: ALL_STORES,
    net_profit: addValues(...rows.map((row) => row.net_profit)),
    distribution_amount: addValues(...rows.map((row) => row.distribution_amount)),
    capital_amount: addValues(...rows.map((row) => row.capital_amount)),
    historical_profit: addValues(...rows.map((row) => row.historical_profit)),
    historical_distribution: addValues(...rows.map((row) => row.historical_distribution)),
    remaining_undistributed: addValues(...rows.map((row) => row.remaining_undistributed)),
    cumulative_capital: addValues(...rows.map((row) => row.cumulative_capital)),
    suggested_distribution: addValues(...rows.map((row) => row.suggested_distribution)),
    reference_ratio: "—",
    locked: rows.every((row) => row.locked),
    no_distribution: rows.every((row) => row.no_distribution),
    no_capital: rows.every((row) => row.no_capital),
    entries: [...entries.values()],
  };
}

function mergeWorkspaces(items: DividendWorkspace[], period: string): DividendWorkspace {
  const byPeriod = new Map<string, DividendWorkspace["history"]>();
  items.forEach((item) => item.history.forEach((row) => byPeriod.set(row.period, [...(byPeriod.get(row.period) ?? []), row])));
  const history = [...byPeriod.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([, rows]) => mergeMonths(rows));
  const current = history.find((row) => row.period === period) ?? mergeMonths(items.map((item) => item.current));
  const shareholders = new Map<string, DividendWorkspace["shareholders"][number]>();
  items.flatMap((item) => item.shareholders).forEach((item) => {
    const previous = shareholders.get(item.name);
    shareholders.set(item.name, previous ? { ...previous, holding_ratio: addValues(previous.holding_ratio, item.holding_ratio) } : { ...item, id: `all:${item.name}` });
  });
  return { store: { ...items[0].store, id: ALL_STORES, name: "全公司合并" }, period, shareholders: [...shareholders.values()], current, history };
}

export default function DividendPage() {
  const router = useRouter();
  const searchParams = useClientSearchParams();
  const storeId = searchParams.get("store_id") ?? "";
  const period = searchParams.get("period") ?? dayjs().format("YYYY-MM");
  const [stores, setStores] = useState<Store[]>([]);
  const [workspace, setWorkspace] = useState<DividendWorkspace | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [entryType, setEntryType] = useState<"distribution" | "capital">("distribution");
  const [entryPeriod, setEntryPeriod] = useState(period);
  const [entryModalOpen, setEntryModalOpen] = useState(false);
  const [entryAmounts, setEntryAmounts] = useState<Record<string, string>>({});
  const [entryTotal, setEntryTotal] = useState("0");
  const [entrySaving, setEntrySaving] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [archiveSaving, setArchiveSaving] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveDrafts, setArchiveDrafts] = useState<Record<string, { name: string; holding_ratio: string; remark: string; status: "active" | "inactive" }>>({});
  const [newShareholders, setNewShareholders] = useState<Array<{ name: string; holding_ratio: string; remark: string }>>([]);
  const [unlockOpen, setUnlockOpen] = useState(false);
  const [unlockReason, setUnlockReason] = useState("");
  const [auditOpen, setAuditOpen] = useState(false);
  const [auditLogs, setAuditLogs] = useState<AuditLog[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const formValues = useMemo(() => ({ store_id: storeId || undefined, period: dayjs(`${period}-01`) }), [period, storeId]);

  useEffect(() => {
    let ignore = false;
    getStores().then((items) => {
      if (!ignore) setStores(items);
    }).catch((reason) => {
      if (!ignore) setError(reason instanceof Error ? reason.message : "无法加载门店");
    });
    return () => { ignore = true; };
  }, []);

  useEffect(() => {
    if (!storeId && stores.length > 0) {
      router.replace(`/dividend?store_id=${encodeURIComponent(stores[0].id)}&period=${encodeURIComponent(period)}`);
    }
  }, [period, router, storeId, stores]);

  useEffect(() => {
    if (!storeId || (storeId === ALL_STORES && stores.length === 0)) return;
    let ignore = false;
    setLoading(true);
    setError(null);
    const request = storeId === ALL_STORES
      ? Promise.all(stores.map((store) => apiClient.dividends.workspace(store.id, period))).then((items) => mergeWorkspaces(items, period))
      : apiClient.dividends.workspace(storeId, period);
    request.then((data) => {
      if (!ignore) setWorkspace(data);
    }).catch((reason) => {
      if (!ignore) setError(reason instanceof Error ? reason.message : "分红数据加载失败");
    }).finally(() => {
      if (!ignore) setLoading(false);
    });
    return () => { ignore = true; };
  }, [period, storeId, stores]);

  function changeRange(nextStoreId: string, nextPeriod: dayjs.Dayjs) {
    router.replace(`/dividend?store_id=${encodeURIComponent(nextStoreId)}&period=${nextPeriod.format("YYYY-MM")}`);
  }

  const current = workspace?.current;
  const isAllStores = storeId === ALL_STORES;
  const activeShareholders = workspace?.shareholders.filter((item) => item.status === "active") ?? [];
  const entryColumns = [
    { title: "股东", dataIndex: "shareholder_name" },
    { title: "持股比例", dataIndex: "holding_ratio", render: (value: string) => `${value}%` },
    { title: "金额", dataIndex: "amount", align: "right" as const, render: (value: string) => money(value) },
    { title: "备注", dataIndex: "remark", render: (value: string | null) => value || "—" },
  ];
  const historyColumns = [
    { title: "月份", dataIndex: "period", render: (value: string) => formatPeriod(value) },
    { title: "净利润", dataIndex: "net_profit", render: (value: string) => money(value) },
    { title: "本月分配利润", dataIndex: "distribution_amount", render: (value: string) => money(value) },
    { title: "本月注资", dataIndex: "capital_amount", render: (value: string) => money(value) },
    { title: "期末剩余未分配", dataIndex: "remaining_undistributed", render: (value: string) => <Typography.Text type={Number(value) >= 0 ? "success" : "danger"}>{money(value)}</Typography.Text> },
    { title: "状态", render: (_: unknown, record: DividendWorkspace["history"][number]) => <Space size={4}>{record.no_distribution && record.no_capital ? <Tag color="green">无需补录</Tag> : record.locked && (record.distribution_amount !== "0.00" || record.capital_amount !== "0.00") ? <Tag color="blue">期初补录</Tag> : <Tag>未补录</Tag>}{record.locked ? <Tag color="orange">已锁定</Tag> : <Tag color="green">未锁定</Tag>}</Space> },
    { title: "操作", render: (_: unknown, record: DividendWorkspace["history"][number]) => <Space size={4} wrap><Dropdown menu={{ items: [{ key: "distribution", label: "补录分配", onClick: () => openEntryModal("distribution", record.period) }, { key: "capital", label: "补录注资", onClick: () => openEntryModal("capital", record.period) }], }} disabled={isAllStores || record.locked}><Button type="link" size="small" disabled={isAllStores || record.locked || actionLoading === `${record.period}:both`}>✎ 补录</Button></Dropdown>{!record.locked ? <Button type="link" size="small" loading={actionLoading === `${record.period}:both`} disabled={isAllStores} onClick={() => void markNoEntryBoth(record.period)}>{record.no_distribution && record.no_capital ? "撤销标记" : "标无需补录"}</Button> : null}{!record.locked ? <Button type="link" size="small" loading={actionLoading === `${record.period}:lock`} disabled={isAllStores} onClick={() => void lockPeriod(record.period)}>锁定</Button> : null}<Button type="link" size="small" onClick={() => void openAudit()}>◷ 留痕</Button></Space> },
  ];
  const expandedRowRender = (record: DividendWorkspace["history"][number]) => <Space direction="vertical" style={{ width: "100%" }}><Typography.Text strong>分红明细</Typography.Text><Table rowKey="id" size="small" pagination={false} columns={entryColumns} dataSource={record.entries.filter((item) => item.entry_type === "distribution")} locale={{ emptyText: "暂无分红明细" }} /><Typography.Text strong>注资明细</Typography.Text><Table rowKey="id" size="small" pagination={false} columns={entryColumns} dataSource={record.entries.filter((item) => item.entry_type === "capital")} locale={{ emptyText: "暂无注资明细" }} /></Space>;

  function openEntryModal(type: "distribution" | "capital", targetPeriod = period) {
    const target = workspace?.history.find((row) => row.period === targetPeriod) ?? current;
    if (!target || target.locked || isAllStores) return;
    const existingEntries = target.entries.filter((entry) => entry.entry_type === type);
    const existingByShareholder = new Map(existingEntries.map((entry) => [entry.shareholder_id, entry.amount]));
    const total = existingEntries.length
      ? existingEntries.reduce((sum, entry) => sum + Number(entry.amount || 0), 0).toFixed(2)
      : type === "distribution" ? target.suggested_distribution : "0";
    const amount = Number(total || 0);
    let remaining = amount;
    const amounts: Record<string, string> = {};
    activeShareholders.forEach((shareholder, index) => {
      const existing = existingByShareholder.get(shareholder.id);
      if (existing !== undefined) {
        amounts[shareholder.id] = existing;
        return;
      }
      const value = index === activeShareholders.length - 1 ? remaining : Number((amount * Number(shareholder.holding_ratio) / 100).toFixed(2));
      amounts[shareholder.id] = value.toFixed(2);
      remaining -= value;
    });
    setEntryType(type);
    setEntryPeriod(targetPeriod);
    setEntryTotal(amount.toFixed(2));
    setEntryAmounts(amounts);
    setEntryModalOpen(true);
  }

  function redistributeEntries() {
    const amount = Number(entryTotal || 0);
    let remaining = amount;
    const amounts: Record<string, string> = {};
    activeShareholders.forEach((shareholder, index) => {
      const value = index === activeShareholders.length - 1 ? remaining : Number((amount * Number(shareholder.holding_ratio) / 100).toFixed(2));
      amounts[shareholder.id] = value.toFixed(2);
      remaining -= value;
    });
    setEntryAmounts(amounts);
  }

  async function saveEntries() {
    if (!workspace || !current) return;
    const rows = activeShareholders.map((item) => ({ shareholder_id: item.id, amount: entryAmounts[item.id] || "0" }));
    setEntrySaving(true);
    try {
      await apiClient.dividends.updateMonth(workspace.store.id, entryPeriod, entryType === "distribution" ? { distribution: rows } : { capital: rows });
      setWorkspace(await apiClient.dividends.workspace(workspace.store.id, period));
      setEntryModalOpen(false);
      message.success("保存成功");
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "保存失败");
    } finally {
      setEntrySaving(false);
    }
  }

  function openArchive() {
    if (!workspace) return;
    setArchiveError(null);
    setArchiveDrafts(Object.fromEntries(workspace.shareholders.map((item) => [item.id, { name: item.name, holding_ratio: item.holding_ratio, remark: item.remark || "", status: item.status }])));
    setArchiveOpen(true);
  }

  async function saveArchive() {
    if (!workspace) return;
    setArchiveError(null);
    const activeRatio = Object.values(archiveDrafts).reduce((sum, item) => sum + (item.status === "active" ? Number(item.holding_ratio || 0) : 0), 0) + newShareholders.reduce((sum, item) => sum + Number(item.holding_ratio || 0), 0);
    if (activeRatio > 100.0001) {
      setArchiveError(`当前持股比例合计为 ${activeRatio.toFixed(2)}%，不能超过 100%`);
      return;
    }
    if (Math.abs(activeRatio - 100) > 0.0001) {
      setArchiveError(`当前持股比例合计为 ${activeRatio.toFixed(2)}%，必须等于 100%`);
      return;
    }
    setArchiveSaving(true);
    try {
      await Promise.all(Object.entries(archiveDrafts).map(([id, item]) => apiClient.dividends.updateShareholder(id, item)));
      await Promise.all(newShareholders.filter((item) => item.name.trim()).map((item) => apiClient.dividends.createShareholder({ store_id: workspace.store.id, name: item.name.trim(), holding_ratio: item.holding_ratio || "0", remark: item.remark || null })));
      const data = await apiClient.dividends.workspace(workspace.store.id, period);
      setWorkspace(data);
      setNewShareholders([]);
      setArchiveOpen(false);
      message.success("股东档案已保存");
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "股东档案保存失败");
    } finally {
      setArchiveSaving(false);
    }
  }

  async function markNoEntry(type: "distribution" | "capital", targetPeriod = period) {
    const target = workspace?.history.find((row) => row.period === targetPeriod) ?? current;
    if (!workspace || !target || target.locked || isAllStores) return;
    setActionLoading(`${targetPeriod}:${type}`);
    try {
      const wasMarked = type === "distribution" ? target.no_distribution : target.no_capital;
      await apiClient.dividends.updateMonth(workspace.store.id, targetPeriod, type === "distribution" ? { no_distribution: !wasMarked } : { no_capital: !wasMarked });
      setWorkspace(await apiClient.dividends.workspace(workspace.store.id, period));
      message.success(type === "distribution" ? (wasMarked ? "已取消无需分配标记" : "已标记无需分配") : (wasMarked ? "已取消无需注资标记" : "已标记无需注资"));
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setActionLoading(null);
    }
  }

  async function markNoEntryBoth(targetPeriod: string) {
    const target = workspace?.history.find((row) => row.period === targetPeriod);
    if (!workspace || !target || target.locked || isAllStores) return;
    const marked = target.no_distribution && target.no_capital;
    setActionLoading(`${targetPeriod}:both`);
    try {
      const updated = await apiClient.dividends.updateMonth(workspace.store.id, targetPeriod, { no_distribution: !marked, no_capital: !marked });
      setWorkspace(updated);
      message.success(marked ? "已撤销无需补录标记" : "已标记无需补录");
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "操作失败");
    } finally {
      setActionLoading(null);
    }
  }

  async function lockPeriod(targetPeriod: string) {
    if (!workspace || isAllStores) return;
    setActionLoading(`${targetPeriod}:lock`);
    try {
      await apiClient.dividends.lockMonth(workspace.store.id, targetPeriod);
      setWorkspace(await apiClient.dividends.workspace(workspace.store.id, period));
      message.success(`${formatPeriod(targetPeriod)}已锁定`);
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "锁定失败");
    } finally {
      setActionLoading(null);
    }
  }

  async function unlockCurrent() {
    if (!workspace || !unlockReason.trim()) return;
    try {
      const data = await apiClient.dividends.unlockMonth(workspace.store.id, period, unlockReason.trim());
      setWorkspace(data);
      setUnlockReason("");
      setUnlockOpen(false);
      message.success("月份已解锁");
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "解锁失败");
    }
  }

  async function openAudit() {
    setAuditOpen(true);
    setAuditLoading(true);
    try {
      const result = await apiClient.auditLogs.list("?resource_type=dividend_month&page_size=200");
      setAuditLogs(result.items);
    } catch (reason) {
      message.error(reason instanceof Error ? reason.message : "留痕加载失败");
    } finally {
      setAuditLoading(false);
    }
  }

  const chartRows = workspace?.history.slice().reverse() ?? [];
  const chartMax = Math.max(1, ...chartRows.flatMap((row) => [Math.abs(Number(row.net_profit)), Number(row.distribution_amount)]));

  return <AppShell title="分红管理" kicker="按门店和月份管理利润分配、股东注资与未分配利润">
    <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}><Button onClick={openArchive} disabled={isAllStores}>♙ 股东档案</Button></div>
    {error ? <Alert type="error" showIcon message="分红数据加载失败" description={error} /> : null}
    <Card style={{ marginBottom: 16 }}>
      <Form layout="inline" initialValues={formValues} key={`${storeId}-${period}`}>
        <Form.Item label="门店范围"><Select showSearch optionFilterProp="label" value={storeId || undefined} placeholder="选择门店" style={{ width: 280 }} options={[{ label: "全公司合并", value: ALL_STORES }, ...stores.map((store) => ({ label: store.name, value: store.id }))]} onChange={(value) => changeRange(value, dayjs(`${period}-01`))} /></Form.Item>
        <Form.Item label="查看月份"><DatePicker picker="month" locale={zhCN.DatePicker} format="YYYY年MM月" value={dayjs(`${period}-01`)} allowClear={false} onChange={(value) => value && changeRange(storeId, value)} /></Form.Item>
        <Form.Item><Button type="primary" onClick={() => openEntryModal("distribution")} disabled={isAllStores || !current || current.locked}>✎ 录入本月分配</Button></Form.Item>
        <Form.Item><Button onClick={() => openEntryModal("capital")} disabled={isAllStores || !current || current.locked}>＋ 录入本月注资</Button></Form.Item>
      </Form>
    </Card>
    {loading ? <Card loading style={{ minHeight: 360 }} /> : current && workspace ? <>
      <Alert type="info" showIcon closable message={`系统 ${period} 上线；历史明细按月份记录分配和注资，保存后可锁定，线下确无分红或注资的月份可标记无需补录。`} style={{ marginBottom: 16 }} />
      <div className="store-ledger-report-metrics">
        {[['本月净利润', current.net_profit], ['本月分配利润', current.distribution_amount], ['本月注资', current.capital_amount], ['剩余未分配利润', current.remaining_undistributed], ['历史总利润', current.historical_profit], ['历史已分配利润', current.historical_distribution], ['累计注资', current.cumulative_capital]].map(([title, value]) => <Card key={String(title)}><Statistic title={title} value={money(String(value))} valueStyle={{ color: String(title) === '剩余未分配利润' && Number(value) >= 0 ? '#389e0d' : undefined }} /></Card>)}
        <Card><Statistic title="分红比例参考" value={`${current.reference_ratio}%`} /><Typography.Text type="secondary">建议分配额 {money(current.suggested_distribution)}</Typography.Text><Button size="small" style={{ marginLeft: 8 }} onClick={openArchive} disabled={isAllStores}>设置</Button></Card>
        <Card><Typography.Text type="secondary">月份锁定状态</Typography.Text><div style={{ marginTop: 16 }}><Tag color={current.locked ? 'orange' : 'green'}>{current.locked ? '🔒 已锁定' : '♧ 未锁定'}</Tag><Button size="small" onClick={() => current.locked ? setUnlockOpen(true) : void lockPeriod(period)} disabled={isAllStores} style={{ marginLeft: 8 }}>{current.locked ? '解锁' : '锁定'}</Button></div></Card>
      </div>
      <Card title={`近 12 个月净利润 vs 分配利润 · ${workspace.store.name}`} style={{ marginTop: 16, marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 18, color: '#8c8c8c', fontSize: 13, marginBottom: 8 }}><span><i style={{ display: 'inline-block', width: 10, height: 10, background: '#1d5cff', borderRadius: 2, marginRight: 6 }} />净利润（红柱=亏损月）</span><span><i style={{ display: 'inline-block', width: 10, height: 10, background: '#52c41a', borderRadius: 2, marginRight: 6 }} />分配利润</span></div>
        <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.max(chartRows.length, 1)}, minmax(42px, 1fr))`, gap: 12, alignItems: 'end', height: 190, padding: '12px 8px 0', borderBottom: '1px solid #f0f0f0' }}>{chartRows.map((row) => <div key={row.period} style={{ height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}><div style={{ height: 'calc(100% - 24px)', display: 'flex', alignItems: 'flex-end', gap: 4 }}><div title={`净利润 ${money(row.net_profit)}`} style={{ width: 16, height: `${Math.max(3, Math.abs(Number(row.net_profit)) / chartMax * 100)}%`, background: Number(row.net_profit) < 0 ? '#ff7875' : '#1d5cff', borderRadius: '3px 3px 0 0' }} /><div title={`分配利润 ${money(row.distribution_amount)}`} style={{ width: 16, height: `${Math.max(Number(row.distribution_amount) ? 3 : 0, Number(row.distribution_amount) / chartMax * 100)}%`, background: '#52c41a', borderRadius: '3px 3px 0 0' }} /></div><Typography.Text type="secondary" style={{ fontSize: 12, marginTop: 8 }}>{row.period.slice(2)}</Typography.Text></div>)}</div>
      </Card>
      <Card title={`历史月份明细（展开行查看股东明细与留痕） · ${workspace.store.name}`} style={{ marginBottom: 16 }}><Table rowKey="id" loading={loading} columns={historyColumns} dataSource={workspace.history} expandable={{ expandedRowRender }} pagination={false} scroll={{ x: 1180 }} /></Card>
    </> : <Card><Empty description={storeId ? "暂无分红数据" : "暂无可用门店"} /></Card>}
    <Modal title={`录入本月${entryType === "distribution" ? "分配利润" : "注资"} · ${workspace?.store.name ?? ""} · ${formatPeriod(entryPeriod)}`} open={entryModalOpen} onCancel={() => setEntryModalOpen(false)} onOk={() => void saveEntries()} confirmLoading={entrySaving} okText="保存" cancelText="取消" width={760} styles={{ body: { paddingTop: 4 } }}>
      <Alert type="info" showIcon message={entryType === "distribution" ? `建议分配额 ${money(current?.suggested_distribution ?? "0")}（本月净利润 × 分红比例），可修改` : "请输入本月股东注资总额，可按持股比例重推明细"} style={{ marginBottom: 18 }} />
      <Typography.Text style={{ display: "block", marginBottom: 8, fontSize: 16 }}> {entryType === "distribution" ? "分配总额（元）" : "注资总额（元）"}</Typography.Text>
      <Space style={{ display: "flex", marginBottom: 18 }}><InputNumber size="large" min={0} precision={2} value={Number(entryTotal || 0)} onChange={(value) => setEntryTotal(String(value ?? 0))} style={{ width: 330 }} /><Button size="large" onClick={redistributeEntries}>按持股比例重推明细</Button></Space>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 1fr", gap: 0, background: "#fafafa", borderRadius: 8, padding: "13px 12px", fontWeight: 600, fontSize: 16 }}><span>股东</span><span>持股比例</span><span>{entryType === "distribution" ? "分红金额（元）" : "注资金额（元）"}</span></div>
      {activeShareholders.map((item) => <div key={item.id} style={{ display: "grid", gridTemplateColumns: "1fr 150px 1fr", gap: 18, alignItems: "center", padding: "12px", borderBottom: "1px solid #f0f0f0" }}><Typography.Text>{item.name}</Typography.Text><Typography.Text>{item.holding_ratio}%</Typography.Text><InputNumber size="large" min={0} precision={2} value={Number(entryAmounts[item.id] || 0)} onChange={(value) => setEntryAmounts((currentAmounts) => ({ ...currentAmounts, [item.id]: String(value ?? 0) }))} style={{ width: "100%" }} /></div>)}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 150px 1fr", padding: "14px 12px 0", fontWeight: 600, fontSize: 16 }}><span>明细合计</span><span /> <span>{money(Object.values(entryAmounts).reduce((sum, value) => sum + Number(value || 0), 0).toFixed(2))}</span></div>
    </Modal>
    <Modal title="股东档案维护" open={archiveOpen} onCancel={() => setArchiveOpen(false)} onOk={() => void saveArchive()} confirmLoading={archiveSaving} okText="保存" cancelText="取消" width={760} styles={{ body: { paddingTop: 4 } }}>
      {archiveError ? <Alert type="error" showIcon message={archiveError} style={{ marginBottom: 12 }} /> : null}
      <Alert type="info" showIcon message="股东档案用于自动拆分分红/注资明细，持股比例合计必须等于 100%" style={{ marginBottom: 18 }} />
      <div style={{ display: "grid", gridTemplateColumns: "1fr 230px 90px", gap: 0, background: "#fafafa", borderRadius: 8, padding: "13px 12px", fontWeight: 600, fontSize: 16 }}><span>股东姓名</span><span>持股比例</span><span>操作</span></div>
      {workspace?.shareholders.map((item) => <div key={item.id} style={{ display: "grid", gridTemplateColumns: "1fr 230px 90px", gap: 18, alignItems: "center", padding: "12px", borderBottom: "1px solid #f0f0f0" }}><Input size="large" value={archiveDrafts[item.id]?.name} onChange={(event) => setArchiveDrafts((drafts) => ({ ...drafts, [item.id]: { ...drafts[item.id], name: event.target.value } }))} placeholder="股东姓名" /><InputNumber size="large" min={0} max={100} precision={2} value={Number(archiveDrafts[item.id]?.holding_ratio || 0)} onChange={(value) => setArchiveDrafts((drafts) => ({ ...drafts, [item.id]: { ...drafts[item.id], holding_ratio: String(value ?? 0) } }))} addonAfter="%" style={{ width: "100%" }} /><Button type="link" danger={archiveDrafts[item.id]?.status === "active"} onClick={() => setArchiveDrafts((drafts) => ({ ...drafts, [item.id]: { ...drafts[item.id], status: drafts[item.id].status === "active" ? "inactive" : "active" } }))}>{archiveDrafts[item.id]?.status === "active" ? "删除" : "启用"}</Button></div>)}
      {newShareholders.map((item, index) => <div key={`new-${index}`} style={{ display: "grid", gridTemplateColumns: "1fr 230px 90px", gap: 18, alignItems: "center", padding: "12px", borderBottom: "1px solid #f0f0f0" }}><Input size="large" placeholder="股东姓名" value={item.name} onChange={(event) => setNewShareholders((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, name: event.target.value } : current))} /><InputNumber size="large" min={0} max={100} precision={2} placeholder="持股比例" value={item.holding_ratio ? Number(item.holding_ratio) : undefined} onChange={(value) => setNewShareholders((items) => items.map((current, itemIndex) => itemIndex === index ? { ...current, holding_ratio: String(value ?? "") } : current))} addonAfter="%" style={{ width: "100%" }} /><Button type="link" danger onClick={() => setNewShareholders((items) => items.filter((_, itemIndex) => itemIndex !== index))}>删除</Button></div>)}
      <Button size="large" style={{ marginTop: 16 }} onClick={() => setNewShareholders((items) => [...items, { name: "", holding_ratio: "", remark: "" }])}>＋ 添加股东</Button>
    </Modal>
    <Modal title="解锁月份" open={unlockOpen} onCancel={() => setUnlockOpen(false)} onOk={() => void unlockCurrent()} okText="确认解锁" cancelText="取消"><Typography.Paragraph>解锁后可以修改本月分红和注资数据，请填写解锁原因。</Typography.Paragraph><Input.TextArea rows={4} value={unlockReason} onChange={(event) => setUnlockReason(event.target.value)} placeholder="请输入解锁原因" /></Modal>
    <Modal title="分红管理操作留痕" open={auditOpen} onCancel={() => setAuditOpen(false)} footer={null} width={800}><Table rowKey="id" loading={auditLoading} pagination={{ pageSize: 10 }} dataSource={auditLogs} columns={[{ title: "时间", dataIndex: "created_at" }, { title: "操作人", dataIndex: "actor" }, { title: "动作", dataIndex: "action" }, { title: "说明", dataIndex: "summary" }]} locale={{ emptyText: "暂无操作留痕" }} /></Modal>
  </AppShell>;
}
