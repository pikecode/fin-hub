"use client";

import {
  Alert,
  Button,
  Card,
  Cascader,
  DatePicker,
  Drawer,
  Empty,
  Form,
  Image,
  Input,
  Modal,
  Pagination,
  Popconfirm,
  Radio,
  Select,
  Space,
  Splitter,
  Spin,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  message,
} from "antd";
import zhCN from "antd/locale/zh_CN";
import type { ColumnsType } from "antd/es/table";
import { FileSearchOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import "dayjs/locale/zh-cn";
import { useEffect, useMemo, useState } from "react";
import type {
  ApprovalInstance,
  Attachment,
  ApprovalTemplate,
  BankTransaction,
  ExpenseCategory,
  ExpenseItem,
  ReconciliationExpenseCandidate,
  ReconciliationRecord,
  Store,
} from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../../components/AppShell";
import { StoreLedgerWorkspaceNav } from "../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../lib/api";
import { getApprovalTemplates, getExpenseCategories, getStores } from "../../lib/referenceData";
import { useClientSearchParams } from "../../lib/searchParams";

dayjs.locale("zh-cn");

type ApprovalLike = ReconciliationExpenseCandidate | ReconciliationRecord;
type DingTalkField = Record<string, unknown>;
type DingTalkTableRow = Record<string, unknown>;

interface CandidateFilters {
  template_id?: string;
  approval_no?: string;
}

interface ConfirmValues {
  amount?: string;
  accounting_month?: dayjs.Dayjs;
  bank_occurred?: boolean;
  reason?: string;
}

interface DetailCategoryDraft {
  category_path?: string[];
}

interface ApprovalAttachmentState {
  loading: boolean;
  attachments: Attachment[];
  accessUrls: Record<string, string>;
}

type EditValues = ConfirmValues & {
  expense_item_id?: string;
};

function remainingAmount(transaction: BankTransaction) {
  return Number(transaction.amount) - Number(transaction.matched_amount || 0);
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function defaultLedgerPeriod() {
  return dayjs().subtract(1, "month").format("YYYY-MM");
}

function approvalNoText(record: ApprovalLike) {
  return record.approval_instance?.approval_no || record.approval_instance?.dingtalk_instance_id || "-";
}

function approvalTotalAmount(candidate: ReconciliationExpenseCandidate) {
  return candidate.approval_instance?.total_expense_amount ?? candidate.expense_item.amount;
}

function approvalVoucherCount(candidate: ApprovalLike, detailAttachments: ApprovalAttachmentState | null) {
  if ("voucher_count" in candidate && typeof candidate.voucher_count === "number") {
    return candidate.voucher_count;
  }
  return detailAttachments?.attachments.length ?? 0;
}

function formatRecommendationScore(score: string) {
  const value = Number(score);
  if (!Number.isFinite(value)) return "-";
  return value === 100 ? "100%" : `${value.toFixed(1)}%`;
}

function approvalStatusLabel(status?: string | null) {
  const value = (status || "").toLowerCase();
  if (!value) return "-";
  if (["agree", "approved", "completed", "finish", "success"].includes(value)) return "已完成";
  if (["reject", "rejected", "refused", "deny"].includes(value)) return "已拒绝";
  if (["pending", "processing", "running", "submit"].includes(value)) return "处理中";
  return status || "-";
}

function isReconciliationRecord(record: ApprovalLike): record is ReconciliationRecord {
  return "bank_transaction" in record;
}

function parseApprovalPayload(instance?: ApprovalInstance | null) {
  if (!instance?.raw_payload) return null;
  try {
    const parsed = JSON.parse(instance.raw_payload);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseUrlValues(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return [trimmed];
    try {
      return parseUrlValues(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap((item) => parseUrlValues(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return parseUrlValues(source.url ?? source.downloadUrl ?? source.download_url);
  }
  return [];
}

function isImageUrl(value: string) {
  return /\.(apng|avif|gif|jpe?g|png|webp)(\?.*)?$/i.test(value);
}

function isImageAttachment(attachment: Attachment) {
  const contentType = attachment.content_type || "";
  if (contentType.startsWith("image/")) return true;
  return /\.(apng|avif|gif|jpe?g|png|webp)$/i.test(attachment.file_name);
}

function externalAttachmentUrl(attachment: Attachment) {
  const value = attachment.external_file_id;
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    const url = parsed?.url ?? parsed?.downloadUrl ?? parsed?.download_url;
    return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return /^https?:\/\//i.test(value) ? value : null;
  }
}

function parseDingTalkTableValue(value: unknown): DingTalkTableRow[] {
  if (!value) return [];
  let source = value;
  if (typeof source === "string") {
    try {
      source = JSON.parse(source);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(source)) return [];
  return source
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const cells = (row as Record<string, unknown>).rowValue ?? (row as Record<string, unknown>).row_value;
      if (!Array.isArray(cells)) return null;
      const parsed: DingTalkTableRow = {};
      cells.forEach((cell) => {
        if (!cell || typeof cell !== "object") return;
        const item = cell as Record<string, unknown>;
        const label = item.label ?? item.name ?? item.title ?? item.key;
        if (label) parsed[String(label)] = item.value ?? item.ext_value ?? item.extValue ?? "";
      });
      return parsed;
    })
    .filter((row): row is DingTalkTableRow => Boolean(row));
}

function renderApprovalValue(value: unknown) {
  const urls = parseUrlValues(value);
  if (urls.length) {
    return (
      <Image.PreviewGroup>
        <Space size={8} wrap>
          {urls.map((url) =>
            isImageUrl(url) ? (
              <Image key={url} src={url} alt="凭证" width={56} height={72} style={{ objectFit: "cover", borderRadius: 4 }} />
            ) : (
              <Button key={url} size="small" href={url} target="_blank" rel="noreferrer">
                打开链接
              </Button>
            ),
          )}
        </Space>
      </Image.PreviewGroup>
    );
  }
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") {
    const source = value as Record<string, unknown>;
    if (source.fileName || source.fileId) return String(source.fileName || source.fileId);
    return JSON.stringify(value);
  }
  return value === null || value === undefined || value === "" || value === "null" ? "-" : String(value);
}

function displayFieldSummary(fields: Record<string, unknown>) {
  const entries = Object.entries(fields).filter(([, value]) => value !== null && value !== undefined && value !== "");
  if (!entries.length) return <Typography.Text type="secondary">未配置显示字段</Typography.Text>;
  const visibleEntries = entries.length <= 6 ? entries : entries.slice(0, 5);
  const hiddenEntries = entries.slice(visibleEntries.length);
  const hiddenContent = (
    <Space direction="vertical" size={2}>
      {hiddenEntries.map(([label, value]) => (
        <span key={label}>
          {label}: {Array.isArray(value) ? value.join(", ") : String(value)}
        </span>
      ))}
    </Space>
  );
  return (
    <Space size={[4, 4]} wrap>
      {visibleEntries.map(([label, value]) => (
        <Tag key={label}>
          {label}: {Array.isArray(value) ? value.join(", ") : String(value)}
        </Tag>
      ))}
      {hiddenEntries.length ? (
        <Tooltip title={hiddenContent} placement="topLeft">
          <Tag className="approval-candidate-card__more-fields">更多 {hiddenEntries.length} 项</Tag>
        </Tooltip>
      ) : null}
    </Space>
  );
}

function sortTemplates(templates: ApprovalTemplate[]) {
  return [...templates].sort((left, right) => {
    if (left.is_enabled !== right.is_enabled) return left.is_enabled ? -1 : 1;
    return right.created_at.localeCompare(left.created_at);
  });
}

export default function FinanceReconciliationPage() {
  const searchParams = useClientSearchParams();
  const initialStoreId = searchParams.get("store_id") ?? undefined;
  const initialLedgerPeriod = searchParams.get("ledger_period") ?? undefined;
  const initialApprovalNo = searchParams.get("approval_no") ?? undefined;
  const [stores, setStores] = useState<Store[]>([]);
  const [templates, setTemplates] = useState<ApprovalTemplate[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [candidates, setCandidates] = useState<ReconciliationExpenseCandidate[]>([]);
  const [records, setRecords] = useState<ReconciliationRecord[]>([]);
  const [selectedStoreId, setSelectedStoreId] = useState<string>();
  const [activeTabKey, setActiveTabKey] = useState("workbench");
  const [transactionPage, setTransactionPage] = useState(1);
  const [transactionPageSize, setTransactionPageSize] = useState(30);
  const [candidatePage, setCandidatePage] = useState(1);
  const [candidatePageSize, setCandidatePageSize] = useState(20);
  const [selectedTransaction, setSelectedTransaction] = useState<BankTransaction | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [isApprovalSearchActive, setIsApprovalSearchActive] = useState(Boolean(initialApprovalNo?.trim()));
  const [detailRecord, setDetailRecord] = useState<ApprovalLike | null>(null);
  const [detailExpenseItems, setDetailExpenseItems] = useState<ExpenseItem[]>([]);
  const [confirmExpenseItems, setConfirmExpenseItems] = useState<ExpenseItem[]>([]);
  const [editExpenseItems, setEditExpenseItems] = useState<ExpenseItem[]>([]);
  const [approvalExpenseItemsById, setApprovalExpenseItemsById] = useState<Record<string, ExpenseItem[]>>({});
  const [approvalAttachmentsByExpenseItemId, setApprovalAttachmentsByExpenseItemId] = useState<Record<string, ApprovalAttachmentState>>({});
  const [confirmDetailCategoryDrafts, setConfirmDetailCategoryDrafts] = useState<Record<string, DetailCategoryDraft>>({});
  const [editingDetailCategoryDrafts, setEditingDetailCategoryDrafts] = useState<Record<string, DetailCategoryDraft>>({});
  const [selectedConfirmExpenseItemIds, setSelectedConfirmExpenseItemIds] = useState<string[]>([]);
  const [selectedEditExpenseItemIds, setSelectedEditExpenseItemIds] = useState<string[]>([]);
  const [loadingApprovalDetailIds, setLoadingApprovalDetailIds] = useState<Set<string>>(new Set());
  const [isExpenseItemsLoading, setIsExpenseItemsLoading] = useState(false);
  const [editingRecord, setEditingRecord] = useState<ReconciliationRecord | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCandidateLoading, setIsCandidateLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filterForm] = Form.useForm<CandidateFilters>();
  const [confirmForm] = Form.useForm<ConfirmValues>();
  const [editForm] = Form.useForm<EditValues>();
  // 预加载缓存：transactionId -> candidates
  const [candidatesCache, setCandidatesCache] = useState<Map<string, ReconciliationExpenseCandidate[]>>(new Map());
  const [preloadingTransactionIds, setPreloadingTransactionIds] = useState<Set<string>>(new Set());

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const currentStore = selectedStoreId ? storesById.get(selectedStoreId) : undefined;
  const activeCategories = useMemo(() => categories.filter((category) => category.status === "active"), [categories]);
  const categoriesById = useMemo(() => new Map(activeCategories.map((category) => [category.id, category])), [activeCategories]);
  const categoryOptions = useMemo(
    () =>
      activeCategories
        .filter((category) => !category.parent_id)
        .sort((left, right) => left.sort_order - right.sort_order)
        .map((parent) => ({
          label: parent.name,
          value: parent.name,
          children: activeCategories
            .filter((category) => category.parent_id === parent.id)
            .sort((left, right) => left.sort_order - right.sort_order)
            .map((child) => ({ label: child.name, value: child.name })),
        })),
    [activeCategories],
  );
  const selectedCandidate = useMemo(
    () => candidates.find((candidate) => candidate.expense_item.id === selectedCandidateId),
    [candidates, selectedCandidateId],
  );
  const visibleTransactions = useMemo(
    () => transactions.slice((transactionPage - 1) * transactionPageSize, transactionPage * transactionPageSize),
    [transactions, transactionPage, transactionPageSize],
  );
  const visibleCandidates = useMemo(
    () => candidates.slice((candidatePage - 1) * candidatePageSize, candidatePage * candidatePageSize),
    [candidates, candidatePage, candidatePageSize],
  );
  const bankRemaining = selectedTransaction ? remainingAmount(selectedTransaction) : 0;
  const defaultMatchAmount = bankRemaining;
  const fallbackLedgerPeriod = useMemo(() => defaultLedgerPeriod(), []);
  const selectedLedgerPeriod = initialLedgerPeriod ?? fallbackLedgerPeriod;
  const detailPayload = useMemo(() => parseApprovalPayload(detailRecord?.approval_instance), [detailRecord]);
  const detailFields = useMemo<DingTalkField[]>(() => {
    const fields = detailPayload?.form_component_values ?? detailPayload?.formComponentValues;
    return Array.isArray(fields) ? fields.filter((field) => field && typeof field === "object") : [];
  }, [detailPayload]);
  const detailTables = detailFields
    .map((field) => ({
      name: String(field.name ?? field.label ?? "表格"),
      rows: parseDingTalkTableValue(field.value ?? field.ext_value ?? field.extValue),
    }))
    .filter((table) => table.rows.length);
  const detailNormalFields = detailFields.filter((field) => !parseDingTalkTableValue(field.value ?? field.ext_value ?? field.extValue).length);
  const sortedDetailExpenseItems = useMemo(
    () =>
      [...detailExpenseItems].sort((left, right) => {
        const leftLine = left.approval_line_no ?? Number.MAX_SAFE_INTEGER;
        const rightLine = right.approval_line_no ?? Number.MAX_SAFE_INTEGER;
        if (leftLine !== rightLine) return leftLine - rightLine;
        return left.created_at.localeCompare(right.created_at);
      }),
    [detailExpenseItems],
  );
  const sortedConfirmExpenseItems = useMemo(
    () =>
      [...confirmExpenseItems].sort((left, right) => {
        const leftLine = left.approval_line_no ?? Number.MAX_SAFE_INTEGER;
        const rightLine = right.approval_line_no ?? Number.MAX_SAFE_INTEGER;
        if (leftLine !== rightLine) return leftLine - rightLine;
        return left.created_at.localeCompare(right.created_at);
      }),
    [confirmExpenseItems],
  );
  const sortedEditExpenseItems = useMemo(
    () =>
      [...editExpenseItems].sort((left, right) => {
        const leftLine = left.approval_line_no ?? Number.MAX_SAFE_INTEGER;
        const rightLine = right.approval_line_no ?? Number.MAX_SAFE_INTEGER;
        if (leftLine !== rightLine) return leftLine - rightLine;
        return left.created_at.localeCompare(right.created_at);
      }),
    [editExpenseItems],
  );
  const detailMatchedExpenseId = detailRecord && isReconciliationRecord(detailRecord) ? detailRecord.expense_item.id : undefined;

  function categoryPathForName(categoryName?: string | null) {
    if (!categoryName) return undefined;
    const category = activeCategories.find((item) => item.name === categoryName);
    if (!category) return [categoryName];
    const parentName = category.parent_id ? categoriesById.get(category.parent_id)?.name : undefined;
    return parentName ? [parentName, category.name] : [category.name];
  }

  async function loadBaseData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const stores = await getStores();
      setStores(stores);
      if (!selectedStoreId) {
        const defaultStoreId = initialStoreId && stores.some((store) => store.id === initialStoreId)
          ? initialStoreId
          : stores[0]?.id;
        if (defaultStoreId) setSelectedStoreId(defaultStoreId);
      }
      setIsLoading(false);

      const [templateResult, categoryResult] = await Promise.allSettled([
        getApprovalTemplates(),
        getExpenseCategories(),
      ]);
      const errors: string[] = [];
      if (templateResult.status === "fulfilled") {
        setTemplates(sortTemplates(templateResult.value));
      } else {
        setTemplates([]);
        errors.push("审批模版");
      }
      if (categoryResult.status === "fulfilled") {
        setCategories(categoryResult.value);
      } else {
        setCategories([]);
        errors.push("费用分类");
      }
      if (errors.length) {
        setErrorMessage(`部分基础数据加载失败：${errors.join("、")}。请检查当前用户权限。`);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载门店数据");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadStoreWorkspace(storeId: string, transaction?: BankTransaction | null) {
    setIsLoading(true);
    setErrorMessage(null);
    // 清空预加载缓存
    setCandidatesCache(new Map());
    setPreloadingTransactionIds(new Set());
    try {
      const bankParams = new URLSearchParams({ store_id: storeId, direction: "expense", page_size: "200" });
      const recordParams = new URLSearchParams({ store_id: storeId, page_size: "100" });
      if (selectedLedgerPeriod) {
        recordParams.set("accounting_period", selectedLedgerPeriod);
      }
      const [bankPage, recordPage] = await Promise.all([
        apiClient.bankTransactions.list(`?${bankParams.toString()}`),
        apiClient.matches.reconciliationRecords(`?${recordParams.toString()}`),
      ]);
      // A bank transaction can only be matched to one approval. Once matched,
      // it belongs in the reconciliation records tab rather than this queue.
      setTransactions(bankPage.items.filter((item) => Number(item.matched_amount || 0) <= 0));
      setRecords(recordPage.items);
      setApprovalExpenseItemsById({});
      setTransactionPage(1);
      const nextTransaction = transaction && remainingAmount(transaction) > 0 ? transaction : null;
      setSelectedTransaction(nextTransaction);
      setCandidates([]);
      setCandidatePage(1);
      setSelectedCandidateId(undefined);
      if (nextTransaction) {
        await loadCandidates(nextTransaction, storeId, filterForm.getFieldsValue());
      } else {
        setCandidates([]);
        setIsApprovalSearchActive(Boolean(filterForm.getFieldValue("approval_no")?.trim() || initialApprovalNo?.trim()));
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载门店对账数据");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadCandidates(transaction: BankTransaction | null, storeId: string, filters?: CandidateFilters) {
    // 如果有缓存，直接使用
    if (transaction && candidatesCache.has(transaction.id)) {
      const cached = candidatesCache.get(transaction.id);
      if (cached) {
        setCandidates(cached);
        setCandidatePage(1);
        setSelectedCandidateId(undefined);
        setIsApprovalSearchActive(Boolean(filters?.approval_no?.trim() || initialApprovalNo?.trim()));
        setIsCandidateLoading(false);
        return;
      }
    }

    setIsCandidateLoading(true);
    setErrorMessage(null);
    const params = new URLSearchParams({
      store_id: storeId,
      approval_only: "true",
      page_size: "100",
    });
    const approvalSearch = filters && Object.prototype.hasOwnProperty.call(filters, "approval_no")
      ? filters.approval_no?.trim()
      : initialApprovalNo?.trim();
    if (transaction) params.set("bank_transaction_id", transaction.id);
    if (filters?.template_id) params.set("template_id", filters.template_id);
    if (approvalSearch) params.set("approval_no", approvalSearch);
    try {
      const result = await apiClient.matches.reconciliationCandidates(`?${params.toString()}`);
      setCandidates(result.candidates);
      setCandidatePage(1);
      setSelectedCandidateId(undefined);
      setIsApprovalSearchActive(Boolean(approvalSearch));

      // 缓存结果
      if (transaction && !approvalSearch && !filters?.template_id) {
        setCandidatesCache(prev => new Map(prev).set(transaction.id, result.candidates));
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载审批单候选");
    } finally {
      setIsCandidateLoading(false);
    }
  }

  useEffect(() => {
    void loadBaseData();
  }, []);

  useEffect(() => {
    if (initialStoreId) setSelectedStoreId(initialStoreId);
  }, [initialStoreId]);

  useEffect(() => {
    if (initialApprovalNo) {
      filterForm.setFieldsValue({ approval_no: initialApprovalNo });
    }
  }, [filterForm, initialApprovalNo]);

  useEffect(() => {
    if (selectedStoreId) void loadStoreWorkspace(selectedStoreId);
  }, [selectedStoreId]);

  useEffect(() => {
    let ignore = false;
    const approvalId = detailRecord?.approval_instance?.id;
    if (!approvalId) {
      setDetailExpenseItems([]);
      return;
    }
    async function loadDetailExpenseItems(currentApprovalId: string) {
      try {
        const page = await fetchApprovalExpenseItems(currentApprovalId);
        if (!ignore) setDetailExpenseItems(page.items);
      } catch (error) {
        if (!ignore) {
          setDetailExpenseItems([]);
          message.error(error instanceof Error ? error.message : "无法加载审批费用明细");
        }
      }
    }
    void loadDetailExpenseItems(approvalId);
    return () => {
      ignore = true;
    };
  }, [detailRecord?.approval_instance?.id]);

  async function selectTransaction(transaction: BankTransaction) {
    if (!selectedStoreId) return;
    setSelectedTransaction(transaction);
    setCandidatePage(1);
    await loadCandidates(transaction, selectedStoreId, filterForm.getFieldsValue());

    // 🚀 预加载下两笔流水的候选匹配
    preloadNextTransactions(transaction);
  }

  // 预加载函数：加载指定流水之后的两笔待匹配流水
  function preloadNextTransactions(currentTransaction: BankTransaction) {
    if (!selectedStoreId) return;

    // 找到当前流水的索引
    const currentIndex = transactions.findIndex(t => t.id === currentTransaction.id);
    if (currentIndex === -1) return;

    // 获取后续的两笔待匹配流水（剩余金额 > 0）
    const nextTransactions = transactions
      .slice(currentIndex + 1)
      .filter(t => remainingAmount(t) > 0)
      .slice(0, 2);

    // 异步预加载
    nextTransactions.forEach(async (transaction) => {
      // 跳过已缓存或正在加载的
      if (candidatesCache.has(transaction.id) || preloadingTransactionIds.has(transaction.id)) {
        return;
      }

      // 标记为正在预加载
      setPreloadingTransactionIds(prev => new Set(prev).add(transaction.id));

      try {
        const params = new URLSearchParams({
          store_id: selectedStoreId,
          approval_only: "true",
          page_size: "100",
          bank_transaction_id: transaction.id,
        });

        const result = await apiClient.matches.reconciliationCandidates(`?${params.toString()}`);

        // 缓存结果
        setCandidatesCache(prev => new Map(prev).set(transaction.id, result.candidates));
      } catch (error) {
        // 静默失败，不影响用户操作
        console.warn(`预加载流水 ${transaction.id} 的候选匹配失败:`, error);
      } finally {
        // 移除预加载标记
        setPreloadingTransactionIds(prev => {
          const next = new Set(prev);
          next.delete(transaction.id);
          return next;
        });
      }
    });
  }

  async function fetchApprovalExpenseItems(approvalId: string) {
    const params = new URLSearchParams({ approval_instance_id: approvalId, page_size: "500" });
    return apiClient.expenseItems.list(`?${params.toString()}`);
  }

  async function fetchExpenseAttachments(expenseItemId: string) {
    const params = new URLSearchParams({ resource_type: "expense_item", resource_id: expenseItemId, page_size: "100" });
    return apiClient.attachments.list(`?${params.toString()}`);
  }

  async function loadApprovalExpenseItemsForTable(approvalId: string) {
    if (approvalExpenseItemsById[approvalId] || loadingApprovalDetailIds.has(approvalId)) return;
    setLoadingApprovalDetailIds((current) => new Set(current).add(approvalId));
    try {
      const page = await fetchApprovalExpenseItems(approvalId);
      setApprovalExpenseItemsById((current) => ({ ...current, [approvalId]: page.items }));
    } catch (error) {
      message.error(error instanceof Error ? error.message : "无法加载审批费用明细");
    } finally {
      setLoadingApprovalDetailIds((current) => {
        const next = new Set(current);
        next.delete(approvalId);
        return next;
      });
    }
  }

  async function loadExpenseAttachments(expenseItemId: string) {
    if (approvalAttachmentsByExpenseItemId[expenseItemId]?.attachments) return;
    setApprovalAttachmentsByExpenseItemId((current) => ({
      ...current,
      [expenseItemId]: { loading: true, attachments: current[expenseItemId]?.attachments ?? [], accessUrls: current[expenseItemId]?.accessUrls ?? {} },
    }));
    try {
      const page = await fetchExpenseAttachments(expenseItemId);
      const accessUrls = Object.fromEntries(
        await Promise.all(
          page.items.map(async (attachment) => {
            const sourceUrl = externalAttachmentUrl(attachment);
            if (sourceUrl) return [attachment.id, sourceUrl] as const;
            try {
              const data = await apiClient.attachments.accessUrl(attachment.id);
              return [attachment.id, data.url] as const;
            } catch {
              return [attachment.id, ""] as const;
            }
          }),
        ),
      );
      setApprovalAttachmentsByExpenseItemId((current) => ({
        ...current,
        [expenseItemId]: { loading: false, attachments: page.items, accessUrls },
      }));
    } catch (error) {
      setApprovalAttachmentsByExpenseItemId((current) => ({
        ...current,
        [expenseItemId]: { loading: false, attachments: [], accessUrls: {} },
      }));
      message.error(error instanceof Error ? error.message : "无法加载报销凭证");
    }
  }

  async function preloadExpenseAttachments(expenseItems: ExpenseItem[]) {
    const pendingIds = expenseItems
      .map((item) => item.id)
      .filter((expenseItemId) => !approvalAttachmentsByExpenseItemId[expenseItemId]?.attachments && !approvalAttachmentsByExpenseItemId[expenseItemId]?.loading);
    if (!pendingIds.length) return;
    await Promise.allSettled(pendingIds.map((expenseItemId) => loadExpenseAttachments(expenseItemId)));
  }

  async function updateExpenseCategory(expenseItem: ExpenseItem, categoryPath?: string[]) {
    setIsSaving(true);
    try {
      const updated = await apiClient.expenseItems.update(expenseItem.id, {
        category_l1: categoryPath?.[0] || null,
        category_l2: categoryPath?.at(-1) || null,
      });
      setDetailExpenseItems((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setConfirmExpenseItems((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setEditExpenseItems((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      setApprovalExpenseItemsById((itemsByApproval) =>
        Object.fromEntries(
          Object.entries(itemsByApproval).map(([approvalId, items]) => [
            approvalId,
            items.map((item) => (item.id === updated.id ? updated : item)),
          ]),
        ),
      );
      setCandidates((items) =>
        items.map((candidate) =>
          candidate.expense_item.id === updated.id ? { ...candidate, expense_item: updated } : candidate,
        ),
      );
      setRecords((items) =>
        items.map((record) =>
          record.expense_item.id === updated.id ? { ...record, expense_item: updated } : record,
        ),
      );
      setDetailRecord((record) => {
        if (!record || record.expense_item.id !== updated.id) return record;
        return { ...record, expense_item: updated };
      });
      message.success("费用分类已更新");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "更新费用分类失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function openConfirm() {
    if (!selectedTransaction || !selectedCandidate) {
      message.warning("请先选择银行流水和审批单");
      return;
    }
    confirmForm.setFieldsValue({
      amount: defaultMatchAmount.toFixed(2),
      accounting_month: undefined, // 去掉默认值，用户必须手动选择
      bank_occurred: true,
    });
    setConfirmExpenseItems([selectedCandidate.expense_item]);
    setSelectedConfirmExpenseItemIds([selectedCandidate.expense_item.id]);
    setIsConfirmOpen(true);
    const approvalId = selectedCandidate.approval_instance?.id;
    if (!approvalId) return;
    setIsExpenseItemsLoading(true);
    try {
      const page = await fetchApprovalExpenseItems(approvalId);
      setConfirmExpenseItems(page.items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "无法加载审批费用明细");
    } finally {
      setIsExpenseItemsLoading(false);
    }
  }

  async function submitConfirm(values: ConfirmValues) {
    if (!selectedTransaction || !selectedCandidate || !selectedStoreId) return;
    const accountingPeriod = values.accounting_month?.format("YYYY-MM");
    if (!accountingPeriod) return;
    setIsSaving(true);
    try {
      const selectedExpenseItem = selectedCandidate.expense_item;
      const match = await apiClient.matches.create({
        bank_transaction_id: selectedTransaction.id,
        expense_item_id: selectedExpenseItem.id,
        amount: values.amount || defaultMatchAmount.toFixed(2),
        accounting_period: accountingPeriod,
        bank_occurred: values.bank_occurred ?? true,
        category_l1: selectedExpenseItem.category_l1 || null,
        category_l2: selectedExpenseItem.category_l2 || null,
        confidence: selectedCandidate.score,
        reason: values.reason || selectedCandidate.reason,
      });
      for (const [expenseItemId, draft] of Object.entries(confirmDetailCategoryDrafts)) {
        if (!draft.category_path?.length) continue;
        const expenseItem = confirmExpenseItems.find((item) => item.id === expenseItemId);
        if (!expenseItem) continue;
        await apiClient.expenseItems.update(expenseItem.id, {
          category_l1: draft.category_path[0] || null,
          category_l2: draft.category_path.at(-1) || null,
        });
      }
      await apiClient.matches.confirm(match.id, "admin");
      message.success("匹配已确认");
      setIsConfirmOpen(false);
      setConfirmExpenseItems([]);
      setConfirmDetailCategoryDrafts({});
      setSelectedConfirmExpenseItemIds([]);
      confirmForm.resetFields();
      await loadStoreWorkspace(selectedStoreId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "确认匹配失败");
    } finally {
      setIsSaving(false);
    }
  }

  function openEdit(record: ReconciliationRecord) {
    setEditingRecord(record);
    setEditExpenseItems([record.expense_item]);
    setSelectedEditExpenseItemIds([record.expense_item.id]);
    editForm.setFieldsValue({
      expense_item_id: record.expense_item.id,
      amount: record.match.amount,
      accounting_month: dayjs(record.match.accounting_period || record.bank_transaction.ledger_period || record.bank_transaction.occurred_at.slice(0, 7)),
      bank_occurred: record.match.bank_occurred,
      reason: record.match.reason || undefined,
    });
    const approvalId = record.approval_instance?.id;
    if (!approvalId) return;
    setIsExpenseItemsLoading(true);
    fetchApprovalExpenseItems(approvalId)
      .then((page) => setEditExpenseItems(page.items))
      .catch((error) => message.error(error instanceof Error ? error.message : "无法加载审批费用明细"))
      .finally(() => setIsExpenseItemsLoading(false));
  }

  async function submitEdit(values: EditValues) {
    if (!editingRecord || !selectedStoreId) return;
    setIsSaving(true);
    try {
      await apiClient.matches.updateReconciliationRecord(editingRecord.match.id, {
        expense_item_id: values.expense_item_id || editingRecord.expense_item.id,
        amount: values.amount || editingRecord.match.amount,
        accounting_period: values.accounting_month?.format("YYYY-MM") || editingRecord.match.accounting_period,
        bank_occurred: values.bank_occurred ?? true,
        reason: values.reason || null,
      });
      const updatedExpenseItems = editExpenseItems.filter((item) => item.id === (values.expense_item_id || editingRecord.expense_item.id) || editingRecord.approval_instance?.id === item.approval_instance_id);
      for (const item of updatedExpenseItems) {
        const draft = editingDetailCategoryDrafts[item.id];
        if (!draft?.category_path?.length) continue;
        await apiClient.expenseItems.update(item.id, {
          category_l1: draft.category_path[0] || null,
          category_l2: draft.category_path.at(-1) || null,
        });
      }
      message.success("对账记录已更新");
      setEditingRecord(null);
      setEditingDetailCategoryDrafts({});
      setSelectedEditExpenseItemIds([]);
      editForm.resetFields();
      await loadStoreWorkspace(selectedStoreId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "更新失败");
    } finally {
      setIsSaving(false);
    }
  }

  async function unmatch(record: ReconciliationRecord) {
    if (!selectedStoreId) return;
    setIsSaving(true);
    try {
      await apiClient.matches.unmatchReconciliationRecord(record.match.id);
      message.success("匹配关系已解除");
      await loadStoreWorkspace(selectedStoreId);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "解除匹配失败");
    } finally {
      setIsSaving(false);
    }
  }

  const recordColumns: ColumnsType<ReconciliationRecord> = [
    { title: "入账月", dataIndex: ["match", "accounting_period"], width: 100, fixed: "left", render: (value) => value || "-" },
    { title: "匹配金额", dataIndex: ["match", "amount"], width: 110, align: "right", fixed: "left", render: (value: string) => formatMoney(value) },
    {
      title: "银行流水",
      width: 300,
      render: (_, record) => (
        <Space direction="vertical" size={2} style={{ width: "100%" }}>
          <Space size={6} wrap>
            <Typography.Text strong>{dayjs(record.bank_transaction.occurred_at).format("YYYY-MM-DD")}</Typography.Text>
            <Tag color={record.match.bank_occurred ? "green" : undefined}>
              {record.match.bank_occurred ? "已发生" : "未发生"}
            </Tag>
            <Typography.Text type="danger">{formatMoney(record.bank_transaction.amount)}</Typography.Text>
          </Space>
          <Typography.Text ellipsis>{record.bank_transaction.summary || record.bank_transaction.counterparty_name || "无摘要"}</Typography.Text>
          {record.bank_transaction.bank_serial_no ? (
            <Typography.Text type="secondary" ellipsis>
              流水号 {record.bank_transaction.bank_serial_no}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "审批记录",
      width: 390,
      render: (_, record) => (
        <Space direction="vertical" size={4} style={{ width: "100%" }}>
          <Space size={6} wrap>
            <Typography.Link copyable={{ text: approvalNoText(record) }} onClick={() => setDetailRecord(record)}>
              {approvalNoText(record)}
            </Typography.Link>
            <Tag color="blue">{record.template_name || "手工支出"}</Tag>
            <Tag>{record.approval_instance?.approval_status || record.match.status}</Tag>
          </Space>
          <Typography.Text ellipsis>{record.expense_item.description}</Typography.Text>
          <Space size={[10, 4]} wrap>
            <Typography.Text type="secondary">{record.approval_instance?.applicant_name || "申请人 -"}</Typography.Text>
            <Typography.Text type="secondary">{record.approval_instance?.department_name || "部门 -"}</Typography.Text>
            <Typography.Text type="secondary">单据 {formatMoney(record.expense_item.amount)}</Typography.Text>
          </Space>
          <div className="approval-candidate-card__fields">{displayFieldSummary(record.display_fields)}</div>
        </Space>
      ),
    },
    { title: "费用分类", dataIndex: ["expense_item", "category_l2"], width: 140, render: (value) => value || "-" },
    {
      title: "操作",
      width: 170,
      fixed: "right",
      className: "table-action-column",
      render: (_, record) => (
        <Space size={4}>
          <Button size="small" onClick={() => setDetailRecord(record)}>明细</Button>
          <Button size="small" onClick={() => openEdit(record)}>编辑</Button>
          <Popconfirm title="解除匹配关系？" okText="解除" cancelText="取消" onConfirm={() => unmatch(record)}>
            <Button size="small" danger>解除</Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  function renderReconciliationSubtable(record: ReconciliationRecord) {
    const approvalId = record.approval_instance?.id;
    if (!approvalId) {
      return <Typography.Text type="secondary">这条记录没有可展开的审批明细</Typography.Text>;
    }
    const items = approvalExpenseItemsById[approvalId];
    if (!items) {
      return loadingApprovalDetailIds.has(approvalId)
        ? <Spin size="small" />
        : <Typography.Text type="secondary">展开明细加载失败，请重新展开</Typography.Text>;
    }
    return (
      <div className="reconciliation-record-expanded">
        <Typography.Text type="secondary">审批费用明细</Typography.Text>
        <Table
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={items}
          columns={[
            {
              title: "费用内容",
              dataIndex: "description",
              width: 320,
              render: (value, item) => (
                <Space direction="vertical" size={2}>
                  <Typography.Text>{value || "-"}</Typography.Text>
                  <Typography.Text type="secondary">
                    {item.approval_line_source_type === "table" ? "表格明细" : "审批主单"}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: "业务日期",
              dataIndex: "expense_date",
              width: 120,
              render: (value) => value ? dayjs(value).format("YYYY-MM-DD") : "-",
            },
            {
              title: "金额",
              dataIndex: "amount",
              width: 120,
              align: "right",
              render: (value) => formatMoney(value),
            },
            {
              title: "费用分类",
              dataIndex: "category_l2",
              width: 220,
              render: (value, item) => value
                ? `${item.category_l1 ? `${item.category_l1} / ` : ""}${value}`
                : "待分类",
            },
          ]}
          rowClassName={(item) => (item.id === record.expense_item.id ? "selected-table-row" : "")}
          scroll={{ x: 780 }}
        />
      </div>
    );
  }

  function renderExpenseVoucherCell(expenseItem: ExpenseItem) {
    const attachmentState = approvalAttachmentsByExpenseItemId[expenseItem.id];
    const attachments = attachmentState?.attachments ?? [];
    const loading = attachmentState?.loading ?? false;
    return (
      <div className="dingtalk-attachment-cell">
        {loading ? (
          <Typography.Text type="secondary">加载中...</Typography.Text>
        ) : attachments.length ? (
          <Image.PreviewGroup>
            <Space size={8} wrap>
              {attachments.map((attachment) => {
                const sourceUrl = externalAttachmentUrl(attachment) || attachmentState?.accessUrls[attachment.id];
                if (sourceUrl && isImageAttachment(attachment)) {
                  return (
                    <Image
                      key={attachment.id}
                      src={sourceUrl}
                      alt={attachment.file_name || "报销凭证"}
                      width={56}
                      height={72}
                      style={{ objectFit: "cover", borderRadius: 4 }}
                    />
                  );
                }
                return sourceUrl ? (
                  <Button key={attachment.id} size="small" href={sourceUrl} target="_blank" rel="noreferrer">
                    {attachment.file_name || "报销凭证"}
                  </Button>
                ) : (
                  <Typography.Text key={attachment.id} type="secondary">
                    {attachment.file_name || "报销凭证"}
                  </Typography.Text>
                );
              })}
            </Space>
          </Image.PreviewGroup>
        ) : (
          <Typography.Text type="secondary">暂无凭证</Typography.Text>
        )}
      </div>
    );
  }

  useEffect(() => {
    if (!isConfirmOpen) return;
    void preloadExpenseAttachments(sortedConfirmExpenseItems);
  }, [isConfirmOpen, sortedConfirmExpenseItems]);

  useEffect(() => {
    if (!editingRecord) return;
    void preloadExpenseAttachments(sortedEditExpenseItems);
  }, [editingRecord, sortedEditExpenseItems]);

  return (
    <AppShell title={currentStore?.name ? `${currentStore.name} · 审批单对账` : "审批单对账"} kicker={`账期：${selectedLedgerPeriod}`}>
      {initialStoreId ? (
        <StoreLedgerWorkspaceNav
          storeId={selectedStoreId ?? initialStoreId}
          storeName={currentStore?.name}
          period={selectedLedgerPeriod}
          statusLabel={currentStore?.status === "active" ? "启用门店" : currentStore ? "停用门店" : undefined}
          activeKey="matching"
        />
      ) : null}
      {errorMessage ? <Alert className="dashboard-alert" type="warning" showIcon message={errorMessage} closable onClose={() => setErrorMessage(null)} /> : null}

      {!initialStoreId ? (
        <Card className="reconciliation-summary-card">
          <div className="reconciliation-summary-card__main">
            <div className="reconciliation-summary-card__store">
              <Typography.Text className="reconciliation-summary-card__label">当前门店</Typography.Text>
              <Select
                showSearch
                optionFilterProp="label"
                className="reconciliation-summary-card__select"
                value={selectedStoreId}
                onChange={setSelectedStoreId}
                options={stores.map((store) => ({ label: store.name, value: store.id }))}
              />
            </div>
            <div className="reconciliation-summary-card__metrics">
              <Statistic title="银行流水" value={transactions.length} />
              <Statistic title="候选审批单" value={candidates.length} />
              <Statistic title="已对账" value={records.length} />
            </div>
          </div>
          <Space className="reconciliation-summary-card__actions">
            <Button onClick={() => selectedStoreId && loadStoreWorkspace(selectedStoreId)}>刷新</Button>
          </Space>
        </Card>
      ) : null}

      <Tabs
        className="reconciliation-tabs"
        activeKey={activeTabKey}
        onChange={setActiveTabKey}
        items={[
          {
            key: "workbench",
            label: `银行流水 (${transactions.length})`,
            children: activeTabKey === "workbench" ? (
              <Splitter className="reconciliation-workbench">
                <Splitter.Panel defaultSize="34%" min="300px">
                  <Card
                    title="银行流水"
                    className="data-table-card bank-transaction-panel"
                    extra={<Typography.Text type="secondary">共 {transactions.length} 条</Typography.Text>}
	                  >
	                    {transactions.length ? (
	                      <div className="bank-transaction-list">
	                        {visibleTransactions.map((transaction) => {
	                          const isSelected = transaction.id === selectedTransaction?.id;
                          const isFullyMatched = Number(transaction.matched_amount || 0) > 0;
                          return (
                            <button
                              key={transaction.id}
                              type="button"
                              className={`bank-transaction-card${isSelected ? " is-selected" : ""}${isFullyMatched ? " is-disabled" : ""}`}
                              disabled={isFullyMatched}
                              onClick={() => {
                                if (!isFullyMatched) void selectTransaction(transaction);
                              }}
                            >
                              <span className="bank-transaction-card__main">
	                                <span className="bank-transaction-card__meta">
	                                  <Typography.Text strong>{dayjs(transaction.occurred_at).format("YYYY-MM-DD")}</Typography.Text>
	                                  <Tag color="orange">支出</Tag>
	                                  {transaction.ledger_period ? <Tag>{transaction.ledger_period}</Tag> : null}
	                                  {isFullyMatched ? <Tag color="green">已匹配</Tag> : <Tag>待匹配</Tag>}
	                                </span>
                                {transaction.counterparty_name && (
                                  <Typography.Text className="bank-transaction-card__counterparty" style={{ fontSize: 13, color: '#1890ff', marginTop: 4 }}>
                                    对方户名：{transaction.counterparty_name}
                                  </Typography.Text>
                                )}
	                                <Typography.Text className="bank-transaction-card__summary" ellipsis title={transaction.summary || "无摘要"}>
	                                  {transaction.summary ? `摘要：${transaction.summary}` : "无摘要"}
	                                </Typography.Text>
                                {transaction.bank_serial_no ? (
                                  <span className="bank-transaction-card__serial">流水号 {transaction.bank_serial_no}</span>
                                ) : null}
                              </span>
                              <span className="bank-transaction-card__amounts">
                                <Typography.Text className="bank-transaction-card__amount">{formatMoney(transaction.amount)}</Typography.Text>
                              </span>
	                            </button>
	                          );
	                        })}
	                        {transactions.length > transactionPageSize ? (
	                          <Pagination
	                            className="reconciliation-list-pagination"
	                            size="small"
	                            current={transactionPage}
	                            pageSize={transactionPageSize}
	                            total={transactions.length}
	                            showSizeChanger
	                            pageSizeOptions={[20, 30, 50, 100]}
	                            showTotal={(total, range) => `${range[0]}-${range[1]} / ${total} 条`}
	                            onChange={(page, pageSize) => {
	                              setTransactionPage(page);
	                              setTransactionPageSize(pageSize);
	                            }}
	                          />
	                        ) : null}
	                      </div>
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectedStoreId ? "当前门店暂无银行流水" : "请先选择门店"} />
                    )}
                  </Card>
                </Splitter.Panel>
                <Splitter.Panel min="460px">
                  <Card
                    title={selectedTransaction ? `审批单候选：${formatMoney(selectedTransaction.amount)}` : "审批单候选"}
                    extra={
                      <Space>
                        <Form form={filterForm} layout="inline" initialValues={{ approval_no: initialApprovalNo }} onFinish={(values) => selectedStoreId && loadCandidates(selectedTransaction, selectedStoreId, values)}>
                          <Form.Item name="template_id">
                            <Select
                              allowClear
                              placeholder="模板"
                              style={{ width: 180 }}
                              options={templates
                                .filter((template) => template.is_enabled)
                                .map((template) => ({ label: template.name, value: template.id }))}
                            />
                          </Form.Item>
                          <Form.Item name="approval_no">
                            <Input allowClear placeholder="审批编号" style={{ width: 160 }} />
                          </Form.Item>
                          <Button htmlType="submit">筛选</Button>
                        </Form>
                        <Button type="primary" disabled={!selectedCandidate || !selectedTransaction} onClick={openConfirm}>确认匹配</Button>
                      </Space>
                    }
                    className="data-table-card approval-candidate-panel"
                  >
                    {isApprovalSearchActive ? (
                      <Alert
                        className="dashboard-alert"
                        type="info"
                        showIcon
                        message="当前为审批编号检索结果"
                        description="已匹配明细仅供查看，剩余金额大于 0 的明细仍可继续匹配。"
                      />
                    ) : null}
	                    <Spin spinning={isCandidateLoading}>
	                      {candidates.length ? (
	                        <div className="approval-candidate-list">
	                          {visibleCandidates.map((candidate) => {
	                            const isSelected = candidate.expense_item.id === selectedCandidateId;
                            const isReadOnlyMatched = !isApprovalSearchActive && Number(candidate.remaining_amount || 0) <= 0;
	                            const storeName = storesById.get(candidate.expense_item.store_id)?.name || candidate.approval_instance?.department_name || "-";
                            return (
                              <div
                                key={candidate.expense_item.id}
                                role="button"
                                tabIndex={0}
                                className={`approval-candidate-card${isSelected ? " is-selected" : ""}${isReadOnlyMatched ? " is-disabled" : ""}`}
                                onClick={() => {
                                  if (!isReadOnlyMatched) setSelectedCandidateId(candidate.expense_item.id);
                                }}
                                onKeyDown={(event) => {
                                  if (!isReadOnlyMatched && (event.key === "Enter" || event.key === " ")) setSelectedCandidateId(candidate.expense_item.id);
                                }}
                              >
                                <Tooltip title={candidate.reason}>
                                  <div className="approval-candidate-card__score">
                                    <span>{formatRecommendationScore(candidate.score)}</span>
                                    <Typography.Text type="secondary">推荐度</Typography.Text>
                                  </div>
                                </Tooltip>
                                <div className="approval-candidate-card__main">
                                  <Space size={6} wrap>
                                    <Typography.Text strong copyable={{ text: approvalNoText(candidate) }}>
                                      {approvalNoText(candidate)}
                                    </Typography.Text>
                                    <Tag color="blue">{candidate.template_name || "手工支出"}</Tag>
                                    {candidate.expense_item.category_l2 ? (
                                      <Tag>{candidate.expense_item.category_l1 ? `${candidate.expense_item.category_l1} / ` : ""}{candidate.expense_item.category_l2}</Tag>
                                    ) : (
                                      <Tag color="orange">待分类</Tag>
                                    )}
                                    {isReadOnlyMatched ? <Tag color="green">已完成匹配，仅供查看</Tag> : null}
                                  </Space>
                                  <Typography.Text className="approval-candidate-card__title" ellipsis>
                                    {candidate.expense_item.description}
                                  </Typography.Text>
                                  <Space size={[12, 4]} wrap className="approval-candidate-card__meta">
                                    <span>部门/门店：{storeName}</span>
                                    <span>业务日期：{candidate.expense_item.expense_date ? dayjs(candidate.expense_item.expense_date).format("YYYY-MM-DD") : "-"}</span>
                                  </Space>
                                  <div className="approval-candidate-card__fields">{displayFieldSummary(candidate.display_fields)}</div>
                                </div>
                                <div className="approval-candidate-card__aside">
                                  <Typography.Text className="approval-candidate-card__amount">{formatMoney(approvalTotalAmount(candidate))}</Typography.Text>
                                  <Typography.Text type="secondary">审批单总额</Typography.Text>
                                  <Button
                                    size="small"
                                    type="primary"
                                    ghost
                                    icon={<FileSearchOutlined />}
                                    className="approval-candidate-card__detail-button"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setDetailRecord(candidate);
                                    }}
                                  >
                                    查看明细
                                  </Button>
                                </div>
	                              </div>
	                            );
	                          })}
	                          {candidates.length > candidatePageSize ? (
	                            <Pagination
	                              className="reconciliation-list-pagination"
	                              size="small"
	                              current={candidatePage}
	                              pageSize={candidatePageSize}
	                              total={candidates.length}
	                              showSizeChanger
	                              pageSizeOptions={[10, 20, 50, 100]}
	                              showTotal={(total, range) => `${range[0]}-${range[1]} / ${total} 条`}
	                              onChange={(page, pageSize) => {
	                                setCandidatePage(page);
	                                setCandidatePageSize(pageSize);
	                              }}
	                            />
	                          ) : null}
	                        </div>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectedStoreId ? "当前门店暂无候选审批单" : "请先选择门店"} />
                      )}
                    </Spin>
                  </Card>
                </Splitter.Panel>
              </Splitter>
            ) : null,
          },
          {
            key: "records",
            label: `已对账记录 (${records.length})`,
            children: activeTabKey === "records" ? (
              <Card title="已对账记录" className="data-table-card reconciliation-record-card">
                <Table
                  rowKey={(record) => record.match.id}
                  size="small"
                  loading={isLoading}
                  columns={recordColumns}
                  dataSource={records}
                  expandable={{
                    expandedRowRender: renderReconciliationSubtable,
                    onExpand: (expanded, record) => {
                      if (expanded && record.approval_instance?.id) {
                        void loadApprovalExpenseItemsForTable(record.approval_instance.id);
                      }
                    },
                  }}
                  pagination={{ pageSize: 12 }}
                  scroll={{ x: 1290, y: "calc(100vh - 430px)" }}
                  sticky
                />
              </Card>
            ) : null,
          },
        ]}
      />

      <Modal
        title="匹配并分类"
        open={isConfirmOpen}
        destroyOnHidden
        onCancel={() => setIsConfirmOpen(false)}
        onOk={() => confirmForm.submit()}
        okText="确认匹配"
        confirmLoading={isSaving}
        width={980}
      >
        <Form form={confirmForm} layout="vertical" onFinish={submitConfirm}>
          <Alert
            className="dashboard-alert"
            type="info"
            showIcon
            message={`参考匹配金额 ${formatMoney(defaultMatchAmount)}`}
            description="匹配金额由你确认，系统不校验银行流水金额与审批单金额是否一致。"
          />
          <div className="reconciliation-confirm-summary">
            <div>
              <Typography.Text type="secondary">银行流水</Typography.Text>
              <Typography.Text strong>{selectedTransaction?.summary || "-"}</Typography.Text>
              <Typography.Text>{selectedTransaction ? `${dayjs(selectedTransaction.occurred_at).format("YYYY-MM-DD")} · ${formatMoney(selectedTransaction.amount)}` : "-"}</Typography.Text>
            </div>
            <div>
              <Typography.Text type="secondary">当前审批单</Typography.Text>
              <Typography.Text strong>{selectedCandidate ? approvalNoText(selectedCandidate) : "-"}</Typography.Text>
              <Typography.Text>{selectedCandidate ? `审批单总额 · ${formatMoney(approvalTotalAmount(selectedCandidate))}` : "-"}</Typography.Text>
            </div>
          </div>
          <Card size="small" title="审批费用明细" style={{ marginBottom: 16 }}>
            <Spin spinning={isExpenseItemsLoading}>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={sortedConfirmExpenseItems}
                scroll={{ x: 860, y: 260 }}
                rowClassName={(record) => (record.id === selectedCandidateId ? "ant-table-row-selected" : "")}
                rowSelection={{
                  selectedRowKeys: selectedConfirmExpenseItemIds,
                  onChange: (keys) => setSelectedConfirmExpenseItemIds(keys as string[]),
                }}
                columns={[
                  {
                    title: "费用内容",
                    dataIndex: "description",
                    width: 260,
                    render: (value, record) => (
                      <Space direction="vertical" size={2} style={{ width: "100%" }}>
                        <Typography.Text ellipsis>{value || "-"}</Typography.Text>
                        <Typography.Text type="secondary">
                          {record.expense_date ? dayjs(record.expense_date).format("YYYY-MM-DD") : "-"}
                        </Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: "金额",
                    dataIndex: "amount",
                    width: 110,
                    align: "right",
                    render: (value) => formatMoney(value),
                  },
                  {
                    title: "分类",
                    width: 260,
                    render: (_, record) => (
                      <Cascader
                        value={confirmDetailCategoryDrafts[record.id]?.category_path ?? categoryPathForName(record.category_l2)}
                        options={categoryOptions}
                        placeholder="选择分类"
                        showSearch
                        changeOnSelect={false}
                        disabled={isSaving}
                        style={{ width: "100%" }}
                        onChange={(value) => {
                          const path = value.map(String);
                          setConfirmDetailCategoryDrafts((current) => {
                            const next = { ...current };
                            const targetIds = selectedConfirmExpenseItemIds.includes(record.id) && selectedConfirmExpenseItemIds.length
                              ? selectedConfirmExpenseItemIds
                              : [record.id];
                            targetIds.forEach((id) => {
                              next[id] = { category_path: path };
                            });
                            return next;
                          });
                        }}
                      />
                    ),
                  },
                  {
                    title: "报销凭证",
                    width: 180,
                    render: (_, record) => renderExpenseVoucherCell(record),
                  },
                ]}
              />
            </Spin>
          </Card>
          <Form.Item name="accounting_month" label="入账月份" rules={[{ required: true, message: "请选择入账月份" }]}>
            <DatePicker picker="month" locale={zhCN.DatePicker} placeholder="请选择入账月份" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="amount" label="匹配金额" rules={[{ required: true, message: "请输入匹配金额" }]}>
            <Input disabled />
          </Form.Item>
          <Form.Item name="bank_occurred" label="银行流水是否已发生" valuePropName="checked">
            <Switch checkedChildren="已发生" unCheckedChildren="未发生" />
          </Form.Item>
          <Form.Item name="reason" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="编辑对账记录"
        open={Boolean(editingRecord)}
        destroyOnHidden
        onCancel={() => {
          setEditingRecord(null);
          setEditExpenseItems([]);
        }}
        onOk={() => editForm.submit()}
        confirmLoading={isSaving}
        width={900}
      >
        <Form form={editForm} layout="vertical" onFinish={submitEdit}>
          {editingRecord?.approval_instance ? (
            <Card size="small" title="审批费用明细" style={{ marginBottom: 16 }}>
              <Spin spinning={isExpenseItemsLoading}>
                <Table
                  size="small"
                  rowKey="id"
                  pagination={false}
                  dataSource={sortedEditExpenseItems}
                  scroll={{ x: 860, y: 260 }}
                  rowClassName={(record) => (record.id === editForm.getFieldValue("expense_item_id") ? "ant-table-row-selected" : "")}
                  rowSelection={{
                    selectedRowKeys: selectedEditExpenseItemIds,
                    onChange: (keys) => setSelectedEditExpenseItemIds(keys as string[]),
                  }}
                  columns={[
                    {
                      title: "费用内容",
                      dataIndex: "description",
                      width: 260,
                      render: (value, record) => (
                        <Space direction="vertical" size={2} style={{ width: "100%" }}>
                          <Typography.Text ellipsis>{value || "-"}</Typography.Text>
                          <Typography.Text type="secondary">
                            {record.expense_date ? dayjs(record.expense_date).format("YYYY-MM-DD") : "-"}
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: "金额",
                      dataIndex: "amount",
                      width: 110,
                      align: "right",
                      render: (value) => formatMoney(value),
                    },
                    {
                      title: "分类",
                      width: 240,
                      render: (_, record) => (
                        <Cascader
                          value={editingDetailCategoryDrafts[record.id]?.category_path ?? categoryPathForName(record.category_l2)}
                          options={categoryOptions}
                          placeholder="选择分类"
                          showSearch
                          changeOnSelect={false}
                          disabled={isSaving}
                          style={{ width: "100%" }}
                          onChange={(value) => {
                            const path = value.map(String);
                            setEditingDetailCategoryDrafts((current) => {
                              const next = { ...current };
                              const targetIds = selectedEditExpenseItemIds.includes(record.id) && selectedEditExpenseItemIds.length
                                ? selectedEditExpenseItemIds
                                : [record.id];
                              targetIds.forEach((id) => {
                                next[id] = { category_path: path };
                              });
                              return next;
                            });
                          }}
                        />
                      ),
                    },
                    {
                      title: "报销凭证",
                      width: 180,
                      render: (_, record) => renderExpenseVoucherCell(record),
                    },
                  ]}
                  onRow={(record) => ({
                    onClick: () => {
                      editForm.setFieldsValue({
                        expense_item_id: record.id,
                      });
                    },
                  })}
                />
              </Spin>
            </Card>
          ) : null}
          <Form.Item name="amount" label="匹配金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="accounting_month" label="入账月份" rules={[{ required: true }]}>
            <DatePicker picker="month" locale={zhCN.DatePicker} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="bank_occurred" label="银行流水是否已发生" valuePropName="checked">
            <Switch checkedChildren="已发生" unCheckedChildren="未发生" />
          </Form.Item>
          <Form.Item name="reason" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title="对账明细" open={Boolean(detailRecord)} destroyOnHidden onClose={() => setDetailRecord(null)} width="min(980px, 92vw)">
        {detailRecord && isReconciliationRecord(detailRecord) ? (
          <Card size="small" title="银行流水" style={{ marginBottom: 16 }}>
            <Table
              size="small"
              pagination={false}
              showHeader={false}
              rowKey="label"
              dataSource={[
                { label: "流水日期", value: formatDateTime(detailRecord.bank_transaction.occurred_at) },
                { label: "流水金额", value: formatMoney(detailRecord.bank_transaction.amount) },
                { label: "匹配金额", value: formatMoney(detailRecord.match.amount) },
                { label: "流水状态", value: detailRecord.match.bank_occurred ? "已发生" : "未发生" },
                { label: "流水号", value: detailRecord.bank_transaction.bank_serial_no || "-" },
                { label: "摘要", value: detailRecord.bank_transaction.summary || "-" },
                { label: "对方户名", value: detailRecord.bank_transaction.counterparty_name || "-" },
                { label: "对方账号", value: detailRecord.bank_transaction.counterparty_account || "-" },
              ]}
              columns={[
                { dataIndex: "label", width: 120 },
                { dataIndex: "value", render: renderApprovalValue },
              ]}
            />
          </Card>
        ) : null}
        {detailRecord?.approval_instance ? (
          <Space direction="vertical" size={16} style={{ width: "100%" }}>
            <Card size="small" title="审批信息">
              <Table
                size="small"
                pagination={false}
                showHeader={false}
                rowKey="label"
                dataSource={[
                  { label: "审批编号", value: approvalNoText(detailRecord) },
                  { label: "审批单", value: detailRecord.expense_item.description },
                  { label: "模板", value: detailRecord.template_name || "手工支出" },
                  { label: "金额", value: formatMoney(detailRecord.expense_item.amount) },
                  { label: "状态", value: approvalStatusLabel(detailRecord.approval_instance.approval_status) },
                  { label: "提交时间", value: formatDateTime(detailRecord.approval_instance.submit_at) },
                  { label: "完成时间", value: formatDateTime(detailRecord.approval_instance.approved_at) },
                ]}
                columns={[
                  { dataIndex: "label", width: 120 },
                  { dataIndex: "value", render: renderApprovalValue },
                ]}
              />
            </Card>
            <Card size="small" title="表单字段">
              <Table
                size="small"
                pagination={false}
                rowKey={(record) => String(record.id ?? record.name ?? record.label)}
                dataSource={detailNormalFields}
                columns={[
                  { title: "字段", width: 180, render: (_, record) => String(record.name ?? record.label ?? record.id ?? "-") },
                  { title: "值", render: (_, record) => renderApprovalValue(record.value ?? record.ext_value ?? record.extValue) },
                ]}
              />
            </Card>
            {detailTables.map((table) => {
              const keys = Array.from(new Set(table.rows.flatMap((row) => Object.keys(row))));
              return (
                <Card size="small" title={`${table.name}明细`} key={table.name}>
                  <Table
                    size="small"
                    rowKey={(_, index) => `${table.name}-${index}`}
                    pagination={false}
                    dataSource={table.rows}
                    scroll={{ x: Math.max(keys.length * 160, 760) }}
                    columns={keys.map((key) => ({ title: key, dataIndex: key, width: 180, render: renderApprovalValue }))}
                  />
                </Card>
              );
            })}
          </Space>
        ) : (
          <Alert type="info" showIcon message="这条记录没有关联钉钉审批详情" />
        )}
      </Drawer>
    </AppShell>
  );
}
