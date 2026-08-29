import { List, Card, Typography, Space, Badge, Tooltip, Button, Input, Select, Tag } from "antd";
import { SearchOutlined, FilterOutlined } from "@ant-design/icons";
import type { BankTransaction } from "@fin-hub/shared-types";
import { MoneyDisplay } from "./MoneyDisplay";
import { StatusBadge } from "./StatusBadge";
import { useState } from "react";

interface TransactionListProps {
  transactions: BankTransaction[];
  selectedId: string | null;
  onSelect: (transaction: BankTransaction) => void;
  loading?: boolean;
  stores: Map<string, { id: string; name: string }>;
}

export function TransactionList({ transactions, selectedId, onSelect, loading, stores }: TransactionListProps) {
  const [searchText, setSearchText] = useState("");
  const [filterStore, setFilterStore] = useState<string | null>(null);
  const [filterStatus, setFilterStatus] = useState<string | null>(null);

  const filteredTransactions = transactions.filter((t) => {
    const matchSearch =
      !searchText ||
      t.counterparty_name?.toLowerCase().includes(searchText.toLowerCase()) ||
      t.summary?.toLowerCase().includes(searchText.toLowerCase());

    const matchStore = !filterStore || t.store_id === filterStore;

    const remainingAmount = Number(t.amount) - Number(t.matched_amount || 0);
    const matchStatus =
      !filterStatus ||
      (filterStatus === "unmatched" && remainingAmount > 0) ||
      (filterStatus === "matched" && remainingAmount === 0);

    return matchSearch && matchStore && matchStatus;
  });

  const unmatchedCount = transactions.filter(
    (t) => Number(t.amount) - Number(t.matched_amount || 0) > 0,
  ).length;

  const storeOptions = Array.from(stores.values()).map((s) => ({ label: s.name, value: s.id }));

  return (
    <Card
      title={
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span>待匹配流水</span>
          <Badge count={unmatchedCount} style={{ backgroundColor: "#f59e0b" }} />
        </div>
      }
      style={{ height: "100%", display: "flex", flexDirection: "column" }}
      bodyStyle={{ flex: 1, padding: 0, overflow: "hidden", display: "flex", flexDirection: "column" }}
    >
      {/* 筛选栏 */}
      <div style={{ padding: "12px 16px", borderBottom: "1px solid #e5e7eb", backgroundColor: "#f9fafb" }}>
        <Space direction="vertical" size={8} style={{ width: "100%" }}>
          <Input
            placeholder="搜索对方户名或摘要..."
            prefix={<SearchOutlined style={{ color: "#9ca3af" }} />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            allowClear
          />

          <Space size={8} style={{ width: "100%" }}>
            <Select
              placeholder="门店"
              value={filterStore}
              onChange={setFilterStore}
              allowClear
              style={{ flex: 1 }}
              options={storeOptions}
              suffixIcon={<FilterOutlined />}
            />
            <Select
              placeholder="状态"
              value={filterStatus}
              onChange={setFilterStatus}
              allowClear
              style={{ flex: 1 }}
              options={[
                { label: "未匹配", value: "unmatched" },
                { label: "已完全匹配", value: "matched" },
              ]}
            />
          </Space>

          <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
            共 {filteredTransactions.length} 笔流水
          </Typography.Text>
        </Space>
      </div>

      {/* 流水列表 */}
      <div style={{ flex: 1, overflow: "auto" }}>
        <List
          loading={loading}
          dataSource={filteredTransactions}
          renderItem={(transaction) => {
            const isSelected = transaction.id === selectedId;
            const remainingAmount = Number(transaction.amount) - Number(transaction.matched_amount || 0);
            const isFullyMatched = remainingAmount === 0;
            const storeName = stores.get(transaction.store_id)?.name || "未知门店";

            return (
              <div
                onClick={() => !isFullyMatched && onSelect(transaction)}
                style={{
                  padding: "16px",
                  borderBottom: "1px solid #e5e7eb",
                  backgroundColor: isSelected ? "#f0f9f4" : "#ffffff",
                  borderLeft: isSelected ? "4px solid #2a9d66" : "4px solid transparent",
                  cursor: isFullyMatched ? "not-allowed" : "pointer",
                  opacity: isFullyMatched ? 0.5 : 1,
                  transition: "all 0.2s ease",
                }}
                onMouseEnter={(e) => {
                  if (!isFullyMatched && !isSelected) {
                    e.currentTarget.style.backgroundColor = "#f9fafb";
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isSelected) {
                    e.currentTarget.style.backgroundColor = "#ffffff";
                  }
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                      <Typography.Text strong style={{ fontSize: "14px" }}>
                        {transaction.counterparty_name || "未知对方"}
                      </Typography.Text>
                      {isFullyMatched && (
                        <Tag color="green" style={{ margin: 0, fontSize: "11px" }}>
                          已完全匹配
                        </Tag>
                      )}
                    </div>

                    <Space size={4} split={<span style={{ color: "#d1d5db" }}>•</span>}>
                      <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
                        {transaction.occurred_at.slice(0, 10)}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
                        {storeName}
                      </Typography.Text>
                      <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
                        {transaction.ledger_period}
                      </Typography.Text>
                    </Space>
                  </div>

                  <div style={{ textAlign: "right" }}>
                    <MoneyDisplay value={Number(transaction.amount)} size="medium" />
                  </div>
                </div>

                {Number(transaction.matched_amount || 0) > 0 && (
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: "12px",
                      color: "#6b7280",
                      marginTop: "8px",
                      paddingTop: "8px",
                      borderTop: "1px dashed #e5e7eb",
                    }}
                  >
                    <span>
                      已匹配 <MoneyDisplay value={Number(transaction.matched_amount)} size="small" />
                    </span>
                    <span>
                      剩余 <MoneyDisplay value={remainingAmount} size="small" colorize />
                    </span>
                  </div>
                )}

                {transaction.summary && (
                  <div
                    style={{
                      fontSize: "12px",
                      color: "#9ca3af",
                      marginTop: "6px",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {transaction.summary}
                  </div>
                )}
              </div>
            );
          }}
          locale={{
            emptyText: (
              <div style={{ padding: "40px 24px", textAlign: "center", color: "#9ca3af" }}>
                <div style={{ fontSize: "36px", marginBottom: "12px" }}>🎉</div>
                <Typography.Title level={5} style={{ color: "#6b7280", margin: "0 0 8px 0" }}>
                  {searchText || filterStore || filterStatus ? "未找到匹配的流水" : "所有流水已匹配"}
                </Typography.Title>
                <Typography.Text type="secondary" style={{ fontSize: "13px" }}>
                  {searchText || filterStore || filterStatus ? "尝试修改筛选条件" : "做得好！"}
                </Typography.Text>
              </div>
            ),
          }}
        />
      </div>
    </Card>
  );
}
