"use client";

import { Alert, Card, Empty, Space, Table, Typography, Row, Col } from "antd";
import {
  FileTextOutlined,
  WalletOutlined,
  DollarOutlined,
  WarningOutlined,
  RiseOutlined,
  FallOutlined,
} from "@ant-design/icons";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { StoreLedgerWorkspace } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../../components/AppShell";
import { BankTransactionChart } from "../../components/BankTransactionChart";
import { MoneyDisplay } from "../../components/MoneyDisplay";
import { RevenueChannelMonthlyChart } from "../../components/RevenueChannelMonthlyChart";
import { StoreLedgerWorkspaceNav } from "../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../lib/api";
import { useClientSearchParams } from "../../lib/searchParams";

function currentPeriod() {
  return new Date().toISOString().slice(0, 7);
}

const workspaceCache = new Map<string, { data: StoreLedgerWorkspace; expiresAt: number }>();
const WORKSPACE_CACHE_TTL = 30_000;

function metricCard(title: string, value: string, subtitle: string, icon: React.ReactNode, tone?: "green" | "red" | "gold" | "blue") {
  return (
    <Card size="small" className={`store-ledger-report-metric ${tone ? `store-ledger-report-metric--${tone}` : ""}`}>
      <Space direction="vertical" size={8} className="full-width">
        <Space size={8} align="center">
          <span className="store-ledger-report-metric__icon">{icon}</span>
          <Typography.Text className="store-ledger-report-metric__title">{title}</Typography.Text>
        </Space>
        <Typography.Text className="store-ledger-report-metric__value">{value}</Typography.Text>
        <Typography.Text type="secondary" className="store-ledger-report-metric__subtitle">
          {subtitle}
        </Typography.Text>
      </Space>
    </Card>
  );
}

