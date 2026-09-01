"use client";

import { Alert, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Table, Tabs, Upload } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import type {
  BankImportPreviewRow,
  BankImportPreviewResult,
  BankImportRowError,
  BankTransaction,
  BankTransactionCreate,
  Ledger,
  Store,
  SyncJob,
} from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { StoreLedgerWorkspaceNav } from "../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../lib/api";
import { useClientSearchParams } from "../lib/searchParams";

interface BankFormValues extends Omit<BankTransactionCreate, "occurred_at"> {
  occurred_at?: dayjs.Dayjs;
}

interface BankFilterValues {
  store_id?: string;
  ledger_period?: string;
  direction?: "income" | "expense";
}

type ImportMode = "file" | "paste";

export default function BankPage() {
  const searchParams = useClientSearchParams();
  const queryStoreId = searchParams.get("store_id") ?? undefined;
  const queryLedgerPeriod = searchParams.get("ledger_period") ?? undefined;
  const queryDirection = (searchParams.get("direction") as BankFilterValues["direction"] | null) ?? undefined;
  const initialFilters = useMemo<BankFilterValues>(
    () => ({
      store_id: queryStoreId,
      ledger_period: queryLedgerPeriod,
      direction: queryDirection,
    }),
    [queryDirection, queryLedgerPeriod, queryStoreId],
  );
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [importJobs, setImportJobs] = useState<SyncJob[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<BankTransaction | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [importMode, setImportMode] = useState<ImportMode>("file");
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([]);
  const [pasteText, setPasteText] = useState("");
  const [importResultText, setImportResultText] = useState<string | null>(null);
  const [importPreview, setImportPreview] = useState<BankImportPreviewResult | null>(null);
  const [importRowErrors, setImportRowErrors] = useState<BankImportRowError[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<BankFormValues>();
  const [importForm] = Form.useForm<{ ledger_period: string }>();
  const [filterForm] = Form.useForm<BankFilterValues>();

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const ledgersByKey = useMemo(
    () => new Map(ledgers.map((ledger) => [`${ledger.store_id}|${ledger.period}`, ledger])),
    [ledgers],
  );
  const openLedgerOptions = ledgers
    .filter((ledger) => ledger.status === "open")
    .map((ledger) => ({
      label: `${storesById.get(ledger.store_id)?.name ?? "未知门店"} / ${ledger.period}`,
      value: `${ledger.store_id}|${ledger.period}`,
    }));
  const ledgerPeriodOptions = Array.from(new Set(ledgers.map((ledger) => ledger.period)))
    .sort()
    .reverse()
    .map((period) => ({ label: period, value: period }));
  const currentStore = queryStoreId ? storesById.get(queryStoreId) : undefined;

  function buildFilterParams(values?: BankFilterValues) {
    const params = new URLSearchParams({ page_size: "500" });
    if (values?.store_id) params.set("store_id", values.store_id);
    if (values?.ledger_period) params.set("ledger_period", values.ledger_period);
    if (values?.direction) params.set("direction", values.direction);
    return `?${params.toString()}`;
  }

  async function loadData(filters?: BankFilterValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [storePage, ledgerPage, transactionPage, syncJobPage] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.ledgers.list("?page_size=200"),
        apiClient.bankTransactions.list(buildFilterParams(filters ?? filterForm.getFieldsValue())),
        apiClient.dingtalk.listSyncJobs("?job_type=bank_transaction_import&page_size=20"),
      ]);
      setStores(storePage.items);
      setLedgers(ledgerPage.items);
      setTransactions(transactionPage.items);
      setImportJobs(syncJobPage.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载银行流水");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    filterForm.setFieldsValue(initialFilters);
    loadData(initialFilters);
  }, [filterForm, initialFilters]);

  async function submitFilters(values: BankFilterValues) {
    await loadData(values);
  }

  async function resetFilters() {
    filterForm.resetFields();
    await loadData({});
  }

  async function downloadImportTemplate() {
    setErrorMessage(null);
    try {
      const blob = await apiClient.bankTransactions.downloadImportTemplate();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "bank-import-template.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法下载导入模板");
    }
  }

  function openImportModal(mode: ImportMode) {
    setImportMode(mode);
    setImportPreview(null);
    setImportRowErrors([]);
    setImportResultText(null);
    setIsImportModalOpen(true);
  }

  function openCreateModal() {
    const filters = filterForm.getFieldsValue();
    setEditingTransaction(null);
    form.resetFields();
    form.setFieldsValue({
      direction: "expense",
      ledger_period: filters.store_id && filters.ledger_period ? `${filters.store_id}|${filters.ledger_period}` : undefined,
    });
    setIsModalOpen(true);
  }

  function openEditModal(transaction: BankTransaction) {
    setEditingTransaction(transaction);
    form.setFieldsValue({
      ledger_period: transaction.store_id && transaction.ledger_period ? `${transaction.store_id}|${transaction.ledger_period}` : undefined,
      occurred_at: dayjs(transaction.occurred_at),
      direction: transaction.direction,
      amount: transaction.amount,
      counterparty_name: transaction.counterparty_name,
      counterparty_account: transaction.counterparty_account,
      bank_serial_no: transaction.bank_serial_no,
      summary: transaction.summary,
    });
    setIsModalOpen(true);
  }

  function closeTransactionModal() {
    setIsModalOpen(false);
    setEditingTransaction(null);
    form.resetFields();
  }

  function closeImportModal() {
    setIsImportModalOpen(false);
    setImportPreview(null);
    setUploadFileList([]);
    setPasteText("");
    importForm.resetFields();
  }

  function csvCell(value: string) {
    const normalized = value.replace(/\r/g, "");
    return /[",\n]/.test(normalized) ? `"${normalized.replace(/"/g, '""')}"` : normalized;
  }

  function pasteTextToFile() {
    const rows = pasteText
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

  function fillPasteExample() {
    setPasteText(
      [
        "日期\t收入还是支出\t金额\t备注",
        "2026-08-25\t支出\t4020.04\t林燕玲门店支出报销汇总",
        "2026-08-26\t支出\t3336.70\t程立鼎门店支出报销汇总",
      ].join("\n"),
    );
    setImportPreview(null);
    setImportRowErrors([]);
  }

  function currentImportFile() {
    if (importMode === "paste") return pasteTextToFile();
    return uploadFileList[0]?.originFileObj ?? null;
  }

  async function submitTransaction(values: BankFormValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const payload = {
        occurred_at: values.occurred_at?.toISOString() ?? new Date().toISOString(),
        direction: values.direction,
        amount: values.amount,
        counterparty_name: values.counterparty_name || null,
        counterparty_account: values.counterparty_account || null,
        bank_serial_no: values.bank_serial_no || null,
        summary: values.summary || null,
      };
      if (editingTransaction) {
        const [storeId, period] = values.ledger_period?.split("|") ?? [];
        await apiClient.bankTransactions.update(editingTransaction.id, {
          ...payload,
          store_id: storeId || null,
          ledger_period: period || null,
        });
      } else {
        const [storeId, period] = values.ledger_period?.split("|") ?? [];
        await apiClient.bankTransactions.create({
          ...payload,
          store_id: storeId || null,
          ledger_period: period || null,
        });
      }
      closeTransactionModal();
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存银行流水");
    } finally {
      setIsLoading(false);
    }
  }

  async function submitImport(values: { ledger_period?: string }) {
    const file = currentImportFile();
    if (!file) {
      setErrorMessage(importMode === "paste" ? "请粘贴银行流水数据" : "请选择 CSV / XLSX 文件");
      return;
    }
    const [storeId, period] = values.ledger_period?.split("|") ?? [];
    const formData = new FormData();
    if (storeId && period) {
      formData.append("store_id", storeId);
      formData.append("ledger_period", period);
    }
    formData.append("started_by", "admin");
    formData.append("file", file);

    setIsLoading(true);
    setErrorMessage(null);
    setImportRowErrors([]);
    try {
      const result = await apiClient.bankTransactions.importFile(formData);
      setImportResultText(
        `导入 ${result.created_count} 条，跳过重复 ${result.skipped_count} 条，错误 ${result.row_errors.length} 行`,
      );
      setImportRowErrors(result.row_errors);
      setIsImportModalOpen(false);
      setImportPreview(null);
      setUploadFileList([]);
      setPasteText("");
      importForm.resetFields();
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法导入银行流水");
    } finally {
      setIsLoading(false);
    }
  }

  async function previewImport() {
    const values = await importForm.validateFields();
    const file = currentImportFile();
    if (!file) {
      setErrorMessage(importMode === "paste" ? "请粘贴银行流水数据" : "请选择 CSV / XLSX 文件");
      return;
    }
    const [storeId, period] = values.ledger_period?.split("|") ?? [];
    const formData = new FormData();
    if (storeId && period) {
      formData.append("store_id", storeId);
      formData.append("ledger_period", period);
    }
    formData.append("file", file);

    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await apiClient.bankTransactions.previewImport(formData);
      setImportPreview(result);
      setImportRowErrors(result.row_errors);
      setImportResultText(
        `预览：可导入 ${result.valid_count} 条，重复 ${result.duplicate_count} 条，错误 ${result.error_count} 行`,
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法预览银行流水");
    } finally {
      setIsLoading(false);
    }
  }

  async function rollbackImportJob(job: SyncJob) {
    Modal.confirm({
      title: "回滚导入批次",
      content: `确认删除该批次导入的银行流水？存在候选、确认或拒绝匹配记录的流水不会允许回滚。批次号：${job.id}`,
      okText: "确认回滚",
      okButtonProps: { danger: true },
      cancelText: "取消",
      async onOk() {
        setIsLoading(true);
        setErrorMessage(null);
        try {
          const result = await apiClient.bankTransactions.rollbackImport(job.id, "admin");
          setImportResultText(`已回滚导入批次，删除 ${result.deleted_count} 条银行流水`);
          await loadData();
        } catch (error) {
          setErrorMessage(error instanceof Error ? error.message : "无法回滚导入批次");
        } finally {
          setIsLoading(false);
        }
      },
    });
  }

  const columns: ColumnsType<BankTransaction> = [
    { title: "发生时间", dataIndex: "occurred_at", width: 150, fixed: "left", render: (value: string) => value.replace("T", " ").slice(0, 16) },
    { title: "方向", dataIndex: "direction", width: 80, render: (value) => (value === "income" ? "收入" : "支出") },
    { title: "金额", dataIndex: "amount", width: 120, align: "right", render: (value: string) => formatMoney(value) },
    { title: "已匹配", dataIndex: "matched_amount", width: 120, align: "right", render: (value: string) => formatMoney(value) },
    { title: "门店", dataIndex: "store_id", width: 220, ellipsis: true, render: (value) => value ? storesById.get(value)?.name ?? "未知门店" : "待匹配归属" },
    { title: "账期", dataIndex: "ledger_period", width: 100, render: (value) => value || "-" },
    { title: "对方户名", dataIndex: "counterparty_name", width: 180, ellipsis: true, render: (value) => value || "-" },
    { title: "流水号", dataIndex: "bank_serial_no", width: 220, ellipsis: true, render: (value) => value || "-" },
    { title: "摘要", dataIndex: "summary", width: 280, ellipsis: true, render: (value) => value || "-" },
    {
      title: "操作",
      key: "actions",
      width: 100,
      fixed: "right",
      align: "center",
      className: "table-action-column",
      render: (_, record) => {
        const ledger = ledgersByKey.get(`${record.store_id}|${record.ledger_period}`);
        return (
          <Button size="small" disabled={ledger?.status === "closed"} onClick={() => openEditModal(record)}>
            编辑
          </Button>
        );
      },
    },
  ];

  const previewColumns: ColumnsType<BankImportPreviewRow> = [
    { title: "行号", dataIndex: "row_number" },
    { title: "发生时间", dataIndex: "occurred_at", render: (value: string) => value.replace("T", " ").slice(0, 16) },
    { title: "方向", dataIndex: "direction", render: (value) => (value === "income" ? "收入" : "支出") },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "对方户名", dataIndex: "counterparty_name", render: (value) => value || "-" },
    { title: "备注", dataIndex: "summary", render: (value) => value || "-" },
    { title: "流水号", dataIndex: "bank_serial_no", render: (value) => value || "-" },
    { title: "结果", dataIndex: "duplicate", render: (value: boolean) => (value ? "重复跳过" : "可导入") },
  ];
  const importJobColumns: ColumnsType<SyncJob> = [
    { title: "批次号", dataIndex: "id", ellipsis: true },
    { title: "状态", dataIndex: "status", width: 100 },
    { title: "处理", dataIndex: "processed_count", width: 80 },
    { title: "成功", dataIndex: "success_count", width: 80 },
    { title: "失败/跳过", dataIndex: "failed_count", width: 100 },
    {
      title: "完成时间",
      dataIndex: "finished_at",
      width: 160,
      render: (value: string | null) => (value ? value.replace("T", " ").slice(0, 16) : "-"),
    },
    {
      title: "操作",
      width: 110,
      render: (_, record) => (
        <Button size="small" danger disabled={record.status !== "succeeded"} onClick={() => rollbackImportJob(record)}>
          回滚
        </Button>
      ),
    },
  ];

  return (
    <AppShell
      title="银行流水"
      action={
        <Space>
          <Button onClick={() => openImportModal("file")}>导入文件</Button>
          <Button onClick={() => openImportModal("paste")}>批量粘贴</Button>
          <Button type="primary" onClick={openCreateModal}>新增流水</Button>
        </Space>
      }
    >
      {queryStoreId ? (
        <StoreLedgerWorkspaceNav
          storeId={queryStoreId}
          storeName={currentStore?.name}
          period={queryLedgerPeriod}
          periodOptions={ledgerPeriodOptions}
          statusLabel={currentStore?.status === "active" ? "启用门店" : currentStore ? "停用门店" : undefined}
          activeKey="bank"
        />
      ) : null}
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      {importResultText ? (
        <Alert className="dashboard-alert" message={importResultText} type="success" showIcon closable />
      ) : null}
      {importRowErrors.length ? (
        <Alert
          className="dashboard-alert"
          message="部分行导入失败"
          description={importRowErrors.map((error) => `第 ${error.row_number} 行：${error.message}`).join("；")}
          type="warning"
          showIcon
          closable
        />
      ) : null}
      <Card title="最近导入批次" className="dashboard-alert">
        <Table
          rowKey="id"
          loading={isLoading}
          columns={importJobColumns}
          dataSource={importJobs}
          pagination={false}
          size="small"
        />
      </Card>
      <Card title="银行流水列表">
        <Form form={filterForm} layout="inline" onFinish={submitFilters} className="table-filter-form">
          <Form.Item name="store_id" label="门店">
            <Select
              allowClear
              className="filter-select"
              options={stores.map((store) => ({ label: store.name, value: store.id }))}
            />
          </Form.Item>
          <Form.Item name="ledger_period" label="账期">
            <Select allowClear className="filter-select" options={ledgerPeriodOptions} />
          </Form.Item>
          <Form.Item name="direction" label="方向">
            <Select
              allowClear
              className="filter-select"
              options={[
                { label: "收入", value: "income" },
                { label: "支出", value: "expense" },
              ]}
            />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={isLoading}>
                筛选
              </Button>
              <Button onClick={resetFilters}>重置</Button>
            </Space>
          </Form.Item>
        </Form>
        <Table
          rowKey="id"
          loading={isLoading}
          columns={columns}
          dataSource={transactions}
          scroll={{ x: 1470 }}
          sticky
        />
      </Card>
      <Modal
        title={editingTransaction ? "编辑银行流水" : "新增银行流水"}
        open={isModalOpen}
        onCancel={closeTransactionModal}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitTransaction} initialValues={{ direction: "expense" }}>
          <Form.Item name="ledger_period" label="账套">
            <Select allowClear placeholder="可先留空，匹配审批后自动归属" options={openLedgerOptions} />
          </Form.Item>
          <Form.Item name="occurred_at" label="发生时间">
            <DatePicker showTime className="full-width" />
          </Form.Item>
          <Form.Item name="direction" label="方向" rules={[{ required: true }]}>
            <Select
              options={[
                { label: "收入", value: "income" },
                { label: "支出", value: "expense" },
              ]}
            />
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="counterparty_name" label="对方户名">
            <Input />
          </Form.Item>
          <Form.Item name="counterparty_account" label="对方账号">
            <Input />
          </Form.Item>
          <Form.Item name="bank_serial_no" label="流水号">
            <Input />
          </Form.Item>
          <Form.Item name="summary" label="摘要">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="导入银行流水"
        open={isImportModalOpen}
        destroyOnHidden
        onCancel={closeImportModal}
        onOk={() => importForm.submit()}
        confirmLoading={isLoading}
        width={860}
        footer={[
          <Button key="cancel" onClick={closeImportModal}>
            取消
          </Button>,
          <Button key="preview" onClick={previewImport} loading={isLoading}>
            预览
          </Button>,
          <Button key="import" type="primary" onClick={() => importForm.submit()} loading={isLoading}>
            确认导入
          </Button>,
        ]}
      >
        <Form form={importForm} layout="vertical" onFinish={submitImport}>
          <Form.Item name="ledger_period" label="账套">
            <Select allowClear placeholder="可留空导入未归属流水" options={openLedgerOptions} />
          </Form.Item>
          <Space className="dashboard-alert">
            <Button size="small" onClick={downloadImportTemplate}>
              下载标准模板
            </Button>
          </Space>
          <Tabs
            activeKey={importMode}
            onChange={(key) => {
              setImportMode(key as ImportMode);
              setImportPreview(null);
              setImportRowErrors([]);
              setImportResultText(null);
            }}
            items={[
              {
                key: "file",
                label: "文件导入",
                children: (
                  <Form.Item label="CSV / XLSX 文件" required>
                    <Upload
                      accept=".csv,.xlsx,.xlsm,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                      maxCount={1}
                      fileList={uploadFileList}
                      beforeUpload={() => false}
                      onChange={({ fileList }) => {
                        setUploadFileList(fileList.slice(-1));
                        setImportPreview(null);
                      }}
                    >
                      <Button>选择文件</Button>
                    </Upload>
                  </Form.Item>
                ),
              },
              {
                key: "paste",
                label: "批量粘贴",
                children: (
                  <Form.Item
                    label="粘贴 Excel 数据"
                    required
                    extra="可以直接粘贴四列数据，默认按：日期、收入还是支出、金额、备注。也可以带表头，并额外包含流水号、对方户名、对方账号。"
                  >
                    <Space className="dashboard-alert">
                      <Button size="small" onClick={fillPasteExample}>
                        填入示例
                      </Button>
                      <Button
                        size="small"
                        onClick={() => {
                          setPasteText("");
                          setImportPreview(null);
                          setImportRowErrors([]);
                        }}
                      >
                        清空
                      </Button>
                    </Space>
                    <Input.TextArea
                      rows={10}
                      value={pasteText}
                      onChange={(event) => {
                        setPasteText(event.target.value);
                        setImportPreview(null);
                      }}
                      placeholder={"日期\t收入还是支出\t金额\t备注\n2026-08-25\t支出\t4020.04\t林燕玲门店支出报销汇总\n2026-08-26\t支出\t3336.70\t程立鼎门店支出报销汇总"}
                    />
                  </Form.Item>
                ),
              },
            ]}
          />
        </Form>
        {importPreview ? (
          <Table
            rowKey="row_number"
            size="small"
            columns={previewColumns}
            dataSource={importPreview.preview_rows}
            pagination={false}
            scroll={{ x: 900 }}
          />
        ) : null}
      </Modal>
    </AppShell>
  );
}
