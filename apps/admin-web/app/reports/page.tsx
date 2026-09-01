"use client";

import { Alert, Button, Card, DatePicker, Drawer, Empty, Form, Select, Space, Statistic, Table, Tabs, Tag } from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import type {
  BankTransaction,
  ExpenseBreakdownItem,
  ExpenseItem,
  FinancialAnalyticsCategoryItem,
  FinancialAnalyticsDetailReport,
  FinancialAnalyticsReport,
  FinancialAnalyticsStoreItem,
  FinancialAnalyticsTemplateItem,
  Ledger,
  LedgerReportDetail,
  LedgerTrend,
  RevenueChannelBreakdownItem,
  RevenueRecord,
  Store,
  StoreReportSummary,
} from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { CategoryPieChart } from "../components/CategoryPieChart";
import { ComparisonBarChart } from "../components/ComparisonBarChart";
import { TrendChart } from "../components/TrendChart";
import { apiClient } from "../lib/api";

interface ReportFilterValues {
  store_id?: string;
  period_range?: [dayjs.Dayjs, dayjs.Dayjs];
  ledger_key?: string;
}

const matchStatusLabels: Record<string, string> = {
  confirmed: "已对账",
  candidate: "待确认",
  rejected: "已解除/驳回",
};

function toNumber(value: string | number | null | undefined) {
  return Number(value ?? 0);
}

function formatPercent(value: string | number | null | undefined) {
  return `${Number(value ?? 0).toFixed(2)}%`;
}

function buildAnalyticsParams(values: ReportFilterValues) {
  const params = new URLSearchParams();
  if (values.store_id) params.set("store_id", values.store_id);
  if (values.period_range?.[0]) params.set("period_start", values.period_range[0].format("YYYY-MM"));
  if (values.period_range?.[1]) params.set("period_end", values.period_range[1].format("YYYY-MM"));
  return params.toString() ? `?${params.toString()}` : "";
}

