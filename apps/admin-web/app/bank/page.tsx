"use client";

import { Alert, Button, Card, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Table, Tabs, Upload, Typography, message } from "antd";
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
  direction?: "income" | "expense";
  unmatched_only?: boolean;
}

type BankEntryField = "occurred_at" | "direction" | "counterparty_name" | "counterparty_account" | "amount" | "summary";

interface BankEntryRow {
  key: string;
  occurred_at: string;
  direction: "收入" | "支出";
  counterparty_name: string;
  counterparty_account: string;
  amount: string;
  summary: string;
}

const bankEntryHeaders: Record<BankEntryField, string> = {
  occurred_at: "发生日期",
  direction: "类型",
  counterparty_name: "对方户名",
  counterparty_account: "对方账号",
  amount: "金额",
  summary: "备注",
};

const bankEntryFields: BankEntryField[] = ["occurred_at", "direction", "counterparty_name", "counterparty_account", "amount", "summary"];

function createBankEntryRows(count: number): BankEntryRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `bank-entry-${Date.now()}-${index}`,
    occurred_at: "",
    direction: "支出",
    counterparty_name: "",
    counterparty_account: "",
    amount: "",
    summary: "",
  }));
}

function isBankEntryRowEmpty(row: BankEntryRow) {
  return !row.occurred_at.trim() && !row.amount.trim() && !row.counterparty_name.trim() && !row.counterparty_account.trim() && !row.summary.trim();
}

function normalizeEntryDirection(value: string) {
  const normalized = value.trim().toLowerCase();
  if (["收入", "income", "in", "收"].includes(normalized)) return "收入";
  if (["支出", "expense", "out", "付", "付款"].includes(normalized)) return "支出";
  return "";
}

function normalizeEntryOccurredAt(value: string) {
  const text = value.trim();
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
  const text = value.trim();
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

function parsePastedEntryRows(text: string) {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trimEnd())
    .filter((row) => row.trim());
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
  const firstCells = rows[0].split("\t").map((cell) => cell.trim());
  const hasHeader = firstCells.some((cell) => headerWords.includes(cell));
  return (hasHeader ? rows.slice(1) : rows).map((row) => row.split("\t"));
}

