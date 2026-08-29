"use client";

import { Alert, Button, Card, Space, Spin, Row, Col, Statistic, Tabs } from "antd";
import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import type {
  BankTransaction,
  ExpenseBankMatch,
  ExpenseItem,
  Ledger,
  Store,
  RevenueRecord,
} from "@fin-hub/shared-types";
import { apiClient } from "../lib/api";
import { AppShell } from "../components/AppShell";
import { MetricCard } from "../components/MetricCard";
import { EmptyState } from "../components/EmptyState";
import { TrendChart } from "../components/TrendChart";
import { ComparisonBarChart } from "../components/ComparisonBarChart";
import { CategoryPieChart } from "../components/CategoryPieChart";
import { ArrowUpOutlined, ArrowDownOutlined } from "@ant-design/icons";

interface DashboardData {
  stores: Store[];
  ledgers: Ledger[];
  expenseItems: ExpenseItem[];
  bankTransactions: BankTransaction[];
  matches: ExpenseBankMatch[];
  revenueRecords: RevenueRecord[];
}

const emptyData: DashboardData = {
  stores: [],
  ledgers: [],
  expenseItems: [],
  bankTransactions: [],
  matches: [],
  revenueRecords: [],
};

export default function DashboardPage() {
  const router = useRouter();
  const [data, setData] = useState<DashboardData>(emptyData);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    loadData();
  }, []);

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [stores, ledgers, expenseItems, bankTransactions, matches, revenueRecords] = await Promise.all([
        apiClient.stores.list("?page_size=200"),
        apiClient.ledgers.list("?page_size=200"),
        apiClient.expenseItems.list("?page_size=1000"),
        apiClient.bankTransactions.list("?page_size=1000"),
        apiClient.matches.list("?page_size=1000"),
        apiClient.revenueRecords.list("?page_size=1000"),
      ]);

      setData({
        stores: stores.items,
        ledgers: ledgers.items,
        expenseItems: expenseItems.items,
        bankTransactions: bankTransactions.items,
        matches: matches.items,
        revenueRecords: revenueRecords.items,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载数据");
    } finally {
      setIsLoading(false);
    }
  }

  // 计算指标
  const metrics = useMemo(() => {
    const confirmedBankIds = new Set(
      data.matches.filter((m) => m.status === "confirmed").map((m) => m.bank_transaction_id),
    );

    const unmatchedTransactions = data.bankTransactions.filter(
      (t) => t.direction === "expense" && !confirmedBankIds.has(t.id),
    );

    const unclassifiedExpenses = data.expenseItems.filter((item) => !item.category_l1);

    const missingSuppliers = data.expenseItems.filter((item) => !item.supplier_name);

    const openLedgers = data.ledgers.filter((l) => l.status === "open");

    // 计算总收入
    const totalRevenue = data.revenueRecords.reduce((sum, r) => sum + Number(r.gross_amount || 0), 0);

    // 计算总支出
    const totalExpense = data.expenseItems.reduce((sum, e) => sum + Number(e.amount || 0), 0);

    // 计算利润
    const totalProfit = totalRevenue - totalExpense;

    return {
      unmatchedCount: unmatchedTransactions.length,
      unclassifiedCount: unclassifiedExpenses.length,
      missingSupplierCount: missingSuppliers.length,
      openLedgerCount: openLedgers.length,
      totalRevenue,
      totalExpense,
      totalProfit,
      profitMargin: totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0,
    };
  }, [data]);

  // 准备趋势图数据（最近6个月）
  const trendData = useMemo(() => {
    // 按账期分组
    const ledgerMap = new Map<string, { revenue: number; expense: number }>();

    data.revenueRecords.forEach((r) => {
      const current = ledgerMap.get(r.ledger_period) || { revenue: 0, expense: 0 };
      current.revenue += Number(r.gross_amount || 0);
      ledgerMap.set(r.ledger_period, current);
    });

    data.expenseItems.forEach((e) => {
      const current = ledgerMap.get(e.ledger_period) || { revenue: 0, expense: 0 };
      current.expense += Number(e.amount || 0);
      ledgerMap.set(e.ledger_period, current);
    });

    // 排序并取最近6个月
    const sortedPeriods = Array.from(ledgerMap.keys()).sort().slice(-6);

    return {
      periods: sortedPeriods,
      revenue: sortedPeriods.map((p) => ledgerMap.get(p)?.revenue || 0),
      expense: sortedPeriods.map((p) => ledgerMap.get(p)?.expense || 0),
      profit: sortedPeriods.map((p) => {
        const d = ledgerMap.get(p);
        return d ? d.revenue - d.expense : 0;
      }),
    };
  }, [data]);

  // 准备门店对比数据
  const storeComparison = useMemo(() => {
    const storeMap = new Map<string, { revenue: number; expense: number }>();

    data.revenueRecords.forEach((r) => {
      const current = storeMap.get(r.store_id) || { revenue: 0, expense: 0 };
      current.revenue += Number(r.gross_amount || 0);
      storeMap.set(r.store_id, current);
    });

    data.expenseItems.forEach((e) => {
      const current = storeMap.get(e.store_id) || { revenue: 0, expense: 0 };
      current.expense += Number(e.amount || 0);
      storeMap.set(e.store_id, current);
    });

    return Array.from(storeMap.entries())
      .map(([storeId, amounts]) => {
        const store = data.stores.find((s) => s.id === storeId);
        return {
          name: store?.name || "未知门店",
          revenue: amounts.revenue,
          expense: amounts.expense,
          profit: amounts.revenue - amounts.expense,
        };
      })
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 8); // 取前8个门店
  }, [data]);

  // 准备分类饼图数据
  const categoryData = useMemo(() => {
    const categoryMap = new Map<string, number>();

    data.expenseItems.forEach((item) => {
      if (item.category_l1) {
        const current = categoryMap.get(item.category_l1) || 0;
        categoryMap.set(item.category_l1, current + Number(item.amount || 0));
      }
    });

    return Array.from(categoryMap.entries())
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 10); // 取前10个分类
  }, [data]);

  if (errorMessage) {
    return (
      <AppShell title="数据仪表盘">
        <EmptyState
          type="error"
          description={errorMessage}
          primaryAction={{
            label: "重新加载",
            onClick: loadData,
          }}
        />
      </AppShell>
    );
  }

  return (
    <AppShell title="数据仪表盘" kicker="数据概览与趋势分析">
      <Spin spinning={isLoading}>
        <Space direction="vertical" size={16} style={{ width: "100%", display: "flex" }}>
          {/* 关键指标 */}
          <Row gutter={[16, 16]}>
            <Col xs={24} sm={12} lg={6}>
              <MetricCard
                title="待匹配流水"
                value={metrics.unmatchedCount}
                unit="笔"
                status={metrics.unmatchedCount > 50 ? "warning" : "normal"}
                action={{
                  label: "去处理",
                  onClick: () => router.push("/matching-v2"),
                }}
                loading={isLoading}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
              <MetricCard
                title="未分类明细"
                value={metrics.unclassifiedCount}
                unit="条"
                status={metrics.unclassifiedCount > 30 ? "warning" : "normal"}
                action={{
                  label: "去分类",
                  onClick: () => router.push("/expenses"),
                }}
                loading={isLoading}
              />
            </Col>
            <Col xs={24} sm={12} lg={6}>
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
            </Col>
            <Col xs={24} sm={12} lg={6}>
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
            </Col>
          </Row>

          {/* 财务概览 */}
          <Card title="财务概览" loading={isLoading}>
            <Row gutter={[16, 16]}>
              <Col xs={24} sm={8}>
                <Statistic
                  title="总收入"
                  value={metrics.totalRevenue}
                  precision={2}
                  prefix="¥"
                  valueStyle={{ color: "#2a9d66", fontWeight: 700, fontFeatureSettings: "'tnum'" }}
                />
              </Col>
              <Col xs={24} sm={8}>
                <Statistic
                  title="总支出"
                  value={metrics.totalExpense}
                  precision={2}
                  prefix="¥"
                  valueStyle={{ color: "#ef4444", fontWeight: 700, fontFeatureSettings: "'tnum'" }}
                />
              </Col>
              <Col xs={24} sm={8}>
                <Statistic
                  title="利润"
                  value={metrics.totalProfit}
                  precision={2}
                  prefix="¥"
                  suffix={
                    <span style={{ fontSize: "14px", marginLeft: "8px" }}>
                      {metrics.profitMargin > 0 ? (
                        <span style={{ color: "#2a9d66" }}>
                          <ArrowUpOutlined /> {metrics.profitMargin.toFixed(1)}%
                        </span>
                      ) : (
                        <span style={{ color: "#ef4444" }}>
                          <ArrowDownOutlined /> {Math.abs(metrics.profitMargin).toFixed(1)}%
                        </span>
                      )}
                    </span>
                  }
                  valueStyle={{
                    color: metrics.totalProfit >= 0 ? "#2a9d66" : "#ef4444",
                    fontWeight: 700,
                    fontFeatureSettings: "'tnum'",
                  }}
                />
              </Col>
            </Row>
          </Card>

          {/* 趋势图 */}
          {trendData.periods.length > 0 && (
            <TrendChart title="收支趋势（最近6个月）" data={trendData} height={350} loading={isLoading} />
          )}

          {/* 门店对比和分类占比 */}
          <Row gutter={[16, 16]}>
            <Col xs={24} lg={14}>
              {storeComparison.length > 0 && (
                <ComparisonBarChart
                  title="门店收支对比（前8名）"
                  data={storeComparison}
                  height={400}
                  loading={isLoading}
                />
              )}
            </Col>
            <Col xs={24} lg={10}>
              {categoryData.length > 0 && (
                <CategoryPieChart
                  title="支出分类占比（前10名）"
                  data={categoryData}
                  height={400}
                  loading={isLoading}
                />
              )}
            </Col>
          </Row>
        </Space>
      </Spin>
    </AppShell>
  );
}
