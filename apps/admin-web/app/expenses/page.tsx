"use client";

import { Alert, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Table, Tag, Upload } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import type {
  Attachment,
  ExpenseCategory,
  ExpenseItem,
  Ledger,
  Store,
  Supplier,
} from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

interface ExpenseFormValues {
  ledger_period: string;
  expense_date?: dayjs.Dayjs;
  description: string;
  amount: string;
  category_l1?: string | null;
  category_l2?: string | null;
  supplier_name?: string | null;
  payee_account?: string | null;
}

interface ExpenseFilterValues {
  store_id?: string;
  ledger_period?: string;
  payment_status?: ExpenseItem["payment_status"];
}

export default function ExpensesPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [items, setItems] = useState<ExpenseItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentItem, setAttachmentItem] = useState<ExpenseItem | null>(null);
  const [uploadFileList, setUploadFileList] = useState<UploadFile[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isAttachmentLoading, setIsAttachmentLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isAttachmentModalOpen, setIsAttachmentModalOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<ExpenseItem | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<ExpenseFormValues>();
  const [filterForm] = Form.useForm<ExpenseFilterValues>();
  const selectedCategoryL1 = Form.useWatch("category_l1", form);

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
  const categoryOptions = categories
    .filter((category) => category.status === "active" && !category.parent_id)
    .map((category) => ({ label: category.name, value: category.name }));
  const selectedParentCategory = categories.find(
    (category) => category.name === selectedCategoryL1 && !category.parent_id,
  );
  const categoryL2Options = categories
    .filter(
      (category) =>
        category.status === "active" &&
        selectedParentCategory !== undefined &&
        category.parent_id === selectedParentCategory.id,
    )
    .map((category) => ({ label: category.name, value: category.name }));
  const supplierOptions = suppliers
    .filter((supplier) => supplier.status === "active")
    .map((supplier) => ({ label: supplier.name, value: supplier.name }));
  const ledgerPeriodOptions = Array.from(new Set(ledgers.map((ledger) => ledger.period)))
    .sort()
    .reverse()
    .map((period) => ({ label: period, value: period }));

  function buildFilterParams(values?: ExpenseFilterValues) {
    const params = new URLSearchParams({ page_size: "500" });
    if (values?.store_id) params.set("store_id", values.store_id);
    if (values?.ledger_period) params.set("ledger_period", values.ledger_period);
    if (values?.payment_status) params.set("payment_status", values.payment_status);
    return `?${params.toString()}`;
  }

  async function loadData(filters?: ExpenseFilterValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [storePage, ledgerPage, categoryPage, supplierPage, itemPage] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.ledgers.list("?page_size=200"),
        apiClient.categories.list("?page_size=500"),
        apiClient.suppliers.list("?page_size=500"),
        apiClient.expenseItems.list(buildFilterParams(filters ?? filterForm.getFieldsValue())),
      ]);
      setStores(storePage.items);
      setLedgers(ledgerPage.items);
      setCategories(categoryPage.items);
      setSuppliers(supplierPage.items);
      setItems(itemPage.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载支出明细");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function submitFilters(values: ExpenseFilterValues) {
    await loadData(values);
  }

  async function resetFilters() {
    filterForm.resetFields();
    await loadData({});
  }

  async function submitItem(values: ExpenseFormValues) {
    const [storeId, period] = values.ledger_period.split("|");
    setIsLoading(true);
    try {
      const payload = {
        description: values.description,
        amount: values.amount,
        expense_date: values.expense_date?.format("YYYY-MM-DD") ?? null,
        category_l1: values.category_l1 ?? null,
        category_l2: values.category_l2 ?? null,
        supplier_name: values.supplier_name ?? null,
        payee_account: values.payee_account ?? null,
      };
      if (editingItem) {
        await apiClient.expenseItems.update(editingItem.id, payload);
      } else {
        await apiClient.expenseItems.create({
          ...payload,
          store_id: storeId,
          ledger_period: period,
        });
      }
      setIsModalOpen(false);
      setEditingItem(null);
      form.resetFields();
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法新增支出明细");
    } finally {
      setIsLoading(false);
    }
  }

  function openCreateModal() {
    setEditingItem(null);
    form.resetFields();
    setIsModalOpen(true);
  }

  function openEditModal(item: ExpenseItem) {
    setEditingItem(item);
    form.setFieldsValue({
      ledger_period: `${item.store_id}|${item.ledger_period}`,
      expense_date: item.expense_date ? dayjs(item.expense_date) : undefined,
      description: item.description,
      amount: item.amount,
      category_l1: item.category_l1,
      category_l2: item.category_l2,
      supplier_name: item.supplier_name,
      payee_account: item.payee_account,
    });
    setIsModalOpen(true);
  }

  async function openAttachmentModal(item: ExpenseItem) {
    setAttachmentItem(item);
    setIsAttachmentModalOpen(true);
    setUploadFileList([]);
    await loadAttachments(item.id);
  }

  async function loadAttachments(itemId: string) {
    setIsAttachmentLoading(true);
    setErrorMessage(null);
    try {
      const page = await apiClient.attachments.list(`?resource_type=expense_item&resource_id=${itemId}&page_size=100`);
      setAttachments(page.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载附件");
    } finally {
      setIsAttachmentLoading(false);
    }
  }

  async function uploadAttachment() {
    const file = uploadFileList[0]?.originFileObj;
    if (!attachmentItem || !file) {
      setErrorMessage("请选择要上传的附件");
      return;
    }
    setIsAttachmentLoading(true);
    setErrorMessage(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      await apiClient.attachments.upload("expense_item", attachmentItem.id, formData);
      setUploadFileList([]);
      await loadAttachments(attachmentItem.id);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法上传附件");
    } finally {
      setIsAttachmentLoading(false);
    }
  }

  async function downloadAttachment(attachment: Attachment) {
    setIsAttachmentLoading(true);
    setErrorMessage(null);
    try {
      const blob = await apiClient.attachments.download(attachment.id);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.file_name;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法下载附件");
    } finally {
      setIsAttachmentLoading(false);
    }
  }

  async function archiveDingtalkAttachment(attachment: Attachment) {
    setIsAttachmentLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.attachments.downloadDingtalk(attachment.id);
      if (attachmentItem) {
        await loadAttachments(attachmentItem.id);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法归档钉钉附件");
    } finally {
      setIsAttachmentLoading(false);
    }
  }

  const columns: ColumnsType<ExpenseItem> = [
    { title: "门店", dataIndex: "store_id", render: (value) => storesById.get(value)?.name ?? "未知门店" },
    { title: "账期", dataIndex: "ledger_period" },
    { title: "支出日期", dataIndex: "expense_date", render: (value) => value || "-" },
    { title: "说明", dataIndex: "description" },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "分类", dataIndex: "category_l1", render: (value) => value || <Tag color="gold">未分类</Tag> },
    { title: "供应商", dataIndex: "supplier_name", render: (value) => value || <Tag>未关联</Tag> },
    {
      title: "付款状态",
      dataIndex: "payment_status",
      render: (value: ExpenseItem["payment_status"]) =>
        value === "paid" ? <Tag color="green">已付款</Tag> : <Tag color="gold">待匹配</Tag>,
    },
    {
      title: "操作",
      width: 170,
      render: (_, record) => {
        const ledger = ledgersByKey.get(`${record.store_id}|${record.ledger_period}`);
        return (
          <Space>
            <Button type="link" disabled={ledger?.status === "closed"} onClick={() => openEditModal(record)}>
              编辑
            </Button>
            <Button type="link" onClick={() => openAttachmentModal(record)}>
              凭证
            </Button>
          </Space>
        );
      },
    },
  ];

  const attachmentColumns: ColumnsType<Attachment> = [
    { title: "文件名", dataIndex: "file_name" },
    { title: "来源", dataIndex: "source", width: 90, render: (value) => (value === "dingtalk" ? "钉钉" : "手工") },
    {
      title: "状态",
      dataIndex: "download_status",
      width: 110,
      render: (value: Attachment["download_status"]) =>
        value === "stored" ? <Tag color="green">已归档</Tag> : <Tag color="gold">待下载</Tag>,
    },
    {
      title: "大小",
      dataIndex: "file_size",
      width: 100,
      render: (value: number | null) => (value ? `${Math.ceil(value / 1024)} KB` : "-"),
    },
    {
      title: "操作",
      width: 150,
      render: (_, record) =>
        record.download_status === "stored" ? (
          <Button type="link" onClick={() => downloadAttachment(record)}>
            下载
          </Button>
        ) : (
          <Button type="link" disabled={record.source !== "dingtalk"} onClick={() => archiveDingtalkAttachment(record)}>
            归档
          </Button>
        ),
    },
  ];

  return (
    <AppShell
      title="支出明细"
      action={<Button type="primary" onClick={openCreateModal}>新增支出</Button>}
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="支出明细列表">
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
          <Form.Item name="payment_status" label="付款状态">
            <Select
              allowClear
              className="filter-select"
              options={[
                { label: "未付款", value: "unpaid" },
                { label: "部分付款", value: "partial_paid" },
                { label: "已付款", value: "paid" },
                { label: "无银行流水", value: "no_bank_flow" },
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
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={items} />
      </Card>
      <Modal
        title={editingItem ? "编辑支出" : "新增支出"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingItem(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitItem}>
          <Form.Item name="ledger_period" label="账套" rules={[{ required: true }]}>
            <Select disabled={Boolean(editingItem)} options={openLedgerOptions} />
          </Form.Item>
          <Form.Item name="expense_date" label="支出日期">
            <DatePicker className="full-width" />
          </Form.Item>
          <Form.Item name="description" label="支出说明" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="amount" label="金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="category_l1" label="一级分类">
            <Select
              allowClear
              showSearch
              options={categoryOptions}
              onChange={() => form.setFieldValue("category_l2", null)}
            />
          </Form.Item>
          <Form.Item name="category_l2" label="二级分类">
            <Select allowClear showSearch options={categoryL2Options} disabled={!selectedCategoryL1} />
          </Form.Item>
          <Form.Item name="supplier_name" label="供应商">
            <Select allowClear showSearch options={supplierOptions} />
          </Form.Item>
          <Form.Item name="payee_account" label="收款账号">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title={attachmentItem ? `${attachmentItem.description} 凭证` : "凭证"}
        open={isAttachmentModalOpen}
        onCancel={() => {
          setIsAttachmentModalOpen(false);
          setAttachmentItem(null);
          setAttachments([]);
        }}
        footer={null}
        width={760}
      >
        <Space className="table-filter-form">
          <Upload
            beforeUpload={() => false}
            fileList={uploadFileList}
            maxCount={1}
            onChange={({ fileList }) => setUploadFileList(fileList.slice(-1))}
          >
            <Button>选择文件</Button>
          </Upload>
          <Button type="primary" loading={isAttachmentLoading} onClick={uploadAttachment}>
            上传凭证
          </Button>
        </Space>
        <Table
          rowKey="id"
          loading={isAttachmentLoading}
          columns={attachmentColumns}
          dataSource={attachments}
          pagination={{ pageSize: 5 }}
        />
      </Modal>
    </AppShell>
  );
}
