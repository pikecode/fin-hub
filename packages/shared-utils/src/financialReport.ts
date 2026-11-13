import type { FinancialReportSupplement, StoreLedgerWorkspace } from "@fin-hub/shared-types";
import { formatMoney } from "./index";

export interface ReportMetric { title: string; value: string; hint?: string; tone?: "primary" | "muted"; }
export interface ReportGroup { title: string; items: ReportMetric[]; }
export const reportPercent = (amount: string | number, total: string | number) => Number(total) > 0 ? `${(Number(amount) / Number(total) * 100).toFixed(2)}%` : "—";
const cash = (value: string | null | undefined) => value == null ? "待录入" : formatMoney(value);
export function reportGroups(data: StoreLedgerWorkspace, extra: FinancialReportSupplement): ReportGroup[] {
  const m = data.metrics;
  return [
    { title: "门店营收", items: [
      { title: "营业收入", value: formatMoney(m.income_amount), tone: "primary" },
      { title: "本月业绩目标", value: cash(extra.revenue_target) },
      { title: "业绩完成率", value: reportPercent(m.income_amount, extra.revenue_target || 0) },
      { title: "实收", value: formatMoney(m.revenue_net_amount), tone: "muted" },
      { title: "手续费", value: formatMoney(m.fee_amount), tone: "muted" },
      { title: "手续费率", value: reportPercent(m.fee_amount, m.income_amount), tone: "muted" },
    ] },
    { title: "门店支出", items: [
      { title: "总支出", value: formatMoney(m.expense_amount), tone: "primary" },
      { title: "营业毛利率", value: reportPercent(m.gross_profit_amount, m.income_amount), hint: `食材成本 ${formatMoney(m.food_cost_amount)}` },
      { title: "营运费用占比", value: reportPercent(m.operation_expense_amount, m.income_amount), hint: `运营费用 ${formatMoney(m.operation_expense_amount)}` },
      { title: "薪资占比", value: reportPercent(m.labor_cost_amount, m.income_amount), hint: `人工成本 ${formatMoney(m.labor_cost_amount)}` },
      ...(extra.accrual_totals && Object.values(extra.accrual_totals).some(value => Number(value) !== 0) ? [
        { title: "本月计提", value: formatMoney(extra.accrual_totals.accrual), hint: "已包含在总支出中" },
        { title: "本月补提", value: formatMoney(extra.accrual_totals.supplement), hint: "已包含在总支出中" },
        { title: "本月冲销", value: formatMoney(extra.accrual_totals.reversal), hint: "已从总支出中扣减" },
      ] : []),
    ] },
    { title: "资金流情况", items: [{ title: "其他应收款 · 外借款", value: cash(extra.loan_receivable_amount || "0"), hint: "截至本月末未归还本金，不计入经营利润" }, { title: "银行卡余额", value: extra.bank_balance.status === "ready" ? cash(extra.bank_balance.amount) : extra.bank_balance.status === "pending" ? "待到期" : extra.bank_balance.status === "missing_manual" ? "待录入" : "未录入余额基准", tone: "primary", hint: extra.bank_balance.source === "manual" ? `截至 ${extra.bank_balance.date} 余额` : `${extra.bank_balance.date} 日终余额` }] },
    { title: "利润分红", items: [
      { title: "本月净利润", value: formatMoney(Number(m.income_amount) - Number(m.expense_amount)), hint: "财务报表净利润", tone: "primary" },
      { title: "上月末未分配利润", value: extra.dividend_excluded ? "隔离前" : cash(extra.previous_remaining_undistributed), hint: "上月结余；启用首月取期初未分配利润" },
      { title: "剩余未分配利润", value: extra.dividend_excluded ? "隔离前" : cash(extra.remaining_undistributed), hint: extra.dividend_excluded ? `自 ${extra.dividend_start_period} 起计算` : "分红管理当月余额" },
      { title: "本月分红", value: formatMoney(extra.distribution_amount) },
      { title: "本月补充筹建超支", value: formatMoney(extra.preopening_coverage_amount || "0"), hint: "扣减未分配利润，不计入股东分红" },
      { title: "本月运营增资", value: formatMoney(extra.capital_amount) },
      { title: "历史累计利润", value: cash(extra.historical_profit), hint: "期初历史利润＋启用后净利润，截至本月" },
      { title: "历史累计分红", value: formatMoney(extra.cumulative_distribution), hint: "期初历史分红＋启用后分红，截至本月" },
    ] },
    { title: "投入与累计", items: [
      { title: "筹建投入资金", value: formatMoney(extra.preopening_investment), hint: "门店筹建资料" },
      { title: "筹建费用总支出", value: extra.preopening_expense_source === "missing" ? "待录入" : formatMoney(extra.preopening_expense_amount), hint: extra.preopening_expense_source === "manual" ? "人工录入" : extra.preopening_expense_source === "missing" ? "筹建报表未封账" : "已封账筹建报表总支出" },
      { title: extra.preopening_balance == null ? "筹建结余/超支" : Number(extra.preopening_balance) < 0 ? "筹建超支" : "筹建结余", value: extra.preopening_balance == null ? "待计算" : formatMoney(Math.abs(Number(extra.preopening_balance))), hint: extra.preopening_balance == null ? undefined : `经营利润已补充 ${formatMoney(extra.preopening_profit_covered || "0")} / 超支未补充 ${formatMoney(extra.preopening_uncovered || "0")}` },
      { title: "累计投入", value: formatMoney(extra.total_capital), hint: "筹建投入＋截至本月运营增资" },
      { title: "累计分红", value: formatMoney(extra.cumulative_distribution), hint: "截至本月" },
    ] },
  ];
}
export interface ReportCategory { historical_amount?: string; key: string; name: string; amount: string; item_count: number; share: string; revenue_share: string; children?: ReportCategory[]; }
export function reportCategorySections(categories: ReportCategory[], totalExpense: string, foodCost: string) {
  return [
    { title: "食材成本", amount: foodCost || "0", rows: categories.filter(item => item.name === "食材成本") },
    { title: "运营支出", amount: String(Number(totalExpense || 0) - Number(foodCost || 0)), rows: categories.filter(item => item.name !== "食材成本") },
  ];
}

