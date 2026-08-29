"use client";

import { Alert, Badge, Button, Card, Flex, Space, Spin, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useMemo, useState } from "react";
import type { BankTransaction, ExpenseBankMatch, ExpenseItem, Ledger, LedgerSummary, Store } from "@fin-hub/shared-types";
import { formatPeriod } from "@fin-hub/shared-utils";
import { apiClient } from "./lib/api";
import { AppShell } from "./components/AppShell";

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
  { title: "门店", dataIndex: "storeName" },
  { title: "账期", dataIndex: "period", render: (value: string) => formatPeriod(value) },
  {
    title: "状态",
    dataIndex: "status",
    render: (value: LedgerSummary["status"]) =>
      value === "closed" ? <Tag color="green">已封账</Tag> : <Tag color="gold">待做账</Tag>,
  },
  { title: "待匹配流水", dataIndex: "pendingTransactionCount" },
  { title: "未分类明细", dataIndex: "unclassifiedExpenseItemCount" },
  { title: "缺供应商", dataIndex: "missingSupplierCount" },
  { title: "操作", render: () => <Button type="link">进入账套</Button> },
];

export default function HomePage() {
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
          {errorMessage ? (
            <Alert
              className="dashboard-alert"
              message="API 数据暂不可用"
              description={`请确认 API 服务已启动并允许 ${process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000"} 访问。错误：${errorMessage}`}
              type="warning"
              showIcon
            />
          ) : null}
          <Flex gap={16} wrap="wrap" className="metrics">
            <Card>
              <Typography.Text type="secondary">待匹配流水</Typography.Text>
              <Typography.Title level={2}>{metrics.pendingTransactionCount}</Typography.Title>
            </Card>
            <Card>
              <Typography.Text type="secondary">未分类明细行</Typography.Text>
              <Typography.Title level={2}>{metrics.unclassifiedExpenseItemCount}</Typography.Title>
            </Card>
            <Card>
              <Typography.Text type="secondary">需供应商未关联</Typography.Text>
              <Typography.Title level={2}>{metrics.missingSupplierCount}</Typography.Title>
            </Card>
            <Card>
              <Typography.Text type="secondary">待封账账套</Typography.Text>
              <Typography.Title level={2}>{metrics.openLedgerCount}</Typography.Title>
            </Card>
          </Flex>
          <Card
            title="门店账套"
            extra={
              <Space>
                <Badge status={errorMessage ? "warning" : "processing"} text="实时读取 API 数据" />
                <Button>查看全部</Button>
              </Space>
            }
          >
            <Spin spinning={isLoading}>
              <Table
                rowKey="id"
                columns={columns}
                dataSource={ledgerSummaries}
                locale={{ emptyText: errorMessage ? "API 暂不可用" : "暂无账套数据" }}
                pagination={false}
              />
            </Spin>
          </Card>
    </AppShell>
  );
}
