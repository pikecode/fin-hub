"use client";

import { Alert, Button, Card, DatePicker, Form, Input, Modal, Select, Space, Table } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import type { Ledger, RevenueChannel, RevenueRecord, RevenueRecordCreate, Store } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

interface RevenueFormValues extends Omit<RevenueRecordCreate, "revenue_date" | "ledger_period"> {
  revenue_date?: dayjs.Dayjs;
}

interface RevenueFilterValues {
  store_id?: string;
  ledger_period?: string;
  channel?: string;
}

export default function RevenuePage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [channels, setChannels] = useState<RevenueChannel[]>([]);
  const [records, setRecords] = useState<RevenueRecord[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<RevenueRecord | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<RevenueFormValues>();
  const [filterForm] = Form.useForm<RevenueFilterValues>();

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const ledgersByKey = useMemo(
    () => new Map(ledgers.map((ledger) => [`${ledger.store_id}|${ledger.period}`, ledger])),
    [ledgers],
  );
  const ledgerPeriodOptions = Array.from(new Set(ledgers.map((ledger) => ledger.period)))
    .sort()
    .reverse()
    .map((period) => ({ label: period, value: period }));
  const channelOptions = channels
    .filter((channel) => channel.status === "active")
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name))
    .map((channel) => ({ label: channel.name, value: channel.name }));
  const filterChannelOptions = Array.from(new Set([...channels.map((channel) => channel.name), ...records.map((record) => record.channel)]))
    .sort()
    .map((channel) => ({ label: channel, value: channel }));

  function buildFilterParams(values?: RevenueFilterValues) {
    const params = new URLSearchParams({ page_size: "500" });
    if (values?.store_id) params.set("store_id", values.store_id);
    if (values?.ledger_period) params.set("ledger_period", values.ledger_period);
    if (values?.channel) params.set("channel", values.channel);
    return `?${params.toString()}`;
  }

  async function loadData(filters?: RevenueFilterValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [storePage, ledgerPage, channelPage, recordPage] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.ledgers.list("?page_size=200"),
        apiClient.revenueChannels.list("?page_size=500"),
        apiClient.revenueRecords.list(buildFilterParams(filters ?? filterForm.getFieldsValue())),
      ]);
      setStores(storePage.items);
      setLedgers(ledgerPage.items);
      setChannels(channelPage.items);
      setRecords(recordPage.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载营业收入");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  function openCreateModal() {
    setEditingRecord(null);
    form.resetFields();
    form.setFieldsValue({
      revenue_date: dayjs(),
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

  const columns: ColumnsType<RevenueRecord> = [
    { title: "门店", dataIndex: "store_id", render: (value) => storesById.get(value)?.name ?? "未知门店" },
    { title: "账期", dataIndex: "ledger_period" },
    { title: "日期", dataIndex: "revenue_date" },
    { title: "渠道", dataIndex: "channel" },
    { title: "经营收入", dataIndex: "gross_amount", render: (value: string) => formatMoney(value) },
    { title: "实收金额", dataIndex: "net_amount", render: (value: string) => formatMoney(value) },
    { title: "手续费", dataIndex: "fee_amount", render: (value: string) => formatMoney(value) },
    { title: "备注", dataIndex: "remark", render: (value) => value || "-" },
    {
      title: "操作",
      width: 110,
      render: (_, record) => {
        const ledger = ledgersByKey.get(`${record.store_id}|${record.ledger_period}`);
        return (
          <Button type="link" disabled={ledger?.status === "closed"} onClick={() => openEditModal(record)}>
            编辑
          </Button>
        );
      },
    },
  ];

  return (
    <AppShell title="营业收入" action={<Button type="primary" onClick={openCreateModal}>新增收入</Button>}>
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
            <Input />
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
