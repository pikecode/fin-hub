import type { DividendWorkspace } from "@fin-hub/shared-types";

export const ALL_STORES = "__all__";

function addValues(...values: Array<string | number | undefined>) {
  return values.reduce<number>((sum, value) => sum + Number(value || 0), 0).toFixed(2);
}

function mergeMonths(rows: Array<DividendWorkspace["current"]>) {
  const first = rows[0];
  const activeRows = rows.filter((row) => !row.excluded_from_calculation);
  const entries = new Map<string, DividendWorkspace["current"]["entries"][number]>();
  activeRows.flatMap((row) => row.entries).forEach((entry) => {
    const key = `${entry.entry_type}:${entry.shareholder_name}`;
    const previous = entries.get(key);
    entries.set(key, previous ? { ...previous, amount: addValues(previous.amount, entry.amount), holding_ratio: addValues(previous.holding_ratio, entry.holding_ratio) } : { ...entry, id: key });
  });
  return {
    ...first,
    id: `all:${first.period}`,
    store_id: ALL_STORES,
    excluded_from_calculation: activeRows.length === 0,
    available_profit: activeRows.some((row) => row.available_profit == null) ? null : addValues(...activeRows.map((row) => row.available_profit ?? "0")),
    profit_source: "report" as const,
    net_profit: addValues(...activeRows.map((row) => row.net_profit)),
    distribution_amount: addValues(...activeRows.map((row) => row.distribution_amount)),
    capital_amount: addValues(...activeRows.map((row) => row.capital_amount)),
    historical_profit: addValues(...activeRows.map((row) => row.historical_profit)),
    historical_distribution: addValues(...activeRows.map((row) => row.historical_distribution)),
    remaining_undistributed: activeRows.some((row) => row.remaining_undistributed === null) ? null : addValues(...activeRows.map((row) => row.remaining_undistributed ?? "0")),
    cumulative_capital: addValues(...activeRows.map((row) => row.cumulative_capital)),
    suggested_distribution: addValues(...activeRows.map((row) => row.suggested_distribution)),
    reference_ratio: "—",
    locked: activeRows.every((row) => row.locked),
    no_distribution: activeRows.every((row) => row.no_distribution),
    no_capital: activeRows.every((row) => row.no_capital),
    entries: [...entries.values()],
  };
}

export function mergeWorkspaces(items: DividendWorkspace[], period: string): DividendWorkspace {
  const byPeriod = new Map<string, DividendWorkspace["history"]>();
  items.forEach((item) => item.history.forEach((row) => byPeriod.set(row.period, [...(byPeriod.get(row.period) ?? []), row])));
  const history = [...byPeriod.entries()].sort(([left], [right]) => right.localeCompare(left)).map(([, rows]) => mergeMonths(rows));
  const current = history.find((row) => row.period === period) ?? mergeMonths(items.map((item) => item.current));
  const shareholders = new Map<string, DividendWorkspace["shareholders"][number]>();
  items.flatMap((item) => item.shareholders).forEach((item) => {
    const previous = shareholders.get(item.name);
    shareholders.set(item.name, previous ? { ...previous, holding_ratio: addValues(previous.holding_ratio, item.holding_ratio) } : { ...item, id: `all:${item.name}` });
  });
  return {
    store: { ...items[0].store, id: ALL_STORES, name: "全公司合并" },
    period,
    available_periods: [...new Set(items.flatMap((item) => item.available_periods ?? []))].sort().reverse(),
    shareholders: [...shareholders.values()],
    current,
    history,
    opening: items.every((item) => item.opening?.configured) ? { ...items[0].opening!, configured: true, start_period: null } : null,
    warnings: items.filter((item) => !item.opening?.configured).map((item) => `${item.store.name}尚未配置期初，暂沿用旧口径`),
    funding: {
      preopening_investment: addValues(...items.filter((item) => !item.current.excluded_from_calculation).map((item) => item.funding?.preopening_investment)),
      preopening_expense_amount: addValues(...items.filter((item) => !item.current.excluded_from_calculation).map((item) => item.funding?.preopening_expense_amount)),
      preopening_expense_override: null, preopening_expense_source: "report",
    },
  };
}

