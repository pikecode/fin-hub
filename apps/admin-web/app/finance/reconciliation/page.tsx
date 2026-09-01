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
  Popconfirm,
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
  Upload,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import type {
  ApprovalInstance,
  ApprovalTemplate,
  BankImportPreviewResult,
  BankTransaction,
  ExpenseCategory,
  ReconciliationExpenseCandidate,
  ReconciliationRecord,
  Store,
} from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../../components/AppShell";
import { StoreLedgerWorkspaceNav } from "../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../lib/api";
import { useClientSearchParams } from "../../lib/searchParams";

type ImportMode = "grid" | "file" | "paste";
type ApprovalLike = ReconciliationExpenseCandidate | ReconciliationRecord;
type DingTalkField = Record<string, unknown>;
type DingTalkTableRow = Record<string, unknown>;
type BankEntryField = "occurred_at" | "direction" | "amount" | "summary";

interface BankEntryRow {
  key: string;
  occurred_at: string;
  direction: "收入" | "支出" | "";
  amount: string;
  summary: string;
}

interface CandidateFilters {
  template_id?: string;
  approval_no?: string;
}

interface ConfirmValues {
  amount?: string;
  accounting_month?: dayjs.Dayjs;
  bank_occurred?: boolean;
  category_path?: string[];
  reason?: string;
}

type EditValues = ConfirmValues;

function remainingAmount(transaction: BankTransaction) {
  return Number(transaction.amount) - Number(transaction.matched_amount || 0);
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function approvalNoText(record: ApprovalLike) {
  return record.approval_instance?.approval_no || record.approval_instance?.dingtalk_instance_id || "-";
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

function csvCell(value: string) {
  const normalized = value.replace(/\r/g, "");
  return /[",\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
}

function pasteToFile(text: string) {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trimEnd())
    .filter((row) => row.trim());
  if (!rows.length) return null;
  const firstCells = rows[0].split("\t").map((cell) => cell.trim());
  const hasHeader = firstCells.some((cell) =>
    ["日期", "发生时间", "交易时间", "收入还是支出", "方向", "收支方向", "金额", "备注", "摘要"].includes(cell),
  );
  const normalizedRows = hasHeader ? rows : ["日期\t收入还是支出\t金额\t备注", ...rows];
  const csv = normalizedRows.map((row) => row.split("\t").map(csvCell).join(",")).join("\n");
  return new File([csv], "bank-transactions-paste.csv", { type: "text/csv;charset=utf-8" });
}

const bankEntryFields: BankEntryField[] = ["occurred_at", "direction", "amount", "summary"];
const bankEntryHeaders: Record<BankEntryField, string> = {
  occurred_at: "日期",
  direction: "收入还是支出",
  amount: "金额",
  summary: "备注",
};

function createEmptyEntryRows(count: number, offset = 0): BankEntryRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `entry-${Date.now()}-${offset + index}-${Math.random().toString(36).slice(2, 8)}`,
    occurred_at: "",
    direction: "",
    amount: "",
    summary: "",
  }));
}

function isEntryRowEmpty(row: BankEntryRow) {
  return !row.occurred_at.trim() && !row.direction && !row.amount.trim() && !row.summary.trim();
}

function entryRowsToText(rows: BankEntryRow[]) {
  const filledRows = rows.filter((row) => !isEntryRowEmpty(row));
  if (!filledRows.length) return "";
  return [
    bankEntryFields.map((field) => bankEntryHeaders[field]).join("\t"),
    ...filledRows.map((row) => bankEntryFields.map((field) => row[field]).join("\t")),
  ].join("\n");
}

function normalizeEntryDirection(value: string): BankEntryRow["direction"] {
  const normalized = value.trim().toLowerCase();
  if (["收入", "income", "in", "收"].includes(normalized)) return "收入";
  if (["支出", "expense", "out", "付", "付款"].includes(normalized)) return "支出";
  return "";
}

