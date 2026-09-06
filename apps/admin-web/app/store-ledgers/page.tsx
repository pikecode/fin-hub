"use client";

import {
  Alert,
  Button,
  Card,
  Collapse,
  Empty,
  Input,
  Select,
  Space,
  Typography,
  Spin,
} from "antd";
import {
  FolderOutlined,
  BankOutlined,
  ShopOutlined,
  SearchOutlined,
  RightOutlined,
} from "@ant-design/icons";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import dayjs from "dayjs";
import type { Ledger, Store, StoreGroup } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";
import { getLedgers, getMyStores } from "../lib/referenceData";

interface StoreLedgerCard {
  store: Store;
}

function defaultLedgerPeriod() {
  return dayjs().subtract(1, "month").format("YYYY-MM");
}

function storeLedgerPath(storeId: string, period?: string | null) {
  const params = `?period=${encodeURIComponent(period || defaultLedgerPeriod())}`;
  return `/store-ledgers/${storeId}${params}`;
}

function StoreCard({ store, onClick }: {
  store: Store;
  onClick: () => void;
}) {
  return (
    <Card
      hoverable
      onClick={onClick}
      style={{
        height: "100%",
      }}
      styles={{
        body: { padding: 18 },
      }}
      >
        <Space align="center" size={10} style={{ width: "100%" }}>
        <div
          style={{
            width: 36,
            height: 36,
            borderRadius: 8,
            background: "rgba(20,184,166,0.1)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <ShopOutlined style={{ fontSize: 18, color: "#14b8a6" }} />
        </div>
        <Typography.Title level={5} style={{ margin: 0 }} ellipsis>
          {store.name}
        </Typography.Title>
        </Space>
        <Typography.Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
          {defaultLedgerPeriod()}
        </Typography.Text>
        <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end", color: "#14b8a6" }}>
          <Space size={4}>
            <BankOutlined />
            <Typography.Text style={{ fontSize: 12, color: "#14b8a6" }}>进入账套</Typography.Text>
            <RightOutlined style={{ fontSize: 10 }} />
          </Space>
        </div>
      </Card>
  );
}

export default function StoreLedgersPage() {
  const router = useRouter();
  const [stores, setStores] = useState<Store[]>([]);
  const [groups, setGroups] = useState<StoreGroup[]>([]);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
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
        const [storePage, ledgerPage, storeGroups] = await Promise.all([
          getMyStores(),
          getLedgers(),
          apiClient.stores.listGroups(),
        ]);
        if (!ignore) {
          setStores(storePage);
          setLedgers(ledgerPage);
          setGroups(storeGroups);
          setIsLoading(false);
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

  const cards: StoreLedgerCard[] = stores
    .filter((store) => statusFilter === "all" || store.status === "active")
    .filter((store) => {
      const value = keyword.trim().toLowerCase();
      if (!value) return true;
      return store.name.toLowerCase().includes(value);
    })
    .map((store) => ({ store }));

  // 按分组组织门店卡片
  const groupsById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);

  const groupedCards = useMemo(() => {
    const grouped = new Map<string, StoreLedgerCard[]>();
    const ungrouped: StoreLedgerCard[] = [];

    cards.forEach((card) => {
      const groupId = card.store.group_id;
      if (groupId) {
        if (!grouped.has(groupId)) {
          grouped.set(groupId, []);
        }
        grouped.get(groupId)!.push(card);
      } else {
        ungrouped.push(card);
      }
    });

    // 按分组的 sort_order 排序
    const sortedGroups = Array.from(grouped.entries())
      .sort((a, b) => {
        const groupA = groupsById.get(a[0]);
        const groupB = groupsById.get(b[0]);
        return (groupA?.sort_order ?? 999) - (groupB?.sort_order ?? 999);
      });

    return { sortedGroups, ungrouped };
  }, [cards, groupsById]);

  return (
      <AppShell
        title="门店账套"
        kicker="STORE LEDGERS"
      >
        <Space direction="vertical" size={24} style={{ width: "100%", display: "flex" }}>
        {errorMessage && (
          <Alert message="加载失败" description={errorMessage} type="error" showIcon closable />
        )}

          <Space wrap style={{ width: "100%", justifyContent: "space-between" }}>
            <Space wrap>
              <Input
                prefix={<SearchOutlined />}
                allowClear
                placeholder="搜索门店名称"
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
            </Space>
          </Space>

        {/* 门店卡片列表 */}
        <Space direction="vertical" size={24} style={{ width: "100%", display: "flex" }}>
          {cards.length ? (
            <>
              {/* 按分组显示 */}
          {groupedCards.sortedGroups.length > 0 && (
            <Collapse
              defaultActiveKey={groupedCards.sortedGroups.map(([groupId]) => groupId)}
              items={groupedCards.sortedGroups
                .map(([groupId, groupCards]) => {
                  const group = groupsById.get(groupId);
                  if (!group) return null;

                  return {
                    key: groupId,
                    label: (
                      <Space>
                        <FolderOutlined style={{ color: "#14b8a6" }} />
                        <span style={{ fontWeight: 500 }}>{group.name}</span>
                      </Space>
                    ),
                    children: (
                      <Space direction="vertical" size={12} style={{ width: "100%" }}>
                        {groupCards.map((card) => (
                          <StoreCard
                            key={card.store.id}
                            store={card.store}
                            onClick={() => router.push(storeLedgerPath(card.store.id))}
                          />
                        ))}
                      </Space>
                    ),
                    style: {
                      borderLeft: "4px solid #14b8a6",
                    },
                  };
                })
                .filter((item): item is NonNullable<typeof item> => item !== null)}
              style={{ width: "100%" }}
            />
          )}

              {/* 未分组门店 */}
          {groupedCards.ungrouped.length > 0 && (
            <Collapse
              defaultActiveKey={["ungrouped"]}
              items={[
                {
                  key: "ungrouped",
                  label: (
                    <Space>
                      <ShopOutlined />
                      <span style={{ fontWeight: 500 }}>未分组门店</span>
                    </Space>
                  ),
                  children: (
                    <Space direction="vertical" size={12} style={{ width: "100%" }}>
                      {groupedCards.ungrouped.map((card) => (
                        <StoreCard
                          key={card.store.id}
                          store={card.store}
                          onClick={() => router.push(storeLedgerPath(card.store.id))}
                        />
                      ))}
                    </Space>
                  ),
                  style: {
                    borderLeft: "4px solid #d1d5db",
                  },
                },
              ]}
              style={{ width: "100%" }}
            />
          )}
            </>
          ) : isLoading ? (
            <Card>
              <div style={{ textAlign: "center", padding: 48 }}>
                <Spin size="large" />
                <Typography.Text type="secondary" style={{ display: "block", marginTop: 16 }}>
                  加载门店数据...
                </Typography.Text>
              </div>
            </Card>
          ) : (
            <Card>
              <Empty
                description={keyword ? "未找到匹配门店" : "暂无门店数据"}
                image={Empty.PRESENTED_IMAGE_SIMPLE}
              >
                <Button type="primary" onClick={() => router.push("/stores")}>
                  添加门店
                </Button>
              </Empty>
            </Card>
          )}
        </Space>
      </Space>
    </AppShell>
  );
}
