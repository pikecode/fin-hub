"use client";

import dynamic from "next/dynamic";
import { Alert, Button, Card, Empty, Image, InputNumber, Modal, Space, Table, Tag, Typography, message } from "antd";
import { DownloadOutlined, EyeOutlined, FilePdfOutlined, InfoCircleOutlined, PaperClipOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Attachment, ExpenseItem, MajorExpenseVoucher, StoreLedgerWorkspace, FinancialReportSupplement, FinancialReportAppendix } from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";
import { financialReportHtml, reportGroups } from "./financialReportPresentation";
import { paginateFinancialReport } from "./financialReportPagination";
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

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function isImageAttachment(attachment: Pick<Attachment, "content_type" | "file_name">) {
  return Boolean(
    attachment.content_type?.startsWith("image/")
      || attachment.file_name?.match(/\.(apng|avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i),
  );
}

function externalAttachmentUrl(attachment: Attachment): string | null {
  const value = attachment.external_file_id;
  if (!value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  try {
    const parsed = JSON.parse(value);
    const url = parsed?.url ?? parsed?.downloadUrl ?? parsed?.download_url;
    return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return null;
  }
}

export interface StoreFinancialReportViewProps {
  storeId: string;
  period: string;
}

export function StoreFinancialReportView({ storeId, period }: StoreFinancialReportViewProps) {
  const [data, setData] = useState<StoreLedgerWorkspace | null>(null);
  const [supplement, setSupplement] = useState<FinancialReportSupplement | null>(null);
  const [targetOpen, setTargetOpen] = useState(false);
  const [targetValue, setTargetValue] = useState<string | null>(null);
  const [targetSaving, setTargetSaving] = useState(false);
  const [targetError, setTargetError] = useState<string | null>(null);
  const [isHtmlExporting, setIsHtmlExporting] = useState(false);
  const [expandedCategories, setExpandedCategories] = useState<string[]>([]);
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
  const [isPdfExporting, setIsPdfExporting] = useState(false);

  useEffect(() => {
    let ignore = false;
    setIsLoading(true);
    setData(null);
    setErrorMessage(null);
    setSupplement(null);
    setTargetOpen(false);
    Promise.all([
      apiClient.storeLedgers.report(storeId, `?period=${encodeURIComponent(period)}`),
      apiClient.reports.financialSupplement(storeId, period),
    ]).then(([workspace, extra]) => { if (!ignore) { setData(workspace); setSupplement(extra); } })
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

  useEffect(() => {
    setExpandedCategories(categoryRows.filter((item) => item.children?.length).map((item) => item.key));
  }, [categoryRows]);

  async function saveTarget() {
    if (targetSaving) return;
    setTargetSaving(true);
    setTargetError(null);
    const requestedStore = storeId;
    const requestedPeriod = period;
    try {
      const extra = await apiClient.reports.updateFinancialTarget(requestedStore, requestedPeriod, targetValue);
      setSupplement((current) => current?.store_id === extra.store_id && current.period === extra.period ? extra : current);
      setTargetOpen(false);
      message.success("业绩目标已保存");
    } catch (error) {
      setTargetError(error instanceof Error ? error.message : "业绩目标保存失败");
    } finally { setTargetSaving(false); }
  }

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
    const entries = await Promise.all(result.items.map(async (attachment) => {
      try {
        if (attachment.source === "dingtalk") {
          const url = externalAttachmentUrl(attachment) || (await apiClient.attachments.accessUrl(attachment.id)).url;
          if (/\.(apng|avif|gif|jpe?g|png|webp)(?:[?#].*)?$/i.test(url)) attachment.content_type = "image/*";
          return [attachment.id, url] as const;
        }
        const blob = await apiClient.attachments.download(attachment.id);
        if (blob.type.startsWith("image/")) attachment.content_type = blob.type;
        return [attachment.id, isImageAttachment(attachment) ? URL.createObjectURL(blob) : ""] as const;
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
      const query = new URLSearchParams({ detail_type: "report_expense", store_id: storeId, period_start: data.period, period_end: data.period, category_l1: category.children?.length ? category.name : categoryRows.find((row) => row.children?.some((child) => child.key === category.key))?.name || category.name, page_size: "500" });
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
      if (attachment.source === "dingtalk") {
        const url = externalAttachmentUrl(attachment) || (await apiClient.attachments.accessUrl(attachment.id)).url;
        window.open(url, "_blank", "noopener,noreferrer");
        return;
      }
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
      setVoucherPreviewLoading(true);
      const state = await loadExpenseVoucherState(resourceId);
      setVoucherAttachments(state.attachments);
      replaceVoucherPreviewUrls(state.previewUrls);
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

  function reportHtml(appendix: FinancialReportAppendix) {
    if (!data || !supplement) return null;
    return financialReportHtml(data, supplement, appendix, categoryRows, majorExpenseVouchers);
  }

  function downloadBlob(blob: Blob, filename: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
    URL.revokeObjectURL(url);
  }

  async function loadExportExpenseItems() {
    return apiClient.reports.financialAppendix(storeId, period);
  }

  async function exportHtml() {
    if (!data) return;
    setIsHtmlExporting(true);
    try {
      const expenseItems = await loadExportExpenseItems();
      const html = reportHtml(expenseItems);
      if (!html) return;
      downloadBlob(new Blob([html], { type: "text/html;charset=utf-8" }), `${data.store.name}-${data.period}-门店财务报表.html`);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "导出 HTML 失败");
    } finally { setIsHtmlExporting(false); }
  }

  async function exportPdf() {
    if (!data) return;
    setIsPdfExporting(true);
    try {
      const html = reportHtml(await loadExportExpenseItems());
      if (!html) return;
      const filename = `${data.store.name}-${data.period}-门店财务报表.pdf`;
      const iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      iframe.style.position = "fixed";
      iframe.style.left = "-10000px";
      iframe.style.top = "0";
      iframe.style.width = "800px";
      iframe.style.height = "900px";
      iframe.style.border = "0";
      document.body.appendChild(iframe);
      try {
        const frameDocument = iframe.contentDocument;
        if (!frameDocument) throw new Error("无法准备 PDF 页面");
        frameDocument.open();
        frameDocument.write(html);
        frameDocument.close();
        await frameDocument.fonts.ready;
        await new Promise((resolve) => window.requestAnimationFrame(() => resolve(undefined)));
        iframe.style.height = `${Math.max(frameDocument.documentElement.scrollHeight, 900)}px`;
        const { default: html2pdf } = await import("html2pdf.js");
        const options = {
          margin: [10, 12, 16, 12],
          filename,
          image: { type: "jpeg" as const, quality: 0.98 },
          html2canvas: {
            scale: frameDocument.documentElement.scrollHeight > 12000 ? 1.5 : 2,
            useCORS: true,
            backgroundColor: "#ffffff",
            windowWidth: 800,
          },
          jsPDF: { unit: "mm", format: "a4", orientation: "portrait" },
          pagebreak: { mode: ["css", "legacy"], avoid: [".report-header", "h2", "tr", ".metric", ".chart-row"] },
        } as Parameters<InstanceType<typeof html2pdf.Worker>["set"]>[0];
        const reportElement = frameDocument.querySelector<HTMLElement>(".financial-export");
        if (!reportElement) throw new Error("无法读取报表内容");
        // Styles travel with the source element when html2pdf clones it into the current document.
        const pages = paginateFinancialReport(reportElement);
        if (!pages.length) throw new Error("报表内容为空");
        const worker = html2pdf().set(options).from(pages[0]).toPdf();
        const pdf = await worker.get("pdf");
        for (const page of pages.slice(1)) {
          const canvas = await html2pdf().set(options).from(page).toCanvas().get("canvas");
          pdf.addPage();
          const imageWidth = 186;
          const imageHeight = imageWidth * canvas.height / canvas.width;
          const factor = Math.min(1, 265 / imageHeight);
          pdf.addImage(canvas.toDataURL("image/jpeg", 0.98), "JPEG", 12, 10, imageWidth * factor, imageHeight * factor);
        }
        const pageCount = pdf.internal.getNumberOfPages();
        for (let page = 1; page <= pageCount; page += 1) {
          pdf.setPage(page);
          pdf.setDrawColor(220, 231, 233);
          pdf.line(12, 283, 198, 283);
          pdf.setFontSize(8);
          pdf.setTextColor(110, 127, 137);
          pdf.text(`${data.period}  |  FINANCIAL REPORT`, 12, 289);
          pdf.text(`${page} / ${pageCount}`, 198, 289, { align: "right" });
        }
        pdf.save(filename);
      } finally {
        iframe.remove();
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "导出 PDF 失败");
    } finally {
      setIsPdfExporting(false);
    }
  }

  function renderDetailVoucherCell(value: number | undefined, record: ExpenseItem) {
    const count = Number(value || 0);
    if (!count) return "无";
    const state = detailVoucherState[record.id];
    if (!state || state.loading) return <Typography.Text type="secondary">凭证加载中...</Typography.Text>;
    const imageAttachments = state.attachments.filter(isImageAttachment);
    return (
      <Space size={8} wrap>
        <Image.PreviewGroup>
        {imageAttachments.map((attachment) => {
          const previewUrl = state.previewUrls[attachment.id];
          return previewUrl ? (
            <Image
              key={attachment.id}
              src={previewUrl}
              alt={attachment.file_name || "报销凭证"}
              width={56}
              height={72}
              preview={{ mask: <EyeOutlined /> }}
              style={{ objectFit: "cover", borderRadius: 6, border: "1px solid #e5e7eb" }}
            />
          ) : null;
        })}
        </Image.PreviewGroup>
        {state.attachments.filter((attachment) => !isImageAttachment(attachment)).map((attachment) => (
          <Button key={attachment.id} size="small" icon={<PaperClipOutlined />} onClick={() => void openAttachment(attachment)}>
            {attachment.file_name || "报销凭证"}
          </Button>
        ))}
        {imageAttachments.some((attachment) => !state.previewUrls[attachment.id]) || !state.attachments.length ? <Button type="link" size="small" onClick={() => void openVouchers(record)}>{count} 份 · 查看</Button> : null}
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
      <Modal title="设置本月业绩目标" open={targetOpen} onCancel={() => { if (!targetSaving) setTargetOpen(false); }} onOk={() => void saveTarget()} confirmLoading={targetSaving} cancelButtonProps={{ disabled: targetSaving }} maskClosable={!targetSaving} keyboard={!targetSaving} closable={!targetSaving} okText="保存" cancelText="取消">
        <Typography.Paragraph type="secondary">按当前门店、当前月份维护；清空表示未录入，目标为 0 时不计算完成率。</Typography.Paragraph>
        {targetError ? <Alert showIcon type="error" message={targetError} style={{ marginBottom: 16 }} /> : null}
        <InputNumber stringMode min="0" max="999999999999.99" precision={2} value={targetValue} onChange={(value) => setTargetValue(value == null ? null : String(value))} disabled={targetSaving} addonAfter="元" style={{ width: "100%" }} />
      </Modal>
      {errorMessage ? <Alert type="error" showIcon message="报表加载失败" description={errorMessage} /> : null}
      {isLoading ? <div className="store-financial-report__loading"><Card loading /><Card loading /></div> : data && metrics && stats && supplement ? <>
        <div className="store-financial-report__hero"><div><Typography.Text className="store-financial-report__eyebrow">门店财务报表 · {formatPeriod(data.period)}</Typography.Text><Typography.Title level={2}>经营全景</Typography.Title><Typography.Text type="secondary">收入按录入日期统计，支出按入账月份统计，门店预充值已排除。</Typography.Text></div><div className="store-financial-report__hero-actions"><Tag color={data.selected_ledger?.status === "closed" ? "green" : "gold"}>{data.selected_ledger?.status === "closed" ? "已封账" : "进行中"}</Tag><Button icon={<DownloadOutlined />} loading={isHtmlExporting} disabled={isMajorExpenseVoucherLoading || isPdfExporting} onClick={() => void exportHtml()}>导出 HTML</Button><Button type="primary" icon={<FilePdfOutlined />} loading={isPdfExporting} disabled={isMajorExpenseVoucherLoading || isHtmlExporting} onClick={() => void exportPdf()}>导出 PDF</Button></div></div>
        {reportGroups(data, supplement).map((group) => <Card key={group.title} className={`report-summary report-summary--${group.title === "门店支出" ? "expense" : "default"}`} title={group.title}
          extra={group.title === "门店营收" ? <Button type="link" disabled={data.selected_ledger?.status === "closed"} onClick={() => { setTargetValue(supplement.revenue_target); setTargetError(null); setTargetOpen(true); }}>设置业绩目标</Button> : undefined}>
          <div className={`report-summary__grid report-summary__grid--${group.items.length}`}>
            {group.items.map((item) => <div key={item.title} className={`report-summary__metric ${item.tone ? `report-summary__metric--${item.tone}` : ""}`}>
              <Typography.Text type="secondary">{item.title}</Typography.Text>
              <strong>{item.value}</strong>
              {item.hint ? <Typography.Text type="secondary" className="report-summary__hint">{item.hint}</Typography.Text> : null}
            </div>)}
          </div>
        </Card>)}
        <div className="store-financial-report__grid"><Card title="营业收入渠道"><RevenueChannelStackChart data={metrics.revenue_channel_summary} height={330} /></Card><Card title="核心成本率结构"><div className="store-financial-report__cost-list">{[["食材成本", metrics.food_cost_amount, metrics.food_cost_rate], ["人工成本", metrics.labor_cost_amount, metrics.labor_cost_rate], ["租金成本", metrics.rent_cost_amount, metrics.rent_cost_rate]].map(([name, amount, rate]) => <div className="store-financial-report__cost-item" key={String(name)}><div><Typography.Text strong>{name}</Typography.Text><Typography.Text type="secondary">{formatMoney(String(amount))}</Typography.Text></div><div className="store-financial-report__bar"><span style={{ width: `${Math.min(Number(rate || 0), 100)}%` }} /></div><Typography.Text type="secondary">{rate == null ? "/" : `${rate}%`}</Typography.Text></div>)}</div></Card></div>
        <Card title="各渠道经营收入明细" className="store-financial-report__category-card"><Table rowKey="channel" size="middle" pagination={false} dataSource={[...metrics.revenue_channel_summary].sort((a, b) => Number(b.gross_amount) - Number(a.gross_amount))} columns={[{ title: "收入渠道", dataIndex: "channel" }, { title: "经营收入", dataIndex: "gross_amount", align: "right" as const, render: (value: string) => `${formatMoney(value)}` }, { title: "实收", dataIndex: "net_amount", align: "right" as const, render: (value: string) => formatMoney(value) }, { title: "手续费", dataIndex: "fee_amount", align: "right" as const, render: (value: string) => `${formatMoney(value)}` }, { title: "手续费率", dataIndex: "fee_rate", align: "right" as const, render: (value: string) => `${value}%` }, { title: "收入占比", align: "right" as const, render: (_value: unknown, record) => ratio(Number(record.gross_amount), stats.income) }]} /></Card>
        <div className="store-financial-report__grid"><ExpenseCategoryBarChart title="支出分类排行" data={categoryRows.map((item) => ({ name: item.name, value: Number(item.amount) }))} height={330} /><Card title="核心食材"><div className="store-financial-report__food-grid">{[["鸡肉", metrics.chicken_cost_amount, metrics.chicken_cost_rate], ["菌子", metrics.mushroom_cost_amount, metrics.mushroom_cost_rate]].map(([name, amount, rate]) => <div className="store-financial-report__food-card" key={String(name)}><Typography.Text type="secondary">{name}支出</Typography.Text><Typography.Title level={3}>{formatMoney(String(amount))}</Typography.Title><div className="store-financial-report__food-bar"><span style={{ width: `${Math.min(Number(rate || 0), 100)}%` }} /></div><Tag color="blue">占营业收入 {rate == null ? "/" : `${rate}%`}</Tag></div>)}</div></Card></div>
        <Card title="各类别支出统计" className="store-financial-report__category-card"><Table rowKey="key" size="middle" columns={[{ title: "费用分类", dataIndex: "name", render: (value: string, record: CategoryRow) => <Button type="link" onClick={() => void openCategoryDetail(record)}>{value}</Button> }, { title: "金额", dataIndex: "amount", align: "right" as const, render: (value: string) => `${formatMoney(value)}` }, { title: "占营业收入", dataIndex: "revenue_share", align: "right" as const }, { title: "占总支出", dataIndex: "share", align: "right" as const }, { title: "条数", dataIndex: "item_count", align: "right" as const, width: 90 }]} dataSource={categoryRows} expandable={{ childrenColumnName: "children", expandedRowKeys: expandedCategories, onExpandedRowsChange: (keys) => setExpandedCategories(keys.map(String)), onExpand: (_expanded, record) => { if (!record.children?.length) void openCategoryDetail(record); } }} pagination={false} /></Card>
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
                    {!isImage ? <div>
                      <Typography.Text strong ellipsis style={{ maxWidth: 360 }}>{value || "报销凭证"}</Typography.Text>
                      <br />
                      <Typography.Text type="secondary">{record.content_type || (isImage ? "图片凭证" : "文件凭证")}</Typography.Text>
                    </div> : null}
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