function parsePastedEntryRows(text: string) {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trimEnd())
    .filter((row) => row.trim());
  if (!rows.length) return [];
  const headerWords = Object.values(bankEntryHeaders).concat(["发生时间", "交易时间", "方向", "收支方向", "摘要"]);
  const firstCells = rows[0].split("\t").map((cell) => cell.trim());
  const hasHeader = firstCells.some((cell) => headerWords.includes(cell));
  return (hasHeader ? rows.slice(1) : rows).map((row) => row.split("\t"));
}

function assignEntryField(row: BankEntryRow, field: BankEntryField, value: string) {
  if (field === "direction") {
    row.direction = normalizeEntryDirection(value);
    return;
  }
  row[field] = value;
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
  const [selectedTransaction, setSelectedTransaction] = useState<BankTransaction | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string>();
  const [detailRecord, setDetailRecord] = useState<ApprovalLike | null>(null);
  const [editingRecord, setEditingRecord] = useState<ReconciliationRecord | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("grid");
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [entryRows, setEntryRows] = useState<BankEntryRow[]>(() => createEmptyEntryRows(12));
  const [focusedEntryCell, setFocusedEntryCell] = useState<{ rowIndex: number; field: BankEntryField }>({ rowIndex: 0, field: "occurred_at" });
  const [importPreview, setImportPreview] = useState<BankImportPreviewResult | null>(null);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isCandidateLoading, setIsCandidateLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filterForm] = Form.useForm<CandidateFilters>();
  const [confirmForm] = Form.useForm<ConfirmValues>();
  const [editForm] = Form.useForm<EditValues>();
  const [importForm] = Form.useForm<{ ledger_period?: string }>();

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const currentStore = selectedStoreId ? storesById.get(selectedStoreId) : undefined;
  const activeCategories = categories.filter((category) => category.status === "active");
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
  const selectedCandidate = candidates.find((candidate) => candidate.expense_item.id === selectedCandidateId);
  const bankRemaining = selectedTransaction ? remainingAmount(selectedTransaction) : 0;
  const defaultMatchAmount = selectedCandidate ? Math.min(bankRemaining, Number(selectedCandidate.remaining_amount || 0)) : bankRemaining;
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
      const [storeResult, templateResult, categoryResult] = await Promise.allSettled([
        apiClient.stores.list("?page_size=500"),
        apiClient.dingtalk.listTemplates("?page_size=500"),
        apiClient.categories.list("?page_size=500"),
      ]);
      const errors: string[] = [];
      if (storeResult.status === "fulfilled") {
        setStores(storeResult.value.items);
        if (!selectedStoreId) {
          const defaultStoreId = initialStoreId && storeResult.value.items.some((store) => store.id === initialStoreId)
            ? initialStoreId
            : storeResult.value.items[0]?.id;
          if (defaultStoreId) setSelectedStoreId(defaultStoreId);
        }
      } else {
        errors.push("门店");
      }
      if (templateResult.status === "fulfilled") {
        setTemplates(sortTemplates(templateResult.value.items));
      } else {
        setTemplates([]);
        errors.push("审批模版");
      }
      if (categoryResult.status === "fulfilled") {
        setCategories(categoryResult.value.items);
      } else {
        setCategories([]);
        errors.push("费用分类");
      }
      if (errors.length) {
        setErrorMessage(`部分基础数据加载失败：${errors.join("、")}。请检查当前用户权限。`);
      }
    } finally {
      setIsLoading(false);
    }
  }

  async function loadStoreWorkspace(storeId: string, transaction?: BankTransaction | null) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [bankPage, recordPage, pendingMatchPage] = await Promise.all([
        apiClient.bankTransactions.list(`?store_id=${storeId}&direction=expense&page_size=500`),
        apiClient.matches.reconciliationRecords(`?store_id=${storeId}&page_size=200`),
        apiClient.matches.reconciliationRecords(`?store_id=${storeId}&status=candidate&page_size=500`),
      ]);
      const activeMatchedBankIds = new Set(
        [...recordPage.items, ...pendingMatchPage.items].map((record) => record.bank_transaction.id),
      );
      const unmatched = bankPage.items.filter((item) => remainingAmount(item) > 0 && !activeMatchedBankIds.has(item.id));
      setTransactions(unmatched);
      setRecords(recordPage.items);
      const nextTransaction = transaction && remainingAmount(transaction) > 0 ? transaction : null;
      setSelectedTransaction(nextTransaction);
      setCandidates([]);
      setSelectedCandidateId(undefined);
      await loadCandidates(nextTransaction, storeId, filterForm.getFieldsValue());
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载门店对账数据");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadCandidates(transaction: BankTransaction | null, storeId: string, filters?: CandidateFilters) {
    setIsCandidateLoading(true);
    setErrorMessage(null);
    const params = new URLSearchParams({
      store_id: storeId,
      approval_only: "true",
      page_size: "100",
    });
    if (transaction) params.set("bank_transaction_id", transaction.id);
    if (filters?.template_id) params.set("template_id", filters.template_id);
    if (filters?.approval_no) params.set("approval_no", filters.approval_no);
    try {
      const result = await apiClient.matches.reconciliationCandidates(`?${params.toString()}`);
      setCandidates(result.candidates);
      setSelectedCandidateId(undefined);
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
    if (initialApprovalNo) {
      filterForm.setFieldsValue({ approval_no: initialApprovalNo });
    }
  }, [filterForm, initialApprovalNo]);

  useEffect(() => {
    if (selectedStoreId) void loadStoreWorkspace(selectedStoreId);
  }, [selectedStoreId]);

  async function selectTransaction(transaction: BankTransaction) {
    if (!selectedStoreId) return;
    setSelectedTransaction(transaction);
    await loadCandidates(transaction, selectedStoreId, filterForm.getFieldsValue());
  }

  function currentImportFile() {
    if (importMode === "grid") return pasteToFile(entryRowsToText(entryRows));
    if (importMode === "paste") return pasteToFile(pasteText);
    return uploadFileList[0]?.originFileObj ?? null;
  }

  function updateEntryCell(rowKey: string, field: BankEntryField, value: string) {
    setEntryRows((rows) =>
      rows.map((row) =>
        row.key === rowKey
          ? {
              ...row,
              [field]: field === "direction" ? normalizeEntryDirection(value) || (value as BankEntryRow["direction"]) : value,
            }
          : row,
      ),
    );
    setImportPreview(null);
  }

  function pasteRowsIntoGrid(text: string, startRowIndex = focusedEntryCell.rowIndex, startField = focusedEntryCell.field) {
    const pastedRows = parsePastedEntryRows(text);
    if (!pastedRows.length) return;
    const startFieldIndex = bankEntryFields.indexOf(startField);
    const requiredRows = startRowIndex + pastedRows.length;
    setEntryRows((rows) => {
      const nextRows = [...rows];
      if (requiredRows > nextRows.length) {
        nextRows.push(...createEmptyEntryRows(requiredRows - nextRows.length, nextRows.length));
      }
      pastedRows.forEach((cells, rowOffset) => {
        const targetIndex = startRowIndex + rowOffset;
        const target = { ...nextRows[targetIndex] };
        if (cells.length === 1) {
          const value = cells[0]?.trim() ?? "";
          assignEntryField(target, startField, value);
        } else {
          cells.forEach((cell, columnOffset) => {
            const field = bankEntryFields[startFieldIndex + columnOffset];
            if (!field) return;
            const value = cell.trim();
            assignEntryField(target, field, value);
          });
        }
        nextRows[targetIndex] = target;
      });
      return nextRows;
    });
    setImportPreview(null);
  }

  function fillEntryColumn(field: BankEntryField) {
    setEntryRows((rows) => {
      const sourceValue = rows.find((row) => String(row[field] || "").trim())?.[field] ?? "";
      if (!sourceValue) return rows;
      return rows.map((row) => (isEntryRowEmpty(row) || !String(row[field] || "").trim() ? { ...row, [field]: sourceValue } : row));
    });
    setImportPreview(null);
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      pasteRowsIntoGrid(text);
    } catch {
      message.warning("浏览器未允许读取剪贴板，请直接在表格单元格里粘贴");
    }
  }

  async function previewImport() {
    if (!selectedStoreId) return;
    const file = currentImportFile();
    if (!file) {
      setErrorMessage(importMode === "file" ? "请选择 CSV / XLSX 文件" : "请录入银行流水数据");
      return;
    }
    const values = importForm.getFieldsValue();
    const formData = new FormData();
    formData.append("store_id", selectedStoreId);
    if (values.ledger_period) formData.append("ledger_period", values.ledger_period);
    formData.append("file", file);
    setIsSaving(true);
    try {
      setImportPreview(await apiClient.bankTransactions.previewImport(formData));
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法预览银行流水");
    } finally {
      setIsSaving(false);
    }
  }

  async function submitImport() {
    if (!selectedStoreId) return;
    const file = currentImportFile();
    if (!file) {
      setErrorMessage(importMode === "file" ? "请选择 CSV / XLSX 文件" : "请录入银行流水数据");
      return;
    }
    const values = importForm.getFieldsValue();
    const formData = new FormData();
    formData.append("store_id", selectedStoreId);
    if (values.ledger_period) formData.append("ledger_period", values.ledger_period);
    formData.append("started_by", "admin");
    formData.append("file", file);
    setIsSaving(true);
    try {
      const result = await apiClient.bankTransactions.importFile(formData);
      message.success(`导入 ${result.created_count} 条，跳过 ${result.skipped_count} 条`);
      setIsImportOpen(false);
      setPasteText("");
      setEntryRows(createEmptyEntryRows(12));
      setUploadFileList([]);
      setImportPreview(null);
      await loadStoreWorkspace(selectedStoreId, selectedTransaction);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法导入银行流水");
    } finally {
      setIsSaving(false);
    }
  }

  function openConfirm() {
    if (!selectedTransaction || !selectedCandidate) {
      message.warning("请先选择银行流水和审批单");
      return;
    }
    confirmForm.setFieldsValue({
      amount: defaultMatchAmount.toFixed(2),
      accounting_month: dayjs(selectedTransaction.ledger_period || selectedTransaction.occurred_at.slice(0, 7)),
      bank_occurred: true,
      category_path: categoryPathForName(selectedCandidate.expense_item.category_l2),
    });
    setIsConfirmOpen(true);
  }

  async function submitConfirm(values: ConfirmValues) {
    if (!selectedTransaction || !selectedCandidate || !selectedStoreId) return;
    const accountingPeriod = values.accounting_month?.format("YYYY-MM");
    if (!accountingPeriod) return;
    setIsSaving(true);
    try {
      const match = await apiClient.matches.create({
        bank_transaction_id: selectedTransaction.id,
        expense_item_id: selectedCandidate.expense_item.id,
        amount: values.amount || defaultMatchAmount.toFixed(2),
        accounting_period: accountingPeriod,
        bank_occurred: values.bank_occurred ?? true,
        category_l1: values.category_path?.[0] || null,
        category_l2: values.category_path?.at(-1) || null,
        confidence: selectedCandidate.score,
        reason: values.reason || selectedCandidate.reason,
      });
      await apiClient.matches.confirm(match.id, "admin");
      message.success("匹配已确认");
      setIsConfirmOpen(false);
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
    editForm.setFieldsValue({
      amount: record.match.amount,
      accounting_month: dayjs(record.match.accounting_period || record.bank_transaction.ledger_period || record.bank_transaction.occurred_at.slice(0, 7)),
      bank_occurred: record.match.bank_occurred,
      category_path: categoryPathForName(record.expense_item.category_l2),
      reason: record.match.reason || undefined,
    });
  }

  async function submitEdit(values: EditValues) {
    if (!editingRecord || !selectedStoreId) return;
    setIsSaving(true);
    try {
      await apiClient.matches.updateReconciliationRecord(editingRecord.match.id, {
        amount: values.amount || editingRecord.match.amount,
        accounting_period: values.accounting_month?.format("YYYY-MM") || editingRecord.match.accounting_period,
        bank_occurred: values.bank_occurred ?? true,
        category_l1: values.category_path?.[0] || null,
        category_l2: values.category_path?.at(-1) || null,
        reason: values.reason || null,
      });
      message.success("对账记录已更新");
      setEditingRecord(null);
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
          <Typography.Text type="secondary" ellipsis>
            {record.bank_transaction.bank_serial_no ? `流水号 ${record.bank_transaction.bank_serial_no}` : "未填写流水号"}
          </Typography.Text>
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

  const entryColumns: ColumnsType<BankEntryRow> = [
    {
      title: "日期",
      dataIndex: "occurred_at",
      width: 150,
      render: (value: string, record, index) => (
        <Input
          value={value}
          placeholder="2026/8/28"
          onFocus={() => setFocusedEntryCell({ rowIndex: index, field: "occurred_at" })}
          onPaste={(event) => {
            event.preventDefault();
            pasteRowsIntoGrid(event.clipboardData.getData("text"), index, "occurred_at");
          }}
          onChange={(event) => updateEntryCell(record.key, "occurred_at", event.target.value)}
        />
      ),
    },
    {
      title: "方向",
      dataIndex: "direction",
      width: 120,
      render: (value: BankEntryRow["direction"], record, index) => (
        <Select
          value={value || undefined}
          placeholder="支出"
          options={[
            { label: "支出", value: "支出" },
            { label: "收入", value: "收入" },
          ]}
          onFocus={() => setFocusedEntryCell({ rowIndex: index, field: "direction" })}
          onChange={(nextValue) => updateEntryCell(record.key, "direction", nextValue)}
          style={{ width: "100%" }}
        />
      ),
    },
    {
      title: "金额",
      dataIndex: "amount",
      width: 140,
      render: (value: string, record, index) => (
        <Input
          value={value}
          placeholder="12002"
          onFocus={() => setFocusedEntryCell({ rowIndex: index, field: "amount" })}
          onPaste={(event) => {
            event.preventDefault();
            pasteRowsIntoGrid(event.clipboardData.getData("text"), index, "amount");
          }}
          onChange={(event) => updateEntryCell(record.key, "amount", event.target.value)}
        />
      ),
    },
    {
      title: "备注",
      dataIndex: "summary",
      render: (value: string, record, index) => (
        <Input
          value={value}
          placeholder="备注"
          onFocus={() => setFocusedEntryCell({ rowIndex: index, field: "summary" })}
          onPaste={(event) => {
            event.preventDefault();
            pasteRowsIntoGrid(event.clipboardData.getData("text"), index, "summary");
          }}
          onChange={(event) => updateEntryCell(record.key, "summary", event.target.value)}
        />
      ),
    },
  ];

  return (
    <AppShell
      title="财务对账"
      kicker="按门店录入银行流水，并匹配钉钉审批单"
    >
      {initialStoreId ? (
        <StoreLedgerWorkspaceNav
          storeId={selectedStoreId ?? initialStoreId}
          storeName={currentStore?.name}
          period={initialLedgerPeriod}
          statusLabel={currentStore?.status === "active" ? "启用门店" : currentStore ? "停用门店" : undefined}
          activeKey="matching"
        />
      ) : null}
      {errorMessage ? <Alert className="dashboard-alert" type="warning" showIcon message={errorMessage} closable onClose={() => setErrorMessage(null)} /> : null}

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
            <Statistic title="待匹配流水" value={transactions.length} />
            <Statistic title="候选审批单" value={candidates.length} />
            <Statistic title="已对账" value={records.length} />
          </div>
        </div>
        <Space className="reconciliation-summary-card__actions">
          <Button disabled={!selectedStoreId} type="primary" onClick={() => setIsImportOpen(true)}>导入/录入流水</Button>
          <Button onClick={() => selectedStoreId && loadStoreWorkspace(selectedStoreId)}>刷新</Button>
        </Space>
      </Card>

      <Tabs
        className="reconciliation-tabs"
        defaultActiveKey="workbench"
        items={[
          {
            key: "workbench",
            label: `待匹配 (${transactions.length})`,
            children: (
              <Splitter className="reconciliation-workbench">
                <Splitter.Panel defaultSize="34%" min="300px">
                  <Card
                    title="待匹配银行流水"
                    className="data-table-card bank-transaction-panel"
                    extra={<Typography.Text type="secondary">共 {transactions.length} 条</Typography.Text>}
                  >
                    {transactions.length ? (
                      <div className="bank-transaction-list">
                        {transactions.map((transaction) => {
                          const isSelected = transaction.id === selectedTransaction?.id;
                          const remaining = remainingAmount(transaction);
                          return (
                            <button
                              key={transaction.id}
                              type="button"
                              className={`bank-transaction-card${isSelected ? " is-selected" : ""}`}
                              onClick={() => selectTransaction(transaction)}
                            >
                              <span className="bank-transaction-card__main">
                                <span className="bank-transaction-card__meta">
                                  <Typography.Text strong>{dayjs(transaction.occurred_at).format("YYYY-MM-DD")}</Typography.Text>
                                  <Tag color="orange">支出</Tag>
                                  {transaction.ledger_period ? <Tag>{transaction.ledger_period}</Tag> : null}
                                </span>
                                <Typography.Text className="bank-transaction-card__summary" ellipsis>
                                  {transaction.summary || transaction.counterparty_name || "无摘要"}
                                </Typography.Text>
                                <span className="bank-transaction-card__serial">
                                  {transaction.bank_serial_no ? `流水号 ${transaction.bank_serial_no}` : "未填写流水号"}
                                </span>
                              </span>
                              <span className="bank-transaction-card__amounts">
                                <Typography.Text className="bank-transaction-card__amount">{formatMoney(transaction.amount)}</Typography.Text>
                                <Typography.Text type="secondary">未匹配 {formatMoney(remaining)}</Typography.Text>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectedStoreId ? "当前门店暂无待匹配流水" : "请先选择门店"} />
                    )}
                  </Card>
                </Splitter.Panel>
                <Splitter.Panel min="460px">
                  <Card
                    title={selectedTransaction ? `审批单候选：${formatMoney(bankRemaining)}` : "审批单候选"}
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
                    <Spin spinning={isCandidateLoading}>
                      {candidates.length ? (
                        <div className="approval-candidate-list">
                          {candidates.map((candidate) => {
                            const isSelected = candidate.expense_item.id === selectedCandidateId;
                            const storeName = storesById.get(candidate.expense_item.store_id)?.name || candidate.approval_instance?.department_name || "-";
                            return (
                              <div
                                key={candidate.expense_item.id}
                                role="button"
                                tabIndex={0}
                                className={`approval-candidate-card${isSelected ? " is-selected" : ""}`}
                                onClick={() => setSelectedCandidateId(candidate.expense_item.id)}
                                onKeyDown={(event) => {
                                  if (event.key === "Enter" || event.key === " ") setSelectedCandidateId(candidate.expense_item.id);
                                }}
                              >
                                <div className="approval-candidate-card__score">
                                  <span>{Number(candidate.score).toFixed(0)}</span>
                                  <Typography.Text type="secondary">推荐</Typography.Text>
                                </div>
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
                                  <Typography.Text className="approval-candidate-card__amount">{formatMoney(candidate.expense_item.amount)}</Typography.Text>
                                  <Typography.Text type="secondary">未匹配 {formatMoney(candidate.remaining_amount)}</Typography.Text>
                                  <Button
                                    size="small"
                                    onClick={(event) => {
                                      event.stopPropagation();
                                      setDetailRecord(candidate);
                                    }}
                                  >
                                    明细
                                  </Button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      ) : (
                        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={selectedStoreId ? "当前门店暂无候选审批单" : "请先选择门店"} />
                      )}
                    </Spin>
                  </Card>
                </Splitter.Panel>
              </Splitter>
            ),
          },
          {
            key: "records",
            label: `已对账记录 (${records.length})`,
            children: (
              <Card title="已对账记录" className="data-table-card reconciliation-record-card">
                <Table rowKey={(record) => record.match.id} size="small" loading={isLoading} columns={recordColumns} dataSource={records} pagination={{ pageSize: 12 }} scroll={{ x: 1290, y: "calc(100vh - 430px)" }} sticky />
              </Card>
            ),
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
        width={720}
      >
        <Form form={confirmForm} layout="vertical" onFinish={submitConfirm}>
          <Alert
            className="dashboard-alert"
            type="info"
            showIcon
            message={`建议匹配金额 ${formatMoney(defaultMatchAmount)}`}
            description={`确认后会把当前银行流水关联到所选审批明细，并把下面的费用分类写入该明细，供后续报表统计使用。流水未匹配 ${selectedTransaction ? formatMoney(bankRemaining) : "-"}，审批明细未匹配 ${selectedCandidate ? formatMoney(selectedCandidate.remaining_amount) : "-"}。`}
          />
          <div className="reconciliation-confirm-summary">
            <div>
              <Typography.Text type="secondary">银行流水</Typography.Text>
              <Typography.Text strong>{selectedTransaction?.summary || "-"}</Typography.Text>
              <Typography.Text>{selectedTransaction ? `${dayjs(selectedTransaction.occurred_at).format("YYYY-MM-DD")} · ${formatMoney(selectedTransaction.amount)}` : "-"}</Typography.Text>
            </div>
            <div>
              <Typography.Text type="secondary">审批明细</Typography.Text>
              <Typography.Text strong>{selectedCandidate?.expense_item.description || "-"}</Typography.Text>
              <Typography.Text>{selectedCandidate ? `${approvalNoText(selectedCandidate)} · ${formatMoney(selectedCandidate.expense_item.amount)}` : "-"}</Typography.Text>
            </div>
          </div>
          <Form.Item name="accounting_month" label="入账月份" rules={[{ required: true }]}>
            <DatePicker picker="month" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="amount" label="匹配金额" rules={[{ required: true, message: "请输入匹配金额" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="category_path" label="审批明细费用分类" rules={[{ required: true, message: "请选择费用分类" }]}>
            <Cascader
              options={categoryOptions}
              placeholder="选择一级 / 二级分类"
              showSearch
              changeOnSelect={false}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item name="bank_occurred" label="银行流水是否已发生" valuePropName="checked">
            <Switch checkedChildren="已发生" unCheckedChildren="未发生" />
          </Form.Item>
          <Form.Item name="reason" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="编辑对账记录" open={Boolean(editingRecord)} destroyOnHidden onCancel={() => setEditingRecord(null)} onOk={() => editForm.submit()} confirmLoading={isSaving}>
        <Form form={editForm} layout="vertical" onFinish={submitEdit}>
          <Form.Item name="amount" label="匹配金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="accounting_month" label="入账月份" rules={[{ required: true }]}>
            <DatePicker picker="month" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="category_path" label="费用分类" rules={[{ required: true, message: "请选择费用分类" }]}>
            <Cascader
              options={categoryOptions}
              placeholder="选择一级 / 二级分类"
              showSearch
              changeOnSelect={false}
              style={{ width: "100%" }}
            />
          </Form.Item>
          <Form.Item name="bank_occurred" label="银行流水是否已发生" valuePropName="checked">
            <Switch checkedChildren="已发生" unCheckedChildren="未发生" />
          </Form.Item>
          <Form.Item name="reason" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="导入当前门店流水" open={isImportOpen} destroyOnHidden onCancel={() => setIsImportOpen(false)} onOk={submitImport} confirmLoading={isSaving} width={960} footer={[
        <Button key="cancel" onClick={() => setIsImportOpen(false)}>取消</Button>,
        <Button key="preview" onClick={previewImport} loading={isSaving}>预览</Button>,
        <Button key="import" type="primary" onClick={submitImport} loading={isSaving}>确认导入</Button>,
      ]}>
        <Alert className="dashboard-alert" type="info" showIcon message={`导入门店：${selectedStoreId ? storesById.get(selectedStoreId)?.name : "-"}`} description="不指定账期时，系统按每行日期自动归属到对应月份；跨月流水可以一次粘贴。" />
        <Form form={importForm} layout="vertical">
          <Form.Item name="ledger_period" label="固定账期">
            <Input placeholder="可留空，例如 2026-08" />
          </Form.Item>
        </Form>
        <Tabs activeKey={importMode} onChange={(key) => { setImportMode(key as ImportMode); setImportPreview(null); }} items={[
          {
            key: "grid",
            label: "表格录入",
            children: (
              <Space direction="vertical" style={{ width: "100%" }} size={12}>
                <div className="bank-entry-grid-toolbar">
                  <Space wrap>
                    <Button onClick={() => setEntryRows((rows) => [...rows, ...createEmptyEntryRows(10, rows.length)])}>添加 10 行</Button>
                    <Button onClick={pasteFromClipboard}>读取剪贴板</Button>
                    <Button onClick={() => { setEntryRows(createEmptyEntryRows(12)); setImportPreview(null); }}>清空</Button>
                  </Space>
                  <Space wrap>
                    <Button size="small" onClick={() => fillEntryColumn("occurred_at")}>日期向下填充</Button>
                    <Button size="small" onClick={() => fillEntryColumn("direction")}>方向向下填充</Button>
                    <Button size="small" onClick={() => fillEntryColumn("summary")}>备注向下填充</Button>
                  </Space>
                </div>
                <Table
                  className="bank-entry-grid"
                  rowKey="key"
                  size="small"
                  pagination={false}
                  dataSource={entryRows}
                  columns={entryColumns}
                  scroll={{ x: 760, y: 360 }}
                />
                <Typography.Text type="secondary">可以从 Excel 复制整块数据后点第一个日期单元格粘贴；单列数据会从当前单元格向下填充。</Typography.Text>
              </Space>
            ),
          },
          {
            key: "paste",
            label: "批量粘贴",
            children: (
              <Space direction="vertical" style={{ width: "100%" }}>
                <Input.TextArea rows={10} value={pasteText} onChange={(event) => { setPasteText(event.target.value); setImportPreview(null); }} placeholder={"2026/8/28\t支出\t12002\t备注1\n2026/8/29\t支出\t12003\t备注2"} />
                <Typography.Text type="secondary">无表头时默认按：日期、收入还是支出、金额、备注。</Typography.Text>
              </Space>
            ),
          },
          {
            key: "file",
            label: "文件导入",
            children: (
              <Upload accept=".csv,.xlsx,.xlsm" maxCount={1} fileList={uploadFileList} beforeUpload={() => false} onChange={({ fileList }) => { setUploadFileList(fileList.slice(-1)); setImportPreview(null); }}>
                <Button>选择文件</Button>
              </Upload>
            ),
          },
        ]} />
        {importPreview ? (
          <Table
            style={{ marginTop: 16 }}
            rowKey="row_number"
            size="small"
            pagination={false}
            dataSource={importPreview.preview_rows}
            columns={[
              { title: "行", dataIndex: "row_number", width: 70 },
              { title: "日期", dataIndex: "occurred_at", width: 150, render: formatDateTime },
              { title: "方向", dataIndex: "direction", width: 80, render: (value) => (value === "income" ? "收入" : "支出") },
              { title: "金额", dataIndex: "amount", width: 120, align: "right", render: (value: string) => formatMoney(value) },
              { title: "备注", dataIndex: "summary", ellipsis: true, render: (value) => value || "-" },
              { title: "结果", dataIndex: "duplicate", width: 100, render: (value: boolean) => (value ? <Tag>重复</Tag> : <Tag color="green">可导入</Tag>) },
            ]}
            scroll={{ x: 760 }}
          />
        ) : null}
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
                  { label: "状态", value: detailRecord.approval_instance.approval_status },
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
                  { title: "类型", width: 140, render: (_, record) => String(record.component_type ?? record.componentType ?? "-") },
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
