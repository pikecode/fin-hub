import { Typography } from "antd";
import type { CSSProperties } from "react";

interface MoneyDisplayProps {
  value: number;
  currency?: string;
  colorize?: boolean;
  size?: "small" | "medium" | "large";
  showSign?: boolean;
  className?: string;
}

export function MoneyDisplay({
  value,
  currency = "¥",
  colorize = false,
  size = "medium",
  showSign = false,
  className = "",
}: MoneyDisplayProps) {
  const isNegative = value < 0;
  const isZero = value === 0;
  const absValue = Math.abs(value);

  const sizeStyles: Record<string, CSSProperties> = {
    small: { fontSize: "14px" },
    medium: { fontSize: "16px" },
    large: { fontSize: "24px", fontWeight: 700 },
  };

  const colorStyle: CSSProperties = colorize
    ? isZero
      ? { color: "#9ca3af" }
      : isNegative
        ? { color: "#dc2626" }
        : { color: "#111827" }
    : {};

  const sign = showSign && !isZero ? (isNegative ? "-" : "+") : isNegative ? "-" : "";

  return (
    <Typography.Text
      className={`money-cell ${className}`}
      style={{
        fontVariantNumeric: "tabular-nums",
        fontWeight: 600,
        fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Mono', 'Consolas', 'Monaco', monospace",
        ...sizeStyles[size],
        ...colorStyle,
      }}
    >
      {sign}
      {currency}
      {absValue.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
    </Typography.Text>
  );
}
