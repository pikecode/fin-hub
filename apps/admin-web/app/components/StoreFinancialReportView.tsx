"use client";

import dynamic from "next/dynamic";
import { Alert, Button, Card, Empty, Image, Modal, Space, Table, Tag, Typography, message } from "antd";
import { DownloadOutlined, EyeOutlined, FilePdfOutlined, InfoCircleOutlined, PaperClipOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ExpenseItem, MajorExpenseVoucher, StoreLedgerWorkspace } from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";
import { MetricCard } from "./MetricCard";
import { apiClient } from "../lib/api";

const RevenueChannelStackChart = dynamic(
  () => import("./RevenueChannelStackChart").then((module) => module.RevenueChannelStackChart),
  { ssr: false, loading: () => <Card loading style={{ minHeight: 360 }} /> },
);
const ExpenseCategoryBarChart = dynamic(
  () => import("./ExpenseCategoryBarChart").then((module) => module.ExpenseCategoryBarChart),
  { ssr: false, loading: () => <Card loading style={{ minHeight: 360 }} /> },
);

interface CategoryRow {
  key: string;
  name: string;
  amount: string;
  item_count: number;
  share: string;
  revenue_share: string;
  children?: CategoryRow[];
}

interface ExpenseVoucherState {
  loading: boolean;
  attachments: Attachment[];
  previewUrls: Record<string, string>;
}

function ratio(value: number, denominator: number) {
  return denominator > 0 ? `${((value / denominator) * 100).toFixed(2)}%` : "/";
}

