"use client";

import { Alert, Badge, Button, Card, Flex, Space, Spin, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { BankTransaction, ExpenseBankMatch, ExpenseItem, Ledger, LedgerSummary, Store } from "@fin-hub/shared-types";
import { formatPeriod } from "@fin-hub/shared-utils";
import { apiClient } from "./lib/api";
import { AppShell } from "./components/AppShell";
import { MetricCard } from "./components/MetricCard";
import { StatusBadge } from "./components/StatusBadge";
import { EmptyState } from "./components/EmptyState";

interface DashboardData {
  stores: Store[];
  ledgers: Ledger[];
  expenseItems: ExpenseItem[];
  bankTransactions: BankTransaction[];
  matches: ExpenseBankMatch[];
}

const emptyDashboard: DashboardData = {
  stores: [],
  ledgers: [],
  expenseItems: [],
  bankTransactions: [],
  matches: [],
};

const columns: ColumnsType<LedgerSummary> = [
  {
    title: "门店",
    dataIndex: "storeName",
    width: 180,
    fixed: 'left',
  },
  {
    title: "账期",
    dataIndex: "period",
    render: (value: string) => formatPeriod(value),
    width: 120,
  },
  {
    title: "状态",
    dataIndex: "status",
    render: (value: LedgerSummary["status"]) => (
      <StatusBadge status={value === "closed" ? "closed" : "open"} />
    ),
    width: 100,
  },
  {
    title: "待匹配流水",
    dataIndex: "pendingTransactionCount",
    align: "right",
    width: 120,
    render: (value: number) => (
      <span style={{ fontWeight: value > 0 ? 600 : 400, color: value > 0 ? '#f59e0b' : '#9ca3af' }}>
        {value}
      </span>
    ),
  },
  {
    title: "未分类明细",
    dataIndex: "unclassifiedExpenseItemCount",
    align: "right",
    width: 120,
    render: (value: number) => (
      <span style={{ fontWeight: value > 0 ? 600 : 400, color: value > 0 ? '#f59e0b' : '#9ca3af' }}>
        {value}
      </span>
    ),
  },
  {
    title: "缺供应商",
    dataIndex: "missingSupplierCount",
    align: "right",
    width: 100,
    render: (value: number) => (
      <span style={{ fontWeight: value > 0 ? 600 : 400, color: value > 0 ? '#dc2626' : '#9ca3af' }}>
        {value}
      </span>
    ),
  },
  {
    title: "操作",
    fixed: 'right',
    width: 100,
    render: () => <Button type="link" style={{ padding: 0 }}>进入账套</Button>
  },
];

export default function HomePage() {
  const router = useRouter();
  const [dashboardData, setDashboardData] = useState<DashboardData>(emptyDashboard);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;

    async function loadDashboard() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const [stores, ledgers, expenseItems, bankTransactions, matches] = await Promise.all([
          apiClient.stores.list("?page_size=200"),
          apiClient.ledgers.list("?page_size=200"),
          apiClient.expenseItems.list("?page_size=500"),
          apiClient.bankTransactions.list("?page_size=500"),
          apiClient.matches.list("?page_size=500"),
        ]);
        if (!ignore) {
          setDashboardData({
            stores: stores.items,
            ledgers: ledgers.items,
            expenseItems: expenseItems.items,
            bankTransactions: bankTransactions.items,
            matches: matches.items,
          });
        }
      } catch (error) {
        if (!ignore) {
          setDashboardData(emptyDashboard);
          setErrorMessage(error instanceof Error ? error.message : "无法加载首页数据");
        }
      } finally {
        if (!ignore) {
          setIsLoading(false);
        }
      }
    }

    loadDashboard();
    return () => {
      ignore = true;
    };
  }, []);

  const ledgerSummaries = useMemo(() => {
    const storesById = new Map(dashboardData.stores.map((store) => [store.id, store]));
    const confirmedBankIds = new Set(
      dashboardData.matches
        .filter((match) => match.status === "confirmed")
        .map((match) => match.bank_transaction_id),
    );

    return dashboardData.ledgers.map((ledger) => {
      const expenseItems = dashboardData.expenseItems.filter(
        (item) => item.store_id === ledger.store_id && item.ledger_period === ledger.period,
      );
      const bankTransactions = dashboardData.bankTransactions.filter(
        (transaction) =>
          transaction.store_id === ledger.store_id &&
          transaction.ledger_period === ledger.period &&
          transaction.direction === "expense" &&
          !confirmedBankIds.has(transaction.id),
      );

      return {
        id: ledger.id,
        storeId: ledger.store_id,
        storeName: storesById.get(ledger.store_id)?.name ?? "未知门店",
        period: ledger.period,
        status: ledger.status,
        pendingTransactionCount: bankTransactions.length,
        unclassifiedExpenseItemCount: expenseItems.filter((item) => !item.category_l1).length,
        missingSupplierCount: expenseItems.filter((item) => !item.supplier_name).length,
      } satisfies LedgerSummary;
    });
  }, [dashboardData]);

  const metrics = useMemo(
    () => ({
      pendingTransactionCount: ledgerSummaries.reduce(
        (total, ledger) => total + ledger.pendingTransactionCount,
        0,
      ),
      unclassifiedExpenseItemCount: ledgerSummaries.reduce(
        (total, ledger) => total + ledger.unclassifiedExpenseItemCount,
        0,
      ),
      missingSupplierCount: ledgerSummaries.reduce(
        (total, ledger) => total + ledger.missingSupplierCount,
        0,
      ),
      openLedgerCount: ledgerSummaries.filter((ledger) => ledger.status === "open").length,
    }),
    [ledgerSummaries],
  );

  return (
    <AppShell title="首页仪表盘">
      {errorMessage && (
        <Alert
          className="dashboard-alert"
          message="API 数据暂不可用"
          description={`请确认 API 服务已启动并允许 ${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000"} 访问。错误：${errorMessage}`}
          type="warning"
          showIcon
          closable
        />
      )}

      <Flex gap={16} wrap="wrap" className="metrics">
        <MetricCard
          title="待匹配流水"
          value={metrics.pendingTransactionCount}
          unit="笔"
          status={metrics.pendingTransactionCount > 50 ? "warning" : "normal"}
          action={{
            label: "去处理",
            onClick: () => router.push("/matching"),
          }}
          loading={isLoading}
        />

        <MetricCard
          title="未分类明细"
          value={metrics.unclassifiedExpenseItemCount}
          unit="条"
          status={metrics.unclassifiedExpenseItemCount > 30 ? "warning" : "normal"}
          action={{
            label: "去分类",
            onClick: () => router.push("/expenses"),
          }}
          loading={isLoading}
        />

        <MetricCard
          title="缺供应商"
          value={metrics.missingSupplierCount}
          unit="条"
          status={metrics.missingSupplierCount > 20 ? "danger" : "normal"}
          action={{
            label: "去关联",
            onClick: () => router.push("/expenses"),
          }}
          loading={isLoading}
        />

        <MetricCard
          title="待封账账套"
          value={metrics.openLedgerCount}
          unit="个"
          action={{
            label: "查看账套",
            onClick: () => router.push("/ledgers"),
          }}
          loading={isLoading}
        />
      </Flex>

      <Card
        title="门店账套"
        extra={
          <Space>
            <Badge status={errorMessage ? "warning" : "processing"} text="实时读取 API 数据" />
            <Button onClick={() => router.push("/ledgers")}>查看全部</Button>
          </Space>
        }
      >
        <Spin spinning={isLoading}>
          {!isLoading && ledgerSummaries.length === 0 && !errorMessage ? (
            <EmptyState
              title="暂无账套数据"
              description="请先创建门店账套开始做账"
              primaryAction={{
                label: "创建账套",
                onClick: () => router.push("/ledgers"),
              }}
              secondaryAction={{
                label: "查看文档",
                onClick: () => window.open("/docs", "_blank"),
              }}
            />
          ) : errorMessage ? (
            <EmptyState
              type="error"
              description={errorMessage}
              primaryAction={{
                label: "重新加载",
                onClick: () => window.location.reload(),
              }}
            />
          ) : (
            <Table
              rowKey="id"
              columns={columns}
              dataSource={ledgerSummaries}
              pagination={ledgerSummaries.length > 10 ? { pageSize: 10, showSizeChanger: true } : false}
              scroll={{ x: 1000 }}
            />
          )}
        </Spin>
      </Card>
    </AppShell>
  );
}
