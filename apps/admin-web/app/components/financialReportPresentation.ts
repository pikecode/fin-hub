import type { FinancialReportAppendix, FinancialReportSupplement, MajorExpenseVoucher, StoreLedgerWorkspace } from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";

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
    ] },
    { title: "资金流情况", items: [{ title: "银行卡余额", value: extra.bank_balance.status === "ready" ? cash(extra.bank_balance.amount) : extra.bank_balance.status === "pending" ? "待到期" : "未录入余额基准", tone: "primary", hint: `${extra.bank_balance.date} 日终余额` }] },
    { title: "利润分红", items: [
      { title: "本月净利润", value: formatMoney(Number(m.income_amount) - Number(m.expense_amount)), hint: "财务报表净利润", tone: "primary" },
      { title: "剩余未分配利润", value: extra.dividend_excluded ? "隔离前" : cash(extra.remaining_undistributed), hint: extra.dividend_excluded ? `自 ${extra.dividend_start_period} 起计算` : "分红管理当月余额" },
      { title: "本月分配利润", value: formatMoney(extra.distribution_amount) },
      { title: "本月运营增资", value: formatMoney(extra.capital_amount) },
    ] },
    { title: "投入与累计", items: [
      { title: "筹建投入资金", value: formatMoney(extra.preopening_investment), hint: "门店筹建资料" },
      { title: "筹建费用总支出", value: formatMoney(extra.preopening_expense_amount), hint: extra.preopening_expense_source === "manual" ? "人工录入" : "筹建报表累计支出" },
      { title: "累计增资", value: formatMoney(extra.total_capital), hint: "筹建投入＋截至本月运营增资" },
      { title: "累计分红", value: formatMoney(extra.cumulative_distribution), hint: "截至本月" },
    ] },
  ];
}
export interface ReportCategory { key: string; name: string; amount: string; item_count: number; share: string; revenue_share: string; children?: ReportCategory[]; }
const esc = (v: unknown) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const day = (value?: string | null) => value ? value.slice(0, 10) : "—";
const percent = (value: unknown) => value == null ? "—" : `${value}%`;
const special: Record<string, string> = { current_account: "往来款", shareholder_dividend: "股东分红", shareholder_capital: "股东注资", other_income_expense: "其他收支", counter_refund: "退款", loan_repayment: "借还款", bank_interest: "银行结息", bank_fee: "银行手续费", bank_sms_fee: "银行短信费", bank_other_expense: "银行其他支出" };
export function financialReportHtml(data: StoreLedgerWorkspace, extra: FinancialReportSupplement, appendix: FinancialReportAppendix, categories: ReportCategory[], vouchers: MajorExpenseVoucher[]) {
  const metrics = data.metrics;
  const groups = reportGroups(data, extra).map((group) => `<section class="${group.title === "门店支出" ? "expense-group" : ""}"><h2>${group.title}</h2><div class="metrics metrics--${group.items.length} ${group.title === "门店支出" ? "expense-metrics" : ""}">${group.items.map((item) => `<div class="metric ${item.tone || ""}"><label>${esc(item.title)}</label><strong>${esc(item.value)}</strong>${item.hint ? `<small>${esc(item.hint)}</small>` : ""}</div>`).join("")}</div></section>`).join("");
  const channels = [...metrics.revenue_channel_summary].sort((a, b) => Number(b.gross_amount) - Number(a.gross_amount));
  const maxChannel = Math.max(0, ...channels.map((item) => Number(item.gross_amount)), ...channels.map((item) => Number(item.net_amount)));
  const channelChart = channels.map((item) => `<div class="channel-row"><b>${esc(item.channel)}</b>${[["营业收入", item.gross_amount], ["实收", item.net_amount]].map(([label, amount], index) => `<div class="channel-line"><label>${label}</label><div class="track"><i style="width:${maxChannel ? Math.max(0, Number(amount)) / maxChannel * 100 : 0}%;background:${index ? "#84b8ad" : "#0f766e"}"></i></div><span>${esc(formatMoney(amount))}</span></div>`).join("")}</div>`).join("");
  const table = (headers: string[], rows: string[], empty = "暂无数据") => `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${headers.length}">${empty}</td></tr>`}</tbody></table>`;
  const row = (cells: string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
  const costRows = [["食材成本", metrics.food_cost_amount, metrics.food_cost_rate], ["人工成本", metrics.labor_cost_amount, metrics.labor_cost_rate], ["租金成本", metrics.rent_cost_amount, metrics.rent_cost_rate]].map(([name, amount, rate]) => row([esc(name), esc(formatMoney(String(amount))), `<div class="track"><i style="width:${Math.min(Math.max(Number(rate || 0), 0), 100)}%;background:#d65a37"></i></div>`, percent(rate)]));
  const categoryRows = categories.flatMap((item) => [row([`<b>${esc(item.name)}</b>`, esc(formatMoney(item.amount)), item.revenue_share, item.share]), ...(item.children || []).map((child) => row([`　${esc(child.name)}`, esc(formatMoney(child.amount)), child.revenue_share, child.share]))]);
  const expenseRows = appendix.expense_items.map((item) => row([esc(item.category_l1 || "未分类"), esc(item.category_l2 || "—"), esc(item.description), day(item.application_date || item.expense_date), esc(formatMoney(item.amount))]));
  const appendixRows = appendix.rows.map(({ transaction: bank, business }) => {
    const content = business.map((item) => item.kind === "income"
      ? `${esc(item.description)}：营业收入日期 ${day(item.revenue_start)} 至 ${day(item.revenue_end)}；关联金额 ${esc(formatMoney(item.accounting_amount))}`
      : `${esc(item.approval_no || "审批报销")} · 申请日期 ${day(item.application_date)}<br>${(item.expense_details?.length ? item.expense_details : [item]).map((detail) => `${esc([detail.category_l1, detail.category_l2].filter(Boolean).join(" / "))} ${esc(detail.description)}${"amount" in detail ? ` ${esc(formatMoney(String(detail.amount)))}` : ""}`).join("<br>")}<br>确认入账金额 ${esc(formatMoney(item.accounting_amount))}${item.settlement_group ? "（整组审批金额，多笔实付共同关联，不重复累计）" : item.shared_accounting_amount ? "（审批单本月总额，多笔匹配共享，不重复累计）" : ""}`).join("<hr>");
    return row([day(bank.occurred_at), bank.direction === "income" ? "收入" : "支出", esc(bank.counterparty_name || "—"), esc(formatMoney(bank.amount)), esc(special[bank.direct_posting_type || bank.special_type || ""] || bank.special_type || "普通流水"), content || esc(bank.summary || "—")]);
  });
  const voucherRows = vouchers.map((item) => row([esc(item.expense_name), esc(item.ledger_period), esc(formatMoney(item.display_amount)), `${item.attachment_count} 份`, esc(item.remark || "—")]));
  const style = `@page{size:A4 portrait;margin:12mm 12mm 17mm} .financial-export,.financial-export *{box-sizing:border-box}.financial-export{max-width:760px;margin:auto;padding:24px;color:#263c44;background:white;font:12px/1.6 Arial,"PingFang SC","Microsoft YaHei",sans-serif}header{padding:24px;background:#143d43;border-radius:12px;color:white;margin-bottom:20px}header h1{font-size:25px;margin:5px 0}header p{margin:0;opacity:.8}section{margin:0 0 22px}h2{font-size:17px;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid #dae5e5;color:#20484c;break-after:avoid}.metrics{display:flex;flex-wrap:wrap;margin:-5px}.metric{width:calc(33.333% - 10px);margin:5px;padding:14px;border:1px solid #dce8e5;border-radius:8px;break-inside:avoid}.metrics--4 .metric{width:calc(50% - 10px)}.metrics--1 .metric{width:calc(100% - 10px)}.expense-metrics.metrics--4 .metric{width:calc(33.333% - 10px)}.expense-metrics.metrics--4 .primary{width:calc(100% - 10px)}label{display:block;color:#697d82;font-size:11px}strong{display:block;font-size:21px;line-height:1.6;font-variant-numeric:tabular-nums}.primary{background:#edf6f2}.primary strong{color:#126b5c}.muted strong{font-size:17px}small{display:block;color:#6c7d80;font-size:10px}.channel-row{margin:14px 0;break-inside:avoid}.channel-line{display:flex;align-items:center;gap:10px;margin-top:5px}.channel-line label{width:52px}.channel-line span{width:105px;text-align:right}.track{height:12px;flex:1;background:#eef2ef;border-radius:4px;overflow:hidden}.track i{display:block;height:100%;background:#0f766e}table{border-collapse:collapse;width:100%;font-size:10px;table-layout:fixed}th{background:#edf3f2;color:#456169;text-align:left}td,th{padding:9px 6px;border-bottom:1px solid #e0e9e7;overflow-wrap:anywhere;vertical-align:top}tr,.metric{break-inside:avoid;page-break-inside:avoid}thead{display:table-header-group}.appendix-table th:last-child{width:40%}.note{color:#75878c;font-size:10px;margin:8px 0}hr{border:0;border-top:1px solid #e0e9e7}.appendix{break-before:page}.appendix-table tr{break-inside:auto;page-break-inside:auto}`;
  const scopedStyle = style.replace(/(^|})([^{}]+){/g, (whole, prefix: string, selector: string) => selector.trim().startsWith("@") ? whole : prefix + selector.split(",").map((part) => part.trim().startsWith(".financial-export") ? part.trim() : `.financial-export ${part.trim()}`).join(",") + "{");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(data.store.name)}-${esc(data.period)}-门店财务报表</title></head><body style="margin:0"><main class="financial-export"><style>${scopedStyle}</style><header><p>门店财务报表 · 月度经营报告</p><h1>${esc(data.store.name)}</h1><p>${esc(formatPeriod(data.period))}</p></header>${groups}<section><h2>营业收入渠道</h2>${channelChart || "暂无收入"}${table(["渠道", "营业收入", "实收", "手续费", "手续费率"], channels.map((item) => row([esc(item.channel), esc(formatMoney(item.gross_amount)), esc(formatMoney(item.net_amount)), esc(formatMoney(item.fee_amount)), percent(item.fee_rate)])))}</section><section><h2>核心成本率</h2>${table(["成本项目", "金额", "占比图示", "成本率"], costRows)}</section><section><h2>核心食材</h2>${table(["食材", "金额", "占营业收入"], [["鸡肉", metrics.chicken_cost_amount, metrics.chicken_cost_rate], ["菌子", metrics.mushroom_cost_amount, metrics.mushroom_cost_rate]].map(([name, amount, rate]) => row([esc(name), esc(formatMoney(String(amount))), percent(rate)])))}</section><section><h2>各类别支出统计</h2>${table(["费用分类", "金额", "占营业收入", "占总支出"], categoryRows)}</section><section><h2>支出明细</h2>${table(["一级分类", "二级分类", "支出详情", "申请报销日期", "金额"], expenseRows)}</section>${vouchers.length ? `<section><h2>主要支出凭证</h2><p class="note">仅展示，不计入利润。</p>${table(["费用名称", "账期", "展示金额", "附件", "备注"], voucherRows)}</section>` : ""}<section class="appendix"><h2>流水业务附录</h2><p class="note">普通关联流水按入账月纳入，特殊属性和直接入账按发生月纳入。流水金额不等于本月支出；跨月和多笔实付关联不重复累计审批金额。</p><div class="appendix-table">${table(["发生日期", "类型", "对方户名", "流水金额", "流水属性", "关联业务 / 备注"], appendixRows).replace("<table>", '<table class="appendix-table">')}</div></section></main></body></html>`;
}
