"use client";

import { Alert, Button, Card, Checkbox, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Statistic, Table, Tabs, Upload, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import customParseFormat from "dayjs/plugin/customParseFormat";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Key } from "react";
import {
  PlusOutlined,
  ImportOutlined,
  UploadOutlined,
  DownloadOutlined,
  DeleteOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import type {
  BankImportPreviewRow,
  BankImportPreviewResult,
  BankImportRowError,
  BankTransaction,
  BankTransactionCreate,
  Ledger,
  Store,
} from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { MoneyDisplay } from "../components/MoneyDisplay";
import { StatusBadge } from "../components/StatusBadge";
import { getBankTransactionViewColumns } from "../components/BankTransactionColumns";
import { StoreLedgerWorkspaceNav } from "../components/StoreLedgerWorkspaceNav";
import { EnterpriseTable } from "../components/EnterpriseTable";
import type { EnterpriseTableColumn } from "../components/EnterpriseTable";
import { apiClient } from "../lib/api";
import { getLedgers, getStores } from "../lib/referenceData";
import { useClientSearchParams } from "../lib/searchParams";

dayjs.extend(customParseFormat);

interface BankFormValues extends Omit<BankTransactionCreate, "occurred_at"> {
  ledger_key?: string;
  occurred_at?: dayjs.Dayjs;
}

interface BankFilterValues {
  store_id?: string;
  ledger_period?: string;
  month?: dayjs.Dayjs;
  direction?: "income" | "expense";
  special_type?: "normal" | "current_account" | "shareholder_dividend" | "shareholder_capital" | "other_income_expense";
  unmatched_only?: boolean;
  match_status?: "unmatched" | "matched";
  counterparty_name?: string;
  counterparty_account?: string;
  occurred_range?: [dayjs.Dayjs, dayjs.Dayjs];
}

const bankSpecialTypeLabels: Record<Exclude<NonNullable<BankTransactionCreate["special_type"]>, "normal">, string> = {
  current_account: "往来款",
  shareholder_dividend: "股东分红",
  shareholder_capital: "股东注资",
  other_income_expense: "其他收支",
};

function bankSpecialTypeLabel(value?: string | null) {
  return value ? bankSpecialTypeLabels[value as keyof typeof bankSpecialTypeLabels] ?? value : "普通流水";
}

type BankEntryField = "occurred_at" | "income_amount" | "expense_amount" | "counterparty_name" | "counterparty_account" | "summary";
type BankPaymentStatus = "paid" | "unpaid";

interface BankEntryRow {
  key: string;
  occurred_at: string;
  income_amount: string;
  expense_amount: string;
  counterparty_name: string;
  counterparty_account: string;
  summary: string;
  payment_status: BankPaymentStatus;
}

const bankEntryHeaders: Record<BankEntryField, string> = {
  occurred_at: "发生日期",
  income_amount: "收入",
  expense_amount: "支出",
  counterparty_name: "对方户名",
  counterparty_account: "对方账号",
  summary: "备注",
};

const bankEntryFields: BankEntryField[] = [
  "occurred_at",
  "income_amount",
  "expense_amount",
  "counterparty_name",
  "counterparty_account",
  "summary",
];

const bankPaymentStatusOptions: Array<{ label: string; value: BankPaymentStatus }> = [
  { label: "已实付", value: "paid" },
  { label: "未实付", value: "unpaid" },
];

function createBankEntryRows(count: number): BankEntryRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `bank-entry-${Date.now()}-${index}`,
    occurred_at: "",
    income_amount: "",
    expense_amount: "",
    counterparty_name: "",
    counterparty_account: "",
    summary: "",
    payment_status: "paid",
  }));
}

function ensureBankEntryRows(rows: BankEntryRow[], requiredCount: number) {
  if (rows.length >= requiredCount) return rows.map((row) => ({ ...row }));
  return [...rows.map((row) => ({ ...row })), ...createBankEntryRows(requiredCount - rows.length)];
}

function isBankEntryRowEmpty(row: BankEntryRow) {
  return (
    !row.occurred_at.trim() &&
    !row.income_amount.trim() &&
    !row.expense_amount.trim() &&
    !row.counterparty_name.trim() &&
    !row.counterparty_account.trim() &&
    !row.summary.trim()
  );
}

function getBankEntryValidationErrors(rows: BankEntryRow[], period?: string) {
  const errors: string[] = [];
  rows.forEach((row, index) => {
    if (isBankEntryRowEmpty(row)) return;
    const rowNumber = index + 1;
    const occurredAt = parseEntryOccurredAt(row.occurred_at);
    const incomeAmount = normalizePastedAmount(row.income_amount);
    const expenseAmount = normalizePastedAmount(row.expense_amount);
    const hasIncome = Boolean(incomeAmount);
    const hasExpense = Boolean(expenseAmount);
    if (!occurredAt) errors.push(`第 ${rowNumber} 行：发生日期格式无效`);
    if (period && occurredAt && occurredAt.format("YYYY-MM") !== period) errors.push(`第 ${rowNumber} 行：发生日期不属于账期 ${period}`);
    if (!normalizePastedCell(row.counterparty_name)) errors.push(`第 ${rowNumber} 行：请填写对方户名`);
    if (hasIncome && hasExpense) errors.push(`第 ${rowNumber} 行：收入和支出只能填写一个`);
    if (!hasIncome && !hasExpense) errors.push(`第 ${rowNumber} 行：请填写收入或支出金额`);
    for (const [label, value] of [["收入", incomeAmount], ["支出", expenseAmount]] as const) {
      if (value && (!Number.isFinite(Number(value)) || Number(value) <= 0)) errors.push(`第 ${rowNumber} 行：${label}金额必须大于 0`);
    }
  });
  return errors;
}

function bankDirectionCell(direction: "income" | "expense", target: "income" | "expense") {
  if (direction !== target) return <span className="bank-direction-placeholder">-</span>;
  return <StatusBadge status={direction === "income" ? "income" : "expense"} text={direction === "income" ? "收入" : "支出"} size="small" />;
}

