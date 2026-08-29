import { Card, Typography, Space, Button } from "antd";
import { ArrowUpOutlined, ArrowDownOutlined, MinusOutlined } from "@ant-design/icons";
import type { CSSProperties } from "react";

interface MetricCardProps {
  title: string;
  value: number | string;
  unit?: string;
  trend?: {
    value: number;
    direction: "up" | "down" | "flat";
    period?: string;
  };
  status?: "normal" | "warning" | "danger";
  action?: {
    label: string;
    onClick: () => void;
  };
  loading?: boolean;
}

export function MetricCard({ title, value, unit, trend, status = "normal", action, loading }: MetricCardProps) {
  const cardStyle: CSSProperties = {
    position: "relative",
    borderLeft: status === "warning" ? "4px solid #f59e0b" : status === "danger" ? "4px solid #dc2626" : undefined,
  };

  const getTrendIcon = () => {
    if (!trend) return null;
    if (trend.direction === "up") return <ArrowUpOutlined style={{ fontSize: "12px" }} />;
    if (trend.direction === "down") return <ArrowDownOutlined style={{ fontSize: "12px" }} />;
    return <MinusOutlined style={{ fontSize: "12px" }} />;
  };

  const getTrendStyle = (): CSSProperties => {
    if (!trend) return {};
    const baseStyle: CSSProperties = {
      display: "inline-flex",
      alignItems: "center",
      gap: "4px",
      padding: "2px 8px",
      borderRadius: "12px",
      fontSize: "12px",
      fontWeight: 600,
    };

    if (trend.direction === "up") {
      return { ...baseStyle, color: "#059669", backgroundColor: "rgba(5, 150, 105, 0.1)" };
    }
    if (trend.direction === "down") {
      return { ...baseStyle, color: "#dc2626", backgroundColor: "rgba(220, 38, 38, 0.1)" };
    }
    return { ...baseStyle, color: "#6b7280", backgroundColor: "#f3f4f6" };
  };

  return (
    <Card style={cardStyle} loading={loading} bodyStyle={{ padding: "24px" }}>
      <Space direction="vertical" size={8} style={{ width: "100%" }}>
        <Typography.Text type="secondary" style={{ fontSize: "14px", fontWeight: 500 }}>
          {title}
        </Typography.Text>

        <Typography.Title
          level={2}
          style={{
            margin: "8px 0 0",
            fontSize: "36px",
            fontWeight: 700,
            fontFeatureSettings: "'tnum'",
            lineHeight: 1.2,
            color: "#111827",
          }}
        >
          {value}
          {unit && (
            <Typography.Text style={{ fontSize: "16px", marginLeft: "4px", color: "#6b7280" }}>
              {unit}
            </Typography.Text>
          )}
        </Typography.Title>

        <Space size={12} style={{ marginTop: "8px" }}>
          {trend && (
            <span style={getTrendStyle()}>
              {getTrendIcon()}
              {Math.abs(trend.value)}%{trend.period && ` ${trend.period}`}
            </span>
          )}

          {action && (
            <Button type="link" size="small" onClick={action.onClick} style={{ padding: 0, height: "auto" }}>
              {action.label} →
            </Button>
          )}
        </Space>
      </Space>
    </Card>
  );
}
