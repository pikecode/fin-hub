"use client";

import { Alert, Button, Card, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Table, Typography, message } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Ledger, RevenueChannel, RevenueRecord, RevenueRecordCreate, Store } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { MoneyDisplay } from "../components/MoneyDisplay";
import { StoreLedgerWorkspaceNav } from "../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../lib/api";
import { getLedgers, getRevenueChannels, getStores } from "../lib/referenceData";
import { useClientSearchParams } from "../lib/searchParams";
import { PlusOutlined, ImportOutlined } from "@ant-design/icons";

interface RevenueFormValues extends Omit<RevenueRecordCreate, "revenue_date" | "ledger_period"> {
  revenue_date?: dayjs.Dayjs;
}

interface RevenueFilterValues {
  store_id?: string;
  ledger_period?: string;
  channel?: string;
}

type RevenueEntryField = "revenue_date" | "gross_amount" | "net_amount" | "remark";

interface RevenueEntryRow {
  key: string;
  revenue_date: string;
  gross_amount: string;
  net_amount: string;
  remark: string;
}

const revenueEntryFields: RevenueEntryField[] = ["revenue_date", "gross_amount", "net_amount", "remark"];
const revenueEntryHeaders: Record<RevenueEntryField, string> = {
  revenue_date: "日期",
  gross_amount: "经营收入",
  net_amount: "实收金额",
  remark: "备注",
};

function createRevenueEntryRows(period: string) {
  const month = dayjs(`${period}-01`);
  const days = month.isValid() ? month.daysInMonth() : dayjs().daysInMonth();
  const base = month.isValid() ? month : dayjs().startOf("month");
  return Array.from({ length: days }, (_, index) => ({
    key: `revenue-entry-${base.format("YYYY-MM")}-${index + 1}`,
    revenue_date: base.date(index + 1).format("YYYY-MM-DD"),
    gross_amount: "",
    net_amount: "",
    remark: "",
  }));
}

function isRevenueEntryRowEmpty(row: RevenueEntryRow) {
  return !row.gross_amount.trim() && !row.net_amount.trim();
}

function parseRevenueEntryRows(text: string) {
  const rows = text
    .split(/\r?\n/)
    .map((row) => row.trimEnd())
    .filter((row) => row.trim());
  if (!rows.length) return [];
  const headerWords = Object.values(revenueEntryHeaders).concat(["收入日期", "收入", "金额"]);
  const firstCells = rows[0].split("\t").map((cell) => cell.trim());
  const hasHeader = firstCells.some((cell) => headerWords.includes(cell));
  return (hasHeader ? rows.slice(1) : rows).map((row) => row.split("\t"));
}

