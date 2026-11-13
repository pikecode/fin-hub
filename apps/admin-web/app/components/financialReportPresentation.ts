import type { FinancialReportAppendix, FinancialReportSupplement, MajorExpenseVoucher, StoreLedgerWorkspace } from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";

export { reportGroups, reportPercent, reportCategorySections } from "@fin-hub/shared-utils";
import { reportGroups, reportPercent, reportCategorySections } from "@fin-hub/shared-utils";
import type { ReportMetric, ReportGroup, ReportCategory } from "@fin-hub/shared-utils";
export type { ReportMetric, ReportGroup, ReportCategory } from "@fin-hub/shared-utils";
const esc = (v: unknown) => String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const day = (value?: string | null) => value ? value.slice(0, 10) : "—";
const percent = (value: unknown) => value == null ? "—" : `${value}%`;
export const reportSpecialLabels: Record<string, string> = { current_account: "往来款", shareholder_dividend: "股东分红", shareholder_capital: "股东注资", other_income_expense: "其他收支", counter_refund: "退款", loan_repayment: "借还款", bank_interest: "银行结息", other_income: "其他收入", bank_fee: "银行手续费", bank_sms_fee: "银行短信费", bank_other_expense: "银行其他支出" };
export function financialReportHtml(data: StoreLedgerWorkspace, extra: FinancialReportSupplement, appendix: FinancialReportAppendix, categories: ReportCategory[], vouchers: MajorExpenseVoucher[], origin = "", receipts: { title: string; urls: string[] }[] = []) {
  const metrics = data.metrics;
  const channels = [...metrics.revenue_channel_summary].sort((a, b) => Number(b.gross_amount) - Number(a.gross_amount));
  const table = (headers: string[], rows: string[], empty = "暂无数据") => `<table><thead><tr>${headers.map((header) => `<th>${header}</th>`).join("")}</tr></thead><tbody>${rows.join("") || `<tr><td colspan="${headers.length}">${empty}</td></tr>`}</tbody></table>`;
  const row = (cells: string[]) => `<tr>${cells.map((cell) => `<td>${cell}</td>`).join("")}</tr>`;
  const channelSection = `<section><h2>营业收入渠道</h2>${table(["渠道", "营业收入", "实收", "手续费", "手续费率"], channels.map((item) => row([esc(item.channel), esc(formatMoney(item.gross_amount)), esc(formatMoney(item.net_amount)), esc(formatMoney(item.fee_amount)), percent(item.fee_rate)])))}</section>`;
  const loanSection = (extra.loan_receivables || []).length ? `<section><h2>其他应收款 · 外借款明细</h2>${table(["借款人", "借出本金", "累计归还", "未还本金", "状态"], (extra.loan_receivables || []).map(item => row([esc(item.borrower), esc(formatMoney(item.amount)), esc(formatMoney(item.repaid)), esc(formatMoney(item.remaining)), esc(item.status)])))}</section>` : "";
  const groups = reportGroups(data, extra).map((group) => `<section class="${group.title === "门店支出" ? "expense-group" : ""}"><h2>${group.title}</h2><div class="metrics metrics--${group.items.length} ${group.title === "门店支出" ? "expense-metrics" : ""}">${group.items.map((item) => `<div class="metric ${item.tone || ""}"><label>${esc(item.title)}</label><strong>${esc(item.value)}</strong>${item.hint ? `<small>${esc(item.hint)}</small>` : ""}</div>`).join("")}</div></section>${group.title === "门店营收" ? channelSection : group.title === "资金流情况" ? loanSection : ""}`).join("");
  const costRows = [["食材成本", metrics.food_cost_amount, metrics.food_cost_rate], ["人工成本", metrics.labor_cost_amount, metrics.labor_cost_rate], ["租金成本", metrics.rent_cost_amount, metrics.rent_cost_rate]].map(([name, amount, rate]) => row([esc(name), esc(formatMoney(String(amount))), `<div class="track"><i style="width:${Math.min(Math.max(Number(rate || 0), 0), 100)}%;background:#d65a37"></i></div>`, percent(rate)]));
  const categoryTables = reportCategorySections(categories, metrics.expense_amount, metrics.food_cost_amount).map(section => `<h3>${esc(section.title)} · ${esc(formatMoney(section.amount))}</h3><p class="note">占营业收入 ${reportPercent(section.amount, metrics.income_amount)} · 占总支出 ${reportPercent(section.amount, metrics.expense_amount)}</p>${table(["费用分类", "金额", "占营业收入", "占总支出", "历史累计支出"], section.rows.flatMap((item) => [row([`<b>${esc(item.name)}</b>`, esc(formatMoney(item.amount)), item.revenue_share, item.share, item.historical_amount == null ? "—" : esc(formatMoney(item.historical_amount))]), ...(item.children || []).map((child) => row([`　${esc(child.name)}`, esc(formatMoney(child.amount)), child.revenue_share, child.share, child.historical_amount == null ? "—" : esc(formatMoney(child.historical_amount))]))]))}`).join("");
  const accrualSection = `<section><h2>计提与冲销费用</h2><p class="note">按费用分类排序，包含计提、补提和冲销；金额已计入各类别及总支出，此处不重复累计，冲销显示负数。</p>${table(["费用分类", "日期", "费用内容", "入账金额"], (extra.accrual_details || []).map(item => row([esc([item.category_l1, item.category_l2].filter(Boolean).join(" / ") || "未分类"), esc(item.date), esc(item.description), esc(formatMoney(item.amount))])))}</section>`;
  const reportExpenses = appendix.expense_items.filter(item => item.category_l1 !== "手续费" && item.source !== "revenue_fee");
  const expenseById = new Map(reportExpenses.map(item => [item.id, item]));
  const displayedExpenses = new Map<string, number>();
  const expenseRows: string[] = [];
  let bankNumber = 0;
  for (const { transaction: bank, business } of appendix.rows) {
    if (bank.direction !== "expense") continue;
    const ids = [...new Set(business.filter(item => item.kind === "expense").flatMap(item =>
      (item.expense_details || []).flatMap(detail => detail.expense_id && expenseById.has(detail.expense_id) ? [detail.expense_id] : [])))];
    if (!ids.length) continue;
    bankNumber += 1;
    const bankLabel = `流水 ${bankNumber}<br>${esc(bank.counterparty_name || "—")}<br>${esc(formatMoney(bank.amount))}<small>${esc(bank.summary || "")}</small>`;
    ids.forEach((id, index) => {
      const item = expenseById.get(id)!;
      const previous = displayedExpenses.get(id);
      expenseRows.push(row([
        index === 0 ? bankLabel : `<small>流水 ${bankNumber}（明细续行）</small><small data-bank-continuation-context style="display:none">付款日期：<br><span style="white-space:nowrap">${day(bank.occurred_at)}</span><br>流水总额：${esc(formatMoney(bank.amount))}</small>`,
        day(bank.occurred_at), esc(item.category_l2 || item.category_l1 || "未分类"),
        esc(item.description), day(item.application_date || item.expense_date),
        previous == null ? esc(formatMoney(item.amount)) : `<small>同流水 ${previous} 费用<br>不重复计入</small>`,
      ]));
      if (previous == null) displayedExpenses.set(id, bankNumber);
    });
  }
  // Accruals and purchases may be recognized without a bank transaction.
  for (const item of reportExpenses) {
    if (displayedExpenses.has(item.id)) continue;
    expenseRows.push(row(["未关联银行流水", day(item.expense_date), esc(item.category_l2 || item.category_l1 || "未分类"),
      esc(item.description), day(item.application_date || item.expense_date), esc(formatMoney(item.amount))]));
  }

  const appendixRows = appendix.rows.map(({ transaction: bank, business }) => {
    const content = business.map((item) => item.kind === "income"
      ? `${esc(item.description)}：营业收入日期 ${day(item.revenue_start)} 至 ${day(item.revenue_end)}；关联金额 ${esc(formatMoney(item.accounting_amount))}`
      : `${esc(item.approval_no || "审批报销")} · 申请日期 ${day(item.application_date)}<br>${(item.expense_details?.length ? item.expense_details : [item]).map((detail) => `${esc([detail.category_l1, detail.category_l2].filter(Boolean).join(" / "))} ${esc(detail.description)}${"amount" in detail ? ` ${esc(formatMoney(String(detail.amount)))}` : ""}`).join("<br>")}<br>确认入账金额 ${esc(formatMoney(item.accounting_amount))}${item.settlement_group ? "（整组审批金额，多笔实付共同关联，不重复累计）" : item.shared_accounting_amount ? "（审批单本月总额，多笔匹配共享，不重复累计）" : ""}`).join("<hr>");
    return row([day(bank.occurred_at), bank.direction === "income" ? "收入" : "支出", esc(bank.counterparty_name || "—"), esc(formatMoney(bank.amount)), esc(reportSpecialLabels[bank.direct_posting_type || bank.special_type || ""] || bank.special_type || "普通流水"), content || esc(bank.summary || "—")]);
  });
  const specialRows = appendix.rows.filter(({ transaction }) => transaction.special_type || transaction.direct_posting_type).map(({ transaction: bank }) => row([day(bank.occurred_at), esc(bank.ledger_period || "—"), esc(bank.direct_posting_type ? bank.occurred_at.slice(0, 7) : "以对账记录为准"), esc(reportSpecialLabels[bank.direct_posting_type || bank.special_type || ""] || bank.special_type || "其他"), bank.direction === "income" ? "收入" : "支出", esc(formatMoney(bank.amount)), esc(bank.counterparty_name || "—"), esc(bank.summary || "—"), `<a href="${esc(`${origin}/bank?${new URLSearchParams({ store_id: bank.store_id || data.store.id, transaction_id: bank.id, ledger_period: data.period })}`)}">查看流水</a><br><small>${esc(bank.bank_serial_no || bank.id)}</small>`]));
  const voucherRows = vouchers.map((item) => row([esc(item.expense_name), esc(item.ledger_period), esc(formatMoney(item.display_amount)), `${item.attachment_count} 份`, esc(item.remark || "—")]));
  const style = `@page{size:A4 portrait;margin:12mm 12mm 17mm} .financial-export,.financial-export *{box-sizing:border-box}.financial-export{width:700px;max-width:700px;margin:auto;padding:24px;color:#263c44;background:white;font:12px/1.6 Arial,"PingFang SC","Microsoft YaHei",sans-serif}header{padding:24px;background:#143d43;border-radius:12px;color:white;margin-bottom:20px}header h1{font-size:25px;margin:5px 0}header p{margin:0;opacity:.8}section{margin:0 0 22px}h2{font-size:17px;margin:0 0 12px;padding-bottom:8px;border-bottom:1px solid #dae5e5;color:#20484c;break-after:avoid}.metrics{display:flex;flex-wrap:wrap;margin:-5px}.metric{width:calc(33.333% - 10px);margin:5px;padding:14px;border:1px solid #dce8e5;border-radius:8px;break-inside:avoid}.metrics--4 .metric{width:calc(50% - 10px)}.metrics--1 .metric{width:calc(100% - 10px)}.expense-metrics.metrics--4 .metric{width:calc(33.333% - 10px)}.expense-metrics.metrics--4 .primary{width:calc(100% - 10px)}label{display:block;color:#697d82;font-size:11px}strong{display:block;font-size:21px;line-height:1.6;font-variant-numeric:tabular-nums}.primary{background:#edf6f2}.primary strong{color:#126b5c}.muted strong{font-size:17px}small{display:block;color:#6c7d80;font-size:10px}.track{height:12px;min-width:0;flex:1;background:#eef2ef;border-radius:4px;overflow:hidden}.track i{display:block;height:100%;background:#0f766e}table{border-collapse:collapse;width:100%;font-size:10px;table-layout:fixed}th{background:#edf3f2;color:#456169;text-align:left}td,th{padding:9px 6px;border-bottom:1px solid #e0e9e7;overflow-wrap:anywhere;vertical-align:top}tr,.metric{break-inside:avoid;page-break-inside:avoid}thead{display:table-header-group}.appendix-table th:last-child{width:40%}.note{color:#75878c;font-size:10px;margin:8px 0}hr{border:0;border-top:1px solid #e0e9e7}.appendix{break-before:page}.appendix-table tr{break-inside:auto;page-break-inside:auto}`;
  const receiptSection = receipts.length ? `<section><h2>计提及借还款图片凭证</h2>${receipts.map((receipt, index) => `<div style="break-inside:avoid"><h3>凭证 ${index + 1} · ${esc(receipt.title)}</h3>${receipt.urls.map(url => `<a href="${esc(url)}" target="_blank"><img src="${esc(url)}" alt="凭证" style="max-width:220px;max-height:240px;object-fit:contain;margin:8px" /></a>`).join("")}</div>`).join("")}</section>` : "";
  const scopedStyle = style.replace(/(^|})([^{}]+){/g, (whole, prefix: string, selector: string) => selector.trim().startsWith("@") ? whole : prefix + selector.split(",").map((part) => part.trim().startsWith(".financial-export") ? part.trim() : `.financial-export ${part.trim()}`).join(",") + "{");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${esc(data.store.name)}-${esc(data.period)}-门店财务报表</title></head><body style="margin:0"><main class="financial-export"><style>${scopedStyle}</style><header><p>门店财务报表 · 月度经营报告</p><h1>${esc(data.store.name)}</h1><p>${esc(formatPeriod(data.period))}</p><p>门店预充值、备用金/借款及异常费用不计入经营支出。</p></header>${groups}<section><h2>核心成本率</h2>${table(["成本项目", "金额", "占比图示", "成本率"], costRows)}</section><section><h2>各类别支出统计</h2><p class="note">历史累计支出：当前门店截至 ${esc(data.period)}（含当期）的各分类入账累计金额。</p>${categoryTables}</section>${accrualSection}<section><h2>特殊流水</h2><p class="note">展示特殊属性及直接入账流水，是否计入利润沿用各流水入账规则，此处不重复累计。</p>${table(["日期", "所属账期", "入账月份", "流水属性", "方向", "流水金额", "对方户名", "备注", "来源"], specialRows)}</section><section><h2>支出明细</h2><p class="note">按银行流水分组展示。“明细续行”属于同一笔银行流水，不代表新增付款。详情金额为本期入账金额，与流水金额可能不同；同一费用关联多笔流水时仅首次展示金额。无流水的计提、采购等单独列示；手续费明细不在此表展示。</p>${table(["银行流水", "支出日期", "二级分类", "支出详情", "申请报销日期", "详情金额"], expenseRows)}</section>${vouchers.length ? `<section><h2>主要支出凭证</h2><p class="note">仅展示，不计入利润。</p>${table(["费用名称", "账期", "展示金额", "附件", "备注"], voucherRows)}</section>` : ""}<section class="appendix"><h2>流水业务附录</h2><p class="note">普通关联流水按入账月纳入，特殊属性和直接入账按发生月纳入。流水金额不等于本月支出；跨月和多笔实付关联不重复累计审批金额。</p><div class="appendix-table">${table(["发生日期", "类型", "对方户名", "流水金额", "流水属性", "关联业务 / 备注"], appendixRows).replace("<table>", '<table class="appendix-table">')}</div></section>${receiptSection}</main></body></html>`;
}