export default function StoreLedgerWorkspacePage() {
  const params = useParams();
  const searchParams = useClientSearchParams();
  const storeId = params?.storeId as string;
  const period = searchParams.get("period") || currentPeriod();

  const [data, setData] = useState<StoreLedgerWorkspace | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function loadData() {
      if (!storeId || !period) return;
      const cacheKey = `${storeId}|${period}`;
      const cached = workspaceCache.get(cacheKey);
      if (cached && cached.expiresAt > Date.now()) {
        setData(cached.data);
        setIsLoading(false);
        return;
      }
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const workspace = await apiClient.storeLedgers.workspace(storeId, `?period=${period}`);
        if (!ignore) {
          setData(workspace);
          workspaceCache.set(cacheKey, { data: workspace, expiresAt: Date.now() + WORKSPACE_CACHE_TTL });
        }
      } catch (error) {
        if (!ignore) setErrorMessage(error instanceof Error ? error.message : "加载失败");
      } finally {
        if (!ignore) setIsLoading(false);
      }
    }
    void loadData();
    return () => {
      ignore = true;
    };
  }, [storeId, period]);

  const storeName = data?.store.name ?? "门店";

  const stats = useMemo(() => {
    if (!data) return null;
    return {
      grossIncome: Number(data.metrics.revenue_income_amount || 0),
      netIncome: Number(data.metrics.revenue_net_amount || 0),
      expense: Number(data.metrics.expense_amount || 0),
      approvalAmount: Number(data.metrics.approval_amount || 0),
      approvalAccountingAmount: Number(data.metrics.approval_accounting_amount || 0),
      balance: Number(data.metrics.revenue_income_amount || 0) - Number(data.metrics.expense_amount || 0),
      unmatchedBank: data.metrics.unmatched_bank_transaction_count,
      pendingApprovals: data.metrics.pending_approval_count,
      bankIncome: Number(data.bank_transactions.filter((item) => item.direction === "income").reduce((total, item) => total + Number(item.amount || 0), 0)),
      bankExpense: Number(data.bank_transactions.filter((item) => item.direction === "expense").reduce((total, item) => total + Number(item.amount || 0), 0)),
      unmatchedBankAmount: Number(data.bank_transactions.filter((item) => Number(item.matched_amount || 0) <= 0).reduce((total, item) => total + Number(item.amount || 0), 0)),
    };
  }, [data]);

  const bankChartData = useMemo(() => {
    if (!data) return [];
    return [
      { name: "收入流水", value: Number(stats?.bankIncome || 0) },
      { name: "支出流水", value: Number(stats?.bankExpense || 0) },
      { name: "未匹配流水", value: Number(stats?.unmatchedBankAmount || 0) },
    ];
  }, [data, stats]);

  const categoryColumns = [
    { title: "分类", dataIndex: "name", ellipsis: true },
    {
      title: "金额",
      dataIndex: "amount",
      align: "right" as const,
      render: (value: string) => <MoneyDisplay value={Number(value || 0)} colorize />,
    },
    { title: "条数", dataIndex: "item_count", width: 90, align: "right" as const },
  ];

  const channelColumns = [
    { title: "渠道", dataIndex: "channel", ellipsis: true },
    {
      title: "经营收入",
      dataIndex: "gross_amount",
      align: "right" as const,
      render: (value: string) => <MoneyDisplay value={Number(value || 0)} colorize />,
    },
    {
      title: "实收",
      dataIndex: "net_amount",
      align: "right" as const,
      render: (value: string) => <MoneyDisplay value={Number(value || 0)} colorize />,
    },
    {
      title: "费率",
      dataIndex: "fee_rate",
      align: "right" as const,
      render: (value: string) => `${value || "0.00"}%`,
    },
    { title: "记录数", dataIndex: "record_count", width: 90, align: "right" as const },
  ];

  return (
    <AppShell title={`${storeName} · 总览`} kicker={`账期: ${period}`}>
      <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }}>
        {errorMessage ? <Alert message="加载失败" description={errorMessage} type="error" showIcon closable /> : null}

        {data ? (
          <StoreLedgerWorkspaceNav
            storeId={storeId}
            storeName={data.store.name}
            period={data.period}
            periodOptions={data.ledgers.map((ledger) => ({ label: ledger.period, value: ledger.period }))}
            ledgerStatusLabel={data.selected_ledger?.status === "closed" ? "已封账" : data.selected_ledger ? "进行中" : undefined}
            activeKey="overview"
          />
        ) : null}

        {stats ? (
          <div className="store-ledger-report-metrics">
            {metricCard("经营收入", formatMoney(stats.grossIncome), "各渠道录入累计，按录入日期统计", <RiseOutlined />, "green")}
            {metricCard("实收", formatMoney(stats.netIncome), "录入时填写的实收金额汇总", <WalletOutlined />, "blue")}
            {metricCard("本期支出", formatMoney(stats.expense), "审批支出按账期汇总", <FallOutlined />, "red")}
            {metricCard(
              "审批金额",
              formatMoney(stats.approvalAmount),
              `创建时间累计；对账账期累计：${formatMoney(stats.approvalAccountingAmount)}`,
              <FileTextOutlined />,
              "gold",
            )}
            {metricCard("本期结余", formatMoney(stats.netIncome - stats.expense), "实收减本期支出", <DollarOutlined />, stats.netIncome - stats.expense >= 0 ? "green" : "red")}
            {metricCard("待处理项", `${stats.unmatchedBank} / ${stats.pendingApprovals}`, "未处理流水 / 未处理审批", <WarningOutlined />, "blue")}
          </div>
        ) : null}

        {data ? (
          <Row gutter={16}>
            <Col xs={24} lg={12}>
              <Card size="small" title="经营收入渠道统计">
                <Table
                  rowKey="channel"
                  columns={channelColumns}
                  dataSource={data.metrics.revenue_channel_summary}
                  pagination={false}
                  size="small"
                />
              </Card>
            </Col>
            <Col xs={24} lg={12}>
              <Card size="small" title="支出分类统计">
                <Table
                  rowKey={(item) => item.name}
                  columns={categoryColumns}
                  dataSource={data.metrics.expense_category_summary}
                  pagination={false}
                  size="small"
                />
              </Card>
            </Col>
          </Row>
        ) : null}

        {data && stats ? (
          <Row gutter={16}>
            <Col xs={24} lg={12}>
              <BankTransactionChart title="银行流水统计" data={bankChartData} height={360} />
            </Col>
            <Col xs={24} lg={12}>
              <RevenueChannelMonthlyChart
                title="经营收入渠道月度图"
                data={data.metrics.revenue_channel_monthly_summary}
                height={360}
              />
            </Col>
          </Row>
        ) : isLoading ? (
          <Card loading />
        ) : (
          <Empty description="暂无数据" />
        )}
      </Space>
    </AppShell>
  );
}