export default function ReportsPage() {
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [analytics, setAnalytics] = useState<FinancialAnalyticsReport | null>(null);
  const [summaries, setSummaries] = useState<StoreReportSummary[]>([]);
  const [selectedDetail, setSelectedDetail] = useState<LedgerReportDetail | null>(null);
  const [selectedTrend, setSelectedTrend] = useState<LedgerTrend | null>(null);
  const [drilldown, setDrilldown] = useState<FinancialAnalyticsDetailReport | null>(null);
  const [isDrilldownOpen, setIsDrilldownOpen] = useState(false);
  const [isDrilldownLoading, setIsDrilldownLoading] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<ReportFilterValues>();

  const storesById = useMemo(() => new Map(stores.map((store) => [store.id, store])), [stores]);
  const ledgerOptions = ledgers.map((ledger) => ({
    label: `${storesById.get(ledger.store_id)?.name ?? "未知门店"} / ${formatPeriod(ledger.period)}`,
    value: `${ledger.store_id}|${ledger.period}`,
  }));

  async function loadAnalytics(values: ReportFilterValues = form.getFieldsValue()) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const report = await apiClient.reports.analytics(buildAnalyticsParams(values));
      setAnalytics(report);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载统计分析");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadBaseData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [storePage, ledgerPage, reportSummaries, report] = await Promise.all([
        apiClient.stores.list("?page_size=500"),
        apiClient.ledgers.list("?page_size=500"),
        apiClient.reports.storeSummaries(),
        apiClient.reports.analytics(),
      ]);
      setStores(storePage.items);
      setLedgers(ledgerPage.items);
      setSummaries(reportSummaries);
      setAnalytics(report);
      if (reportSummaries[0]) {
        const ledgerKey = `${reportSummaries[0].store_id}|${reportSummaries[0].period}`;
        form.setFieldValue("ledger_key", ledgerKey);
        const [detail, trends] = await Promise.all([
          apiClient.reports.ledgerDetail(reportSummaries[0].store_id, reportSummaries[0].period),
          apiClient.reports.ledgerTrends(`?store_id=${encodeURIComponent(reportSummaries[0].store_id)}&limit=6`),
        ]);
        setSelectedDetail(detail);
        setSelectedTrend(trends[0] ?? null);
      }
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载报表");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    void loadBaseData();
  }, []);

  async function submitLedgerFilter(values: ReportFilterValues) {
    if (!values.ledger_key) return;
    const [storeId, period] = values.ledger_key.split("|");
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [detail, trends] = await Promise.all([
        apiClient.reports.ledgerDetail(storeId, period),
        apiClient.reports.ledgerTrends(`?store_id=${encodeURIComponent(storeId)}&limit=6`),
      ]);
      setSelectedDetail(detail);
      setSelectedTrend(trends[0] ?? null);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法读取账套报表");
    } finally {
      setIsLoading(false);
    }
  }

  async function exportSelectedReportXlsx() {
    const selectedSummary = selectedDetail?.summary;
    if (!selectedSummary) return;
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

  async function openDrilldown(extraParams: Record<string, string | undefined>) {
    const baseValues = form.getFieldsValue();
    const params = new URLSearchParams(buildAnalyticsParams(baseValues).replace(/^\?/, ""));
    Object.entries(extraParams).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    setIsDrilldownOpen(true);
    setIsDrilldownLoading(true);
    setErrorMessage(null);
    try {
      const detail = await apiClient.reports.analyticsDetails(`?${params.toString()}`);
      setDrilldown(detail);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载下钻明细");
    } finally {
      setIsDrilldownLoading(false);
    }
  }

  const trendChartData = {
    periods: analytics?.trends.map((item) => formatPeriod(item.period)) ?? [],
    revenue: analytics?.trends.map((item) => toNumber(item.income_amount)) ?? [],
    expense: analytics?.trends.map((item) => toNumber(item.expense_amount)) ?? [],
    profit: analytics?.trends.map((item) => toNumber(item.profit_amount)) ?? [],
  };
  const storeChartData = (analytics?.stores ?? []).slice(0, 10).map((item) => ({
    name: item.store_name,
    revenue: toNumber(item.income_amount),
    expense: toNumber(item.expense_amount),
    profit: toNumber(item.profit_amount),
  }));
  const categoryChartData = (analytics?.categories ?? []).slice(0, 10).map((item) => ({
    name: item.category_l2 ? `${item.category_l1}/${item.category_l2}` : item.category_l1,
    value: toNumber(item.amount),
  }));

  const storeColumns: ColumnsType<FinancialAnalyticsStoreItem> = [
    {
      title: "门店",
      dataIndex: "store_name",
      fixed: "left",
      width: 220,
      render: (value: string, record) => (
        <Button type="link" onClick={() => openDrilldown({ detail_type: "store", store_id: record.store_id })}>
          {value}
        </Button>
      ),
    },
    { title: "收入", dataIndex: "income_amount", render: (value: string) => formatMoney(value) },
    { title: "审批支出", dataIndex: "expense_amount", render: (value: string) => formatMoney(value) },
    { title: "银行支出", dataIndex: "bank_expense_amount", render: (value: string) => formatMoney(value) },
    { title: "已对账", dataIndex: "matched_expense_amount", render: (value: string) => formatMoney(value) },
    { title: "未对账流水", dataIndex: "unmatched_bank_amount", render: (value: string) => formatMoney(value) },
    { title: "未付款审批", dataIndex: "pending_expense_count", width: 110 },
  ];

  const categoryColumns: ColumnsType<FinancialAnalyticsCategoryItem> = [
    {
      title: "一级分类",
      dataIndex: "category_l1",
      render: (value: string, record) => (
        <Button
          type="link"
          onClick={() =>
            openDrilldown({
              detail_type: "category",
              category_l1: record.category_l1,
              category_l2: record.category_l2 ?? undefined,
            })
          }
        >
          {value}
        </Button>
      ),
    },
    { title: "二级分类", dataIndex: "category_l2", render: (value) => value || "-" },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "笔数", dataIndex: "item_count", width: 90 },
  ];

  const templateColumns: ColumnsType<FinancialAnalyticsTemplateItem> = [
    {
      title: "审批模版",
      dataIndex: "template_name",
      render: (value: string, record) => (
        <Button type="link" onClick={() => openDrilldown({ detail_type: "template", template_id: record.template_id })}>
          {value}
        </Button>
      ),
    },
    { title: "审批数", dataIndex: "approval_count", width: 90 },
    { title: "审批支出", dataIndex: "expense_amount", render: (value: string) => formatMoney(value) },
    { title: "已对账", dataIndex: "matched_amount", render: (value: string) => formatMoney(value) },
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

  const revenueChannelColumns: ColumnsType<RevenueChannelBreakdownItem> = [
    { title: "渠道", dataIndex: "channel" },
    { title: "经营收入", dataIndex: "gross_amount", render: (value: string) => formatMoney(value) },
    { title: "实收金额", dataIndex: "net_amount", render: (value: string) => formatMoney(value) },
    { title: "手续费", dataIndex: "fee_amount", render: (value: string) => formatMoney(value) },
    { title: "费率", dataIndex: "fee_rate", render: (value: string) => formatPercent(value) },
    { title: "已对账", dataIndex: "matched_amount", render: (value: string) => formatMoney(value) },
    { title: "未对账", dataIndex: "unmatched_amount", render: (value: string) => formatMoney(value) },
    { title: "对账完成率", dataIndex: "reconciliation_rate", render: (value: string) => formatPercent(value) },
    { title: "记录数", dataIndex: "record_count" },
  ];

  const trendColumns: ColumnsType<LedgerReportDetail["summary"]> = [
    { title: "账期", dataIndex: "period", render: (value: string) => formatPeriod(value) },
    { title: "收入", dataIndex: "income_amount", render: (value: string) => formatMoney(value) },
    { title: "支出", dataIndex: "expense_amount", render: (value: string) => formatMoney(value) },
    { title: "利润", dataIndex: "profit_amount", render: (value: string) => formatMoney(value) },
  ];

  const pendingExpenseColumns: ColumnsType<ExpenseItem> = [
    { title: "支出", dataIndex: "description" },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "分类", dataIndex: "category_l1", render: (value) => value || <Tag color="gold">未分类</Tag> },
    { title: "付款状态", dataIndex: "payment_status" },
  ];

  const pendingBankColumns: ColumnsType<BankTransaction> = [
    { title: "发生时间", dataIndex: "occurred_at", render: (value: string) => value.replace("T", " ").slice(0, 16) },
    { title: "金额", dataIndex: "amount", render: (value: string) => formatMoney(value) },
    { title: "已匹配", dataIndex: "matched_amount", render: (value: string) => formatMoney(value) },
    { title: "摘要", dataIndex: "summary", render: (value) => value || "-" },
  ];

  const drilldownExpenseColumns: ColumnsType<ExpenseItem> = [
    { title: "日期", dataIndex: "expense_date", width: 110, render: (value) => value || "-" },
    { title: "支出", dataIndex: "description", ellipsis: true },
    { title: "金额", dataIndex: "amount", width: 120, render: (value: string) => formatMoney(value) },
    { title: "分类", dataIndex: "category_l1", width: 140, render: (value, record) => record.category_l2 || value || "-" },
    { title: "付款状态", dataIndex: "payment_status", width: 120 },
  ];

  const drilldownBankColumns: ColumnsType<BankTransaction> = [
    { title: "发生时间", dataIndex: "occurred_at", width: 160, render: (value: string) => value.replace("T", " ").slice(0, 16) },
    { title: "金额", dataIndex: "amount", width: 120, render: (value: string) => formatMoney(value) },
    { title: "已匹配", dataIndex: "matched_amount", width: 120, render: (value: string) => formatMoney(value) },
    { title: "摘要", dataIndex: "summary", ellipsis: true, render: (value) => value || "-" },
  ];

  const drilldownApprovalColumns: ColumnsType<FinancialAnalyticsDetailReport["approval_instances"][number]> = [
    { title: "审批编号", dataIndex: "approval_no", width: 160, render: (value) => value || "-" },
    { title: "申请人", dataIndex: "applicant_name", width: 120, render: (value) => value || "-" },
    { title: "状态", dataIndex: "approval_status", width: 120 },
    { title: "提交时间", dataIndex: "submit_at", width: 160, render: (value: string | null) => value ? value.replace("T", " ").slice(0, 16) : "-" },
  ];

  const drilldownReconciliationColumns: ColumnsType<FinancialAnalyticsDetailReport["reconciliation_records"][number]> = [
    { title: "审批编号", render: (_, record) => record.approval_instance?.approval_no || "-" },
    { title: "模版", dataIndex: "template_name", render: (value) => value || "-" },
    { title: "银行流水", render: (_, record) => record.bank_transaction.summary || "-" },
    { title: "匹配金额", render: (_, record) => formatMoney(record.match.amount) },
    { title: "入账月份", render: (_, record) => record.match.accounting_period || "-" },
    { title: "状态", render: (_, record) => matchStatusLabels[record.match.status] ?? record.match.status },
  ];

  return (
    <AppShell
      title="统计报表"
      kicker="经营指标、门店费用和对账状态分析"
      action={
        <Space>
          <Button onClick={() => loadAnalytics()}>刷新分析</Button>
          <Button type="primary" onClick={exportSelectedReportXlsx} disabled={!selectedDetail}>
            导出明细
          </Button>
        </Space>
      }
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon closable onClose={() => setErrorMessage(null)} />
      ) : null}

      <Card className="analytics-filter-card">
        <Form form={form} layout="inline" onFinish={loadAnalytics}>
          <Form.Item name="store_id" label="门店">
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="全部授权门店"
              style={{ width: 260 }}
              options={stores.map((store) => ({ label: store.name, value: store.id }))}
            />
          </Form.Item>
          <Form.Item name="period_range" label="账期">
            <DatePicker.RangePicker picker="month" format="YYYY-MM" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={isLoading}>分析</Button>
          </Form.Item>
        </Form>
      </Card>

      <div className="analytics-metric-grid">
        <Card><Statistic title="授权门店" value={analytics?.metrics.store_count ?? 0} suffix="家" /></Card>
        <Card><Statistic title="总收入" value={formatMoney(analytics?.metrics.total_income_amount ?? 0)} /></Card>
        <Card><Statistic title="审批支出" value={formatMoney(analytics?.metrics.total_expense_amount ?? 0)} /></Card>
        <Card><Statistic title="利润" value={formatMoney(analytics?.metrics.total_profit_amount ?? 0)} /></Card>
        <Card><Statistic title="银行支出" value={formatMoney(analytics?.metrics.bank_expense_amount ?? 0)} /></Card>
        <Card><Statistic title="已对账金额" value={formatMoney(analytics?.metrics.matched_expense_amount ?? 0)} /></Card>
        <Card className="analytics-clickable-card" onClick={() => openDrilldown({ detail_type: "unmatched_bank" })}>
          <Statistic title="未对账流水" value={formatMoney(analytics?.metrics.unmatched_bank_amount ?? 0)} suffix={`${analytics?.metrics.unmatched_bank_count ?? 0} 笔`} />
        </Card>
        <Card className="analytics-clickable-card" onClick={() => openDrilldown({ detail_type: "pending_expense" })}>
          <Statistic title="未付款审批" value={formatMoney(analytics?.metrics.pending_expense_amount ?? 0)} suffix={`${analytics?.metrics.pending_expense_count ?? 0} 笔`} />
        </Card>
      </div>

      <Tabs
        className="analytics-tabs"
        defaultActiveKey="overview"
        items={[
          {
            key: "overview",
            label: "经营总览",
            children: (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <div className="analytics-chart-grid">
                  <TrendChart title="月度收入、支出和利润趋势" data={trendChartData} loading={isLoading} height={340} />
                  <CategoryPieChart title="费用分类占比" data={categoryChartData} loading={isLoading} height={340} />
                </div>
                <ComparisonBarChart title="门店经营对比" data={storeChartData} loading={isLoading} height={380} horizontal />
              </Space>
            ),
          },
          {
            key: "stores",
            label: "门店费用分析",
            children: (
              <Card title="门店费用排行" className="data-table-card">
                <Table
                  rowKey="store_id"
                  loading={isLoading}
                  columns={storeColumns}
                  dataSource={analytics?.stores ?? []}
                  scroll={{ x: 980 }}
                  pagination={{ pageSize: 10 }}
                />
              </Card>
            ),
          },
          {
            key: "categories",
            label: "分类与审批",
            children: (
              <div className="analytics-table-grid">
                <Card title="费用分类排行" className="data-table-card">
                  <Table rowKey={(record) => `${record.category_l1}-${record.category_l2 ?? ""}`} loading={isLoading} columns={categoryColumns} dataSource={analytics?.categories ?? []} pagination={{ pageSize: 10 }} />
                </Card>
                <Card title="审批模版统计" className="data-table-card">
                  <Table rowKey="template_id" loading={isLoading} columns={templateColumns} dataSource={analytics?.templates ?? []} pagination={{ pageSize: 10 }} />
                </Card>
              </div>
            ),
          },
          {
            key: "reconciliation",
            label: "对账分析",
            children: (
              <div className="analytics-status-grid">
                {(analytics?.reconciliation ?? []).map((item) => (
                  <Card
                    key={item.status}
                    className="analytics-clickable-card"
                    onClick={() => openDrilldown({ detail_type: "reconciliation", match_status: item.status })}
                  >
                    <Statistic title={matchStatusLabels[item.status] ?? item.status} value={formatMoney(item.amount)} suffix={`${item.count} 笔`} />
                  </Card>
                ))}
                {!analytics?.reconciliation.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} /> : null}
              </div>
            ),
          },
          {
            key: "ledger",
            label: "账套明细",
            children: (
              <Space direction="vertical" size={16} style={{ width: "100%" }}>
                <Card title="账套选择">
                  <Form form={form} layout="inline" onFinish={submitLedgerFilter}>
                    <Form.Item name="ledger_key" label="账套" rules={[{ required: true }]}>
                      <Select className="report-ledger-select" options={ledgerOptions} />
                    </Form.Item>
                    <Form.Item>
                      <Button type="primary" htmlType="submit" loading={isLoading}>查看明细</Button>
                    </Form.Item>
                  </Form>
                </Card>
                {selectedDetail ? (
                  <>
                    <div className="analytics-metric-grid analytics-metric-grid--compact">
                      <Card><Statistic title="门店" value={selectedDetail.summary.store_name} /></Card>
                      <Card><Statistic title="账期" value={formatPeriod(selectedDetail.summary.period)} /></Card>
                      <Card><Statistic title="收入" value={formatMoney(selectedDetail.summary.income_amount)} /></Card>
                      <Card><Statistic title="支出" value={formatMoney(selectedDetail.summary.expense_amount)} /></Card>
                    </div>
                    <Card title="最近账期趋势" className="data-table-card">
                      <Table rowKey="period" loading={isLoading} columns={trendColumns} dataSource={selectedTrend?.items ?? []} pagination={false} />
                    </Card>
                    <Card title="营业收入明细" className="data-table-card">
                      <Table rowKey="id" loading={isLoading} columns={revenueColumns} dataSource={selectedDetail.revenue_records} pagination={{ pageSize: 6 }} />
                    </Card>
                    <Card title="收入渠道分析" className="data-table-card">
                      <Table
                        rowKey="channel"
                        loading={isLoading}
                        columns={revenueChannelColumns}
                        dataSource={selectedDetail.revenue_channel_breakdown}
                        scroll={{ x: 980 }}
                        pagination={false}
                      />
                    </Card>
                    <div className="analytics-table-grid">
                      <Card title="费用分类" className="data-table-card">
                        <Table rowKey="name" loading={isLoading} columns={breakdownColumns} dataSource={selectedDetail.category_breakdown} pagination={false} />
                      </Card>
                      <Card title="供应商支出" className="data-table-card">
                        <Table rowKey="name" loading={isLoading} columns={breakdownColumns} dataSource={selectedDetail.supplier_breakdown} pagination={false} />
                      </Card>
                    </div>
                    <div className="analytics-table-grid">
                      <Card title="待处理支出" className="data-table-card">
                        <Table rowKey="id" loading={isLoading} columns={pendingExpenseColumns} dataSource={selectedDetail.pending_expense_items} pagination={{ pageSize: 5 }} />
                      </Card>
                      <Card title="未匹配银行流水" className="data-table-card">
                        <Table rowKey="id" loading={isLoading} columns={pendingBankColumns} dataSource={selectedDetail.pending_bank_transactions} pagination={{ pageSize: 5 }} />
                      </Card>
                    </div>
                  </>
                ) : (
                  <Card><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无账套明细" /></Card>
                )}
              </Space>
            ),
          },
        ]}
      />

      <Card title="门店最新账套" className="data-table-card">
        <Table
          rowKey="ledger_id"
          loading={isLoading}
          columns={[
            { title: "门店", dataIndex: "store_name" },
            { title: "账期", dataIndex: "period", render: (value: string) => formatPeriod(value) },
            { title: "收入", dataIndex: "income_amount", render: (value: string) => formatMoney(value) },
            { title: "支出", dataIndex: "expense_amount", render: (value: string) => formatMoney(value) },
            { title: "利润", dataIndex: "profit_amount", render: (value: string) => formatMoney(value) },
            { title: "待付款支出", dataIndex: "pending_expense_count" },
            { title: "未匹配流水", dataIndex: "pending_bank_transaction_count" },
          ]}
          dataSource={summaries}
          pagination={{ pageSize: 10 }}
        />
      </Card>
      <Drawer
        title={drilldown?.title ?? "统计明细"}
        open={isDrilldownOpen}
        onClose={() => setIsDrilldownOpen(false)}
        width={980}
      >
        <Space direction="vertical" size={16} style={{ width: "100%" }}>
          {drilldown?.bank_transactions.length ? (
            <Card title={`银行流水 (${drilldown.bank_transactions.length})`} className="data-table-card">
              <Table
                rowKey="id"
                loading={isDrilldownLoading}
                columns={drilldownBankColumns}
                dataSource={drilldown.bank_transactions}
                pagination={{ pageSize: 10 }}
              />
            </Card>
          ) : null}
          {drilldown?.expense_items.length ? (
            <Card title={`审批支出 (${drilldown.expense_items.length})`} className="data-table-card">
              <Table
                rowKey="id"
                loading={isDrilldownLoading}
                columns={drilldownExpenseColumns}
                dataSource={drilldown.expense_items}
                pagination={{ pageSize: 10 }}
              />
            </Card>
          ) : null}
          {drilldown?.approval_instances.length ? (
            <Card title={`审批单 (${drilldown.approval_instances.length})`} className="data-table-card">
              <Table
                rowKey="id"
                loading={isDrilldownLoading}
                columns={drilldownApprovalColumns}
                dataSource={drilldown.approval_instances}
                pagination={{ pageSize: 10 }}
              />
            </Card>
          ) : null}
          {drilldown?.reconciliation_records.length ? (
            <Card title={`对账记录 (${drilldown.reconciliation_records.length})`} className="data-table-card">
              <Table
                rowKey={(record) => record.match.id}
                loading={isDrilldownLoading}
                columns={drilldownReconciliationColumns}
                dataSource={drilldown.reconciliation_records}
                pagination={{ pageSize: 10 }}
              />
            </Card>
          ) : null}
          {!isDrilldownLoading &&
          !drilldown?.bank_transactions.length &&
          !drilldown?.expense_items.length &&
          !drilldown?.approval_instances.length &&
          !drilldown?.reconciliation_records.length ? (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无明细数据" />
          ) : null}
        </Space>
      </Drawer>
    </AppShell>
  );
}
