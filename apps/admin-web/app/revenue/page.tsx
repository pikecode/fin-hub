"use client";

import { Alert, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Table, Tag, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import type { BankTransaction, Ledger, RevenueBankMatch, RevenueChannel, RevenueRecord, RevenueRecordCreate, Store } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { StoreLedgerWorkspaceNav } from "../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../lib/api";
import { useClientSearchParams } from "../lib/searchParams";

interface RevenueFormValues extends Omit<RevenueRecordCreate, "revenue_date" | "ledger_period"> {
  revenue_date?: dayjs.Dayjs;
}

interface RevenueFilterValues {
  store_id?: string;
  ledger_period?: string;
  channel?: string;
}

export default function RevenuePage() {
  const searchParams = useClientSearchParams();
  const queryStoreId = searchParams.get("store_id") ?? undefined;
  const queryLedgerPeriod = searchParams.get("ledger_period") ?? undefined;
  const queryChannel = searchParams.get("channel") ?? undefined;
  const initialFilters = useMemo<RevenueFilterValues>(
    () => ({
      store_id: queryStoreId,
      ledger_period: queryLedgerPeriod,
      channel: queryChannel,
    }),
    [queryChannel, queryLedgerPeriod, queryStoreId],
  );
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [channels, setChannels] = useState<RevenueChannel[]>([]);
  const [records, setRecords] = useState<RevenueRecord[]>([]);
  const [revenueMatches, setRevenueMatches] = useState<RevenueBankMatch[]>([]);
  const [incomeBankTransactions, setIncomeBankTransactions] = useState<BankTransaction[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isMatchModalOpen, setIsMatchModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<RevenueRecord | null>(null);
  const [matchingRecord, setMatchingRecord] = useState<RevenueRecord | null>(null);
  const [selectedBankTransactionId, setSelectedBankTransactionId] = useState<string>();
  const [isMatching, setIsMatching] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<RevenueFormValues>();
  const [filterForm] = Form.useForm<RevenueFilterValues>();
  const watchedGrossAmount = Form.useWatch("gross_amount", form);
  const watchedNetAmount = Form.useWatch("net_amount", form);

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const ledgersByKey = useMemo(
    () => new Map(ledgers.map((ledger) => [`${ledger.store_id}|${ledger.period}`, ledger])),
    [ledgers],
  );
  const ledgerPeriodOptions = Array.from(new Set(ledgers.map((ledger) => ledger.period)))
    .sort()
    .reverse()
    .map((period) => ({ label: period, value: period }));
  const currentStore = queryStoreId ? storesById.get(queryStoreId) : undefined;
  const channelOptions = channels
    .filter((channel) => channel.status === "active")
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map((channel) => ({ label: channel.name, value: channel.name }));
  const filterChannelOptions = Array.from(new Set([...channels.map((channel) => channel.name), ...records.map((record) => record.channel)]))
    .sort()
    .map((channel) => ({ label: channel, value: channel }));

  function calculateFee(grossAmount?: string | number | null, netAmount?: string | number | null) {
    const gross = Number(grossAmount ?? 0);
    const net = Number(netAmount ?? 0);
    if (!Number.isFinite(gross) || !Number.isFinite(net)) return "0.00";
    return Math.max(gross - net, 0).toFixed(2);
  }

  function calculateFeeRate(grossAmount?: string | number | null, feeAmount?: string | number | null) {
    const gross = Number(grossAmount ?? 0);
    const fee = Number(feeAmount ?? 0);
    if (!Number.isFinite(gross) || gross <= 0 || !Number.isFinite(fee)) return "0.00%";
    return `${((fee / gross) * 100).toFixed(2)}%`;
  }

  function buildFilterParams(values?: RevenueFilterValues) {
    const params = new URLSearchParams({ page_size: "500" });
    if (values?.store_id) params.set("store_id", values.store_id);
    if (values?.ledger_period) params.set("ledger_period", values.ledger_period);
    if (values?.channel) params.set("channel", values.channel);
    return `?${params.toString()}`;
  }

  function buildRevenueMatchParams(values?: RevenueFilterValues) {
    const params = new URLSearchParams({ page_size: "500" });
    if (values?.store_id) params.set("store_id", values.store_id);
    if (values?.ledger_period) params.set("ledger_period", values.ledger_period);
    return `?${params.toString()}`;
  }

  function buildIncomeBankParams(record: RevenueRecord) {
    const params = new URLSearchParams({
      page_size: "500",
      direction: "income",
      store_id: record.store_id,
      ledger_period: record.ledger_period,
    });
    return `?${params.toString()}`;
  }

  async function loadData(filters?: RevenueFilterValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const activeFilters = filters ?? filterForm.getFieldsValue();
      const [storePage, ledgerPage, channelPage, recordPage, matchPage] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.ledgers.list("?page_size=200"),
        apiClient.revenueChannels.list("?page_size=500"),
        apiClient.revenueRecords.list(buildFilterParams(activeFilters)),
        apiClient.matches.listRevenue(buildRevenueMatchParams(activeFilters)),
      ]);
      setStores(storePage.items);
      setLedgers(ledgerPage.items);
      setChannels(channelPage.items);
      setRecords(recordPage.items);
      setRevenueMatches(matchPage.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载营业收入");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    filterForm.setFieldsValue(initialFilters);
    loadData(initialFilters);
  }, [filterForm, initialFilters]);

  useEffect(() => {
    if (!isModalOpen) return;
    form.setFieldValue("fee_amount", calculateFee(watchedGrossAmount, watchedNetAmount));
  }, [form, isModalOpen, watchedGrossAmount, watchedNetAmount]);

  function openCreateModal() {
    const filters = filterForm.getFieldsValue();
    setEditingRecord(null);
    form.resetFields();
    form.setFieldsValue({
      store_id: filters.store_id,
      revenue_date: filters.ledger_period ? dayjs(`${filters.ledger_period}-01`) : dayjs(),
      channel: channelOptions[0]?.value,
      gross_amount: "0.00",
      net_amount: "0.00",
      fee_amount: "0.00",
    });
    setIsModalOpen(true);
  }

  function openEditModal(record: RevenueRecord) {
    setEditingRecord(record);
    form.setFieldsValue({
      store_id: record.store_id,
      revenue_date: dayjs(record.revenue_date),
      channel: record.channel,
      gross_amount: record.gross_amount,
      net_amount: record.net_amount,
      fee_amount: record.fee_amount,
      remark: record.remark,
    });
    setIsModalOpen(true);
  }

  async function submitRecord(values: RevenueFormValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const payload = {
        store_id: values.store_id,
        revenue_date: values.revenue_date?.format("YYYY-MM-DD") ?? dayjs().format("YYYY-MM-DD"),
        channel: values.channel,
        gross_amount: values.gross_amount,
        net_amount: values.net_amount,
        fee_amount: values.fee_amount ?? "0.00",
        remark: values.remark || null,
      };
      if (editingRecord) {
        await apiClient.revenueRecords.update(editingRecord.id, payload);
      } else {
        await apiClient.revenueRecords.create(payload);
      }
      setIsModalOpen(false);
      setEditingRecord(null);
      form.resetFields();
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存营业收入");
    } finally {
      setIsLoading(false);
    }
  }

  async function submitFilters(values: RevenueFilterValues) {
    await loadData(values);
  }

  async function resetFilters() {
    filterForm.resetFields();
    await loadData({});
  }

  function remainingAmount(transaction: BankTransaction) {
    const remaining = Number(transaction.amount) - Number(transaction.matched_amount || 0);
    return Number.isFinite(remaining) ? remaining : 0;
  }

  function isRevenueRecordMatched(record: RevenueRecord) {
    const currentFilters = filterForm.getFieldsValue();
    if (currentFilters.store_id !== record.store_id || currentFilters.ledger_period !== record.ledger_period) return false;
    return revenueMatches.some(
      (match) =>
        match.status !== "rejected" &&
        match.channel === record.channel &&
        match.revenue_start_date <= record.revenue_date &&
        match.revenue_end_date >= record.revenue_date,
    );
  }

  async function openMatchModal(record: RevenueRecord) {
    setIsMatching(true);
    setErrorMessage(null);
    setMatchingRecord(record);
    setSelectedBankTransactionId(undefined);
    setIsMatchModalOpen(true);
    try {
      const bankPage = await apiClient.bankTransactions.list(buildIncomeBankParams(record));
      setIncomeBankTransactions(
        bankPage.items.filter((transaction) => transaction.direction === "income" && remainingAmount(transaction) >= Number(record.net_amount)),
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载收入流水");
    } finally {
      setIsMatching(false);
    }
  }

  async function submitRevenueMatch() {
    if (!matchingRecord || !selectedBankTransactionId) return;
    setIsMatching(true);
    setErrorMessage(null);
    try {
      const match = await apiClient.matches.createRevenue({
        bank_transaction_id: selectedBankTransactionId,
        channel: matchingRecord.channel,
        revenue_start_date: matchingRecord.revenue_date,
        revenue_end_date: matchingRecord.revenue_date,
        amount: matchingRecord.net_amount,
        confidence: "100.00",
        reason: "营业收入日记录手动关联银行流水",
      });
      await apiClient.matches.confirmRevenue(match.id, "admin");
      message.success("已关联银行流水");
      setIsMatchModalOpen(false);
      setMatchingRecord(null);
      setSelectedBankTransactionId(undefined);
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法关联银行流水");
    } finally {
      setIsMatching(false);
    }
  }

  const columns: ColumnsType<RevenueRecord> = [
    { title: "门店", dataIndex: "store_id", render: (value) => storesById.get(value)?.name ?? "未知门店" },
    { title: "账期", dataIndex: "ledger_period" },
    { title: "日期", dataIndex: "revenue_date" },
    { title: "渠道", dataIndex: "channel" },
    { title: "经营收入", dataIndex: "gross_amount", render: (value: string) => formatMoney(value) },
    { title: "实收金额", dataIndex: "net_amount", render: (value: string) => formatMoney(value) },
    { title: "手续费", dataIndex: "fee_amount", render: (value: string) => formatMoney(value) },
    { title: "费率", render: (_, record) => calculateFeeRate(record.gross_amount, record.fee_amount) },
    {
      title: "对账状态",
      width: 110,
      render: (_, record) => (isRevenueRecordMatched(record) ? <Tag color="green">已关联</Tag> : <Tag>待关联</Tag>),
    },
    { title: "备注", dataIndex: "remark", render: (value) => value || "-" },
    {
      title: "操作",
      width: 180,
      render: (_, record) => {
        const ledger = ledgersByKey.get(`${record.store_id}|${record.ledger_period}`);
        return (
          <Space>
            <Button type="link" disabled={ledger?.status === "closed"} onClick={() => openEditModal(record)}>
              编辑
            </Button>
            <Button type="link" disabled={ledger?.status === "closed" || isRevenueRecordMatched(record)} onClick={() => openMatchModal(record)}>
              关联流水
            </Button>
          </Space>
        );
      },
    },
  ];

  return (
    <AppShell title="营业收入" action={<Button type="primary" onClick={openCreateModal}>新增收入</Button>}>
      {queryStoreId ? (
        <StoreLedgerWorkspaceNav
          storeId={queryStoreId}
          storeName={currentStore?.name}
          period={queryLedgerPeriod}
          periodOptions={ledgerPeriodOptions}
          statusLabel={currentStore?.status === "active" ? "启用门店" : currentStore ? "停用门店" : undefined}
          activeKey="revenue"
        />
      ) : null}
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="收入记录">
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
          <Form.Item name="channel" label="渠道">
            <Select allowClear showSearch className="filter-select" options={filterChannelOptions} />
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
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={records} />
      </Card>

      <Modal
        title={editingRecord ? "编辑收入" : "新增收入"}
        open={isModalOpen}
        onCancel={() => {
          setIsModalOpen(false);
          setEditingRecord(null);
        }}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
      >
        <Form form={form} layout="vertical" onFinish={submitRecord}>
          <Form.Item name="store_id" label="门店" rules={[{ required: true }]}>
            <Select
              showSearch
              optionFilterProp="label"
              options={stores.map((store) => ({ label: store.name, value: store.id }))}
            />
          </Form.Item>
          <Form.Item
            name="revenue_date"
            label="收入日期"
            extra="系统会按收入日期自动归属账期，例：2026-08-20 归入 2026-08。"
            rules={[{ required: true, message: "请选择收入日期" }]}
          >
            <DatePicker className="full-width" />
          </Form.Item>
          <Form.Item name="channel" label="收入渠道" rules={[{ required: true }]}>
            <Select showSearch options={channelOptions} />
          </Form.Item>
          <Form.Item name="gross_amount" label="经营收入" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="net_amount" label="实收金额" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="fee_amount" label="手续费">
            <Input readOnly />
          </Form.Item>
          <Form.Item noStyle shouldUpdate>
            {() => (
              <Alert
                type="info"
                showIcon
                message={`费率 ${calculateFeeRate(form.getFieldValue("gross_amount"), form.getFieldValue("fee_amount"))}`}
                className="dashboard-alert"
              />
            )}
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="关联收入流水"
        open={isMatchModalOpen}
        onCancel={() => {
          setIsMatchModalOpen(false);
          setMatchingRecord(null);
          setSelectedBankTransactionId(undefined);
        }}
        onOk={submitRevenueMatch}
        confirmLoading={isMatching}
        okButtonProps={{ disabled: !selectedBankTransactionId }}
        okText="确认关联"
        width={760}
      >
        {matchingRecord ? (
          <Space direction="vertical" className="full-width" size="middle">
            <Alert
              type="info"
              showIcon
              message={`${storesById.get(matchingRecord.store_id)?.name ?? "未知门店"} / ${matchingRecord.ledger_period} / ${matchingRecord.revenue_date} / ${matchingRecord.channel}`}
              description={`实收金额 ${formatMoney(matchingRecord.net_amount)}，请选择一条收入方向银行流水进行关联。`}
            />
            <Table
              rowKey="id"
              loading={isMatching}
              rowSelection={{
                type: "radio",
                selectedRowKeys: selectedBankTransactionId ? [selectedBankTransactionId] : [],
                onChange: (keys) => setSelectedBankTransactionId(String(keys[0])),
              }}
              columns={[
                { title: "发生时间", dataIndex: "occurred_at", render: (value: string) => value.replace("T", " ").slice(0, 16) },
                { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
                { title: "已匹配", dataIndex: "matched_amount", render: (value: string) => formatMoney(value) },
                { title: "剩余", render: (_, transaction) => formatMoney(remainingAmount(transaction).toFixed(2)) },
                { title: "对方户名", dataIndex: "counterparty_name", render: (value: string | null) => value || "-" },
                { title: "摘要", dataIndex: "summary", ellipsis: true, render: (value: string | null) => value || "-" },
              ]}
              dataSource={incomeBankTransactions}
              pagination={{ pageSize: 5 }}
            />
          </Space>
        ) : null}
      </Modal>
    </AppShell>
  );
}
