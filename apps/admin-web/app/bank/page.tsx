"use client";

import { Alert, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Table, Upload } from "antd";
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
} from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

interface BankFormValues extends Omit<BankTransactionCreate, "occurred_at"> {
  occurred_at?: dayjs.Dayjs;
}

interface BankFilterValues {
  store_id?: string;
  ledger_period?: string;
  direction?: "income" | "expense";
}

export default function BankPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [transactions, setTransactions] = useState<BankTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<BankTransaction | null>(null);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([]);
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
      const [storePage, ledgerPage, transactionPage] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.ledgers.list("?page_size=200"),
        apiClient.bankTransactions.list(buildFilterParams(filters ?? filterForm.getFieldsValue())),
      ]);
      setStores(storePage.items);
      setLedgers(ledgerPage.items);
      setTransactions(transactionPage.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载银行流水");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function submitFilters(values: BankFilterValues) {
    await loadData(values);
  }

  async function resetFilters() {
    filterForm.resetFields();
    await loadData({});
  }

  function openCreateModal() {
    setEditingTransaction(null);
    form.resetFields();
    form.setFieldsValue({ direction: "expense" });
    setIsModalOpen(true);
  }

  function openEditModal(transaction: BankTransaction) {
    setEditingTransaction(transaction);
    form.setFieldsValue({
      ledger_period: `${transaction.store_id}|${transaction.ledger_period}`,
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
        await apiClient.bankTransactions.update(editingTransaction.id, payload);
      } else {
        const [storeId, period] = values.ledger_period.split("|");
        await apiClient.bankTransactions.create({
          ...payload,
          store_id: storeId,
          ledger_period: period,
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

  async function submitImport(values: { ledger_period: string }) {
    const file = uploadFileList[0]?.originFileObj;
    if (!file) {
      setErrorMessage("请选择 CSV / XLSX 文件");
      return;
    }
    const [storeId, period] = values.ledger_period.split("|");
    const formData = new FormData();
    formData.append("store_id", storeId);
    formData.append("ledger_period", period);
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
    const file = uploadFileList[0]?.originFileObj;
    if (!file) {
      setErrorMessage("请选择 CSV / XLSX 文件");
      return;
    }
    const [storeId, period] = values.ledger_period.split("|");
    const formData = new FormData();
    formData.append("store_id", storeId);
    formData.append("ledger_period", period);
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

  const columns: ColumnsType<BankTransaction> = [
    { title: "门店", dataIndex: "store_id", render: (value) => storesById.get(value)?.name ?? "未知门店" },
    { title: "账期", dataIndex: "ledger_period" },
    { title: "发生时间", dataIndex: "occurred_at", render: (value: string) => value.replace("T", " ").slice(0, 16) },
    { title: "方向", dataIndex: "direction", render: (value) => (value === "income" ? "收入" : "支出") },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "对方户名", dataIndex: "counterparty_name", render: (value) => value || "-" },
    { title: "流水号", dataIndex: "bank_serial_no", render: (value) => value || "-" },
    { title: "已匹配", dataIndex: "matched_amount", render: (value: string) => formatMoney(value) },
    {
      title: "操作",
      key: "actions",
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
    { title: "流水号", dataIndex: "bank_serial_no", render: (value) => value || "-" },
    { title: "结果", dataIndex: "duplicate", render: (value: boolean) => (value ? "重复跳过" : "可导入") },
  ];

  return (
    <AppShell
      title="银行流水"
      action={
        <Space>
          <Button onClick={() => setIsImportModalOpen(true)}>导入流水</Button>
          <Button type="primary" onClick={openCreateModal}>新增流水</Button>
        </Space>
      }
    >
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
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={transactions} />
      </Card>
      <Modal
        title={editingTransaction ? "编辑银行流水" : "新增银行流水"}
        open={isModalOpen}
        onCancel={closeTransactionModal}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitTransaction} initialValues={{ direction: "expense" }}>
          <Form.Item name="ledger_period" label="账套" rules={[{ required: true }]}>
            <Select disabled={Boolean(editingTransaction)} options={openLedgerOptions} />
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
        onCancel={() => {
          setIsImportModalOpen(false);
          setImportPreview(null);
          setUploadFileList([]);
          importForm.resetFields();
        }}
        onOk={() => importForm.submit()}
        confirmLoading={isLoading}
        width={860}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setIsImportModalOpen(false);
              setImportPreview(null);
              setUploadFileList([]);
              importForm.resetFields();
            }}
          >
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
          <Form.Item name="ledger_period" label="账套" rules={[{ required: true }]}>
            <Select options={openLedgerOptions} />
          </Form.Item>
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
        </Form>
        {importPreview ? (
          <Table
            rowKey="row_number"
            size="small"
            columns={previewColumns}
            dataSource={importPreview.preview_rows}
            pagination={false}
          />
        ) : null}
      </Modal>
    </AppShell>
  );
}