function normalizeEntryOccurredAt(value: string) {
  const text = normalizePastedCell(value);
  if (!text) return "";
  const formats = [
    "YYYY-MM-DD HH:mm:ss",
    "YYYY-MM-DD HH:mm",
    "YYYY/MM/DD HH:mm:ss",
    "YYYY/MM/DD HH:mm",
    "YYYY-MM-DD",
    "YYYY/MM/DD",
    "YYYY年MM月DD日 HH:mm:ss",
    "YYYY年MM月DD日 HH:mm",
    "YYYY年MM月DD日",
  ];
  const parsed = dayjs(text, formats, true);
  if (parsed.isValid()) {
    return parsed.format("YYYY-MM-DD");
  }
  const fallback = dayjs(text);
  return fallback.isValid() ? fallback.format("YYYY-MM-DD") : text;
}

function parseEntryOccurredAt(value: string) {
  const text = normalizePastedCell(value);
  if (!text) return null;
  const formats = [
    "YYYY-MM-DD HH:mm:ss",
    "YYYY-MM-DD HH:mm",
    "YYYY/MM/DD HH:mm:ss",
    "YYYY/MM/DD HH:mm",
    "YYYY-MM-DD",
    "YYYY/MM/DD",
    "YYYY年MM月DD日 HH:mm:ss",
    "YYYY年MM月DD日 HH:mm",
    "YYYY年MM月DD日",
  ];
  const parsed = dayjs(text, formats, true);
  if (parsed.isValid()) return parsed;
  const fallback = dayjs(text);
  return fallback.isValid() ? fallback : null;
}

function toBankOccurredAt(value: dayjs.Dayjs) {
  return `${value.format("YYYY-MM-DD")}T00:00:00`;
}

function normalizeFullWidthText(value: string) {
  return value.replace(/[！-～]/g, (char) => String.fromCharCode(char.charCodeAt(0) - 0xfee0)).replace(/\u3000/g, " ");
}

function normalizePastedCell(value?: string | null) {
  if (!value) return "";
  let text = normalizeFullWidthText(value).replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (text.length >= 3 && text.startsWith("=\"") && text.endsWith("\"")) {
    text = text.slice(2, -1).replace(/""/g, "\"").trim();
  }
  if (text.length >= 2 && text.startsWith("\"") && text.endsWith("\"")) {
    text = text.slice(1, -1).replace(/""/g, "\"").trim();
  }
  return text;
}

function normalizePastedAmount(value?: string | null) {
  const text = normalizePastedCell(value)
    .replace(/[￥¥,\s]/g, "")
    .replace(/[()（）]/g, (char) => (char === "(" || char === "（" ? "-" : ""))
    .replace(/[^\d.+-]/g, "");
  const normalized = text.replace(/(?!^)-/g, "").replace(/(?!^)\+/g, "");
  return normalized && normalized !== "-" && normalized !== "." ? normalized : "";
}

function parsePastedEntryRows(text: string) {
  const source = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!source.includes("\t") && !source.includes("\n") && !source.trim()) return [];
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const delimiter = source.includes("\t") ? "\t" : ",";

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const nextChar = source[index + 1];
    if (char === "\"") {
      if (inQuotes && nextChar === "\"") {
        cell += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }
    if (!inQuotes && char === delimiter) {
      row.push(normalizePastedCell(cell));
      cell = "";
      continue;
    }
    if (!inQuotes && char === "\n") {
      row.push(normalizePastedCell(cell));
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += char;
  }

  row.push(normalizePastedCell(cell));
  rows.push(row);
  if (!rows.length) return [];
  const headerWords = Object.values(bankEntryHeaders).concat([
    "发生时间",
    "发生日期",
    "交易时间",
    "方向",
    "收支方向",
    "摘要",
    "类型",
    "备注",
    "对方户名",
    "对方账号",
    "户名",
    "账号",
  ]);
  const firstCells = rows[0].map((cell) => normalizePastedCell(cell));
  const hasHeader = firstCells.some((cell) => headerWords.includes(cell));
  return hasHeader ? rows.slice(1) : rows;
}

function applyPastedEntryRows(
  text: string,
  rows: BankEntryRow[],
  startRowIndex: number,
  startField: BankEntryField,
) {
  const parsedRows = parsePastedEntryRows(text);
  if (!parsedRows.length) return null;
  const updatedRows = ensureBankEntryRows(rows, startRowIndex + parsedRows.length);
  const startFieldIndex = bankEntryFields.indexOf(startField);
  parsedRows.forEach((cells, rowOffset) => {
    const rowIndex = startRowIndex + rowOffset;
    cells.forEach((cell, cellOffset) => {
      const field = bankEntryFields[startFieldIndex + cellOffset];
      if (!field) return;
      const value = normalizePastedCell(cell);
      if (field === "income_amount" || field === "expense_amount") {
        updatedRows[rowIndex][field] = normalizePastedAmount(value);
        return;
      }
      if (!value) return;
      if (field === "occurred_at") {
        updatedRows[rowIndex].occurred_at = normalizeEntryOccurredAt(value);
      } else if (field === "counterparty_name") {
        updatedRows[rowIndex].counterparty_name = value;
      } else if (field === "counterparty_account") {
        updatedRows[rowIndex].counterparty_account = value;
      } else if (field === "summary") {
        updatedRows[rowIndex].summary = value;
      }
    });
  });
  return updatedRows;
}

