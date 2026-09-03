"use client";

import { Alert, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Table, Upload, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import type { UploadFile } from "antd/es/upload/interface";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import {
  PlusOutlined,
  UploadOutlined,
  DownloadOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import type {
  Attachment,
  ExpenseCategory,
  ExpenseItem,
  Ledger,
  Store,
  Supplier,
} from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { MoneyDisplay } from "../components/MoneyDisplay";
import { StatusBadge } from "../components/StatusBadge";
import { EnterpriseTable } from "../components/EnterpriseTable";
import type { EnterpriseTableColumn } from "../components/EnterpriseTable";
import { SmartFilterBar } from "../components/SmartFilterBar";
import { apiClient } from "../lib/api";
import { getExpenseCategories, getLedgers, getStores } from "../lib/referenceData";

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
        getStores(),
        getLedgers(),
        getExpenseCategories(),
        apiClient.suppliers.list("?page_size=500"),
        apiClient.expenseItems.list(buildFilterParams(filters ?? filterForm.getFieldsValue())),
      ]);
      setStores(storePage);
      setLedgers(ledgerPage);
      setCategories(categoryPage);
      setSuppliers(supplierPage.items);
      setItems(itemPage.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "加载失败");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

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
        message.success("更新成功");
      } else {
        await apiClient.expenseItems.create({
          ...payload,
          store_id: storeId,
          ledger_period: period,
        });
        message.success("创建成功");
      }
      setIsModalOpen(false);
      setEditingItem(null);
      form.resetFields();
      await loadData();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
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
      message.error("加载附件失败");
    } finally {
      setIsAttachmentLoading(false);
    }
  }

  async function uploadAttachment() {
    if (!uploadFileList.length || !attachmentItem) {
      message.warning("请选择文件");
      return;
    }
    const file = uploadFileList[0].originFileObj;
    if (!file) return;
    setIsAttachmentLoading(true);
    try {
      const payload = new FormData();
      payload.append("file", file);
      await apiClient.attachments.upload("expense_item", attachmentItem.id, payload);
      message.success("上传成功");
      setUploadFileList([]);
      await loadAttachments(attachmentItem.id);
    } catch (error) {
      message.error("上传失败");
    } finally {
      setIsAttachmentLoading(false);
    }
  }

  async function downloadAttachment(attachment: Attachment) {
    try {
      const blob = await apiClient.attachments.download(attachment.id);
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = attachment.file_name;
      link.click();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      message.error("下载失败");
    }
  }

  async function openDingtalkAttachment(attachment: Attachment) {
    try {
      const data = await apiClient.attachments.accessUrl(attachment.id);
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      message.error("无法打开钉钉附件");
    }
  }

  const columns: EnterpriseTableColumn<ExpenseItem>[] = [
    {
      title: "门店",
      key: "store_id",
      dataIndex: "store_id",
      width: 140,
      render: (value) => storesById.get(value)?.name ?? "未知门店",
    },
    {
      title: "账期",
      key: "ledger_period",
      dataIndex: "ledger_period",
      width: 90,
    },
    {
      title: "支出日期",
      key: "expense_date",
      dataIndex: "expense_date",
      width: 110,
      render: (value) => value || "-",
    },
    {
      title: "说明",
      key: "description",
      dataIndex: "description",
      ellipsis: true,
    },
    {
      title: "金额",
      key: "amount",
      dataIndex: "amount",
      width: 120,
      align: "right",
      render: (value: string) => <MoneyDisplay value={Number(value)} />,
    },
    {
      title: "分类",
      key: "category_l1",
      dataIndex: "category_l1",
      width: 120,
      render: (value) => value || <StatusBadge status="uncategorized" text="未分类" />,
    },
    {
      title: "供应商",
      key: "supplier_name",
      dataIndex: "supplier_name",
      width: 140,
      ellipsis: true,
      render: (value) => value || <StatusBadge status="unlinked" text="未关联" />,
    },
    {
      title: "付款状态",
      key: "payment_status",
      dataIndex: "payment_status",
      width: 100,
      render: (value: ExpenseItem["payment_status"]) => {
        const statusMap = {
          paid: { status: "paid" as const, text: "已付款" },
          partial_paid: { status: "partial" as const, text: "部分付款" },
          unpaid: { status: "pending" as const, text: "待付款" },
          no_bank_flow: { status: "none" as const, text: "无流水" },
        };
        const config = statusMap[value] || statusMap.unpaid;
        return <StatusBadge status={config.status} text={config.text} />;
      },
    },
    {
      title: "操作",
      key: "actions",
      width: 180,
      fixed: "right",
      render: (_, record) => {
        const ledger = ledgersByKey.get(`${record.store_id}|${record.ledger_period}`);
        const isClosed = ledger?.status === "closed";
        return (
          <Space size="small">
            <Button
              type="link"
              size="small"
              disabled={isClosed}
              onClick={() => openEditModal(record)}
            >
              编辑
            </Button>
            <Button
              type="link"
              size="small"
              icon={<FileTextOutlined />}
              onClick={() => openAttachmentModal(record)}
            >
              凭证
            </Button>
          </Space>
        );
      },
    },
  ];

  const attachmentColumns: ColumnsType<Attachment> = [
    {
      title: "文件名",
      dataIndex: "file_name",
      ellipsis: true,
    },
    {
      title: "来源",
      dataIndex: "source",
      width: 90,
      render: (value) => (value === "dingtalk" ? "钉钉" : "手工"),
    },
    {
      title: "状态",
      dataIndex: "download_status",
      width: 100,
      render: (value: Attachment["download_status"]) => (
        <StatusBadge
          status={value === "stored" ? "stored" : "pending"}
          text={value === "stored" ? "已上传" : "在线附件"}
        />
      ),
    },
    {
      title: "大小",
      dataIndex: "file_size",
      width: 100,
      render: (value: number | null) => (value ? `${Math.ceil(value / 1024)} KB` : "-"),
    },
    {
      title: "操作",
      width: 120,
      render: (_, record) =>
        record.download_status === "stored" ? (
          <Button
            type="link"
            size="small"
            icon={<DownloadOutlined />}
            onClick={() => downloadAttachment(record)}
          >
            下载
          </Button>
        ) : (
          <Button
            type="link"
            size="small"
            disabled={record.source !== "dingtalk"}
            onClick={() => openDingtalkAttachment(record)}
          >
            打开
          </Button>
        ),
    },
  ];

  return (
    <AppShell
      title="支出明细"
      kicker="EXPENSES"
      action={
        <Button type="primary" icon={<PlusOutlined />} onClick={openCreateModal}>
          新增支出
        </Button>
      }
    >
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }}>
        {errorMessage && (
          <Alert message="加载失败" description={errorMessage} type="error" showIcon closable />
        )}

        <SmartFilterBar
          filters={[
            {
              name: "store_id",
              label: "门店",
              type: "select",
              options: stores.map((s) => ({ label: s.name, value: s.id })),
            },
            {
              name: "ledger_period",
              label: "账期",
              type: "select",
              options: ledgerPeriodOptions,
            },
            {
              name: "payment_status",
              label: "付款状态",
              type: "select",
              options: [
                { label: "未付款", value: "unpaid" },
                { label: "部分付款", value: "partial_paid" },
                { label: "已付款", value: "paid" },
                { label: "无银行流水", value: "no_bank_flow" },
              ],
            },
          ]}
          onFilter={(values) => loadData(values)}
        />

        <EnterpriseTable
          rowKey="id"
          columns={columns}
          dataSource={items}
          loading={isLoading}
          exportFileName="支出明细"
        />
      </Space>

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
            <DatePicker style={{ width: "100%" }} />
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
        title={
          <Space>
            <FileTextOutlined />
            <span>{attachmentItem ? `${attachmentItem.description} 凭证` : "凭证"}</span>
          </Space>
        }
        open={isAttachmentModalOpen}
        onCancel={() => {
          setIsAttachmentModalOpen(false);
          setAttachmentItem(null);
          setAttachments([]);
        }}
        footer={null}
        width={760}
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          <Space>
            <Upload
              beforeUpload={() => false}
              fileList={uploadFileList}
              maxCount={1}
              onChange={({ fileList }) => setUploadFileList(fileList.slice(-1))}
            >
              <Button icon={<UploadOutlined />}>选择文件</Button>
            </Upload>
            <Button
              type="primary"
              loading={isAttachmentLoading}
              onClick={uploadAttachment}
            >
              上传凭证
            </Button>
          </Space>
          <Table
            rowKey="id"
            size="small"
            loading={isAttachmentLoading}
            columns={attachmentColumns}
            dataSource={attachments}
            pagination={{ pageSize: 5 }}
          />
        </Space>
      </Modal>
    </AppShell>
  );
}
