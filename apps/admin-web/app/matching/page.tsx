"use client";

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tabs,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import type {
  BankTransaction,
  ExpenseBankMatch,
  ExpenseItem,
  MatchCreate,
  RevenueBankMatch,
  RevenueChannel,
  RevenueMatchCreate,
  RevenueRecord,
  Store,
} from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

interface MatchingData {
  stores: Store[];
  expenseItems: ExpenseItem[];
  bankTransactions: BankTransaction[];
  incomeBankTransactions: BankTransaction[];
  matches: ExpenseBankMatch[];
  revenueRecords: RevenueRecord[];
  revenueChannels: RevenueChannel[];
  revenueMatches: RevenueBankMatch[];
}

const emptyData: MatchingData = {
  stores: [],
  expenseItems: [],
  bankTransactions: [],
  incomeBankTransactions: [],
  matches: [],
  revenueRecords: [],
  revenueChannels: [],
  revenueMatches: [],
};

interface RevenueMatchFormValues extends Omit<RevenueMatchCreate, "revenue_start_date" | "revenue_end_date"> {
  revenue_start_date?: dayjs.Dayjs;
  revenue_end_date?: dayjs.Dayjs;
}

export default function MatchingPage() {
  const [data, setData] = useState<MatchingData>(emptyData);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isRevenueModalOpen, setIsRevenueModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [form] = Form.useForm<MatchCreate>();
  const [revenueForm] = Form.useForm<RevenueMatchFormValues>();

  const storesById = useMemo(() => new Map(data.stores.map((store) => [store.id, store])), [data.stores]);
  const expenseById = useMemo(
    () => new Map(data.expenseItems.map((item) => [item.id, item])),
    [data.expenseItems],
  );
  const bankById = useMemo(
    () => new Map([...data.bankTransactions, ...data.incomeBankTransactions].map((transaction) => [transaction.id, transaction])),
    [data.bankTransactions, data.incomeBankTransactions],
  );

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [
        stores,
        expenseItems,
        bankTransactions,
        incomeBankTransactions,
        matches,
        revenueRecords,
        revenueChannels,
        revenueMatches,
      ] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.expenseItems.list("?page_size=500&payment_status=unpaid,partial_paid"),
        apiClient.bankTransactions.list("?page_size=500&direction=expense"),
        apiClient.bankTransactions.list("?page_size=500&direction=income"),
        apiClient.matches.list("?page_size=500"),
        apiClient.revenueRecords.list("?page_size=500"),
        apiClient.revenueChannels.list("?page_size=500"),
        apiClient.matches.listRevenue("?page_size=500"),
      ]);
      setData({
        stores: stores.items,
        expenseItems: expenseItems.items,
        bankTransactions: bankTransactions.items,
        incomeBankTransactions: incomeBankTransactions.items,
        matches: matches.items,
        revenueRecords: revenueRecords.items,
        revenueChannels: revenueChannels.items,
        revenueMatches: revenueMatches.items,
      });
    } catch (error) {
      setData(emptyData);
      setErrorMessage(error instanceof Error ? error.message : "无法加载匹配数据");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function createCandidate(values: MatchCreate) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.matches.create(values);
      setIsModalOpen(false);
      form.resetFields();
      setSuccessMessage("候选匹配已创建");
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法创建候选匹配");
    } finally {
      setIsLoading(false);
    }
  }

  async function autoSuggestMatches() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await apiClient.matches.autoSuggest();
      setSuccessMessage(`自动生成 ${result.created_count} 条候选匹配，跳过 ${result.skipped_count} 条已存在关系`);
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法自动生成候选匹配");
    } finally {
      setIsLoading(false);
    }
  }

  async function confirmMatch(match: ExpenseBankMatch) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.matches.confirm(match.id, "admin");
      setSuccessMessage("匹配已确认");
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法确认匹配");
    } finally {
      setIsLoading(false);
    }
  }

  async function rejectMatch(match: ExpenseBankMatch) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.matches.reject(match.id);
      setSuccessMessage("候选匹配已拒绝");
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法拒绝匹配");
    } finally {
      setIsLoading(false);
    }
  }

  async function createRevenueCandidate(values: RevenueMatchFormValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.matches.createRevenue({
        bank_transaction_id: values.bank_transaction_id,
        channel: values.channel,
        revenue_start_date: values.revenue_start_date?.format("YYYY-MM-DD") ?? dayjs().format("YYYY-MM-DD"),
        revenue_end_date: values.revenue_end_date?.format("YYYY-MM-DD") ?? dayjs().format("YYYY-MM-DD"),
        amount: values.amount,
        confidence: values.confidence,
        reason: values.reason || null,
      });
      setIsRevenueModalOpen(false);
      revenueForm.resetFields();
      setSuccessMessage("收入候选匹配已创建");
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法创建收入候选匹配");
    } finally {
      setIsLoading(false);
    }
  }

  async function confirmRevenueMatch(match: RevenueBankMatch) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.matches.confirmRevenue(match.id, "admin");
      setSuccessMessage("收入匹配已确认");
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法确认收入匹配");
    } finally {
      setIsLoading(false);
    }
  }

  async function rejectRevenueMatch(match: RevenueBankMatch) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.matches.rejectRevenue(match.id);
      setSuccessMessage("收入候选匹配已拒绝");
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法拒绝收入匹配");
    } finally {
      setIsLoading(false);
    }
  }

  const expenseColumns: ColumnsType<ExpenseItem> = [
    { title: "门店", dataIndex: "store_id", render: (value) => storesById.get(value)?.name ?? "未知门店" },
    { title: "账期", dataIndex: "ledger_period" },
    { title: "支出", dataIndex: "description" },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "已确认", render: (_, record) => formatMoney(confirmedExpenseAmount(record.id).toFixed(2)) },
    { title: "剩余", render: (_, record) => formatMoney(remainingExpenseAmount(record).toFixed(2)) },
    {
      title: "状态",
      dataIndex: "payment_status",
      render: (value: ExpenseItem["payment_status"]) =>
        value === "partial_paid" ? <Tag color="blue">部分付款</Tag> : <Tag color="gold">未付款</Tag>,
    },
    { title: "供应商", dataIndex: "supplier_name", render: (value) => value || "-" },
  ];

  const bankColumns: ColumnsType<BankTransaction> = [
    { title: "门店", dataIndex: "store_id", render: (value) => storesById.get(value)?.name ?? "未知门店" },
    { title: "账期", dataIndex: "ledger_period" },
    { title: "对方户名", dataIndex: "counterparty_name", render: (value) => value || "-" },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "已匹配", dataIndex: "matched_amount", render: (value: string) => formatMoney(value) },
    { title: "剩余", render: (_, record) => formatMoney(remainingBankAmount(record).toFixed(2)) },
  ];

  const matchColumns: ColumnsType<ExpenseBankMatch> = [
    {
      title: "支出明细",
      dataIndex: "expense_item_id",
      render: (value) => expenseById.get(value)?.description ?? value,
    },
    {
      title: "银行流水",
      dataIndex: "bank_transaction_id",
      render: (value) => bankById.get(value)?.counterparty_name ?? value,
    },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    {
      title: "状态",
      dataIndex: "status",
      render: (value: ExpenseBankMatch["status"]) => {
        if (value === "confirmed") return <Tag color="green">已确认</Tag>;
        if (value === "rejected") return <Tag>已拒绝</Tag>;
        return <Tag color="gold">候选</Tag>;
      },
    },
    { title: "原因", dataIndex: "reason", render: (value) => value || "-" },
    {
      title: "操作",
      render: (_, record) =>
        record.status === "candidate" ? (
          <Space>
            <Button type="link" onClick={() => confirmMatch(record)}>
              确认
            </Button>
            <Button type="link" danger onClick={() => rejectMatch(record)}>
              拒绝
            </Button>
          </Space>
        ) : null,
    },
  ];

  const revenueRecordColumns: ColumnsType<RevenueRecord> = [
    { title: "门店", dataIndex: "store_id", render: (value) => storesById.get(value)?.name ?? "未知门店" },
    { title: "账期", dataIndex: "ledger_period" },
    { title: "日期", dataIndex: "revenue_date" },
    { title: "渠道", dataIndex: "channel" },
    { title: "实收", dataIndex: "net_amount", render: (value: string) => formatMoney(value) },
  ];

  const revenueMatchColumns: ColumnsType<RevenueBankMatch> = [
    {
      title: "银行流水",
      dataIndex: "bank_transaction_id",
      render: (value) => bankById.get(value)?.counterparty_name ?? value,
    },
    { title: "渠道", dataIndex: "channel" },
    {
      title: "收入日期",
      render: (_, record) => `${record.revenue_start_date} 至 ${record.revenue_end_date}`,
    },
    { title: "匹配金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    {
      title: "状态",
      dataIndex: "status",
      render: (value: RevenueBankMatch["status"]) => {
        if (value === "confirmed") return <Tag color="green">已确认</Tag>;
        if (value === "rejected") return <Tag>已拒绝</Tag>;
        return <Tag color="gold">候选</Tag>;
      },
    },
    { title: "原因", dataIndex: "reason", render: (value) => value || "-" },
    {
      title: "操作",
      render: (_, record) =>
        record.status === "candidate" ? (
          <Space>
            <Button type="link" onClick={() => confirmRevenueMatch(record)}>
              确认
            </Button>
            <Button type="link" danger onClick={() => rejectRevenueMatch(record)}>
              拒绝
            </Button>
          </Space>
        ) : null,
    },
  ];

  const activeChannelOptions = data.revenueChannels
    .filter((channel) => channel.status === "active")
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map((channel) => ({ label: channel.name, value: channel.name }));

  function toAmount(value: string | number | null | undefined) {
    return Number(value ?? 0);
  }

  function confirmedExpenseAmount(expenseItemId: string) {
    return data.matches
      .filter((match) => match.expense_item_id === expenseItemId && match.status === "confirmed")
      .reduce((sum, match) => sum + toAmount(match.amount), 0);
  }

  function remainingExpenseAmount(item: ExpenseItem) {
    return Math.max(toAmount(item.amount) - confirmedExpenseAmount(item.id), 0);
  }

  function remainingBankAmount(transaction: BankTransaction) {
    return Math.max(toAmount(transaction.amount) - toAmount(transaction.matched_amount), 0);
  }

  return (
    <AppShell
      title="匹配工作台"
      action={
        <Space>
          <Button onClick={autoSuggestMatches}>自动生成候选</Button>
          <Button type="primary" onClick={() => setIsModalOpen(true)}>新增候选匹配</Button>
        </Space>
      }
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      {successMessage ? (
        <Alert className="dashboard-alert" message={successMessage} type="success" showIcon closable />
      ) : null}
      <Tabs
        items={[
          {
            key: "expense",
            label: "支出匹配",
            children: (
              <>
                <div className="matching-grid">
                  <Card title="待付款支出">
                    <Table
                      rowKey="id"
                      loading={isLoading}
                      columns={expenseColumns}
                      dataSource={data.expenseItems}
                      pagination={{ pageSize: 6 }}
                    />
                  </Card>
                  <Card title="支出流水">
                    <Table
                      rowKey="id"
                      loading={isLoading}
                      columns={bankColumns}
                      dataSource={data.bankTransactions}
                      pagination={{ pageSize: 6 }}
                    />
                  </Card>
                </div>
                <Card title="支出匹配记录" className="section-card">
                  <Table
                    rowKey="id"
                    loading={isLoading}
                    columns={matchColumns}
                    dataSource={data.matches}
                    pagination={{ pageSize: 8 }}
                  />
                </Card>
              </>
            ),
          },
          {
            key: "revenue",
            label: "收入匹配",
            children: (
              <>
                <div className="matching-grid">
                  <Card title="收入流水">
                    <Table
                      rowKey="id"
                      loading={isLoading}
                      columns={bankColumns}
                      dataSource={data.incomeBankTransactions}
                      pagination={{ pageSize: 6 }}
                    />
                  </Card>
                  <Card title="收入记录">
                    <Table
                      rowKey="id"
                      loading={isLoading}
                      columns={revenueRecordColumns}
                      dataSource={data.revenueRecords}
                      pagination={{ pageSize: 6 }}
                    />
                  </Card>
                </div>
                <Card
                  title="收入匹配记录"
                  className="section-card"
                  extra={<Button type="primary" onClick={() => setIsRevenueModalOpen(true)}>新增收入候选</Button>}
                >
                  <Table
                    rowKey="id"
                    loading={isLoading}
                    columns={revenueMatchColumns}
                    dataSource={data.revenueMatches}
                    pagination={{ pageSize: 8 }}
                  />
                </Card>
              </>
            ),
          },
        ]}
      />
      <Modal
        title="新增候选匹配"
        open={isModalOpen}
        onCancel={() => setIsModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Typography.Paragraph type="secondary">
          候选匹配不会改变付款状态，只有确认后才会更新支出明细和银行流水。
        </Typography.Paragraph>
        <Form form={form} layout="vertical" onFinish={createCandidate}>
          <Form.Item name="expense_item_id" label="支出明细" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={data.expenseItems.map((item) => ({
                label: `${item.description} / 剩余 ${formatMoney(remainingExpenseAmount(item).toFixed(2))}`,
                value: item.id,
              }))}
            />
          </Form.Item>
          <Form.Item name="bank_transaction_id" label="银行流水" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={data.bankTransactions.map((transaction) => ({
                label: `${transaction.counterparty_name ?? "未知对方"} / 剩余 ${formatMoney(remainingBankAmount(transaction).toFixed(2))}`,
                value: transaction.id,
              }))}
            />
          </Form.Item>
          <Form.Item name="amount" label="匹配金额" rules={[{ required: true }]}>
            <Input placeholder="例如 1280.00" />
          </Form.Item>
          <Form.Item name="reason" label="匹配原因">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="新增收入候选匹配"
        open={isRevenueModalOpen}
        onCancel={() => setIsRevenueModalOpen(false)}
        onOk={() => revenueForm.submit()}
        confirmLoading={isLoading}
      >
        <Typography.Paragraph type="secondary">
          收入匹配使用所选渠道日期范围内的实收金额合计，确认后会更新银行流水已匹配金额。
        </Typography.Paragraph>
        <Form form={revenueForm} layout="vertical" onFinish={createRevenueCandidate}>
          <Form.Item name="bank_transaction_id" label="收入流水" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={data.incomeBankTransactions.map((transaction) => ({
                label: `${transaction.counterparty_name ?? "未知对方"} / ${formatMoney(transaction.amount)}`,
                value: transaction.id,
              }))}
            />
          </Form.Item>
          <Form.Item name="channel" label="收入渠道" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label" options={activeChannelOptions} />
          </Form.Item>
          <Form.Item name="revenue_start_date" label="收入开始日期" rules={[{ required: true }]}>
            <DatePicker className="full-width" />
          </Form.Item>
          <Form.Item name="revenue_end_date" label="收入结束日期" rules={[{ required: true }]}>
            <DatePicker className="full-width" />
          </Form.Item>
          <Form.Item name="amount" label="匹配金额" rules={[{ required: true }]}>
            <Input placeholder="例如 970.00" />
          </Form.Item>
          <Form.Item name="reason" label="匹配原因">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