function escapeHtml(value: unknown) {
  return String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function isImageAttachment(attachment: Pick<Attachment, "content_type" | "file_name">) {
  return Boolean(
    attachment.content_type?.startsWith("image/")
      || attachment.file_name?.match(/\.(apng|avif|gif|jpe?g|png|webp)$/i),
  );
}

export interface StoreFinancialReportViewProps {
  storeId: string;
  period: string;
}

export function StoreFinancialReportView({ storeId, period }: StoreFinancialReportViewProps) {
  const [data, setData] = useState<StoreLedgerWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExpenseItem[]>([]);
  const [detailTitle, setDetailTitle] = useState("");
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isDetailLoading, setIsDetailLoading] = useState(false);
  const [detailVoucherState, setDetailVoucherState] = useState<Record<string, ExpenseVoucherState>>({});
  const [voucherAttachments, setVoucherAttachments] = useState<Attachment[]>([]);
  const [voucherPreviewUrls, setVoucherPreviewUrls] = useState<Record<string, string>>({});
  const [voucherPreviewLoading, setVoucherPreviewLoading] = useState(false);
  const [voucherModalTitle, setVoucherModalTitle] = useState("报销凭证");
  const [isVoucherOpen, setIsVoucherOpen] = useState(false);
  const detailVoucherStateRef = useRef<Record<string, ExpenseVoucherState>>({});
  const voucherPreviewUrlsRef = useRef<Record<string, string>>({});
  const [majorExpenseVouchers, setMajorExpenseVouchers] = useState<MajorExpenseVoucher[]>([]);
  const [isMajorExpenseVoucherLoading, setIsMajorExpenseVoucherLoading] = useState(false);

  useEffect(() => {
    let ignore = false;
    setIsLoading(true);
    setData(null);
    setErrorMessage(null);
    apiClient.storeLedgers.workspace(storeId, `?period=${encodeURIComponent(period)}`)
      .then((workspace) => { if (!ignore) setData(workspace); })
      .catch((error) => { if (!ignore) setErrorMessage(error instanceof Error ? error.message : "报表加载失败"); })
      .finally(() => { if (!ignore) setIsLoading(false); });
    return () => { ignore = true; };
  }, [period, storeId]);

  useEffect(() => {
    let ignore = false;
    setIsMajorExpenseVoucherLoading(true);
    setMajorExpenseVouchers([]);
    const params = new URLSearchParams({ store_id: storeId, ledger_period: period });
    apiClient.expenseItems.majorExpenseVouchers.list(`?${params.toString()}`)
      .then((items) => { if (!ignore) setMajorExpenseVouchers(items); })
      .catch((error) => { if (!ignore) message.error(error instanceof Error ? error.message : "主要支出凭证加载失败"); })
      .finally(() => { if (!ignore) setIsMajorExpenseVoucherLoading(false); });
    return () => { ignore = true; };
  }, [period, storeId]);

  useEffect(() => {
    detailVoucherStateRef.current = detailVoucherState;
  }, [detailVoucherState]);

  useEffect(() => {
    voucherPreviewUrlsRef.current = voucherPreviewUrls;
  }, [voucherPreviewUrls]);

  useEffect(() => {
    return () => {
      Object.values(detailVoucherStateRef.current).forEach((state) => {
        Object.values(state.previewUrls).forEach((url) => URL.revokeObjectURL(url));
      });
      Object.values(voucherPreviewUrlsRef.current).forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const metrics = data?.metrics;
  const categoryRows = useMemo<CategoryRow[]>(() => {
    if (!metrics) return [];
    const roots = new Map<string, CategoryRow>();
    const totalExpense = Number(metrics.expense_amount || 0);
    const totalIncome = Number(metrics.income_amount || 0);
    metrics.expense_category_summary.forEach((item) => {
      const [rootName, childName] = item.name.split(" / ");
      const root = roots.get(rootName) ?? { key: rootName, name: rootName, amount: "0", item_count: 0, share: "/", revenue_share: "/", children: [] };
      root.amount = String(Number(root.amount) + Number(item.amount || 0));
      root.item_count += item.item_count;
      if (childName) root.children!.push({ key: item.name, name: childName, amount: item.amount, item_count: item.item_count, share: ratio(Number(item.amount), totalExpense), revenue_share: ratio(Number(item.amount), totalIncome) });
      roots.set(rootName, root);
    });
    return [...roots.values()].map((item) => ({ ...item, share: ratio(Number(item.amount), totalExpense), revenue_share: ratio(Number(item.amount), totalIncome), children: item.children?.sort((a, b) => Number(b.amount) - Number(a.amount)) })).sort((a, b) => Number(b.amount) - Number(a.amount));
  }, [metrics]);

  const stats = useMemo(() => {
    if (!metrics) return null;
    const income = Number(metrics.income_amount || 0);
    const expense = Number(metrics.expense_amount || 0);
    return { income, netIncome: Number(metrics.revenue_net_amount || 0), fee: Number(metrics.fee_amount || 0), expense, grossProfit: Number(metrics.gross_profit_amount || 0), netProfit: income - expense };
  }, [metrics]);

  const majorExpenseVoucherStats = useMemo(() => ({
    count: majorExpenseVouchers.length,
    totalAmount: majorExpenseVouchers.reduce((total, item) => total + Number(item.display_amount || 0), 0),
    attachmentCount: majorExpenseVouchers.reduce((total, item) => total + Number(item.attachment_count || 0), 0),
  }), [majorExpenseVouchers]);

  function revokeDetailVoucherState(states: Record<string, ExpenseVoucherState>) {
    Object.values(states).forEach((state) => {
      Object.values(state.previewUrls).forEach((url) => URL.revokeObjectURL(url));
    });
  }

  async function loadExpenseVoucherState(expenseItemId: string): Promise<ExpenseVoucherState> {
    const result = await apiClient.attachments.list(`?resource_type=expense_item&resource_id=${encodeURIComponent(expenseItemId)}&page_size=100`);
    const entries = await Promise.all(result.items.filter(isImageAttachment).map(async (attachment) => {
      try {
        const blob = await apiClient.attachments.download(attachment.id);
        return [attachment.id, URL.createObjectURL(blob)] as const;
      } catch {
        return [attachment.id, ""] as const;
      }
    }));
    return {
      loading: false,
      attachments: result.items,
      previewUrls: Object.fromEntries(entries.filter(([, url]) => url)),
    };
  }

  async function preloadDetailVouchers(items: ExpenseItem[]) {
    const targets = items.filter((item) => Number(item.voucher_count || 0) > 0);
    setDetailVoucherState((current) => {
      revokeDetailVoucherState(current);
      return Object.fromEntries(targets.map((item) => [item.id, { loading: true, attachments: [], previewUrls: {} }]));
    });
    const entries = await Promise.all(targets.map(async (item) => {
      try {
        return [item.id, await loadExpenseVoucherState(item.id)] as const;
      } catch {
        return [item.id, { loading: false, attachments: [], previewUrls: {} } satisfies ExpenseVoucherState] as const;
      }
    }));
    setDetailVoucherState((current) => {
      revokeDetailVoucherState(current);
      return Object.fromEntries(entries);
    });
  }

  async function openCategoryDetail(category: CategoryRow) {
    if (!storeId || !data) return;
    setDetailTitle(category.name);
    setIsDetailOpen(true);
    setIsDetailLoading(true);
    try {
      const query = new URLSearchParams({ detail_type: "category", store_id: storeId, period_start: data.period, period_end: data.period, category_l1: category.children?.length ? category.name : categoryRows.find((row) => row.children?.some((child) => child.key === category.key))?.name || category.name, page_size: "500" });
      const child = categoryRows.flatMap((row) => row.children ?? []).find((item) => item.key === category.key);
      if (child) query.set("category_l2", child.name);
      const result = await apiClient.reports.analyticsDetails(`?${query.toString()}`);
      setDetail(result.expense_items);
      void preloadDetailVouchers(result.expense_items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "无法加载费用明细");
    } finally {
      setIsDetailLoading(false);
    }
  }

  function replaceVoucherPreviewUrls(nextUrls: Record<string, string>) {
    setVoucherPreviewUrls((current) => {
      Object.values(current).forEach((url) => URL.revokeObjectURL(url));
      return nextUrls;
    });
  }

  async function openAttachment(attachment: Attachment) {
    try {
      const blob = await apiClient.attachments.download(attachment.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.file_name || "报销凭证";
      link.target = "_blank";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "凭证打开失败");
    }
  }

  async function openVouchersById(resourceId: string, title = "报销凭证") {
    try {
      setVoucherModalTitle(title);
      const result = await apiClient.attachments.list(`?resource_type=expense_item&resource_id=${encodeURIComponent(resourceId)}&page_size=100`);
      setVoucherAttachments(result.items);
      replaceVoucherPreviewUrls({});
      setIsVoucherOpen(true);
      const imageAttachments = result.items.filter(isImageAttachment);
      if (!imageAttachments.length) return;
      setVoucherPreviewLoading(true);
      const entries = await Promise.all(imageAttachments.map(async (attachment) => {
        try {
          const blob = await apiClient.attachments.download(attachment.id);
          return [attachment.id, URL.createObjectURL(blob)] as const;
        } catch {
          return [attachment.id, ""] as const;
        }
      }));
      replaceVoucherPreviewUrls(Object.fromEntries(entries.filter(([, url]) => url)));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "无法加载报销凭证");
    } finally {
      setVoucherPreviewLoading(false);
    }
  }


  async function openVouchers(item: ExpenseItem) {
    await openVouchersById(item.id, "报销凭证");
  }

  function closeVoucherModal() {
    setIsVoucherOpen(false);
    setVoucherAttachments([]);
    replaceVoucherPreviewUrls({});
  }

  function exportPercent(value: string | number | null | undefined) {
    return value == null || value === "" ? "/" : `${value}%`;
  }

  function exportBar(value: string | number | null | undefined, color = "#0f766e") {
    const numericValue = Math.max(0, Math.min(Number(value || 0), 100));
    return `<div class="bar"><span style="width:${numericValue}%;background:${color}"></span></div>`;
  }

  function reportHtml() {
    if (!data || !stats) return null;
    const overviewRows = [
      ["营业收入", formatMoney(stats.income)], ["实收", formatMoney(stats.netIncome)], ["手续费", formatMoney(stats.fee)],
      ["总支出", formatMoney(stats.expense)], ["毛利", formatMoney(stats.grossProfit)], ["净利润", formatMoney(stats.netProfit)],
      ["手续费率", exportPercent(stats.income > 0 ? ((stats.fee / stats.income) * 100).toFixed(2) : null)],
      ["毛利率", exportPercent(stats.income > 0 ? ((stats.grossProfit / stats.income) * 100).toFixed(2) : null)],
      ["净利润率", exportPercent(stats.income > 0 ? ((stats.netProfit / stats.income) * 100).toFixed(2) : null)],
      ["同比", exportPercent(metrics!.income_year_over_year)], ["环比", exportPercent(metrics!.income_month_over_month)],
    ].map(([name, value]) => `<div class="metric"><span>${name}</span><b>${value}</b></div>`).join("");
    const channelRows = metrics!.revenue_channel_summary.map((item) => `<tr><td>${escapeHtml(item.channel)}</td><td>${formatMoney(item.gross_amount)}</td><td>${formatMoney(item.net_amount)}</td><td>${formatMoney(item.fee_amount)}</td><td>${exportPercent(item.fee_rate)}</td><td>${ratio(Number(item.gross_amount), stats.income)}</td></tr>`).join("");
    const channelMax = Math.max(...metrics!.revenue_channel_summary.map((item) => Number(item.gross_amount || 0)), 0);
    const channelChartRows = metrics!.revenue_channel_summary.map((item) => `<div class="chart-row"><span class="chart-label">${escapeHtml(item.channel)}</span><div class="chart-track"><span style="width:${channelMax > 0 ? (Number(item.gross_amount) / channelMax) * 100 : 0}%;background:#0f766e"></span></div><b>${formatMoney(item.gross_amount)}</b></div>`).join("");
    const coreCosts = [["食材成本", metrics!.food_cost_amount, metrics!.food_cost_rate], ["人工成本", metrics!.labor_cost_amount, metrics!.labor_cost_rate], ["租金成本", metrics!.rent_cost_amount, metrics!.rent_cost_rate], ["运营费用", metrics!.operation_expense_amount, metrics!.operation_expense_rate]];
    const coreCostRows = coreCosts.map(([name, amount, rate]) => `<tr><td>${name}</td><td>${formatMoney(String(amount))}</td><td>${exportBar(rate, "#d9482b")}</td><td>${exportPercent(rate)}</td></tr>`).join("");
    const foodRows = [["鸡肉", metrics!.chicken_cost_amount, metrics!.chicken_cost_rate], ["菌子", metrics!.mushroom_cost_amount, metrics!.mushroom_cost_rate]].map(([name, amount, rate]) => `<tr><td>${name}</td><td>${formatMoney(String(amount))}</td><td>${exportBar(rate)}</td><td>${exportPercent(rate)}</td></tr>`).join("");
    const categoryRowsHtml = categoryRows.flatMap((item) => [item, ...(item.children ?? [])]).map((item) => `<tr><td class="${item.children ? "root" : "child"}">${escapeHtml(item.name)}</td><td>${formatMoney(item.amount)}</td><td>${item.item_count}</td><td>${item.revenue_share}</td><td>${item.share}</td></tr>`).join("");
    const categoryMax = Math.max(...categoryRows.filter((item) => item.children?.length).map((item) => Number(item.amount || 0)), 0);
    const categoryChartRows = categoryRows.filter((item) => item.children?.length).map((item) => `<div class="chart-row"><span class="chart-label">${escapeHtml(item.name)}</span><div class="chart-track"><span style="width:${categoryMax > 0 ? (Number(item.amount) / categoryMax) * 100 : 0}%;background:#d9482b"></span></div><b>${formatMoney(item.amount)}</b></div>`).join("");
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(data.store.name)}-${data.period}-门店财务报表</title><style>@page{size:A4;margin:14mm}body{font-family:Arial,"Microsoft YaHei",sans-serif;color:#172033;max-width:1120px;margin:auto;padding:24px}h1{margin:0 0 6px;font-size:28px}h2{margin:30px 0 12px;border-left:4px solid #0f766e;padding-left:10px;font-size:18px}.meta{color:#64748b;margin-bottom:24px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.metric{padding:14px;border:1px solid #e2e8f0;border-radius:8px;background:#f8fafc}.metric span{color:#64748b}.metric b{display:block;font-size:21px;margin-top:7px}.bar{height:9px;min-width:130px;background:#f1f5f9;border-radius:99px;overflow:hidden}.bar span{display:block;height:100%;border-radius:99px}.chart-row{display:grid;grid-template-columns:130px 1fr 100px;gap:12px;align-items:center;margin:10px 0}.chart-label{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#475569}.chart-track{height:14px;background:#f1f5f9;border-radius:99px;overflow:hidden}.chart-track span{display:block;height:100%;border-radius:99px}.chart-row b{text-align:right;font-weight:600}table{width:100%;border-collapse:collapse;margin-bottom:8px}th,td{padding:9px;border-bottom:1px solid #e5e7eb;text-align:left}th{background:#f1f5f9;color:#475569}.root{font-weight:700}.child{padding-left:28px;color:#475569}.note{color:#64748b;font-size:12px;margin-top:24px}@media(max-width:800px){.metrics{grid-template-columns:repeat(2,1fr)}.chart-row{grid-template-columns:90px 1fr 80px}}@media print{body{padding:0}.section{break-inside:avoid}}</style></head><body><h1>${escapeHtml(data.store.name)} 门店财务报表</h1><div class="meta">账期：${formatPeriod(data.period)}　生成时间：${dayjs().format("YYYY-MM-DD HH:mm")}　口径：收入按录入日期，支出按入账月份，门店预充值不计入支出</div><h2>总览指标</h2><div class="metrics">${overviewRows}</div><h2>营业收入渠道</h2><div>${channelChartRows || "暂无收入数据"}</div><table><thead><tr><th>渠道</th><th>经营收入</th><th>实收</th><th>手续费</th><th>手续费率</th><th>收入占比</th></tr></thead><tbody>${channelRows}</tbody></table><h2>核心成本率结构</h2><table><thead><tr><th>成本项目</th><th>金额</th><th>成本率图示</th><th>成本率</th></tr></thead><tbody>${coreCostRows}</tbody></table><h2>核心食材</h2><table><thead><tr><th>食材</th><th>支出金额</th><th>占比图示</th><th>占营业收入</th></tr></thead><tbody>${foodRows}</tbody></table><h2>各类别支出统计</h2><div>${categoryChartRows || "暂无费用数据"}</div><table><thead><tr><th>费用分类</th><th>金额</th><th>条数</th><th>占营业收入</th><th>占总支出</th></tr></thead><tbody>${categoryRowsHtml}</tbody></table>${majorExpenseVouchers.length ? `<h2>主要支出凭证</h2><p class="note">仅作凭证归档和金额展示，不计入总支出、毛利和净利润。</p><div class="metrics"><div class="metric"><span>凭证记录</span><b>${majorExpenseVoucherStats.count}</b></div><div class="metric"><span>展示总金额</span><b>${formatMoney(majorExpenseVoucherStats.totalAmount)}</b></div><div class="metric"><span>附件</span><b>${majorExpenseVoucherStats.attachmentCount} 份</b></div></div><table><thead><tr><th>费用名称</th><th>所属账期</th><th>总金额</th><th>附件</th><th>备注</th><th>录入时间</th></tr></thead><tbody>${majorExpenseVouchers.map((item) => `<tr><td>${escapeHtml(item.expense_name)}</td><td>${escapeHtml(item.ledger_period)}</td><td>${formatMoney(item.display_amount)}</td><td>${item.attachment_count} 份</td><td>${escapeHtml(item.remark || "-")}</td><td>${formatDateTime(item.created_at)}</td></tr>`).join("")}</tbody></table>` : ""}<div class="note">报表导出与页面使用同一账期和统计口径。分类明细可在报表页面点击对应分类查看。</div></body></html>`;
  }

  function exportHtml() {
    const html = reportHtml();
    if (!html || !data) return;
    const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
    const link = document.createElement("a"); link.href = url; link.download = `${data.store.name}-${data.period}-门店财务报表.html`; link.click(); URL.revokeObjectURL(url);
  }

  function exportPdf() {
    const html = reportHtml();
    if (!html) return;
    const printWindow = window.open("", "_blank");
    if (!printWindow) { message.warning("请允许浏览器弹出窗口后再导出 PDF"); return; }
    printWindow.document.write(html); printWindow.document.close(); printWindow.focus(); printWindow.print();
  }

  function renderDetailVoucherCell(value: number | undefined, record: ExpenseItem) {
    const count = Number(value || 0);
    if (!count) return "无";
    const state = detailVoucherState[record.id];
    if (!state || state.loading) return <Typography.Text type="secondary">凭证加载中...</Typography.Text>;
    const imageAttachments = state.attachments.filter(isImageAttachment);
    const fileCount = state.attachments.length - imageAttachments.length;
    return (
      <Space size={6} wrap>
        {imageAttachments.slice(0, 3).map((attachment) => {
          const previewUrl = state.previewUrls[attachment.id];
          return previewUrl ? (
            <Image
              key={attachment.id}
              src={previewUrl}
              alt={attachment.file_name || "报销凭证"}
              width={44}
              height={44}
              preview={{ mask: <EyeOutlined /> }}
              style={{ objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb" }}
            />
          ) : null;
        })}
        {fileCount > 0 ? <Tag color="blue" icon={<PaperClipOutlined />}>{fileCount} 个文件</Tag> : null}
        <Button type="link" size="small" onClick={() => void openVouchers(record)}>{count} 份 · 查看</Button>
      </Space>
    );
  }

  function renderMajorVoucherAttachmentCell(record: MajorExpenseVoucher) {
    const count = Number(record.attachment_count || 0);
    if (!count) return <Tag>未上传</Tag>;
    const state = detailVoucherState[record.id];
    if (!state || state.loading) return <Typography.Text type="secondary">附件加载中...</Typography.Text>;
    const imageAttachments = state.attachments.filter(isImageAttachment);
    const fileCount = state.attachments.length - imageAttachments.length;
    return (
      <Space size={6} wrap>
        {imageAttachments.slice(0, 3).map((attachment) => {
          const previewUrl = state.previewUrls[attachment.id];
          return previewUrl ? (
            <Image
              key={attachment.id}
              src={previewUrl}
              alt={attachment.file_name || "主要支出凭证"}
              width={44}
              height={44}
              preview={{ mask: <EyeOutlined /> }}
              style={{ objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb" }}
            />
          ) : null;
        })}
        {fileCount > 0 ? <Tag color="blue" icon={<PaperClipOutlined />}>{fileCount} 个文件</Tag> : null}
        <Button type="link" size="small" onClick={() => void openVouchersById(record.id, `主要支出凭证 · ${record.expense_name}`)}>{count} 份 · 查看</Button>
      </Space>
    );
  }

  const majorExpenseVoucherColumns = [
    { title: "费用名称", dataIndex: "expense_name", ellipsis: true },
    { title: "所属账期", dataIndex: "ledger_period", width: 110 },
    { title: "总金额", dataIndex: "display_amount", width: 140, align: "right" as const, render: (value: string) => formatMoney(value) },
    { title: "附件", dataIndex: "attachment_count", width: 220, render: (_value: number | undefined, record: MajorExpenseVoucher) => renderMajorVoucherAttachmentCell(record) },
    { title: "备注", dataIndex: "remark", ellipsis: true, render: (value: string | null) => value || "-" },
    { title: "录入时间", dataIndex: "created_at", width: 170, render: (value: string) => formatDateTime(value) },
  ];

  const detailColumns = [
    { title: "日期", dataIndex: "expense_date", width: 120, render: (value: string | null) => value || "-" },
    { title: "费用内容", dataIndex: "description", ellipsis: true },
    { title: "金额", dataIndex: "amount", width: 140, align: "right" as const, render: (value: string) => formatMoney(value) },
    { title: "报销凭证", dataIndex: "voucher_count", width: 220, render: (value: number | undefined, record: ExpenseItem) => renderDetailVoucherCell(value, record) },
  ];

  useEffect(() => {
    const targets = majorExpenseVouchers.filter((item) => Number(item.attachment_count || 0) > 0);
    if (!targets.length) {
      setDetailVoucherState((current) => {
        const next = Object.fromEntries(Object.entries(current).filter(([id]) => detail.some((item) => item.id === id)));
        return next;
      });
      return;
    }
    setDetailVoucherState((current) => ({
      ...current,
      ...Object.fromEntries(targets.filter((item) => !current[item.id]).map((item) => [item.id, { loading: true, attachments: [], previewUrls: {} } satisfies ExpenseVoucherState])),
    }));
    void Promise.all(targets.map(async (item) => {
      if (detailVoucherState[item.id]?.attachments?.length || detailVoucherState[item.id]?.loading === false) return;
      try {
        const state = await loadExpenseVoucherState(item.id);
        setDetailVoucherState((current) => ({ ...current, [item.id]: state }));
      } catch {
        setDetailVoucherState((current) => ({ ...current, [item.id]: { loading: false, attachments: [], previewUrls: {} } }));
      }
    }));
  }, [majorExpenseVouchers]);

  return (
    <div className="store-financial-report-view">
      {errorMessage ? <Alert type="error" showIcon message="报表加载失败" description={errorMessage} /> : null}
      {isLoading ? <div className="store-financial-report__loading"><Card loading /><Card loading /></div> : data && metrics && stats ? <>
        <div className="store-financial-report__hero"><div><Typography.Text className="store-financial-report__eyebrow">门店财务报表 · {formatPeriod(data.period)}</Typography.Text><Typography.Title level={2}>经营全景</Typography.Title><Typography.Text type="secondary">收入按录入日期统计，支出按入账月份统计，门店预充值已排除。</Typography.Text></div><div className="store-financial-report__hero-actions"><Tag color={data.selected_ledger?.status === "closed" ? "green" : "gold"}>{data.selected_ledger?.status === "closed" ? "已封账" : "进行中"}</Tag><Button icon={<DownloadOutlined />} onClick={exportHtml}>导出 HTML</Button><Button type="primary" icon={<FilePdfOutlined />} onClick={exportPdf}>导出 PDF</Button></div></div>
        <section className="store-financial-report__section"><div className="store-financial-report__section-heading"><div><Typography.Title level={4}>总览指标</Typography.Title><Typography.Text type="secondary">本账期经营收入、支出与利润表现</Typography.Text></div></div><div className="store-ledger-report-metrics"><MetricCard title="营业收入" value={formatMoney(stats.income)} unit="元" status="normal" /><MetricCard title="实收" value={formatMoney(stats.netIncome)} unit="元" status="normal" /><MetricCard title="手续费" value={formatMoney(stats.fee)} unit="元" status="warning" /><MetricCard title="总支出" value={formatMoney(stats.expense)} unit="元" status="warning" /><MetricCard title="毛利" value={formatMoney(stats.grossProfit)} unit="元" status={stats.grossProfit >= 0 ? "normal" : "danger"} /><MetricCard title="净利润" value={formatMoney(stats.netProfit)} unit="元" status={stats.netProfit >= 0 ? "normal" : "danger"} /><MetricCard title="手续费率" value={stats.income > 0 ? `${((stats.fee / stats.income) * 100).toFixed(2)}%` : "/"} /><MetricCard title="毛利率" value={stats.income > 0 ? `${((stats.grossProfit / stats.income) * 100).toFixed(2)}%` : "/"} /><MetricCard title="净利润率" value={stats.income > 0 ? `${((stats.netProfit / stats.income) * 100).toFixed(2)}%` : "/"} /><MetricCard title="同比" value={metrics.income_year_over_year == null ? "/" : `${metrics.income_year_over_year}%`} /><MetricCard title="环比" value={metrics.income_month_over_month == null ? "/" : `${metrics.income_month_over_month}%`} /></div></section>
        <div className="store-financial-report__grid"><Card title="营业收入渠道"><RevenueChannelStackChart data={metrics.revenue_channel_summary} height={330} /></Card><Card title="核心成本率结构"><div className="store-financial-report__cost-list">{[["食材成本", metrics.food_cost_amount, metrics.food_cost_rate], ["人工成本", metrics.labor_cost_amount, metrics.labor_cost_rate], ["租金成本", metrics.rent_cost_amount, metrics.rent_cost_rate], ["运营费用", metrics.operation_expense_amount, metrics.operation_expense_rate]].map(([name, amount, rate]) => <div className="store-financial-report__cost-item" key={String(name)}><div><Typography.Text strong>{name}</Typography.Text><Typography.Text type="secondary">{formatMoney(String(amount))}</Typography.Text></div><div className="store-financial-report__bar"><span style={{ width: `${Math.min(Number(rate || 0), 100)}%` }} /></div><Typography.Text type="secondary">{rate == null ? "/" : `${rate}%`}</Typography.Text></div>)}</div></Card></div>
        <Card title="各渠道经营收入明细" className="store-financial-report__category-card"><Table rowKey="channel" size="middle" pagination={false} dataSource={metrics.revenue_channel_summary} columns={[{ title: "收入渠道", dataIndex: "channel" }, { title: "经营收入", dataIndex: "gross_amount", align: "right" as const, render: (value: string) => `${formatMoney(value)}` }, { title: "手续费", dataIndex: "fee_amount", align: "right" as const, render: (value: string) => `${formatMoney(value)}` }, { title: "手续费率", dataIndex: "fee_rate", align: "right" as const, render: (value: string) => `${value}%` }, { title: "收入占比", align: "right" as const, render: (_value: unknown, record) => ratio(Number(record.gross_amount), stats.income) }]} /></Card>
        <div className="store-financial-report__grid"><ExpenseCategoryBarChart title="支出分类排行" data={categoryRows.map((item) => ({ name: item.name, value: Number(item.amount) }))} height={330} /><Card title="核心食材"><div className="store-financial-report__food-grid">{[["鸡肉", metrics.chicken_cost_amount, metrics.chicken_cost_rate], ["菌子", metrics.mushroom_cost_amount, metrics.mushroom_cost_rate]].map(([name, amount, rate]) => <div className="store-financial-report__food-card" key={String(name)}><Typography.Text type="secondary">{name}支出</Typography.Text><Typography.Title level={3}>{formatMoney(String(amount))}</Typography.Title><div className="store-financial-report__food-bar"><span style={{ width: `${Math.min(Number(rate || 0), 100)}%` }} /></div><Tag color="blue">占营业收入 {rate == null ? "/" : `${rate}%`}</Tag></div>)}</div></Card></div>
        <Card title="各类别支出统计" className="store-financial-report__category-card"><Table rowKey="key" size="middle" columns={[{ title: "费用分类", dataIndex: "name", render: (value: string, record: CategoryRow) => <Button type="link" onClick={() => void openCategoryDetail(record)}>{value}</Button> }, { title: "金额", dataIndex: "amount", align: "right" as const, render: (value: string) => `${formatMoney(value)}` }, { title: "占营业收入", dataIndex: "revenue_share", align: "right" as const }, { title: "占总支出", dataIndex: "share", align: "right" as const }, { title: "条数", dataIndex: "item_count", align: "right" as const, width: 90 }]} dataSource={categoryRows} expandable={{ childrenColumnName: "children", onExpand: (_expanded, record) => { if (!record.children?.length) void openCategoryDetail(record); } }} pagination={false} /></Card>
        <Card
          className="store-financial-report__major-voucher-card"
          title="主要支出凭证"
          extra={<Tag color="blue">仅展示，不计入报表</Tag>}
        >
          <Alert
            type="info"
            showIcon
            className="store-financial-report__major-voucher-alert"
            message="主要支出凭证仅用于归档和金额展示，不计入总支出、毛利和净利润。"
          />
          <div className="store-financial-report__major-voucher-note">
            <span className="store-financial-report__major-voucher-note-icon"><InfoCircleOutlined /></span>
            <div className="store-financial-report__major-voucher-note-main">
              <Typography.Text strong>本账期共 {majorExpenseVoucherStats.count} 条主要支出凭证，展示金额合计 {formatMoney(majorExpenseVoucherStats.totalAmount)}。</Typography.Text>
              <Typography.Text type="secondary">这些金额仅用于凭证归档，不参与总支出、毛利和净利润计算。</Typography.Text>
            </div>
          </div>
          <Table
            rowKey="id"
            size="middle"
            loading={isMajorExpenseVoucherLoading}
            columns={majorExpenseVoucherColumns}
            dataSource={majorExpenseVouchers}
            pagination={majorExpenseVouchers.length > 8 ? { pageSize: 8 } : false}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无主要支出凭证" /> }}
          />
        </Card>
      </> : isLoading ? <Card loading /> : <Empty description="暂无报表数据" />}
      <Modal title={`${detailTitle} · 费用明细`} open={isDetailOpen} onCancel={() => setIsDetailOpen(false)} footer={null} width={900}><Table rowKey="id" loading={isDetailLoading} columns={detailColumns} dataSource={detail} pagination={{ pageSize: 10 }} /></Modal>
      <Modal title={voucherModalTitle} open={isVoucherOpen} onCancel={closeVoucherModal} footer={null} width={760}>
        <Table
          rowKey="id"
          dataSource={voucherAttachments}
          pagination={false}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无凭证" /> }}
          columns={[
            {
              title: "凭证",
              dataIndex: "file_name",
              render: (value: string, record: Attachment) => {
                const isImage = isImageAttachment(record);
                const previewUrl = voucherPreviewUrls[record.id];
                return (
                  <Space size={12}>
                    {isImage ? (
                      previewUrl ? (
                        <Image
                          src={previewUrl}
                          alt={value || "报销凭证"}
                          width={72}
                          height={72}
                          preview={{ mask: <EyeOutlined /> }}
                          style={{ objectFit: "cover", borderRadius: 8, border: "1px solid #e5e7eb" }}
                        />
                      ) : (
                        <div className="report-voucher-thumb-placeholder">{voucherPreviewLoading ? "加载中" : "图片"}</div>
                      )
                    ) : (
                      <div className="report-voucher-file-icon"><PaperClipOutlined /></div>
                    )}
                    <div>
                      <Typography.Text strong ellipsis style={{ maxWidth: 360 }}>{value || "报销凭证"}</Typography.Text>
                      <br />
                      <Typography.Text type="secondary">{record.content_type || (isImage ? "图片凭证" : "文件凭证")}</Typography.Text>
                    </div>
                  </Space>
                );
              },
            },
            {
              title: "操作",
              width: 120,
              render: (_value: unknown, record: Attachment) => (
                <Button type="link" onClick={() => void openAttachment(record)}>打开/下载</Button>
              ),
            },
          ]}
        />
      </Modal>
    </div>
  );
}