export default function BankPage() {
  const searchParams = useClientSearchParams();
  const queryStoreId = searchParams.get("store_id") ?? undefined;
  const queryLedgerPeriod = searchParams.get("ledger_period") ?? undefined;
  const initialFilters = useMemo<BankFilterValues>(
    () => ({
      store_id: queryStoreId,
      ledger_period: queryLedgerPeriod ?? dayjs().format("YYYY-MM"),
      month: dayjs(`${queryLedgerPeriod ?? dayjs().format("YYYY-MM")}-01`),
    }),
    [queryStoreId],
  );

  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [entryRows, setEntryRows] = useState<BankEntryRow[]>(() => createBankEntryRows(10));
  const [entryValidationErrors, setEntryValidationErrors] = useState<string[]>([]);
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([]);
  const [importPreview, setImportPreview] = useState<BankImportPreviewResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEntryModalOpen, setIsEntryModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<BankTransaction | null>(null);
  const [pendingSpecialTransaction, setPendingSpecialTransaction] = useState<BankFormValues | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<BankFormValues>();
  const [entryForm] = Form.useForm<{ ledger_key: string }>();
  const [importForm] = Form.useForm<{ ledger_key: string }>();
  const [filterForm] = Form.useForm<BankFilterValues>();
  const loadRequestIdRef = useRef(0);

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const ledgersByKey = useMemo(
    () => new Map(ledgers.map((ledger) => [`${ledger.store_id}|${ledger.period}`, ledger])),
    [ledgers],
  );
  const openLedgerOptions = ledgers
    .filter((ledger) => ledger.status === "open")
    .map((ledger) => ({
      label: `${storesById.get(ledger.store_id)?.name ?? "未知"} / ${ledger.period}`,
      value: `${ledger.store_id}|${ledger.period}`,
    }));
  const entryLedgerOptions = openLedgerOptions.filter((option) => !queryStoreId || option.value.startsWith(`${queryStoreId}|`));
  const currentStore = queryStoreId ? storesById.get(queryStoreId) : undefined;
  const currentStoreLedgerLabel = queryStoreId ? `${currentStore?.name ?? "当前门店"}` : "";

  const entryBatchTotals = useMemo(() => {
    return entryRows.reduce(
      (totals, row) => {
        const incomeAmount = Number(normalizePastedAmount(row.income_amount) || 0);
        const expenseAmount = Number(normalizePastedAmount(row.expense_amount) || 0);
        return {
          income: totals.income + (Number.isFinite(incomeAmount) ? incomeAmount : 0),
          expense: totals.expense + (Number.isFinite(expenseAmount) ? expenseAmount : 0),
        };
      },
      { income: 0, expense: 0 },
    );
  }, [entryRows]);

  const transactionTotals = useMemo(
    () => transactions.reduce(
      (totals, transaction) => ({
        income: totals.income + (transaction.direction === "income" ? Number(transaction.amount) : 0),
        expense: totals.expense + (transaction.direction === "expense" ? Number(transaction.amount) : 0),
      }),
      { income: 0, expense: 0 },
    ),
    [transactions],
  );

  function buildFilterParams(values?: BankFilterValues) {
    const params = new URLSearchParams({ page_size: "500" });
    const storeId = values?.store_id || queryStoreId;
    if (storeId) params.set("store_id", storeId);
    if (values?.month) params.set("ledger_period", values.month.format("YYYY-MM"));
    else if (values?.ledger_period) params.set("ledger_period", values.ledger_period);
    if (values?.direction) params.set("direction", values.direction);
    if (values?.special_type) params.set("special_type", values.special_type);
    if (values?.unmatched_only) params.set("unmatched_only", "true");
    if (values?.match_status) params.set("match_status", values.match_status);
    if (values?.counterparty_name?.trim()) params.set("counterparty_name", values.counterparty_name.trim());
    if (values?.counterparty_account?.trim()) params.set("counterparty_account", values.counterparty_account.trim());
    if (values?.occurred_range?.[0]) params.set("occurred_from", values.occurred_range[0].startOf("day").format("YYYY-MM-DD HH:mm:ss"));
    if (values?.occurred_range?.[1]) params.set("occurred_to", values.occurred_range[1].add(1, "day").startOf("day").format("YYYY-MM-DD HH:mm:ss"));
    return `?${params.toString()}`;
  }

  async function loadData(filters?: BankFilterValues) {
    const requestId = ++loadRequestIdRef.current;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [storePage, ledgerPage, transactionPage] = await Promise.all([
        getStores(),
        getLedgers(),
        apiClient.bankTransactions.list(buildFilterParams(filters ?? filterForm.getFieldsValue())),
      ]);
      if (requestId === loadRequestIdRef.current) {
        setStores(storePage);
        setLedgers(ledgerPage);
        setTransactions(transactionPage.items);
      }
    } catch (error) {
      if (requestId === loadRequestIdRef.current) {
        setErrorMessage(error instanceof Error ? error.message : "加载失败");
      }
    } finally {
      if (requestId === loadRequestIdRef.current) {
        setIsLoading(false);
      }
    }
  }

  function resetFilters() {
    filterForm.setFieldsValue(initialFilters);
    void loadData(initialFilters);
  }

  useEffect(() => {
    filterForm.setFieldsValue(initialFilters);
    void loadData(initialFilters);
  }, [filterForm, initialFilters]);

  function openCreateModal() {
    setEditingTransaction(null);
    form.resetFields();
    if (queryStoreId && queryLedgerPeriod) {
      form.setFieldValue("ledger_key", `${queryStoreId}|${queryLedgerPeriod}`);
    }
    form.setFieldsValue({
      direction: "expense",
      occurred_at: dayjs(),
      counterparty_name: "",
      counterparty_account: "",
      payment_status: "paid",
    });
    setIsModalOpen(true);
  }

  function openEditModal(transaction: BankTransaction) {
    setEditingTransaction(transaction);
    form.setFieldsValue({
      ledger_key: `${transaction.store_id}|${transaction.ledger_period}`,
      occurred_at: dayjs(transaction.occurred_at),
      direction: transaction.direction,
      amount: transaction.amount,
      counterparty_name: transaction.counterparty_name ?? "",
      counterparty_account: transaction.counterparty_account ?? "",
      summary: transaction.summary ?? undefined,
      special_type: transaction.special_type ?? null,
      payment_status: transaction.payment_status ?? "paid",
    });
    setIsModalOpen(true);
  }

  async function submitTransaction(values: BankFormValues, specialConfirmed = false) {
    if (!values.occurred_at) {
      message.warning("请选择发生时间");
      return;
    }
    if (!values.counterparty_name?.trim()) {
      message.warning("请填写对方户名");
      return;
    }
    const amount = normalizePastedAmount(values.amount);
    if (!amount) {
      message.warning("请填写有效金额");
      return;
    }
    const [formStoreId, formPeriod] = (values.ledger_key ?? "").split("|");
    const storeId = formStoreId || queryStoreId;
    const period = formPeriod || queryLedgerPeriod;
    if (!storeId || !period) {
      message.warning("缺少门店，无法保存流水");
      return;
    }
    try {
      const payload: BankTransactionCreate = {
        store_id: storeId,
        ledger_period: period,
        occurred_at: toBankOccurredAt(values.occurred_at),
        direction: values.direction || "expense",
        amount,
        counterparty_name: normalizePastedCell(values.counterparty_name) || null,
        counterparty_account: normalizePastedCell(values.counterparty_account) || null,
        summary: normalizePastedCell(values.summary) || null,
        special_type: values.special_type || null,
        payment_status: values.payment_status || "paid",
      };
      if (values.special_type && !specialConfirmed) {
        setPendingSpecialTransaction(values);
        return;
      }
      setIsLoading(true);
      if (editingTransaction) {
        const isMatched = Number(editingTransaction.matched_amount || 0) > 0;
        await apiClient.bankTransactions.update(
          editingTransaction.id,
          isMatched ? { payment_status: payload.payment_status } : payload,
        );
        message.success("更新成功");
      } else {
        await apiClient.bankTransactions.create(payload);
        message.success("创建成功");
      }
      setIsModalOpen(false);
      setEditingTransaction(null);
      const refreshed = await apiClient.bankTransactions.list(buildFilterParams(filterForm.getFieldsValue()));
      setTransactions(refreshed.items);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function confirmPendingSpecialTransaction() {
    if (!pendingSpecialTransaction) return;
    const values = pendingSpecialTransaction;
    setPendingSpecialTransaction(null);
    await submitTransaction(values, true);
  }

  async function confirmTransactionSubmit() {
    try {
      const values = await form.validateFields();
      await submitTransaction(values);
    } catch (error) {
      if (error && typeof error === "object" && "errorFields" in error) {
        message.warning("请先完善流水信息");
        return;
      }
      message.error(error instanceof Error ? error.message : "操作失败");
    }
  }

  function openEntryModal() {
    entryForm.resetFields();
    setEntryRows(createBankEntryRows(10));
    setEntryValidationErrors([]);
    if (queryStoreId && queryLedgerPeriod) {
      entryForm.setFieldValue("ledger_key", `${queryStoreId}|${queryLedgerPeriod}`);
    }
    setIsEntryModalOpen(true);
  }

  function removeEntryRow(index: number) {
    setEntryRows((rows) => {
      const nextRows = rows.filter((_, rowIndex) => rowIndex !== index);
      return nextRows.length ? nextRows : createBankEntryRows(1);
    });
  }

  async function submitEntryBatch(values: { ledger_key?: string }) {
    const [formStoreId] = (values.ledger_key ?? "").split("|");
    const storeId = formStoreId || queryStoreId;
    if (!storeId) {
      message.warning("请先选择门店");
      return;
    }
    const nonEmptyRows = entryRows.filter((row) => !isBankEntryRowEmpty(row));
    if (!nonEmptyRows.length) {
      message.warning("请至少填写一行流水");
      return;
    }
    const validationErrors = getBankEntryValidationErrors(entryRows);
    setEntryValidationErrors(validationErrors);
    if (validationErrors.length) {
      message.error(validationErrors[0]);
      return;
    }
    setIsLoading(true);
    try {
    const batch: BankTransactionCreate[] = [];
    for (const row of nonEmptyRows) {
      const occurredAt = parseEntryOccurredAt(row.occurred_at);
      const counterpartyName = normalizePastedCell(row.counterparty_name);
      const incomeAmount = normalizePastedAmount(row.income_amount);
      const expenseAmount = normalizePastedAmount(row.expense_amount);
      const hasIncome = Boolean(incomeAmount);
      const hasExpense = Boolean(expenseAmount);
      if (!occurredAt) {
        throw new Error("批量录入中存在无效的发生时间");
      }
      if (!counterpartyName) {
        throw new Error("批量录入中存在未填写对方户名的行");
      }
      if (hasIncome && hasExpense) {
        throw new Error("批量录入中存在同时填写收入和支出的行");
      }
      if (!hasIncome && !hasExpense) {
        throw new Error("批量录入中存在未填写金额的行");
      }
      batch.push({
        store_id: storeId,
        ledger_period: occurredAt.format("YYYY-MM"),
        occurred_at: toBankOccurredAt(occurredAt),
        direction: hasIncome ? "income" : "expense",
        amount: hasIncome ? incomeAmount : expenseAmount,
        counterparty_name: counterpartyName,
        counterparty_account: normalizePastedCell(row.counterparty_account) || null,
        summary: normalizePastedCell(row.summary) || null,
        payment_status: row.payment_status || "paid",
        });
      }
      const result = await apiClient.bankTransactions.createBatch({ items: batch });
      message.success(`成功录入 ${result.created_count} 条流水`);
      setIsEntryModalOpen(false);
      await loadData(initialFilters);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "录入失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function confirmEntryBatch() {
    try {
      const values = await entryForm.validateFields();
      await submitEntryBatch(values);
    } catch (error) {
      if (error && typeof error === "object" && "errorFields" in error) return;
      message.error(error instanceof Error ? error.message : "批量录入失败");
    }
  }

  async function pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      const parsedRows = parsePastedEntryRows(text);
      if (!parsedRows.length) {
        message.warning("剪贴板中没有有效数据");
        return;
      }
      const updatedRows = applyPastedEntryRows(text, entryRows, 0, "occurred_at");
      if (!updatedRows) return;
      setEntryRows(updatedRows);
      message.success(`已粘贴 ${parsedRows.length} 行数据`);
    } catch {
      message.error("无法读取剪贴板");
    }
  }

  function handleSingleAmountPaste(text: string, onAmount: (amount: string) => void) {
    if (text.includes("\t") || text.includes("\n")) return false;
    const amount = normalizePastedAmount(text);
    if (!amount || amount === text.trim()) return false;
    onAmount(amount);
    message.success("已清理金额格式");
    return true;
  }

  function openImportModal() {
    importForm.resetFields();
    if (queryStoreId && queryLedgerPeriod) {
      importForm.setFieldValue("ledger_key", `${queryStoreId}|${queryLedgerPeriod}`);
    }
    setUploadFileList([]);
    setImportPreview(null);
    setIsImportModalOpen(true);
  }

  async function previewImport() {
    if (!uploadFileList.length) {
      message.warning("请选择文件");
      return;
    }
    const ledgerKey = importForm.getFieldValue("ledger_key");
    const [formStoreId, formPeriod] = (ledgerKey ?? "").split("|");
    const storeId = formStoreId || queryStoreId;
    const period = formPeriod || queryLedgerPeriod;
    if (!storeId || !period) {
      message.warning("请选择账套");
      return;
    }
    const file = uploadFileList[0].originFileObj;
    if (!file) return;
    setIsLoading(true);
    try {
      const payload = new FormData();
      payload.append("store_id", storeId);
      payload.append("ledger_period", period);
      payload.append("file", file);
      const result = await apiClient.bankTransactions.previewImport(payload);
      setImportPreview(result);
      message.success("预览成功");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "预览失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function confirmImport() {
    if (!importPreview) return;
    const ledgerKey = importForm.getFieldValue("ledger_key");
    const [formStoreId, formPeriod] = (ledgerKey ?? "").split("|");
    const storeId = formStoreId || queryStoreId;
    const period = formPeriod || queryLedgerPeriod;
    if (!storeId || !period) {
      message.warning("请选择账套");
      return;
    }
    const file = uploadFileList[0]?.originFileObj;
    if (!file) {
      message.warning("请选择文件");
      return;
    }
    setIsLoading(true);
    try {
      const payload = new FormData();
      payload.append("store_id", storeId);
      payload.append("ledger_period", period);
      payload.append("file", file);
      await apiClient.bankTransactions.importFile(payload);
      message.success(`成功导入 ${importPreview.valid_count} 条流水`);
      setIsImportModalOpen(false);
      setImportPreview(null);
      await loadData(initialFilters);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function downloadImportTemplate() {
    try {
      const blob = await apiClient.bankTransactions.downloadImportTemplate();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "bank-import-template.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "下载模板失败");
    }
  }

  async function deleteTransaction(record: BankTransaction) {
    if (Number(record.matched_amount || 0) > 0 || record.special_type) {
      message.warning("这条银行流水已经做过匹配，不能删除");
      return;
    }
    setIsLoading(true);
    try {
      await apiClient.bankTransactions.delete(record.id);
      message.success("删除成功");
      await loadData(initialFilters);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleBatchDelete(selectedKeys: Key[], selectedRows: BankTransaction[]) {
    const ids = selectedKeys.map(String);
    if (!ids.length) {
      message.warning("请先选择要删除的银行流水");
      return;
    }
    const matchedCount = selectedRows.filter((record) => Number(record.matched_amount || 0) > 0 || record.special_type).length;
    if (matchedCount > 0) {
      message.warning(`已匹配的 ${matchedCount} 条银行流水不能删除，请取消选择后重试`);
      return;
    }

    setIsLoading(true);
    try {
      const result = await apiClient.bankTransactions.deleteBatch(ids);
      message.success(`成功删除 ${result.deleted_count} 条流水`);
      await loadData(initialFilters);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "批量删除失败");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: EnterpriseTableColumn<BankTransaction>[] = [
    ...getBankTransactionViewColumns(),
    {
      key: "actions",
      title: "操作",
      width: 120,
      fixed: "right",
      render: (_, record) => {
        const ledger = ledgersByKey.get(`${record.store_id}|${record.ledger_period}`);
        const isClosed = ledger?.status === "closed";
        const isMatched = Number(record.matched_amount || 0) > 0;
        return (
          <Space size="small">
            <Button type="link" size="small" disabled={isClosed} onClick={() => openEditModal(record)}>
              {isMatched ? "付款情况" : "编辑"}
            </Button>
            <Popconfirm
              title="删除银行流水？"
              description="删除前会检查这条流水是否已经做过匹配。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteTransaction(record)}
            >
              <Button type="link" size="small" danger disabled={isClosed || isMatched}>
                删除
              </Button>
            </Popconfirm>
          </Space>
        );
      },
    },
  ];

  const entryColumns: ColumnsType<BankEntryRow> = [
    {
      title: "发生日期",
      dataIndex: "occurred_at",
      width: 140,
      render: (value, _, index) => (
        <DatePicker
          value={value ? dayjs(value) : null}
          size="small"
          style={{ width: "100%" }}
          format="YYYY-MM-DD"
          inputRender={(inputProps) => {
            const { size: _size, ...restInputProps } = inputProps;
            return (
              <Input
                {...restInputProps}
                onPaste={(event) => {
                  const text = event.clipboardData.getData("text");
                  if (!text.includes("\t") && !text.includes("\n")) return;
                  event.preventDefault();
                  const updated = applyPastedEntryRows(text, entryRows, index, "occurred_at");
                  if (!updated) return;
                  setEntryRows(updated);
                  message.success("已粘贴流水数据");
                }}
              />
            );
          }}
          onChange={(date) => {
            const updated = [...entryRows];
            updated[index].occurred_at = date ? date.format("YYYY-MM-DD") : "";
            setEntryRows(updated);
          }}
        />
      ),
    },
    {
      title: "收入",
      dataIndex: "income_amount",
      width: 110,
      align: "right",
      render: (value, _, index) => (
        <Input
          value={value}
          size="small"
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (handleSingleAmountPaste(text, (amount) => {
              const updated = [...entryRows];
              updated[index].income_amount = amount;
              updated[index].expense_amount = "";
              setEntryRows(updated);
            })) {
              event.preventDefault();
              return;
            }
            if (!text.includes("\t") && !text.includes("\n")) return;
            event.preventDefault();
            const updated = applyPastedEntryRows(text, entryRows, index, "income_amount");
            if (!updated) return;
            setEntryRows(updated);
            message.success("已粘贴流水数据");
          }}
          onChange={(e) => {
            const updated = [...entryRows];
            updated[index].income_amount = e.target.value;
            if (e.target.value.trim()) updated[index].expense_amount = "";
            setEntryRows(updated);
          }}
        />
      ),
    },
    {
      title: "支出",
      dataIndex: "expense_amount",
      width: 110,
      align: "right",
      render: (value, _, index) => (
        <Input
          value={value}
          size="small"
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (handleSingleAmountPaste(text, (amount) => {
              const updated = [...entryRows];
              updated[index].expense_amount = amount;
              updated[index].income_amount = "";
              setEntryRows(updated);
            })) {
              event.preventDefault();
              return;
            }
            if (!text.includes("\t") && !text.includes("\n")) return;
            event.preventDefault();
            const updated = applyPastedEntryRows(text, entryRows, index, "expense_amount");
            if (!updated) return;
            setEntryRows(updated);
            message.success("已粘贴流水数据");
          }}
          onChange={(e) => {
            const updated = [...entryRows];
            updated[index].expense_amount = e.target.value;
            if (e.target.value.trim()) updated[index].income_amount = "";
            setEntryRows(updated);
          }}
        />
      ),
    },
    {
      title: "对方户名",
      dataIndex: "counterparty_name",
      width: 180,
      render: (value, _, index) => (
        <Input
          value={value}
          size="small"
          placeholder="必填"
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!text.includes("\t") && !text.includes("\n")) return;
            event.preventDefault();
            const updated = applyPastedEntryRows(text, entryRows, index, "counterparty_name");
            if (!updated) return;
            setEntryRows(updated);
            message.success("已粘贴流水数据");
          }}
          onChange={(e) => {
            const updated = [...entryRows];
            updated[index].counterparty_name = e.target.value;
            setEntryRows(updated);
          }}
        />
      ),
    },
    {
      title: "对方账号",
      dataIndex: "counterparty_account",
      width: 180,
      render: (value, _, index) => (
        <Input
          value={value}
          size="small"
          placeholder="选填"
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!text.includes("\t") && !text.includes("\n")) return;
            event.preventDefault();
            const updated = applyPastedEntryRows(text, entryRows, index, "counterparty_account");
            if (!updated) return;
            setEntryRows(updated);
            message.success("已粘贴流水数据");
          }}
          onChange={(e) => {
            const updated = [...entryRows];
            updated[index].counterparty_account = e.target.value;
            setEntryRows(updated);
          }}
        />
      ),
    },
    {
      title: "备注",
      dataIndex: "summary",
      render: (value, _, index) => (
        <Input
          value={value}
          size="small"
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!text.includes("\t") && !text.includes("\n")) return;
            event.preventDefault();
            const updated = applyPastedEntryRows(text, entryRows, index, "summary");
            if (!updated) return;
            setEntryRows(updated);
            message.success("已粘贴流水数据");
          }}
          onChange={(e) => {
            const updated = [...entryRows];
            updated[index].summary = e.target.value;
            setEntryRows(updated);
          }}
        />
      ),
    },
    {
      title: "付款情况",
      dataIndex: "payment_status",
      width: 110,
      render: (value, _, index) => (
        <Select
          value={value || "paid"}
          size="small"
          options={bankPaymentStatusOptions}
          onChange={(nextValue) => {
            const updated = [...entryRows];
            updated[index].payment_status = nextValue;
            setEntryRows(updated);
          }}
        />
      ),
    },
    {
      title: "操作",
      dataIndex: "key",
      width: 72,
      align: "center",
      render: (_, __, index) => (
        <Button
          type="link"
          danger
          size="small"
          onClick={() => removeEntryRow(index)}
          disabled={entryRows.length <= 1}
        >
          删除
        </Button>
      ),
    },
  ];

  const previewColumns: ColumnsType<BankImportPreviewRow> = [
    { title: "行号", dataIndex: "row_number", width: 70 },
    { title: "发生日期", dataIndex: "occurred_at", width: 120, render: (v) => v?.slice(0, 10) || "-" },
    {
      title: "类型",
      children: [
        {
          title: "收入",
          dataIndex: "direction",
          width: 80,
          align: "center",
          render: (v) => (v === "income" ? <StatusBadge status="income" text="收入" size="small" /> : <span className="bank-direction-placeholder">-</span>),
        },
        {
          title: "支出",
          dataIndex: "direction",
          width: 80,
          align: "center",
          render: (v) => (v === "expense" ? <StatusBadge status="expense" text="支出" size="small" /> : <span className="bank-direction-placeholder">-</span>),
        },
      ],
    },
    { title: "金额", dataIndex: "amount", width: 120, align: "right", render: (v) => <MoneyDisplay value={v || 0} /> },
    { title: "备注", dataIndex: "summary", ellipsis: true },
    {
      title: "状态",
      dataIndex: "errors",
      width: 100,
      render: (errors: BankImportRowError[]) =>
        errors && errors.length > 0 ? <StatusBadge status="error" text="错误" /> : <StatusBadge status="success" text="有效" />,
    },
  ];

  return (
    <AppShell title={currentStore?.name ? `${currentStore.name} · 银行流水` : "银行流水"}>
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }} className="maintenance-page">
        {queryStoreId && (
          <StoreLedgerWorkspaceNav
            storeId={queryStoreId}
            storeName={currentStore?.name}
            period={queryLedgerPeriod}
            ledgerStatusLabel={
              queryLedgerPeriod
                ? ledgersByKey.get(`${queryStoreId}|${queryLedgerPeriod}`)?.status === "closed"
                  ? "已封账"
                  : "进行中"
                : undefined
            }
            activeKey="bank"
          />
        )}

        {errorMessage && <Alert type="error" message="加载失败" description={errorMessage} showIcon closable />}

        <Card
          title="银行流水列表"
          className="data-table-card maintenance-table-card"
          extra={
            <Space>
              <Button icon={<PlusOutlined />} type="primary" onClick={openCreateModal}>
                新增流水
              </Button>
              <Button icon={<UploadOutlined />} onClick={openEntryModal}>
                批量录入
              </Button>
              <Button icon={<ImportOutlined />} onClick={openImportModal}>
                导入文件
              </Button>
            </Space>
          }
          >
          <Space size={32} style={{ marginBottom: 16 }}>
            <Statistic title="本月收入累计" value={transactionTotals.income} precision={2} prefix="¥" />
            <Statistic title="本月支出累计" value={transactionTotals.expense} precision={2} prefix="¥" />
          </Space>
          <Form
            form={filterForm}
            layout="inline"
            onFinish={(values) => void loadData(values)}
            style={{ marginBottom: 16 }}
          >
            <Form.Item name="month">
              <DatePicker picker="month" allowClear={false} placeholder="账期月份" />
            </Form.Item>
            <Form.Item name="occurred_range">
              <DatePicker.RangePicker allowClear placeholder={["发生日期开始", "发生日期结束"]} />
            </Form.Item>
            <Form.Item name="direction">
              <Select
                allowClear
                placeholder="类型"
                style={{ width: 112 }}
                options={[
                  { label: "收入", value: "income" },
                  { label: "支出", value: "expense" },
                ]}
              />
            </Form.Item>
            <Form.Item name="special_type">
              <Select
                allowClear
                placeholder="流水属性"
                style={{ width: 128 }}
                options={[
                  { label: "普通流水", value: "normal" },
                  { label: "往来款", value: "current_account" },
                  { label: "股东分红", value: "shareholder_dividend" },
                  { label: "股东注资", value: "shareholder_capital" },
                  { label: "其他收支", value: "other_income_expense" },
                ]}
              />
            </Form.Item>
            <Form.Item name="match_status">
              <Select
                allowClear
                placeholder="匹配状态"
                style={{ width: 128 }}
                options={[
                  { label: "未匹配", value: "unmatched" },
                  { label: "已匹配", value: "matched" },
                ]}
              />
            </Form.Item>
            <Form.Item name="counterparty_name">
              <Input allowClear placeholder="对方户名" style={{ width: 180 }} />
            </Form.Item>
            <Form.Item name="counterparty_account">
              <Input allowClear placeholder="对方账号" style={{ width: 180 }} />
            </Form.Item>
            <Form.Item>
              <Space size={8}>
                <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>
                  查询
                </Button>
                <Button onClick={resetFilters}>重置</Button>
              </Space>
            </Form.Item>
          </Form>

          <EnterpriseTable
            rowKey="id"
            columns={columns}
            dataSource={transactions}
            loading={isLoading}
            rowSelection={{
              getCheckboxProps: (record) => ({
                disabled: Number(record.matched_amount || 0) > 0 || Boolean(record.special_type),
                name: Number(record.matched_amount || 0) > 0 || record.special_type ? "已匹配，不能删除" : undefined,
              }),
            }}
            exportFileName="银行流水"
            pagination={{
              defaultPageSize: 20,
              showSizeChanger: true,
              pageSizeOptions: [10, 20, 50, 100],
              showTotal: (total, range) => `${range[0]}-${range[1]} / 共 ${total} 条`,
            }}
            batchActions={[
              {
                key: "delete",
                label: "批量删除",
                danger: true,
                icon: <DeleteOutlined />,
                onExecute: handleBatchDelete,
              },
            ]}
          />
        </Card>
      </Space>

      <Modal
        title={editingTransaction ? "编辑流水" : "新增流水"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingTransaction(null);
          setPendingSpecialTransaction(null);
        }}
        onOk={() => void confirmTransactionSubmit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitTransaction}>
          {queryStoreId ? (
            <Alert type="info" showIcon message={`流水归属门店：${currentStoreLedgerLabel}`} style={{ marginBottom: 16 }} />
          ) : (
            <Form.Item name="ledger_key" label="账套" rules={[{ required: true }]}>
              <Select disabled={Boolean(editingTransaction)} options={openLedgerOptions} />
            </Form.Item>
          )}
          <Form.Item name="occurred_at" label="发生日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: "100%" }} disabled={Boolean(editingTransaction && Number(editingTransaction.matched_amount || 0) > 0)} />
          </Form.Item>
          <Form.Item name="direction" label="类型" rules={[{ required: true }]}>
            <Select
              disabled={Boolean(editingTransaction && Number(editingTransaction.matched_amount || 0) > 0)}
              options={[
                { label: "收入", value: "income" },
                { label: "支出", value: "expense" },
              ]}
              />
          </Form.Item>
          <Form.Item name="payment_status" label="付款情况" rules={[{ required: true }]}>
            <Select options={bankPaymentStatusOptions} />
          </Form.Item>
          <Form.Item name="special_type" label="流水属性">
            <Form.Item noStyle shouldUpdate={(previous, current) => previous.special_type !== current.special_type}>
              {({ getFieldValue, setFieldsValue }) => {
                const specialType = getFieldValue("special_type");
                const disabled = Boolean(editingTransaction && Number(editingTransaction.matched_amount || 0) > 0);
                return (
                  <Space>
                    <Checkbox
                      checked={specialType === "current_account"}
                      disabled={disabled}
                      onChange={(event) => setFieldsValue({ special_type: event.target.checked ? "current_account" : null })}
                    >
                      往来款
                    </Checkbox>
                    <Checkbox
                      checked={specialType === "shareholder_dividend"}
                      disabled={disabled}
                      onChange={(event) => setFieldsValue({ special_type: event.target.checked ? "shareholder_dividend" : null })}
                    >
                      股东分红
                    </Checkbox>
                    <Checkbox
                      checked={specialType === "shareholder_capital"}
                      disabled={disabled}
                      onChange={(event) => setFieldsValue({ special_type: event.target.checked ? "shareholder_capital" : null })}
                    >
                      股东注资
                    </Checkbox>
                    <Checkbox
                      checked={specialType === "other_income_expense"}
                      disabled={disabled}
                      onChange={(event) => setFieldsValue({ special_type: event.target.checked ? "other_income_expense" : null })}
                    >
                      其他收支
                    </Checkbox>
                  </Space>
                );
              }}
            </Form.Item>
          </Form.Item>
          <Form.Item name="counterparty_name" label="对方户名" rules={[{ required: true, message: "请填写对方户名" }]}>
            <Input disabled={Boolean(editingTransaction && Number(editingTransaction.matched_amount || 0) > 0)} />
          </Form.Item>
          <Form.Item name="counterparty_account" label="对方账号">
            <Input disabled={Boolean(editingTransaction && Number(editingTransaction.matched_amount || 0) > 0)} />
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}>
            <Input
              disabled={Boolean(editingTransaction && Number(editingTransaction.matched_amount || 0) > 0)}
              onPaste={(event) => {
                const text = event.clipboardData.getData("text");
                if (!handleSingleAmountPaste(text, (amount) => form.setFieldValue("amount", amount))) return;
                event.preventDefault();
              }}
            />
          </Form.Item>
          <Form.Item name="summary" label="备注">
            <Input disabled={Boolean(editingTransaction && Number(editingTransaction.matched_amount || 0) > 0)} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="确认流水属性"
        open={Boolean(pendingSpecialTransaction)}
        onCancel={() => setPendingSpecialTransaction(null)}
        onOk={() => void confirmPendingSpecialTransaction()}
        confirmLoading={isLoading}
        okText="确认保存"
        cancelText="取消"
      >
        <Typography.Paragraph>
          该笔流水将标记为{bankSpecialTypeLabel(pendingSpecialTransaction?.special_type)}，保存后不会进入审批单对账或收入对账。
        </Typography.Paragraph>
        <Typography.Text>是否继续保存？</Typography.Text>
      </Modal>

      <Modal
        title="批量录入流水"
        open={isEntryModalOpen}
        destroyOnClose
        maskClosable={false}
        keyboard={false}
        onCancel={() => {
          setIsEntryModalOpen(false);
          setEntryRows(createBankEntryRows(10));
          setEntryValidationErrors([]);
        }}
        onOk={() => void confirmEntryBatch()}
        confirmLoading={isLoading}
        width={900}
        okText="确认录入"
      >
        <Form form={entryForm} layout="vertical" onFinish={submitEntryBatch}>
          {queryStoreId ? (
            <Alert type="info" showIcon message={`流水归属门店：${currentStoreLedgerLabel}，账期按每行发生日期自动确定`} style={{ marginBottom: 16 }} />
          ) : (
            <Form.Item name="ledger_key" label="账套" rules={[{ required: true }]}>
              <Select options={entryLedgerOptions} placeholder="请选择门店" />
            </Form.Item>
          )}
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <Space wrap>
              <Button onClick={pasteFromClipboard}>读取剪贴板</Button>
              <Button onClick={() => setEntryRows(createBankEntryRows(10))}>清空</Button>
              <Button onClick={() => setEntryRows([...entryRows, ...createBankEntryRows(5)])}>增加 5 行</Button>
            </Space>
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={entryRows}
              columns={entryColumns}
              scroll={{ x: 1200, y: 480 }}
              summary={() => (
                <Table.Summary fixed>
                  <Table.Summary.Row>
                    <Table.Summary.Cell index={0}>
                      <Typography.Text strong>合计</Typography.Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={1}>
                      <div style={{ textAlign: "right" }}>
                        <MoneyDisplay value={entryBatchTotals.income} />
                      </div>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={2}>
                      <div style={{ textAlign: "right" }}>
                        <MoneyDisplay value={entryBatchTotals.expense} />
                      </div>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={3} />
                    <Table.Summary.Cell index={4} />
                    <Table.Summary.Cell index={5} />
                    <Table.Summary.Cell index={6} />
                    <Table.Summary.Cell index={7} />
                  </Table.Summary.Row>
                </Table.Summary>
              )}
            />
            {entryValidationErrors.length > 0 && (
              <Alert
                type="error"
                showIcon
                message="请先修正以下流水"
                description={
                  <Space direction="vertical" size={2}>
                    {entryValidationErrors.map((error) => <Typography.Text key={error}>{error}</Typography.Text>)}
                  </Space>
                }
              />
            )}
            <Typography.Text type="secondary">可以从 Excel 复制整块数据后粘贴。格式：发生日期 | 收入 | 支出 | 对方户名 | 对方账号 | 备注 | 流水号（可选），导入模板同样保持这个顺序。</Typography.Text>
          </Space>
        </Form>
      </Modal>

      <Modal
        title="导入银行流水"
        open={isImportModalOpen}
        destroyOnClose
        onCancel={() => {
          setIsImportModalOpen(false);
          setImportPreview(null);
        }}
        footer={
          importPreview ? (
            <Space>
              <Button onClick={() => setIsImportModalOpen(false)}>取消</Button>
              <Button type="primary" loading={isLoading} onClick={confirmImport}>
                确认导入 ({importPreview.valid_count} 条)
              </Button>
            </Space>
          ) : null
        }
        width={1000}
      >
        <Form form={importForm} layout="vertical">
          <Tabs
            items={[
              {
                key: "step1",
                label: "1. 选择账套和文件",
                children: (
                  <Space direction="vertical" style={{ width: "100%" }}>
                    {queryStoreId ? (
                      <Alert type="info" showIcon message={`流水归属门店：${currentStoreLedgerLabel}`} />
                    ) : (
                      <Form.Item name="ledger_key" label="账套" rules={[{ required: true }]}>
                        <Select options={openLedgerOptions} />
                      </Form.Item>
                    )}
                      <Form.Item label="上传文件">
                        <Space>
                        <Upload
                          maxCount={1}
                          fileList={uploadFileList}
                          beforeUpload={() => false}
                          onChange={({ fileList }) => {
                            setUploadFileList(fileList.slice(-1));
                            setImportPreview(null);
                          }}
                        >
                          <Button icon={<UploadOutlined />}>选择文件</Button>
                        </Upload>
                        <Button type="primary" loading={isLoading} onClick={previewImport}>
                          预览
                        </Button>
                        <Button icon={<DownloadOutlined />} onClick={downloadImportTemplate}>
                          下载模板
                        </Button>
                      </Space>
                    </Form.Item>
                  </Space>
                ),
              },
            ]}
          />
        </Form>
        {importPreview && (
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <Alert
              type={importPreview.error_count > 0 ? "warning" : "success"}
              showIcon
              message={`有效 ${importPreview.valid_count} 条，重复 ${importPreview.duplicate_count} 条，错误 ${importPreview.error_count} 条`}
              description="导入预览和批量录入使用同一套收入/支出字段。"
            />
            <Table
              rowKey="row_number"
              size="small"
              columns={previewColumns}
              dataSource={importPreview.preview_rows}
              pagination={{ pageSize: 10 }}
              scroll={{ x: 900 }}
            />
          </Space>
        )}
      </Modal>
    </AppShell>
  );
}
