"use client";

import { Alert, Button, Card, Flex, Form, Select, Space, Statistic, Table, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState } from "react";
import type {
  BankTransaction,
  ExpenseBreakdownItem,
  ExpenseItem,
  Ledger,
  LedgerReportDetail,
  LedgerTrend,
  RevenueRecord,
  Store,
  StoreComparisonReport,
  StoreReportSummary,
} from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

interface ReportFilterValues {
  ledger_key: string;
}

export default function ReportsPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [summaries, setSummaries] = useState<StoreReportSummary[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<LedgerReportDetail | null>(null);
  const [selectedTrend, setSelectedTrend] = useState<LedgerTrend | null>(null);
  const [storeComparison, setStoreComparison] = useState<StoreComparisonReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<ReportFilterValues>();

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const ledgerOptions = ledgers.map((ledger) => ({
    label: `${storesById.get(ledger.store_id)?.name ?? "未知门店"} / ${formatPeriod(ledger.period)}`,
    value: `${ledger.store_id}|${ledger.period}`,
  }));

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [storePage, ledgerPage, reportSummaries] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.ledgers.list("?page_size=500"),
        apiClient.reports.storeSummaries(),
      ]);
      setStores(storePage.items);
      setLedgers(ledgerPage.items);
      setSummaries(reportSummaries);
      if (reportSummaries[0]) {
        form.setFieldValue("ledger_key", `${reportSummaries[0].store_id}|${reportSummaries[0].period}`);
        const [detail, trends, comparison] = await Promise.all([
          apiClient.reports.ledgerDetail(reportSummaries[0].store_id, reportSummaries[0].period),
          apiClient.reports.ledgerTrends(`?store_id=${encodeURIComponent(reportSummaries[0].store_id)}&limit=6`),
          apiClient.reports.storeComparison(`?period=${encodeURIComponent(reportSummaries[0].period)}`),
        ]);
        setSelectedDetail(detail);
        setSelectedTrend(trends[0] ?? null);
        setStoreComparison(comparison);
      } else {
        setSelectedDetail(null);
        setSelectedTrend(null);
        setStoreComparison(null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载报表");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function submitFilter(values: ReportFilterValues) {
    const [storeId, period] = values.ledger_key.split("|");
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [detail, trends, comparison] = await Promise.all([
        apiClient.reports.ledgerDetail(storeId, period),
        apiClient.reports.ledgerTrends(`?store_id=${encodeURIComponent(storeId)}&limit=6`),
        apiClient.reports.storeComparison(`?period=${encodeURIComponent(period)}`),
      ]);
      setSelectedDetail(detail);
      setSelectedTrend(trends[0] ?? null);
      setStoreComparison(comparison);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法读取账套报表");
    } finally {
      setIsLoading(false);
    }
  }

  async function exportSelectedReport() {
    const selectedSummary = selectedDetail?.summary;
    if (!selectedSummary) {
      setErrorMessage("请先选择账套");
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const blob = await apiClient.reports.exportLedgerDetailCsv(selectedSummary.store_id, selectedSummary.period);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selectedSummary.store_name}-${selectedSummary.period}-财务明细.csv`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法导出报表");
    } finally {
      setIsLoading(false);
    }
  }

  async function exportSelectedReportXlsx() {
    const selectedSummary = selectedDetail?.summary;
    if (!selectedSummary) {
      setErrorMessage("请先选择账套");
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const blob = await apiClient.reports.exportLedgerDetailXlsx(selectedSummary.store_id, selectedSummary.period);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${selectedSummary.store_name}-${selectedSummary.period}-财务明细.xlsx`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法导出 Excel 报表");
    } finally {
      setIsLoading(false);
    }
  }

  const columns: ColumnsType<StoreReportSummary> = [
    { title: "门店", dataIndex: "store_name" },
    { title: "账期", dataIndex: "period", render: (value: string) => formatPeriod(value) },
    {
      title: "账套状态",
      dataIndex: "ledger_status",
      render: (value: StoreReportSummary["ledger_status"]) =>
        value === "closed" ? <Tag color="green">已封账</Tag> : <Tag color="gold">未封账</Tag>,
    },
    { title: "收入", dataIndex: "income_amount", render: (value: string) => formatMoney(value) },
    { title: "支出", dataIndex: "expense_amount", render: (value: string) => formatMoney(value) },
    { title: "利润", dataIndex: "profit_amount", render: (value: string) => formatMoney(value) },
    { title: "待付款支出", dataIndex: "pending_expense_count" },
    { title: "未匹配流水", dataIndex: "pending_bank_transaction_count" },
  ];

  const breakdownColumns: ColumnsType<ExpenseBreakdownItem> = [
    { title: "名称", dataIndex: "name" },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "笔数", dataIndex: "item_count" },
  ];

  const revenueColumns: ColumnsType<RevenueRecord> = [
    { title: "日期", dataIndex: "revenue_date" },
    { title: "渠道", dataIndex: "channel" },
    { title: "经营收入", dataIndex: "gross_amount", render: (value: string) => formatMoney(value) },
    { title: "实收金额", dataIndex: "net_amount", render: (value: string) => formatMoney(value) },
    { title: "手续费", dataIndex: "fee_amount", render: (value: string) => formatMoney(value) },
  ];

  const trendColumns: ColumnsType<LedgerReportDetail["summary"]> = [
    { title: "账期", dataIndex: "period", render: (value: string) => formatPeriod(value) },
    { title: "收入", dataIndex: "income_amount", render: (value: string) => formatMoney(value) },
    { title: "支出", dataIndex: "expense_amount", render: (value: string) => formatMoney(value) },
    { title: "利润", dataIndex: "profit_amount", render: (value: string) => formatMoney(value) },
    {
      title: "状态",
      dataIndex: "ledger_status",
      render: (value: LedgerReportDetail["summary"]["ledger_status"]) =>
        value === "closed" ? <Tag color="green">已封账</Tag> : <Tag color="gold">未封账</Tag>,
    },
  ];

  const comparisonColumns: ColumnsType<LedgerReportDetail["summary"]> = [
    { title: "门店", dataIndex: "store_name" },
    { title: "收入", dataIndex: "income_amount", render: (value: string) => formatMoney(value) },
    { title: "支出", dataIndex: "expense_amount", render: (value: string) => formatMoney(value) },
    { title: "利润", dataIndex: "profit_amount", render: (value: string) => formatMoney(value) },
    { title: "待付款支出", dataIndex: "pending_expense_count" },
    { title: "未匹配流水", dataIndex: "pending_bank_transaction_count" },
  ];

  const pendingExpenseColumns: ColumnsType<ExpenseItem> = [
    { title: "支出", dataIndex: "description" },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "分类", dataIndex: "category_l1", render: (value) => value || <Tag color="gold">未分类</Tag> },
    { title: "供应商", dataIndex: "supplier_name", render: (value) => value || "-" },
    {
      title: "付款状态",
      dataIndex: "payment_status",
      render: (value: ExpenseItem["payment_status"]) =>
        value === "partial_paid" ? <Tag color="gold">部分付款</Tag> : <Tag color="orange">未付款</Tag>,
    },
  ];

  const pendingBankColumns: ColumnsType<BankTransaction> = [
    { title: "发生时间", dataIndex: "occurred_at", render: (value: string) => value.replace("T", " ").slice(0, 16) },
    { title: "对方户名", dataIndex: "counterparty_name", render: (value) => value || "-" },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "已匹配", dataIndex: "matched_amount", render: (value: string) => formatMoney(value) },
    { title: "摘要", dataIndex: "summary", render: (value) => value || "-" },
  ];

  const selectedSummary = selectedDetail?.summary;

  return (
    <AppShell
      title="财务报表"
      action={
        <Space>
          <Button type="primary" onClick={exportSelectedReportXlsx} disabled={!selectedSummary}>
            导出 Excel
          </Button>
          <Button onClick={exportSelectedReport} disabled={!selectedSummary}>
            导出 CSV
          </Button>
          <Button onClick={loadData}>刷新</Button>
        </Space>
      }
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}

      <Card title="账套汇总">
        <Form form={form} layout="inline" onFinish={submitFilter}>
          <Form.Item name="ledger_key" label="账套" rules={[{ required: true }]}>
            <Select className="report-ledger-select" options={ledgerOptions} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={isLoading}>
              查看
            </Button>
          </Form.Item>
        </Form>
        {selectedSummary ? (
          <Flex gap={16} wrap="wrap" className="metrics report-metrics">
            <Card>
              <Statistic title="门店" value={selectedSummary.store_name} />
            </Card>
            <Card>
              <Statistic title="账期" value={formatPeriod(selectedSummary.period)} />
            </Card>
            <Card>
              <Statistic title="收入" value={formatMoney(selectedSummary.income_amount)} />
            </Card>
            <Card>
              <Statistic title="支出" value={formatMoney(selectedSummary.expense_amount)} />
            </Card>
            <Card>
              <Statistic title="利润" value={formatMoney(selectedSummary.profit_amount)} />
            </Card>
          </Flex>
        ) : null}
      </Card>

      {selectedDetail ? (
        <>
          <Card
            title={`${formatPeriod(storeComparison?.period ?? selectedDetail.summary.period)} 门店对比`}
            className="section-card"
          >
            <Flex gap={16} wrap="wrap" className="metrics report-metrics">
              <Card>
                <Statistic title="总收入" value={formatMoney(storeComparison?.total_income_amount ?? 0)} />
              </Card>
              <Card>
                <Statistic title="总支出" value={formatMoney(storeComparison?.total_expense_amount ?? 0)} />
              </Card>
              <Card>
                <Statistic title="总利润" value={formatMoney(storeComparison?.total_profit_amount ?? 0)} />
              </Card>
            </Flex>
            <Table
              rowKey="store_id"
              loading={isLoading}
              columns={comparisonColumns}
              dataSource={storeComparison?.items ?? []}
              pagination={{ pageSize: 8 }}
            />
          </Card>
          <Card title="最近账期趋势" className="section-card">
            <Table
              rowKey="period"
              loading={isLoading}
              columns={trendColumns}
              dataSource={selectedTrend?.items ?? []}
              pagination={false}
            />
          </Card>
          <Card title="营业收入明细" className="section-card">
            <Table
              rowKey="id"
              loading={isLoading}
              columns={revenueColumns}
              dataSource={selectedDetail.revenue_records}
              pagination={{ pageSize: 6 }}
            />
          </Card>
          <div className="matching-grid">
            <Card title="费用分类">
              <Table
                rowKey="name"
                loading={isLoading}
                columns={breakdownColumns}
                dataSource={selectedDetail.category_breakdown}
                pagination={false}
              />
            </Card>
            <Card title="供应商支出">
              <Table
                rowKey="name"
                loading={isLoading}
                columns={breakdownColumns}
                dataSource={selectedDetail.supplier_breakdown}
                pagination={false}
              />
            </Card>
          </div>
          <div className="matching-grid">
            <Card title="待处理支出">
              <Table
                rowKey="id"
                loading={isLoading}
                columns={pendingExpenseColumns}
                dataSource={selectedDetail.pending_expense_items}
                pagination={{ pageSize: 5 }}
              />
            </Card>
            <Card title="未匹配银行流水">
              <Table
                rowKey="id"
                loading={isLoading}
                columns={pendingBankColumns}
                dataSource={selectedDetail.pending_bank_transactions}
                pagination={{ pageSize: 5 }}
              />
            </Card>
          </div>
        </>
      ) : null}

      <Card
        title="门店最新账套"
        extra={<Space>{summaries.length ? <Tag color="blue">{summaries.length} 个门店</Tag> : null}</Space>}
      >
        <Table rowKey="ledger_id" loading={isLoading} columns={columns} dataSource={summaries} />
      </Card>
    </AppShell>
  );
}
