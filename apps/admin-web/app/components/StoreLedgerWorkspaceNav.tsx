"use client";

import { Button, Select, Space, Tabs, Tag, Typography } from "antd";
import {
  BankOutlined,
  DashboardOutlined,
  FileTextOutlined,
  ReconciliationOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { Store } from "@fin-hub/shared-types";
import { apiClient } from "../lib/api";

type StoreLedgerTabKey = "overview" | "bank" | "approvals" | "revenue" | "matching";

interface StoreLedgerWorkspaceNavProps {
  storeId: string;
  storeName?: string;
  period?: string;
  periodOptions?: Array<{ label: string; value: string }>;
  statusLabel?: string;
  ledgerStatusLabel?: string;
  activeKey: StoreLedgerTabKey;
  onPeriodChange?: (period: string) => void;
  extra?: any;
}

const tabItems: Array<{ key: StoreLedgerTabKey; label: string; icon: any }> = [
  { key: "overview", label: "总览", icon: <DashboardOutlined /> },
  { key: "bank", label: "银行流水", icon: <BankOutlined /> },
  { key: "approvals", label: "审批单", icon: <FileTextOutlined /> },
  { key: "revenue", label: "营业收入", icon: <WalletOutlined /> },
  { key: "matching", label: "对账管理", icon: <ReconciliationOutlined /> },
];

function modulePath(storeId: string, key: StoreLedgerTabKey, period?: string) {
  if (key === "overview") {
    const params = period ? `?period=${encodeURIComponent(period)}` : "";
    return `/store-ledgers/${storeId}${params}`;
  }
  if (key === "bank") {
    const query = new URLSearchParams({ store_id: storeId });
    if (period) query.set("ledger_period", period);
    return `/bank?${query.toString()}`;
  }
  if (key === "revenue") {
    const query = new URLSearchParams({ store_id: storeId });
    if (period) query.set("ledger_period", period);
    return `/revenue?${query.toString()}`;
  }
  if (key === "matching") {
    const query = new URLSearchParams({ store_id: storeId });
    if (period) query.set("ledger_period", period);
    return `/finance/reconciliation?${query.toString()}`;
  }
  const params = period ? `?period=${encodeURIComponent(period)}` : "";
  return `/store-ledgers/${storeId}/approvals${params}`;
}

export function StoreLedgerWorkspaceNav({
  storeId,
  storeName,
  period,
  periodOptions = [],
  statusLabel,
  ledgerStatusLabel,
  activeKey,
  onPeriodChange,
  extra,
}: StoreLedgerWorkspaceNavProps) {
  const router = useRouter();
  const [stores, setStores] = useState<Store[]>([]);
  const [isStoreLoading, setIsStoreLoading] = useState(false);
  const storeOptions = useMemo(
    () => stores.map((store) => ({ label: store.name, value: store.id })),
    [stores],
  );

  useEffect(() => {
    let ignore = false;
    setIsStoreLoading(true);
    apiClient.auth.myStores()
      .then((items) => {
        if (!ignore) setStores(items);
      })
      .catch(() => {
        if (!ignore && storeName) setStores([{ id: storeId, name: storeName, status: "active" } as Store]);
      })
      .finally(() => {
        if (!ignore) setIsStoreLoading(false);
      });
    return () => {
      ignore = true;
    };
  }, [storeId, storeName]);

  function navigateToTab(key: string) {
    router.push(modulePath(storeId, key as StoreLedgerTabKey, period));
  }

  function changePeriod(nextPeriod: string) {
    onPeriodChange?.(nextPeriod);
    router.push(modulePath(storeId, activeKey, nextPeriod));
  }

  function changeStore(nextStoreId: string) {
    router.push(modulePath(nextStoreId, activeKey, period));
  }

  return (
    <div className="store-ledger-workspace-nav">
      <div className="store-ledger-workspace-nav__header">
        <div className="store-ledger-workspace-nav__title">
          <Typography.Text className="store-ledger-workspace-nav__eyebrow">当前门店套帐</Typography.Text>
          <Space wrap size={8}>
            <Typography.Title level={4}>{storeName || "门店"}</Typography.Title>
            {statusLabel ? <Tag color={statusLabel === "启用门店" ? "green" : "default"}>{statusLabel}</Tag> : null}
            {ledgerStatusLabel ? <Tag color={ledgerStatusLabel === "已封账" ? "green" : "gold"}>{ledgerStatusLabel}</Tag> : null}
            {period ? <Tag>账期 {period}</Tag> : null}
          </Space>
        </div>
        <Space wrap>
          {period || periodOptions.length ? (
            <Select
              value={period}
              placeholder="选择账期"
              options={periodOptions.length ? periodOptions : period ? [{ label: period, value: period }] : []}
              onChange={changePeriod}
              className="store-ledger-period-select"
            />
          ) : null}
          <Select
            showSearch
            optionFilterProp="label"
            value={storeId}
            loading={isStoreLoading}
            options={storeOptions.length ? storeOptions : [{ label: storeName || "当前门店", value: storeId }]}
            onChange={changeStore}
            className="store-ledger-store-select"
          />
          <Button onClick={() => router.push("/store-ledgers")}>门店入口</Button>
          {extra}
        </Space>
      </div>
      <Tabs
        className="store-ledger-workspace-tabs"
        activeKey={activeKey}
        onChange={navigateToTab}
        items={tabItems.map((item) => ({
          key: item.key,
          label: (
            <span>
              {item.icon}
              {item.label}
            </span>
          ),
        }))}
      />
    </div>
  );
}