export function buildReportCategories(data: StoreLedgerWorkspace, extra: FinancialReportSupplement): ReportCategory[] {
  const m = data.metrics;
  const roots = new Map<string, ReportCategory>();
  function root(name: string) {
    if (!roots.has(name)) roots.set(name, { key: name, name, amount: "0", item_count: 0, share: "—", revenue_share: "—", children: [] });
    return roots.get(name)!;
  }
  for (const item of m.expense_category_summary) {
    const [l1, l2] = item.name.split(" / "); const r = root(l1);
    r.amount = String(Number(r.amount) + Number(item.amount)); r.item_count += item.item_count;
    if (l2) r.children!.push({key: item.name, name: l2, amount: item.amount, item_count: item.item_count,
      share: reportPercent(item.amount, m.expense_amount), revenue_share: reportPercent(item.amount, m.income_amount)});
  }
  for (const item of extra.historical_category_expenses || []) {
    const [l1, l2] = item.name.split(" / "); const r = root(l1);
    r.historical_amount = String(Number(r.historical_amount || 0) + Number(item.amount));
    if (l2) { const child = r.children!.find(c => c.key === item.name);
      if (child) child.historical_amount = item.amount;
      else r.children!.push({key: item.name, name: l2, amount: "0", item_count: 0, historical_amount: item.amount, share: reportPercent(0,m.expense_amount), revenue_share: reportPercent(0,m.income_amount)});
    }
  }
  return [...roots.values()].map(r => ({...r, share: reportPercent(r.amount,m.expense_amount), revenue_share: reportPercent(r.amount,m.income_amount), children:r.children?.sort((a,b)=>Number(b.amount)-Number(a.amount))})).sort((a,b)=>Number(b.amount)-Number(a.amount));
}
