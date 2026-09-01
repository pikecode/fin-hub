"use client";

import {
  Alert,
  Badge,
  Button,
  Card,
  Col,
  Empty,
  Row,
  Select,
  Space,
  Statistic,
  Tag,
  Typography,
} from "antd";
import {
  BankOutlined,
  FileTextOutlined,
  ReconciliationOutlined,
  RightOutlined,
  ShopOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { FinancialAnalyticsStoreItem, Ledger, Store } from "@fin-hub/shared-types";
import { formatMoney } from "@fin-hub/shared-utils";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

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
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function loadData() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const [storePage, ledgerPage, analytics] = await Promise.all([
          apiClient.auth.myStores(),
          apiClient.ledgers.list("?page_size=500"),
          apiClient.reports.analytics(),
        ]);
        if (!ignore) {
          setStores(storePage);
          setLedgers(ledgerPage.items);
          setAnalyticsStores(analytics.stores);
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
    .map((store) => ({
      store,
      ledger: latestLedgerForStore(ledgers, store.id),
      analytics: analyticsByStoreId.get(store.id),
    }));

  return (
    <AppShell
      title="门店套帐"
      kicker="先选择门店，再进入该门店的银行流水、审批单、营业收入和对账管理"
      action={
        <Space>
          <Select
            value={statusFilter}
            options={[
              { label: "仅启用门店", value: "active" },
              { label: "全部门店", value: "all" },
            ]}
            onChange={setStatusFilter}
          />
          <Button onClick={() => router.push("/stores")}>维护门店资料</Button>
        </Space>
      }
    >
      {errorMessage ? <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon /> : null}
      <Card
        className="store-ledger-entry-panel"
        title="选择门店"
        loading={isLoading}
      >
        {cards.length ? (
          <Row gutter={[16, 16]}>
            {cards.map(({ store, ledger, analytics }) => (
              <Col key={store.id} xs={24} md={12} xl={8}>
                <button
                  type="button"
                  className="store-ledger-card"
                  onClick={() => router.push(storeLedgerPath(store.id, ledger?.period))}
                >
                  <div className="store-ledger-card__header">
                    <span className="store-ledger-card__icon">
                      <ShopOutlined />
                    </span>
                    <span className="store-ledger-card__title">
                      <Typography.Text strong>{store.name}</Typography.Text>
                      <Typography.Text type="secondary">{ledger?.period ?? "暂无账套"}</Typography.Text>
                    </span>
                    <RightOutlined />
                  </div>
                  <div className="store-ledger-card__status">
                    <Tag color={store.status === "active" ? "green" : "default"}>
                      {store.status === "active" ? "启用" : "停用"}
                    </Tag>
                    {ledger ? (
                      <Tag color={ledger.status === "closed" ? "green" : "gold"}>
                        {ledger.status === "closed" ? "已封账" : "做账中"}
                      </Tag>
                    ) : (
                      <Tag>未建账套</Tag>
                    )}
                  </div>
                  <Row gutter={12} className="store-ledger-card__metrics">
                    <Col span={8}>
                      <Statistic title="营业收入" value={formatMoney(analytics?.income_amount ?? 0)} />
                    </Col>
                    <Col span={8}>
                      <Statistic title="未匹配流水" value={analytics?.unmatched_bank_count ?? 0} />
                    </Col>
                    <Col span={8}>
                      <Statistic title="待付审批" value={analytics?.pending_expense_count ?? 0} />
                    </Col>
                  </Row>
                  <div className="store-ledger-card__actions">
                    <Badge status={(analytics?.unmatched_bank_count ?? 0) > 0 ? "warning" : "success"} />
                    <span>进入门店套帐</span>
                  </div>
                </button>
              </Col>
            ))}
          </Row>
        ) : (
          <Empty description="暂无可维护门店" />
        )}
      </Card>
      <Row gutter={[16, 16]} className="store-ledger-module-strip">
        <Col xs={24} md={6}>
          <Card><Statistic prefix={<BankOutlined />} title="银行流水" value="导入 / 录入" /></Card>
        </Col>
        <Col xs={24} md={6}>
          <Card><Statistic prefix={<FileTextOutlined />} title="审批单" value="同步 / 查看" /></Card>
        </Col>
        <Col xs={24} md={6}>
          <Card><Statistic prefix={<ReconciliationOutlined />} title="对账" value="候选 / 确认" /></Card>
        </Col>
        <Col xs={24} md={6}>
          <Card><Statistic prefix={<WalletOutlined />} title="营业收入" value="渠道 / 每日" /></Card>
        </Col>
      </Row>
    </AppShell>
  );
}
