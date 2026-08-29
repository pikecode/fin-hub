import { Card, Tag, Button, Space, Badge, Divider, Typography, Progress } from "antd";
import { CheckOutlined, CloseOutlined, SearchOutlined, ArrowRightOutlined } from "@ant-design/icons";
import type { BankTransaction, ExpenseItem, ExpenseBankMatch } from "@fin-hub/shared-types";
import { MoneyDisplay } from "./MoneyDisplay";
import { StatusBadge } from "./StatusBadge";
import type { CSSProperties } from "react";

interface MatchingSuggestion {
  expenseItem: ExpenseItem;
  matchedAmount: number;
  remainingAmount: number;
  confidence: number;
  reason: string;
  isExisting?: boolean;
}

interface MatchingPanelProps {
  selectedTransaction: BankTransaction | null;
  suggestions: MatchingSuggestion[];
  onConfirm: (expenseItemId: string, amount: number) => Promise<void>;
  onReject: (expenseItemId: string) => Promise<void>;
  onManualSearch: () => void;
  onNext: () => void;
  loading?: boolean;
  storeName?: string;
}

export function MatchingPanel({
  selectedTransaction,
  suggestions,
  onConfirm,
  onReject,
  onManualSearch,
  onNext,
  loading = false,
  storeName = "未知门店",
}: MatchingPanelProps) {
  if (!selectedTransaction) {
    return (
      <Card style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", padding: "60px 24px", color: "#9ca3af" }}>
          <div style={{ fontSize: "48px", marginBottom: "16px" }}>👈</div>
          <Typography.Title level={4} style={{ color: "#6b7280", margin: 0 }}>
            选择一笔流水开始匹配
          </Typography.Title>
          <Typography.Text type="secondary">点击左侧待匹配流水</Typography.Text>
        </div>
      </Card>
    );
  }

  const remainingAmount =
    Number(selectedTransaction.amount) - Number(selectedTransaction.matched_amount || 0);
  const matchProgress =
    ((Number(selectedTransaction.matched_amount || 0) / Number(selectedTransaction.amount)) * 100).toFixed(1);

  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 90) return "#059669";
    if (confidence >= 70) return "#f59e0b";
    return "#6b7280";
  };

  const getConfidenceBadge = (confidence: number) => {
    if (confidence >= 90) return { text: "高", color: "success" };
    if (confidence >= 70) return { text: "中", color: "warning" };
    return { text: "低", color: "default" };
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: "16px" }}>
      {/* 当前流水信息 */}
      <Card>
        <div style={{ marginBottom: "12px" }}>
          <Typography.Text type="secondary" style={{ fontSize: "12px", fontWeight: 600, textTransform: "uppercase" }}>
            当前选中流水
          </Typography.Text>
        </div>

        <Space direction="vertical" size={12} style={{ width: "100%" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography.Text strong style={{ fontSize: "16px" }}>
              {selectedTransaction.counterparty_name || "未知对方"}
            </Typography.Text>
            <MoneyDisplay value={Number(selectedTransaction.amount)} size="large" />
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: "12px" }}>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
                交易日期
              </Typography.Text>
              <div style={{ fontWeight: 600 }}>{selectedTransaction.occurred_at.slice(0, 10)}</div>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
                门店
              </Typography.Text>
              <div style={{ fontWeight: 600 }}>{storeName}</div>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
                已匹配金额
              </Typography.Text>
              <div>
                <MoneyDisplay value={Number(selectedTransaction.matched_amount || 0)} colorize />
              </div>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
                剩余金额
              </Typography.Text>
              <div>
                <MoneyDisplay value={remainingAmount} colorize />
              </div>
            </div>
          </div>

          {Number(selectedTransaction.matched_amount || 0) > 0 && (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "4px" }}>
                <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
                  匹配进度
                </Typography.Text>
                <Typography.Text style={{ fontSize: "12px", fontWeight: 600 }}>{matchProgress}%</Typography.Text>
              </div>
              <Progress percent={Number(matchProgress)} showInfo={false} strokeColor="#2a9d66" />
            </div>
          )}

          {selectedTransaction.summary && (
            <div>
              <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
                摘要
              </Typography.Text>
              <div style={{ fontSize: "13px", color: "#6b7280" }}>{selectedTransaction.summary}</div>
            </div>
          )}
        </Space>
      </Card>

      {/* 智能推荐匹配 */}
      <Card
        title={
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span>智能推荐匹配 ({suggestions.length})</span>
            {suggestions.length > 0 && (
              <Button
                type="link"
                size="small"
                icon={<SearchOutlined />}
                onClick={onManualSearch}
                style={{ padding: 0 }}
              >
                手动搜索
              </Button>
            )}
          </div>
        }
        style={{ flex: 1, overflow: "auto" }}
        bodyStyle={{ padding: "16px" }}
      >
        {suggestions.length === 0 ? (
          <div style={{ textAlign: "center", padding: "40px 24px", color: "#9ca3af" }}>
            <div style={{ fontSize: "36px", marginBottom: "12px" }}>🔍</div>
            <Typography.Title level={5} style={{ color: "#6b7280", margin: "0 0 8px 0" }}>
              无推荐匹配
            </Typography.Title>
            <Typography.Text type="secondary" style={{ fontSize: "13px" }}>
              未找到符合条件的支出明细
            </Typography.Text>
            <div style={{ marginTop: "24px" }}>
              <Button type="primary" icon={<SearchOutlined />} onClick={onManualSearch}>
                手动搜索匹配
              </Button>
            </div>
          </div>
        ) : (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {suggestions.map((suggestion, index) => {
              const badge = getConfidenceBadge(suggestion.confidence);
              const isFullMatch = suggestion.remainingAmount === Number(selectedTransaction.amount);

              return (
                <div
                  key={suggestion.expenseItem.id}
                  style={{
                    padding: "16px",
                    border: "1px solid #e5e7eb",
                    borderRadius: "8px",
                    backgroundColor: index === 0 && suggestion.confidence >= 90 ? "#f0f9f4" : "#ffffff",
                    borderLeft: index === 0 && suggestion.confidence >= 90 ? "4px solid #2a9d66" : undefined,
                    transition: "all 0.2s ease",
                    cursor: "pointer",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.boxShadow = "0 4px 12px rgba(0,0,0,0.08)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.boxShadow = "none";
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "8px" }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                        <Typography.Text strong style={{ fontSize: "14px" }}>
                          {suggestion.expenseItem.description}
                        </Typography.Text>
                        {isFullMatch && (
                          <Tag color="green" style={{ margin: 0, fontSize: "11px" }}>
                            完全匹配
                          </Tag>
                        )}
                      </div>

                      {suggestion.expenseItem.supplier_name && (
                        <Typography.Text type="secondary" style={{ fontSize: "12px" }}>
                          供应商: {suggestion.expenseItem.supplier_name}
                        </Typography.Text>
                      )}
                    </div>

                    <div style={{ textAlign: "right" }}>
                      <MoneyDisplay value={suggestion.remainingAmount} size="medium" />
                      <div style={{ marginTop: "4px" }}>
                        <Badge
                          status={badge.color as any}
                          text={
                            <span style={{ fontSize: "12px", color: getConfidenceColor(suggestion.confidence) }}>
                              匹配度 {suggestion.confidence}%
                            </span>
                          }
                        />
                      </div>
                    </div>
                  </div>

                  {suggestion.reason && (
                    <div
                      style={{
                        fontSize: "12px",
                        color: "#6b7280",
                        marginBottom: "12px",
                        padding: "8px",
                        backgroundColor: "#f9fafb",
                        borderRadius: "4px",
                      }}
                    >
                      💡 {suggestion.reason}
                    </div>
                  )}

                  <div style={{ display: "flex", gap: "8px" }}>
                    <Button
                      type={index === 0 && suggestion.confidence >= 90 ? "primary" : "default"}
                      icon={<CheckOutlined />}
                      onClick={() => onConfirm(suggestion.expenseItem.id, suggestion.remainingAmount)}
                      loading={loading}
                      block
                    >
                      确认匹配
                    </Button>
                    <Button
                      icon={<CloseOutlined />}
                      onClick={() => onReject(suggestion.expenseItem.id)}
                      loading={loading}
                    >
                      拒绝
                    </Button>
                  </div>
                </div>
              );
            })}
          </Space>
        )}
      </Card>

      {/* 底部操作栏 */}
      <div
        style={{
          display: "flex",
          gap: "12px",
          padding: "16px",
          backgroundColor: "#ffffff",
          borderTop: "1px solid #e5e7eb",
          borderRadius: "8px",
        }}
      >
        <Button onClick={onManualSearch} icon={<SearchOutlined />}>
          手动搜索
        </Button>
        <Button type="primary" onClick={onNext} icon={<ArrowRightOutlined />} style={{ marginLeft: "auto" }}>
          下一条未匹配
        </Button>
      </div>
    </div>
  );
}
