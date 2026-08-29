export function formatPeriod(period: string): string {
  const [year, month] = period.split("-");
  return year && month ? `${year}年${month}月` : period;
}

export function formatMoney(value: number | string): string {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return "¥0.00";
  return new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
  }).format(numeric);
}
