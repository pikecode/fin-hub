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
import { getMyStores } from "../lib/referenceData";
import { confirmLeaveIfNeeded } from "./navigationGuard";

type StoreLedgerTabKey = "overview" | "bank" | "approvals" | "revenue" | "revenueMatching" | "matching" | "kuailvPurchase";

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
  { key: "revenueMatching", label: "收入对账", icon: <ReconciliationOutlined /> },
  { key: "matching", label: "审批单对账", icon: <ReconciliationOutlined /> },
  { key: "kuailvPurchase", label: "快驴采购录入", icon: <FileTextOutlined /> },
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
  if (key === "matching" || key === "kuailvPurchase") {
    const query = new URLSearchParams({ store_id: storeId });
    if (period) query.set("ledger_period", period);
    if (key === "kuailvPurchase") query.set("module", "kuailv");
    return `/finance/reconciliation?${query.toString()}`;
  }
  if (key === "revenueMatching") {
    const query = new URLSearchParams({ store_id: storeId });
    if (period) query.set("ledger_period", period);
    return `/finance/revenue-reconciliation?${query.toString()}`;
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
  const tabTargets = useMemo(
    () =>
      tabItems.map((item) => ({
        key: item.key,
        href: modulePath(storeId, item.key, period),
      })),
    [storeId, period],
  );
  const storeOptions = useMemo(
    () => stores.map((store) => ({ label: store.name, value: store.id })),
    [stores],
  );
  const canChangePeriod = activeKey !== "bank" && activeKey !== "matching" && activeKey !== "revenueMatching";

  useEffect(() => {
    let ignore = false;
    setIsStoreLoading(true);
    getMyStores()
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

  useEffect(() => {
    tabTargets.forEach((target) => {
      router.prefetch(target.href);
    });
  }, [router, tabTargets]);

  function navigateToTab(key: string) {
    const nextHref = modulePath(storeId, key as StoreLedgerTabKey, period);
    if (nextHref === window.location.pathname + window.location.search) return;
    if (!confirmLeaveIfNeeded()) return;
    router.push(nextHref);
  }

  function changePeriod(nextPeriod: string) {
    if (!confirmLeaveIfNeeded()) return;
    onPeriodChange?.(nextPeriod);
    router.push(modulePath(storeId, activeKey, nextPeriod));
  }

  function changeStore(nextStoreId: string) {
    if (!confirmLeaveIfNeeded()) return;
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
          {canChangePeriod && (period || periodOptions.length) ? (
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
          <Button onClick={() => {
            if (!confirmLeaveIfNeeded()) return;
            router.push("/store-ledgers");
          }}>门店入口</Button>
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
            <span className="store-ledger-workspace-tab-label">
              {item.icon}
              {item.label}
            </span>
          ),
        }))}
      />
    </div>
  );
}