function parseEntryDate(value: string) {
  if (!value.trim()) return null;
  const parsed = dayjs(value);
  return parsed.isValid() ? parsed : null;
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
  const [isLoading, setIsLoading] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isImportModalOpen, setIsImportModalOpen] = useState(false);
  const [editingRecord, setEditingRecord] = useState<RevenueRecord | null>(null);
  const [entryRows, setEntryRows] = useState<RevenueEntryRow[]>(() => createRevenueEntryRows(queryLedgerPeriod ?? dayjs().format("YYYY-MM")));
  const [focusedEntryCell, setFocusedEntryCell] = useState<{ rowIndex: number; field: RevenueEntryField }>({ rowIndex: 0, field: "gross_amount" });
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<RevenueFormValues>();
  const [importForm] = Form.useForm<{ store_id?: string; ledger_period?: dayjs.Dayjs; channel?: string }>();
  const [filterForm] = Form.useForm<RevenueFilterValues>();
  const loadRequestIdRef = useRef(0);
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
  const currentStoreLedgerLabel = queryStoreId
    ? `${currentStore?.name ?? "当前门店"}${queryLedgerPeriod ? ` / ${queryLedgerPeriod}` : ""}`
    : "";
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

  useEffect(() => {
    void (async () => {
      const [storesRes, ledgersRes, channelsRes] = await Promise.all([
        getStores(),
        getLedgers(),
        getRevenueChannels(),
      ]);
      setStores(storesRes);
      setLedgers(ledgersRes);
      setChannels(channelsRes);
    })();
  }, []);

  useEffect(() => {
    void loadRecords(initialFilters);
  }, [initialFilters]);

  useEffect(() => {
    if (watchedGrossAmount || watchedNetAmount) {
      const feeAmount = calculateFee(watchedGrossAmount, watchedNetAmount);
      form.setFieldValue("fee_amount", feeAmount);
    }
  }, [watchedGrossAmount, watchedNetAmount, form]);

  async function loadRecords(filters: RevenueFilterValues) {
    const requestId = ++loadRequestIdRef.current;
    setIsLoading(true);
    setErrorMessage(null);
    filterForm.setFieldsValue(filters);
    try {
      const recordsRes = await apiClient.revenueRecords.list(buildFilterParams(filters));
      if (requestId === loadRequestIdRef.current) {
        setRecords(recordsRes.items);
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

  function openCreateModal() {
    setEditingRecord(null);
    form.resetFields();
    if (queryStoreId) form.setFieldValue("store_id", queryStoreId);
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
      remark: record.remark ?? undefined,
    });
    setIsModalOpen(true);
  }

  async function submitRecord(values: RevenueFormValues) {
    if (!values.revenue_date) {
      message.warning("请选择收入日期");
      return;
    }
    setIsLoading(true);
    try {
      const payload: RevenueRecordCreate = {
        store_id: queryStoreId ?? values.store_id!,
        revenue_date: values.revenue_date.format("YYYY-MM-DD"),
        ledger_period: values.revenue_date.format("YYYY-MM"),
        channel: values.channel!,
        gross_amount: values.gross_amount!,
        net_amount: values.net_amount!,
        fee_amount: values.fee_amount!,
        remark: values.remark ?? null,
      };
      if (editingRecord) {
        await apiClient.revenueRecords.update(editingRecord.id, payload);
        message.success("更新成功");
      } else {
        await apiClient.revenueRecords.create(payload);
        message.success("创建成功");
      }
      setIsModalOpen(false);
      setEditingRecord(null);
      await loadRecords(filterForm.getFieldsValue());
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function deleteRecord(record: RevenueRecord) {
    setIsLoading(true);
    try {
      await apiClient.revenueRecords.delete(record.id);
      message.success("删除成功");
      await loadRecords(filterForm.getFieldsValue());
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除失败");
    } finally {
      setIsLoading(false);
    }
  }

  function openImportModal() {
    importForm.resetFields();
    if (queryStoreId) importForm.setFieldValue("store_id", queryStoreId);
    if (queryLedgerPeriod) importForm.setFieldValue("ledger_period", dayjs(`${queryLedgerPeriod}-01`));
    setEntryRows(createRevenueEntryRows(queryLedgerPeriod ?? dayjs().format("YYYY-MM")));
    setIsImportModalOpen(true);
  }

  async function submitImport(values: { store_id?: string; ledger_period?: dayjs.Dayjs; channel?: string }) {
    if (!values.store_id || !values.ledger_period || !values.channel) {
      message.warning("请填写门店、账期和收入渠道");
      return;
    }
    const nonEmptyRows = entryRows.filter((row) => !isRevenueEntryRowEmpty(row));
    if (!nonEmptyRows.length) {
      message.warning("请至少填写一行收入记录");
      return;
    }
    setIsLoading(true);
    try {
      const period = values.ledger_period.format("YYYY-MM");
      let createdCount = 0;
      const failedRows: string[] = [];
      for (const row of nonEmptyRows) {
        try {
          await apiClient.revenueRecords.create({
            store_id: values.store_id!,
            ledger_period: period,
            revenue_date: row.revenue_date,
            channel: values.channel!,
            gross_amount: row.gross_amount || "0",
            net_amount: row.net_amount || row.gross_amount || "0",
            fee_amount: calculateFee(row.gross_amount, row.net_amount || row.gross_amount),
            remark: row.remark || null,
          });
          createdCount += 1;
        } catch (error) {
          failedRows.push(`${row.revenue_date}：${error instanceof Error ? error.message : "保存失败"}`);
        }
      }
      if (createdCount) message.success(`成功录入 ${createdCount} 条记录`);
      if (failedRows.length) {
        setErrorMessage(`部分收入未录入：${failedRows.slice(0, 5).join("；")}`);
        await loadRecords(filterForm.getFieldsValue());
        return;
      }
      setIsImportModalOpen(false);
      await loadRecords(filterForm.getFieldsValue());
    } catch (error) {
      message.error(error instanceof Error ? error.message : "导入失败");
    } finally {
      setIsLoading(false);
    }
  }

  async function pasteRevenueFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      const parsedRows = parseRevenueEntryRows(text);
      if (!parsedRows.length) {
        message.warning("剪贴板中没有有效数据");
        return;
      }
      const updatedRows = [...entryRows];
      parsedRows.forEach((cells, index) => {
        if (index >= updatedRows.length) return;
        const [dateValue, grossValue, netValue, remarkValue] = cells;
        const parsedDate = parseEntryDate(dateValue);
        if (parsedDate) updatedRows[index].revenue_date = parsedDate.format("YYYY-MM-DD");
        if (grossValue?.trim()) updatedRows[index].gross_amount = grossValue.trim();
        if (netValue?.trim()) updatedRows[index].net_amount = netValue.trim();
        if (remarkValue?.trim()) updatedRows[index].remark = remarkValue.trim();
      });
      setEntryRows(updatedRows);
      message.success(`已粘贴 ${Math.min(parsedRows.length, updatedRows.length)} 行数据`);
    } catch (error) {
      message.error("无法读取剪贴板");
    }
  }

  function fillRevenuePasteExample() {
    const exampleRows = [...entryRows];
    [0, 1, 2].forEach((index) => {
      exampleRows[index].gross_amount = String((Math.random() * 5000 + 1000).toFixed(2));
      exampleRows[index].net_amount = String((Number(exampleRows[index].gross_amount) * 0.994).toFixed(2));
      exampleRows[index].remark = index === 0 ? "示例备注" : "";
    });
    setEntryRows(exampleRows);
    message.info("已填入示例数据");
  }

  const entryColumns: ColumnsType<RevenueEntryRow> = revenueEntryFields.map((field) => ({
    title: revenueEntryHeaders[field],
    dataIndex: field,
    width: field === "revenue_date" ? 110 : field === "remark" ? 180 : 120,
    render: (value: string, _, index: number) => (
      <Input
        value={value}
        size="small"
        onChange={(event) => {
          const updated = [...entryRows];
          updated[index][field] = event.target.value;
          setEntryRows(updated);
        }}
        onFocus={() => setFocusedEntryCell({ rowIndex: index, field })}
        style={{ border: focusedEntryCell.rowIndex === index && focusedEntryCell.field === field ? "1px solid var(--primary-500)" : undefined }}
      />
    ),
  }));

  const columns: ColumnsType<RevenueRecord> = [
    {
      title: "日期",
      dataIndex: "revenue_date",
      width: 110,
      sorter: (a, b) => a.revenue_date.localeCompare(b.revenue_date),
    },
    {
      title: "渠道",
      dataIndex: "channel",
      width: 120,
      ellipsis: true,
    },
    {
      title: "经营收入",
      dataIndex: "gross_amount",
      width: 120,
      align: "right",
      render: (value) => <MoneyDisplay value={Number(value)} />,
      sorter: (a, b) => Number(a.gross_amount) - Number(b.gross_amount),
    },
    {
      title: "实收金额",
      dataIndex: "net_amount",
      width: 120,
      align: "right",
      render: (value) => <MoneyDisplay value={Number(value)} colorize />,
      sorter: (a, b) => Number(a.net_amount) - Number(b.net_amount),
    },
    {
      title: "手续费",
      dataIndex: "fee_amount",
      width: 100,
      align: "right",
      render: (value) => <MoneyDisplay value={Number(value)} />,
    },
    {
      title: "费率",
      width: 80,
      align: "right",
      render: (_, record) => calculateFeeRate(record.gross_amount, record.fee_amount),
    },
    {
      title: "备注",
      dataIndex: "remark",
      ellipsis: true,
      render: (value) => value || "-",
    },
    {
      title: "操作",
      width: 140,
      fixed: "right",
      render: (_, record) => (
        <Space size="small">
          <Button type="link" size="small" onClick={() => openEditModal(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除营业收入？"
            description="删除前会检查这条收入是否已经做过收入对账。"
            okText="删除"
            cancelText="取消"
            okButtonProps={{ danger: true }}
            onConfirm={() => deleteRecord(record)}
          >
            <Button type="link" size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <AppShell title="营业收入">
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }} className="maintenance-page">
        {queryStoreId && queryLedgerPeriod && (
          <StoreLedgerWorkspaceNav
            storeId={queryStoreId}
            storeName={currentStore?.name}
            period={queryLedgerPeriod}
            periodOptions={ledgerPeriodOptions}
            statusLabel={currentStore?.status === "active" ? "启用门店" : currentStore ? "停用门店" : undefined}
            ledgerStatusLabel={ledgersByKey.get(`${queryStoreId}|${queryLedgerPeriod}`)?.status === "closed" ? "已封账" : "进行中"}
            activeKey="revenue"
          />
        )}

        {errorMessage && <Alert type="error" message="加载失败" description={errorMessage} showIcon closable />}

        <Card
          title="营业收入列表"
          className="data-table-card maintenance-table-card"
          extra={
            <Space>
              <Button icon={<ImportOutlined />} onClick={openImportModal}>
                批量录入
              </Button>
              <Button icon={<PlusOutlined />} type="primary" onClick={openCreateModal}>
                新增收入
              </Button>
            </Space>
          }
        >
          {queryStoreId ? null : (
            <Form form={filterForm} layout="inline" onFinish={(values) => loadRecords(values)} className="table-filter-form">
              <Form.Item name="store_id" label="门店">
                <Select allowClear className="filter-select" options={stores.map((store) => ({ label: store.name, value: store.id }))} />
              </Form.Item>
              <Form.Item name="ledger_period" label="账期">
                <Select allowClear className="filter-select" options={ledgerPeriodOptions} />
              </Form.Item>
              <Form.Item name="channel" label="渠道">
                <Select allowClear showSearch className="filter-select" options={filterChannelOptions} />
              </Form.Item>
              <Form.Item>
                <Button type="primary" htmlType="submit" loading={isLoading}>筛选</Button>
              </Form.Item>
            </Form>
          )}
          <Table
            rowKey="id"
            columns={columns}
            dataSource={records}
            loading={isLoading}
            size="middle"
            pagination={{ pageSize: 12, showSizeChanger: true }}
            scroll={{ x: 1120 }}
            sticky
          />
        </Card>
      </Space>

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
          {queryStoreId ? (
            <Alert type="info" showIcon message={`收入归属：${currentStoreLedgerLabel}`} style={{ marginBottom: 16 }} />
          ) : (
            <Form.Item name="store_id" label="门店" rules={[{ required: true }]}>
              <Select
                showSearch
                optionFilterProp="label"
                options={stores.map((store) => ({ label: store.name, value: store.id }))}
              />
            </Form.Item>
          )}
          <Form.Item
            name="revenue_date"
            label="收入日期"
            extra="系统会按收入日期自动归属账期，例：2026-08-20 归入 2026-08。"
            rules={[{ required: true, message: "请选择收入日期" }]}
          >
            <DatePicker style={{ width: "100%" }} />
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
                style={{ marginBottom: 16 }}
              />
            )}
          </Form.Item>
          <Form.Item name="remark" label="备注">
            <Input />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="导入/录入营业收入"
        open={isImportModalOpen}
        destroyOnClose
        onCancel={() => {
          setIsImportModalOpen(false);
          importForm.resetFields();
        }}
        onOk={() => importForm.submit()}
        confirmLoading={isLoading}
        width={900}
        okText="确认录入"
      >
        <Form form={importForm} layout="vertical" onFinish={submitImport}>
          {queryStoreId ? (
            <Alert type="info" showIcon message={`收入归属：${currentStoreLedgerLabel}`} style={{ marginBottom: 16 }} />
          ) : (
            <Space style={{ width: "100%" }} size={12} align="start">
              <Form.Item name="store_id" label="门店" rules={[{ required: true, message: "请选择门店" }]} style={{ flex: 1 }}>
                <Select
                  showSearch
                  optionFilterProp="label"
                  options={stores.map((store) => ({ label: store.name, value: store.id }))}
                />
              </Form.Item>
              <Form.Item name="ledger_period" label="账期" rules={[{ required: true, message: "请选择账期" }]} style={{ width: 180 }}>
                <DatePicker
                  picker="month"
                  style={{ width: "100%" }}
                  onChange={(value) => {
                    if (value) setEntryRows(createRevenueEntryRows(value.format("YYYY-MM")));
                  }}
                />
              </Form.Item>
            </Space>
          )}
          <Form.Item name="channel" label="收入渠道" rules={[{ required: true, message: "请选择收入渠道" }]}>
            <Select showSearch options={channelOptions} />
          </Form.Item>
          <Space direction="vertical" style={{ width: "100%" }} size={12}>
            <Space wrap>
              <Button onClick={pasteRevenueFromClipboard}>读取剪贴板</Button>
              <Button onClick={fillRevenuePasteExample}>填入示例</Button>
              <Button
                onClick={() => {
                  const period = queryLedgerPeriod ?? importForm.getFieldValue("ledger_period")?.format("YYYY-MM") ?? dayjs().format("YYYY-MM");
                  setEntryRows(createRevenueEntryRows(period));
                }}
              >
                清空
              </Button>
            </Space>
            <Table
              rowKey="key"
              size="small"
              pagination={false}
              dataSource={entryRows}
              columns={entryColumns}
              scroll={{ x: 820, y: 420 }}
            />
            <Typography.Text type="secondary">按当前账期生成每日收入行，可以从 Excel 复制整块数据后粘贴到表格。</Typography.Text>
          </Space>
        </Form>
      </Modal>
    </AppShell>
  );
}
