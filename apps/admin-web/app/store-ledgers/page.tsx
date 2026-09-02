"use client";

import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Input,
  Row,
  Select,
  Space,
  Statistic,
  Typography,
  Spin,
} from "antd";
import {
  BankOutlined,
  CalendarOutlined,
  EnvironmentOutlined,
  RightOutlined,
  SafetyCertificateOutlined,
  ShopOutlined,
  SearchOutlined,
  DollarOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { FinancialAnalyticsStoreItem, Ledger, Store } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { MoneyDisplay } from "../components/MoneyDisplay";
import { StatusBadge } from "../components/StatusBadge";
import { apiClient } from "../lib/api";
import { getLedgers, getMyStores } from "../lib/referenceData";

interface StoreLedgerCard {
  store: Store;
  ledger?: Ledger;
  analytics?: FinancialAnalyticsStoreItem;
}

function latestLedgerForStore(ledgers: Ledger[], storeId: string) {
  return ledgers
    .filter((ledger) => ledger.store_id === storeId)
    .sort((left, right) => right.period.localeCompare(left.period))[0];
}

function storeLedgerPath(storeId: string, period?: string) {
  const params = period ? `?period=${encodeURIComponent(period)}` : "";
  return `/store-ledgers/${storeId}${params}`;
}

export default function StoreLedgersPage() {
  const router = useRouter();
  const [stores, setStores] = useState<Store[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [analyticsStores, setAnalyticsStores] = useState<FinancialAnalyticsStoreItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<"active" | "all">("active");
  const [keyword, setKeyword] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function loadData() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const [storePage, ledgerPage] = await Promise.all([
          getMyStores(),
          getLedgers(),
        ]);
        if (!ignore) {
          setStores(storePage);
          setLedgers(ledgerPage);
          setIsLoading(false);
        }
        try {
          const analytics = await apiClient.reports.analytics();
          if (!ignore) {
            setAnalyticsStores(analytics.stores);
          }
        } catch {
          if (!ignore) {
            setAnalyticsStores([]);
          }
        }
      } catch (error) {
        if (!ignore) setErrorMessage(error instanceof Error ? error.message : "无法加载门店套帐");
      } finally {
        if (!ignore) setIsLoading(false);
      }
    }
    void loadData();
    return () => {
      ignore = true;
    };
  }, []);

  const analyticsByStoreId = useMemo(
    () => new Map(analyticsStores.map((item) => [item.store_id, item])),
    [analyticsStores],
  );

  const cards: StoreLedgerCard[] = stores
    .filter((store) => statusFilter === "all" || store.status === "active")
    .filter((store) => {
      const value = keyword.trim().toLowerCase();
      if (!value) return true;
      return [store.name, store.address].filter(Boolean).some((text) => String(text).toLowerCase().includes(value));
    })
    .map((store) => ({
      store,
      ledger: latestLedgerForStore(ledgers, store.id),
      analytics: analyticsByStoreId.get(store.id),
    }));

  // 统计数据
  const stats = useMemo(() => {
    const totalStores = stores.filter((s) => s.status === "active").length;
    const totalIncome = analyticsStores.reduce((sum, a) => sum + Number(a.income_amount || 0), 0);
    const totalUnmatched = analyticsStores.reduce((sum, a) => sum + (a.unmatched_bank_count || 0), 0);
    const totalPending = analyticsStores.reduce((sum, a) => sum + (a.pending_expense_count || 0), 0);

    return {
      totalStores,
      totalIncome,
      totalUnmatched,
      totalPending,
    };
  }, [stores, analyticsStores]);

  return (
    <AppShell
      title="门店账套"
      kicker="STORE LEDGERS"
      action={
        <Space>
          <Input
            prefix={<SearchOutlined />}
            allowClear
            placeholder="搜索门店名称或地址"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            style={{ width: 240 }}
          />
          <Select
            value={statusFilter}
            style={{ width: 140 }}
            options={[
              { label: "仅启用门店", value: "active" },
              { label: "全部门店", value: "all" },
            ]}
            onChange={setStatusFilter}
          />
          <Button onClick={() => router.push("/stores")}>门店管理</Button>
        </Space>
      }
    >
      <Space direction="vertical" size={24} style={{ width: "100%", display: "flex" }}>
        {/* 统计卡片 */}
        <Row gutter={16}>
          <Col span={6}>
            <Card>
              <Statistic
                title="启用门店"
                value={stats.totalStores}
                suffix="家"
                prefix={<ShopOutlined style={{ color: "#14b8a6" }} />}
                valueStyle={{ color: "#14b8a6" }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="本期总收入"
                value={stats.totalIncome}
                precision={2}
                prefix={<DollarOutlined style={{ color: "#10b981" }} />}
                valueStyle={{ color: "#10b981" }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="未匹配流水"
                value={stats.totalUnmatched}
                suffix="笔"
                prefix={<WarningOutlined style={{ color: "#f59e0b" }} />}
                valueStyle={{ color: stats.totalUnmatched > 0 ? "#f59e0b" : "#525252" }}
              />
            </Card>
          </Col>
          <Col span={6}>
            <Card>
              <Statistic
                title="待付款项"
                value={stats.totalPending}
                suffix="笔"
                prefix={<ClockCircleOutlined style={{ color: "#ef4444" }} />}
                valueStyle={{ color: stats.totalPending > 0 ? "#ef4444" : "#525252" }}
              />
            </Card>
          </Col>
        </Row>

        {errorMessage && (
          <Alert message="加载失败" description={errorMessage} type="error" showIcon closable />
        )}

        {/* 门店卡片列表 */}
        <Card
          title={
            <Space>
              <ShopOutlined />
              <span>门店列表</span>
              <Badge count={cards.length} style={{ backgroundColor: "#14b8a6" }} />
            </Space>
          }
          extra={
            isLoading && (
              <Space>
                <Spin size="small" />
                <Typography.Text type="secondary">加载中...</Typography.Text>
              </Space>
            )
          }
        >
          {cards.length ? (
            <Row gutter={[16, 16]}>
              {cards.map(({ store, ledger, analytics }) => {
                const hasIssues = (analytics?.unmatched_bank_count ?? 0) > 0 || (analytics?.pending_expense_count ?? 0) > 0;

                return (
                  <Col key={store.id} xs={24} sm={12} lg={8} xl={6}>
                    <Card
                      hoverable
                      onClick={() => router.push(storeLedgerPath(store.id, ledger?.period))}
                      style={{
                        height: "100%",
                        border: hasIssues ? "1px solid #fbbf24" : undefined,
                      }}
                      styles={{
                        body: { padding: 20 },
                      }}
                    >
                      {/* 顶部：门店信息 */}
                      <Space direction="vertical" size={12} style={{ width: "100%" }}>
                        <div style={{ display: "flex", alignItems: "flex-start", gap: 12 }}>
                          <div
                            style={{
                              width: 48,
                              height: 48,
                              borderRadius: 8,
                              background: "linear-gradient(135deg, #14b8a6 0%, #0d9488 100%)",
                              display: "flex",
                              alignItems: "center",
                              justifyContent: "center",
                              flexShrink: 0,
                            }}
                          >
                            <ShopOutlined style={{ fontSize: 24, color: "white" }} />
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <Typography.Title
                              level={5}
                              style={{ margin: 0, marginBottom: 4 }}
                              ellipsis
                            >
                              {store.name}
                            </Typography.Title>
                            <Typography.Text
                              type="secondary"
                              style={{ fontSize: 12 }}
                              ellipsis
                            >
                              <EnvironmentOutlined /> {store.address || "未填写地址"}
                            </Typography.Text>
                          </div>
                        </div>

                        {/* 状态标签 */}
                        <Space size={4} wrap>
                          <StatusBadge
                            status={store.status === "active" ? "active" : "inactive"}
                          />
                          {ledger ? (
                            <Badge
                              count={
                                <Space size={4}>
                                  <CalendarOutlined />
                                  <span>{ledger.period}</span>
                                </Space>
                              }
                              style={{
                                backgroundColor: ledger.status === "closed" ? "#10b981" : "#f59e0b",
                                fontSize: 12,
                              }}
                            />
                          ) : (
                            <Badge count="未建账套" style={{ backgroundColor: "#d1d5db" }} />
                          )}
                        </Space>

                        {/* 分隔线 */}
                        <div style={{ height: 1, background: "#f0f0f0", margin: "4px 0" }} />

                        {/* 指标 */}
                        <Space direction="vertical" size={8} style={{ width: "100%" }}>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              本期收入
                            </Typography.Text>
                            <MoneyDisplay value={Number(analytics?.income_amount ?? 0)} />
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              未匹配流水
                            </Typography.Text>
                            <Typography.Text
                              strong
                              style={{
                                color: (analytics?.unmatched_bank_count ?? 0) > 0 ? "#f59e0b" : "#525252",
                              }}
                            >
                              {analytics?.unmatched_bank_count ?? 0} 笔
                            </Typography.Text>
                          </div>
                          <div style={{ display: "flex", justifyContent: "space-between" }}>
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              待付款项
                            </Typography.Text>
                            <Typography.Text
                              strong
                              style={{
                                color: (analytics?.pending_expense_count ?? 0) > 0 ? "#ef4444" : "#525252",
                              }}
                            >
                              {analytics?.pending_expense_count ?? 0} 笔
                            </Typography.Text>
                          </div>
                        </Space>

                        {/* 底部：操作区 */}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            paddingTop: 8,
                            borderTop: "1px solid #f0f0f0",
                          }}
                        >
                          <Space size={4}>
                            {ledger?.status === "closed" ? (
                              <>
                                <SafetyCertificateOutlined style={{ color: "#10b981" }} />
                                <Typography.Text style={{ fontSize: 12, color: "#10b981" }}>
                                  已封账
                                </Typography.Text>
                              </>
                            ) : ledger ? (
                              <>
                                <ClockCircleOutlined style={{ color: "#f59e0b" }} />
                                <Typography.Text style={{ fontSize: 12, color: "#f59e0b" }}>
                                  做账中
                                </Typography.Text>
                              </>
                            ) : (
                              <>
                                <WarningOutlined style={{ color: "#d1d5db" }} />
                                <Typography.Text style={{ fontSize: 12, color: "#737373" }}>
                                  待初始化
                                </Typography.Text>
                              </>
                            )}
                          </Space>

                          <Space size={4} style={{ color: "#14b8a6", cursor: "pointer" }}>
                            <BankOutlined />
                            <Typography.Text style={{ fontSize: 12, color: "#14b8a6" }}>
                              进入账套
                            </Typography.Text>
                            <RightOutlined style={{ fontSize: 10 }} />
                          </Space>
                        </div>
                      </Space>
                    </Card>
                  </Col>
                );
              })}
            </Row>
          ) : isLoading ? (
            <div style={{ textAlign: "center", padding: 48 }}>
              <Spin size="large" />
              <Typography.Text type="secondary" style={{ display: "block", marginTop: 16 }}>
                加载门店数据...
              </Typography.Text>
            </div>
          ) : (
            <Empty
              description="暂无门店数据"
              image={Empty.PRESENTED_IMAGE_SIMPLE}
            >
              <Button type="primary" onClick={() => router.push("/stores")}>
                添加门店
              </Button>
            </Empty>
          )}
        </Card>
      </Space>
    </AppShell>
  );
}