function applyPastedEntryRows(
  text: string,
  rows: BankEntryRow[],
  startRowIndex: number,
  startField: BankEntryField,
) {
  const parsedRows = parsePastedEntryRows(text);
  if (!parsedRows.length) return null;
  const updatedRows = [...rows];
  const startFieldIndex = bankEntryFields.indexOf(startField);
  parsedRows.forEach((cells, rowOffset) => {
    const rowIndex = startRowIndex + rowOffset;
    if (rowIndex >= updatedRows.length) return;
    cells.forEach((cell, cellOffset) => {
      const field = bankEntryFields[startFieldIndex + cellOffset];
      if (!field) return;
      const value = cell.trim();
      if (!value) return;
      if (field === "occurred_at") {
        updatedRows[rowIndex].occurred_at = normalizeEntryOccurredAt(value);
      } else if (field === "direction") {
        const normalized = normalizeEntryDirection(value);
        if (normalized) updatedRows[rowIndex].direction = normalized as "收入" | "支出";
      } else if (field === "counterparty_name") {
        updatedRows[rowIndex].counterparty_name = value;
      } else if (field === "counterparty_account") {
        updatedRows[rowIndex].counterparty_account = value;
      } else if (field === "amount") {
        updatedRows[rowIndex].amount = value;
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
      ledger_period: queryLedgerPeriod,
    }),
    [queryStoreId, queryLedgerPeriod],
  );

  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [entryRows, setEntryRows] = useState<BankEntryRow[]>(() => createBankEntryRows(10));
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([]);
  const [importPreview, setImportPreview] = useState<BankImportPreviewResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isEntryModalOpen, setIsEntryModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<BankTransaction | null>(null);
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
  const currentStore = queryStoreId ? storesById.get(queryStoreId) : undefined;
  const currentStoreLedgerLabel = queryStoreId
    ? `${currentStore?.name ?? "当前门店"}${queryLedgerPeriod ? ` / ${queryLedgerPeriod}` : ""}`
    : "";

  function buildFilterParams(values?: BankFilterValues) {
    const params = new URLSearchParams({ page_size: "500" });
    if (values?.store_id) params.set("store_id", values.store_id);
    if (values?.ledger_period) params.set("ledger_period", values.ledger_period);
    if (values?.direction) params.set("direction", values.direction);
    if (values?.unmatched_only) params.set("unmatched_only", "true");
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
    });
    setIsModalOpen(true);
  }

  async function submitTransaction(values: BankFormValues) {
    if (!values.occurred_at) {
      message.warning("请选择发生时间");
      return;
    }
    if (!values.counterparty_name?.trim()) {
      message.warning("请填写对方户名");
      return;
    }
    const [formStoreId, formPeriod] = (values.ledger_key ?? "").split("|");
    const storeId = formStoreId || queryStoreId;
    const period = formPeriod || queryLedgerPeriod;
    if (!storeId || !period) {
      message.warning("缺少门店或账期，无法保存流水");
      return;
    }
    setIsLoading(true);
    try {
      const payload: BankTransactionCreate = {
        store_id: storeId,
        ledger_period: period,
        occurred_at: toBankOccurredAt(values.occurred_at),
        direction: values.direction || "expense",
        amount: values.amount,
        counterparty_name: values.counterparty_name?.trim() || null,
        counterparty_account: values.counterparty_account?.trim() || null,
        summary: values.summary ?? null,
      };
      if (editingTransaction) {
        await apiClient.bankTransactions.update(editingTransaction.id, payload);
        message.success("更新成功");
      } else {
        await apiClient.bankTransactions.create(payload);
        message.success("创建成功");
      }
      setIsModalOpen(false);
      setEditingTransaction(null);
      await loadData(initialFilters);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsLoading(false);
    }
  }

  function openEntryModal() {
    entryForm.resetFields();
    setEntryRows(createBankEntryRows(10));
    if (queryStoreId && queryLedgerPeriod) {
      entryForm.setFieldValue("ledger_key", `${queryStoreId}|${queryLedgerPeriod}`);
    }
    setIsEntryModalOpen(true);
  }

  async function submitEntryBatch(values: { ledger_key?: string }) {
    const [formStoreId, formPeriod] = (values.ledger_key ?? "").split("|");
    const storeId = formStoreId || queryStoreId;
    const period = formPeriod || queryLedgerPeriod;
    if (!storeId || !period) {
      message.warning("请选择账套");
      return;
    }
    const nonEmptyRows = entryRows.filter((row) => !isBankEntryRowEmpty(row));
    if (!nonEmptyRows.length) {
      message.warning("请至少填写一行流水");
      return;
    }
    setIsLoading(true);
    try {
    const batch: BankTransactionCreate[] = [];
    for (const row of nonEmptyRows) {
      const occurredAt = parseEntryOccurredAt(row.occurred_at);
      if (!occurredAt) {
        message.warning("批量录入中存在无效的发生时间");
        return;
      }
      if (!row.counterparty_name.trim()) {
        message.warning("批量录入中存在未填写对方户名的行");
        return;
      }
      if (!row.amount.trim()) {
        message.warning("批量录入中存在未填写金额的行");
        return;
      }
      batch.push({
        store_id: storeId,
        ledger_period: period,
        occurred_at: toBankOccurredAt(occurredAt),
        direction: row.direction === "收入" ? "income" : "expense",
        amount: row.amount,
        counterparty_name: row.counterparty_name.trim(),
        counterparty_account: row.counterparty_account.trim() || null,
        summary: row.summary || null,
        });
      }
      for (const transaction of batch) {
        await apiClient.bankTransactions.create(transaction);
      }
      message.success(`成功录入 ${batch.length} 条流水`);
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
    } catch {
      // keep modal open and let form display validation errors
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
      const updatedRows = [...entryRows];
      parsedRows.forEach((cells, index) => {
        if (index >= updatedRows.length) return;
        const [timeValue, dirValue, counterpartyNameValue, counterpartyAccountValue, amountValue] = cells;
        const summaryValue = cells.length >= 6 ? cells[5] : cells[4] ?? cells[3];
        const normalizedTime = timeValue?.trim() ? normalizeEntryOccurredAt(timeValue) : "";
        if (normalizedTime) updatedRows[index].occurred_at = normalizedTime;
        const normalized = normalizeEntryDirection(dirValue);
        if (normalized) updatedRows[index].direction = normalized as "收入" | "支出";
        if (counterpartyNameValue?.trim()) updatedRows[index].counterparty_name = counterpartyNameValue.trim();
        if (counterpartyAccountValue?.trim()) updatedRows[index].counterparty_account = counterpartyAccountValue.trim();
        if (amountValue?.trim()) updatedRows[index].amount = amountValue.trim();
        if (summaryValue?.trim()) updatedRows[index].summary = summaryValue.trim();
      });
      setEntryRows(updatedRows);
      message.success(`已粘贴 ${Math.min(parsedRows.length, updatedRows.length)} 行数据`);
    } catch {
      message.error("无法读取剪贴板");
    }
  }

  function setAllEntryDirections(direction: "收入" | "支出") {
    setEntryRows((rows) => rows.map((row) => ({ ...row, direction })));
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
    if (Number(record.matched_amount || 0) > 0) {
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

  async function handleBatchDelete(selectedKeys: Key[]) {
    const ids = selectedKeys.map(String);
    const recordsToDelete = transactions.filter(t => ids.includes(t.id));
    const matchedRecords = recordsToDelete.filter(t => Number(t.matched_amount || 0) > 0);

    if (matchedRecords.length > 0) {
      message.warning(`选中的 ${matchedRecords.length} 条流水已匹配，无法删除`);
      return;
    }

    setIsLoading(true);
    try {
      for (const id of ids) {
        await apiClient.bankTransactions.delete(id);
      }
      message.success(`成功删除 ${ids.length} 条流水`);
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
        return (
          <Space size="small">
            <Button type="link" size="small" disabled={isClosed} onClick={() => openEditModal(record)}>
              编辑
            </Button>
            <Popconfirm
              title="删除银行流水？"
              description="删除前会检查这条流水是否已经做过匹配。"
              okText="删除"
              cancelText="取消"
              okButtonProps={{ danger: true }}
              onConfirm={() => deleteTransaction(record)}
            >
              <Button type="link" size="small" danger disabled={isClosed}>
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
      title: "类型",
      dataIndex: "direction",
      width: 100,
      render: (value, _, index) => (
        <Select
          value={value}
          size="small"
          style={{ width: "100%" }}
          options={[
            { label: "收入", value: "收入" },
            { label: "支出", value: "支出" },
          ]}
          onChange={(val) => {
            const updated = [...entryRows];
            updated[index].direction = val;
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
      title: "金额",
      dataIndex: "amount",
      width: 120,
      render: (value, _, index) => (
        <Input
          value={value}
          size="small"
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (!text.includes("\t") && !text.includes("\n")) return;
            event.preventDefault();
            const updated = applyPastedEntryRows(text, entryRows, index, "amount");
            if (!updated) return;
            setEntryRows(updated);
            message.success("已粘贴流水数据");
          }}
          onChange={(e) => {
            const updated = [...entryRows];
            updated[index].amount = e.target.value;
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
  ];

  const previewColumns: ColumnsType<BankImportPreviewRow> = [
    { title: "行号", dataIndex: "row_number", width: 70 },
    { title: "发生日期", dataIndex: "occurred_at", width: 120, render: (v) => v?.slice(0, 10) || "-" },
    {
      title: "类型",
      dataIndex: "direction",
      width: 80,
      render: (v) => (v === "income" ? <StatusBadge status="income" text="收入" /> : <StatusBadge status="expense" text="支出" />),
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
    <AppShell title="银行流水">
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }} className="maintenance-page">
        {queryStoreId && queryLedgerPeriod && (
          <StoreLedgerWorkspaceNav
            storeId={queryStoreId}
            storeName={currentStore?.name}
            period={queryLedgerPeriod}
            ledgerStatusLabel={ledgersByKey.get(`${queryStoreId}|${queryLedgerPeriod}`)?.status === "closed" ? "已封账" : "进行中"}
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
          <EnterpriseTable
            rowKey="id"
            columns={columns}
            dataSource={transactions}
            loading={isLoading}
            exportFileName="银行流水"
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
        }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitTransaction}>
          {queryStoreId && queryLedgerPeriod ? (
            <Alert type="info" showIcon message={`流水归属：${currentStoreLedgerLabel}`} style={{ marginBottom: 16 }} />
          ) : (
            <Form.Item name="ledger_key" label="账套" rules={[{ required: true }]}>
              <Select disabled={Boolean(editingTransaction)} options={openLedgerOptions} />
            </Form.Item>
          )}
          <Form.Item name="occurred_at" label="发生日期" rules={[{ required: true }]}>
            <DatePicker style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="direction" label="类型" rules={[{ required: true }]}>
            <Select
              options={[
                { label: "收入", value: "income" },
                { label: "支出", value: "expense" },
              ]}
              />
          </Form.Item>
          <Form.Item name="counterparty_name" label="对方户名" rules={[{ required: true, message: "请填写对方户名" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="counterparty_account" label="对方账号">
            <Input />
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="summary" label="备注">
            <Input />
          </Form.Item>
        </Form>
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
        }}
        onOk={() => void confirmEntryBatch()}
        confirmLoading={isLoading}
        width={900}
        okText="确认录入"
      >
        <Form form={entryForm} layout="vertical" onFinish={submitEntryBatch}>
          {queryStoreId && queryLedgerPeriod ? (
            <Alert type="info" showIcon message={`流水归属：${currentStoreLedgerLabel}`} style={{ marginBottom: 16 }} />
          ) : (
            <Form.Item name="ledger_key" label="账套" rules={[{ required: true }]}>
              <Select options={openLedgerOptions} />
            </Form.Item>
          )}
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <Space wrap>
              <Button onClick={pasteFromClipboard}>读取剪贴板</Button>
              <Button onClick={() => setAllEntryDirections("收入")}>全部收入</Button>
              <Button onClick={() => setAllEntryDirections("支出")}>全部支出</Button>
              <Button onClick={() => setEntryRows(createBankEntryRows(10))}>清空</Button>
              <Button onClick={() => setEntryRows([...entryRows, ...createBankEntryRows(5)])}>增加 5 行</Button>
            </Space>
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={entryRows}
              columns={entryColumns}
              scroll={{ x: 1120, y: 400 }}
            />
            <Typography.Text type="secondary">可以从 Excel 复制整块数据后粘贴。格式：日期 | 类型 | 对方户名 | 对方账号 | 金额 | 备注</Typography.Text>
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
                    {queryStoreId && queryLedgerPeriod ? (
                      <Alert type="info" showIcon message={`流水归属：${currentStoreLedgerLabel}`} />
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
