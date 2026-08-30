"use client";

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Drawer,
  Form,
  Image,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Splitter,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
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
  ExpenseCategoryCreate,
  ReconciliationExpenseCandidate,
  ReconciliationRecord,
  Store,
} from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../../components/AppShell";
import { apiClient } from "../../lib/api";

type ImportMode = "file" | "paste";
type ApprovalLike = ReconciliationExpenseCandidate | ReconciliationRecord;
type DingTalkField = Record<string, unknown>;
type DingTalkTableRow = Record<string, unknown>;

interface CandidateFilters {
  template_id?: string;
  approval_no?: string;
}

interface ConfirmValues {
  accounting_month?: dayjs.Dayjs;
  bank_occurred?: boolean;
  category_l2?: string;
  reason?: string;
}

interface EditValues extends ConfirmValues {
  amount?: string;
}

function remainingAmount(transaction: BankTransaction) {
  return Number(transaction.amount) - Number(transaction.matched_amount || 0);
}

function formatDateTime(value?: string | null) {
  return value ? dayjs(value).format("YYYY-MM-DD HH:mm") : "-";
}

function approvalNoText(record: ApprovalLike) {
  return record.approval_instance?.approval_no || record.approval_instance?.dingtalk_instance_id || "-";
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
  return (
    <Space size={[4, 4]} wrap>
      {entries.slice(0, 4).map(([label, value]) => (
        <Tag key={label}>
          {label}: {Array.isArray(value) ? value.join(", ") : String(value)}
        </Tag>
      ))}
      {entries.length > 4 ? <Tag>+{entries.length - 4}</Tag> : null}
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

function sortTemplates(templates: ApprovalTemplate[]) {
  return [...templates].sort((left, right) => {
    if (left.is_enabled !== right.is_enabled) return left.is_enabled ? -1 : 1;
    return right.created_at.localeCompare(left.created_at);
  });
}

export default function FinanceReconciliationPage() {
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
  const [importMode, setImportMode] = useState<ImportMode>("paste");
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [importPreview, setImportPreview] = useState<BankImportPreviewResult | null>(null);
  const [isCategoryOpen, setIsCategoryOpen] = useState(false);
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [filterForm] = Form.useForm<CandidateFilters>();
  const [confirmForm] = Form.useForm<ConfirmValues>();
  const [editForm] = Form.useForm<EditValues>();
  const [categoryForm] = Form.useForm<ExpenseCategoryCreate>();
  const [importForm] = Form.useForm<{ ledger_period?: string }>();

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const secondLevelCategories = categories.filter((category) => category.parent_id && category.status === "active");
  const topLevelCategories = categories.filter((category) => !category.parent_id && category.status === "active");
  const selectedCandidate = candidates.find((candidate) => candidate.expense_item.id === selectedCandidateId);
  const bankRemaining = selectedTransaction ? remainingAmount(selectedTransaction) : 0;
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

  async function loadBaseData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [storePage, templatePage, categoryPage] = await Promise.all([
        apiClient.stores.list("?page_size=500"),
        apiClient.dingtalk.listTemplates("?page_size=500"),
        apiClient.categories.list("?page_size=500"),
      ]);
      setStores(storePage.items);
      setTemplates(sortTemplates(templatePage.items));
      setCategories(categoryPage.items);
      if (!selectedStoreId && storePage.items[0]) setSelectedStoreId(storePage.items[0].id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载基础数据");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadStoreWorkspace(storeId: string, transaction?: BankTransaction | null) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [bankPage, recordPage] = await Promise.all([
        apiClient.bankTransactions.list(`?store_id=${storeId}&direction=expense&page_size=500`),
        apiClient.matches.reconciliationRecords(`?store_id=${storeId}&page_size=200`),
      ]);
      const unmatched = bankPage.items.filter((item) => remainingAmount(item) > 0);
      setTransactions(unmatched);
      setRecords(recordPage.items);
      const nextTransaction = transaction && remainingAmount(transaction) > 0 ? transaction : unmatched[0] ?? null;
      setSelectedTransaction(nextTransaction);
      if (nextTransaction) {
        await loadCandidates(nextTransaction, storeId, filterForm.getFieldsValue());
      } else {
        setCandidates([]);
        setSelectedCandidateId(undefined);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载门店对账数据");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadCandidates(transaction: BankTransaction, storeId: string, filters?: CandidateFilters) {
    const params = new URLSearchParams({
      bank_transaction_id: transaction.id,
      store_id: storeId,
      page_size: "100",
    });
    if (filters?.template_id) params.set("template_id", filters.template_id);
    if (filters?.approval_no) params.set("approval_no", filters.approval_no);
    const result = await apiClient.matches.reconciliationCandidates(`?${params.toString()}`);
    setCandidates(result.candidates);
    setSelectedCandidateId(undefined);
  }

  useEffect(() => {
    void loadBaseData();
  }, []);

  useEffect(() => {
    if (selectedStoreId) void loadStoreWorkspace(selectedStoreId);
  }, [selectedStoreId]);

  async function selectTransaction(transaction: BankTransaction) {
    if (!selectedStoreId) return;
    setSelectedTransaction(transaction);
    await loadCandidates(transaction, selectedStoreId, filterForm.getFieldsValue());
  }

  function currentImportFile() {
    if (importMode === "paste") return pasteToFile(pasteText);
    return uploadFileList[0]?.originFileObj ?? null;
  }

  async function previewImport() {
    if (!selectedStoreId) return;
    const file = currentImportFile();
    if (!file) {
      setErrorMessage(importMode === "paste" ? "请粘贴银行流水数据" : "请选择 CSV / XLSX 文件");
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
      setErrorMessage(importMode === "paste" ? "请粘贴银行流水数据" : "请选择 CSV / XLSX 文件");
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
      accounting_month: dayjs(selectedTransaction.ledger_period || selectedTransaction.occurred_at.slice(0, 7)),
      bank_occurred: true,
      category_l2: selectedCandidate.expense_item.category_l2 || undefined,
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
        amount: selectedCandidate.remaining_amount,
        accounting_period: accountingPeriod,
        bank_occurred: values.bank_occurred ?? true,
        category_l2: values.category_l2 || null,
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
      category_l2: record.expense_item.category_l2 || undefined,
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
        category_l2: values.category_l2 || null,
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

  async function createCategory(values: ExpenseCategoryCreate) {
    setIsSaving(true);
    try {
      await apiClient.categories.create(values);
      message.success("分类已新增");
      setIsCategoryOpen(false);
      categoryForm.resetFields();
      const page = await apiClient.categories.list("?page_size=500");
      setCategories(page.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "新增分类失败");
    } finally {
      setIsSaving(false);
    }
  }

  const transactionColumns: ColumnsType<BankTransaction> = [
    { title: "日期", dataIndex: "occurred_at", width: 120, fixed: "left", render: formatDateTime },
    { title: "金额", dataIndex: "amount", width: 110, align: "right", render: (value: string) => formatMoney(value) },
    { title: "未匹配", width: 110, align: "right", render: (_, record) => formatMoney(remainingAmount(record)) },
    { title: "摘要", dataIndex: "summary", width: 220, ellipsis: true, render: (value) => value || "-" },
    { title: "流水号", dataIndex: "bank_serial_no", width: 180, ellipsis: true, render: (value) => value || "-" },
  ];

  const candidateColumns: ColumnsType<ReconciliationExpenseCandidate> = [
    { title: "推荐", dataIndex: "score", width: 80, fixed: "left", align: "center", render: (value: string) => <Tag color="blue">{Number(value).toFixed(0)}</Tag> },
    { title: "审批编号", width: 180, fixed: "left", ellipsis: true, render: (_, record) => approvalNoText(record) },
    { title: "审批单", dataIndex: ["expense_item", "description"], width: 220, ellipsis: true },
    { title: "金额", dataIndex: "remaining_amount", width: 110, align: "right", render: (value: string) => formatMoney(value) },
    { title: "二级分类", dataIndex: ["expense_item", "category_l2"], width: 130, render: (value) => value || <Typography.Text type="secondary">未归类</Typography.Text> },
    { title: "模板", dataIndex: "template_name", width: 160, ellipsis: true, render: (value) => value || "手工支出" },
    { title: "显示字段", dataIndex: "display_fields", width: 320, render: displayFieldSummary },
    {
      title: "操作",
      width: 90,
      fixed: "right",
      align: "center",
      className: "table-action-column",
      render: (_, record) => (
        <Button size="small" onClick={() => setDetailRecord(record)}>
          明细
        </Button>
      ),
    },
  ];

  const recordColumns: ColumnsType<ReconciliationRecord> = [
    { title: "入账月", dataIndex: ["match", "accounting_period"], width: 100, fixed: "left", render: (value) => value || "-" },
    { title: "金额", dataIndex: ["match", "amount"], width: 110, align: "right", render: (value: string) => formatMoney(value) },
    { title: "二级分类", dataIndex: ["expense_item", "category_l2"], width: 130, render: (value) => value || "-" },
    { title: "审批编号", width: 180, ellipsis: true, render: (_, record) => approvalNoText(record) },
    { title: "审批单", dataIndex: ["expense_item", "description"], width: 220, ellipsis: true },
    { title: "银行日期", dataIndex: ["bank_transaction", "occurred_at"], width: 140, render: formatDateTime },
    { title: "银行备注", dataIndex: ["bank_transaction", "summary"], width: 220, ellipsis: true, render: (value) => value || "-" },
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

  return (
    <AppShell
      title="财务对账"
      kicker="按门店录入银行流水，并匹配钉钉审批单"
      action={
        <Space>
          <Button disabled={!selectedStoreId} onClick={() => setIsImportOpen(true)}>导入当前门店流水</Button>
          <Button onClick={() => setIsCategoryOpen(true)}>维护二级分类</Button>
          <Button onClick={() => selectedStoreId && loadStoreWorkspace(selectedStoreId)}>刷新</Button>
        </Space>
      }
    >
      {errorMessage ? <Alert className="dashboard-alert" type="warning" showIcon message={errorMessage} closable onClose={() => setErrorMessage(null)} /> : null}

      <Card className="dashboard-alert">
        <Space wrap size={16}>
          <Typography.Text strong>当前门店</Typography.Text>
          <Select
            showSearch
            optionFilterProp="label"
            style={{ width: 320 }}
            value={selectedStoreId}
            onChange={setSelectedStoreId}
            options={stores.map((store) => ({ label: store.name, value: store.id }))}
          />
          <Statistic title="待匹配流水" value={transactions.length} />
          <Statistic title="候选审批单" value={candidates.length} />
          <Statistic title="已对账" value={records.length} />
        </Space>
      </Card>

      <Splitter className="reconciliation-workbench">
        <Splitter.Panel defaultSize="42%" min="340px">
          <Card title="银行流水" className="data-table-card">
            <Table
              rowKey="id"
              size="small"
              loading={isLoading}
              columns={transactionColumns}
              dataSource={transactions}
              pagination={{ pageSize: 12 }}
              rowClassName={(record) => (record.id === selectedTransaction?.id ? "selected-table-row" : "")}
              onRow={(record) => ({ onClick: () => selectTransaction(record) })}
              scroll={{ x: 740, y: 520 }}
              sticky
            />
          </Card>
        </Splitter.Panel>
        <Splitter.Panel min="460px">
          <Card
            title={selectedTransaction ? `审批单候选：${formatMoney(bankRemaining)}` : "审批单候选"}
            extra={
              <Space>
                <Form form={filterForm} layout="inline" onFinish={(values) => selectedTransaction && selectedStoreId && loadCandidates(selectedTransaction, selectedStoreId, values)}>
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
            className="data-table-card"
          >
            <Table
              rowKey={(record) => record.expense_item.id}
              size="small"
              loading={isLoading}
              columns={candidateColumns}
              dataSource={candidates}
              pagination={{ pageSize: 12 }}
              rowSelection={{
                type: "radio",
                fixed: true,
                selectedRowKeys: selectedCandidateId ? [selectedCandidateId] : [],
                onChange: (keys) => setSelectedCandidateId(String(keys[0] ?? "")),
              }}
              onRow={(record) => ({ onClick: () => setSelectedCandidateId(record.expense_item.id) })}
              scroll={{ x: 1290, y: 520 }}
              sticky
            />
          </Card>
        </Splitter.Panel>
      </Splitter>

      <Card title="已对账记录" className="data-table-card" style={{ marginTop: 16 }}>
        <Table rowKey={(record) => record.match.id} size="small" loading={isLoading} columns={recordColumns} dataSource={records} pagination={{ pageSize: 10 }} scroll={{ x: 1290 }} sticky />
      </Card>

      <Modal title="确认匹配" open={isConfirmOpen} destroyOnHidden onCancel={() => setIsConfirmOpen(false)} onOk={() => confirmForm.submit()} confirmLoading={isSaving}>
        <Form form={confirmForm} layout="vertical" onFinish={submitConfirm}>
          <Alert className="dashboard-alert" type="info" showIcon message={`流水 ${selectedTransaction ? formatMoney(selectedTransaction.amount) : "-"}，审批单 ${selectedCandidate ? formatMoney(selectedCandidate.remaining_amount) : "-"}`} />
          <Form.Item name="accounting_month" label="入账月份" rules={[{ required: true }]}>
            <DatePicker picker="month" style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="category_l2" label="二级分类" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" placeholder="选择二级分类" options={secondLevelCategories.map((category) => ({ label: category.name, value: category.name }))} />
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
          <Form.Item name="category_l2" label="二级分类" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={secondLevelCategories.map((category) => ({ label: category.name, value: category.name }))} />
          </Form.Item>
          <Form.Item name="bank_occurred" label="银行流水是否已发生" valuePropName="checked">
            <Switch checkedChildren="已发生" unCheckedChildren="未发生" />
          </Form.Item>
          <Form.Item name="reason" label="备注">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>

      <Modal title="导入当前门店流水" open={isImportOpen} destroyOnHidden onCancel={() => setIsImportOpen(false)} onOk={submitImport} confirmLoading={isSaving} width={860} footer={[
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

      <Modal title="新增二级分类" open={isCategoryOpen} destroyOnHidden onCancel={() => setIsCategoryOpen(false)} onOk={() => categoryForm.submit()} confirmLoading={isSaving}>
        <Form form={categoryForm} layout="vertical" onFinish={createCategory} initialValues={{ sort_order: 0 }}>
          <Form.Item name="parent_id" label="一级分类" rules={[{ required: true }]}>
            <Select options={topLevelCategories.map((category) => ({ label: category.name, value: category.id }))} />
          </Form.Item>
          <Form.Item name="name" label="二级分类名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer title="审批单明细" open={Boolean(detailRecord)} destroyOnHidden onClose={() => setDetailRecord(null)} width="min(980px, 92vw)">
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
