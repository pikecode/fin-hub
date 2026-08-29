import { Tag } from "antd";
import type { CSSProperties } from "react";

type StatusType =
  | "paid"
  | "unpaid"
  | "partial_paid"
  | "matched"
  | "unmatched"
  | "open"
  | "closed"
  | "pending"
  | "confirmed"
  | "rejected";

interface StatusBadgeProps {
  status: StatusType;
  text?: string;
  size?: "small" | "medium";
}

const statusConfig: Record<
  StatusType,
  { label: string; color: string; backgroundColor: string; borderColor: string }
> = {
  paid: {
    label: "已付款",
    color: "#065f46",
    backgroundColor: "#d1fae5",
    borderColor: "#6ee7b7",
  },
  unpaid: {
    label: "未付款",
    color: "#991b1b",
    backgroundColor: "#fee2e2",
    borderColor: "#fca5a5",
  },
  partial_paid: {
    label: "部分付款",
    color: "#92400e",
    backgroundColor: "#fef3c7",
    borderColor: "#fcd34d",
  },
  matched: {
    label: "已匹配",
    color: "#065f46",
    backgroundColor: "#d1fae5",
    borderColor: "#6ee7b7",
  },
  unmatched: {
    label: "未匹配",
    color: "#6b7280",
    backgroundColor: "#f3f4f6",
    borderColor: "#d1d5db",
  },
  open: {
    label: "待做账",
    color: "#92400e",
    backgroundColor: "#fef3c7",
    borderColor: "#fcd34d",
  },
  closed: {
    label: "已封账",
    color: "#065f46",
    backgroundColor: "#d1fae5",
    borderColor: "#6ee7b7",
  },
  pending: {
    label: "待处理",
    color: "#1e40af",
    backgroundColor: "#dbeafe",
    borderColor: "#93c5fd",
  },
  confirmed: {
    label: "已确认",
    color: "#065f46",
    backgroundColor: "#d1fae5",
    borderColor: "#6ee7b7",
  },
  rejected: {
    label: "已拒绝",
    color: "#991b1b",
    backgroundColor: "#fee2e2",
    borderColor: "#fca5a5",
  },
};

export function StatusBadge({ status, text, size = "medium" }: StatusBadgeProps) {
  const config = statusConfig[status];
  const label = text || config.label;

  const style: CSSProperties = {
    color: config.color,
    backgroundColor: config.backgroundColor,
    borderColor: config.backgroundColor,
    border: "none",
    fontSize: size === "small" ? "12px" : "13px",
    fontWeight: 600,
    padding: size === "small" ? "1px 6px" : "2px 10px",
    borderRadius: "4px",
  };

  return <Tag style={style}>{label}</Tag>;
}
