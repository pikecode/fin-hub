// Run with: node scripts/test-dividend-presentation.cjs
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const ts = require(path.join(root, "apps/admin-web/node_modules/typescript"));
function load(relative, imports = {}) {
  const exports = {};
  const source = fs.readFileSync(path.join(root, relative), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
  new Function("exports", "require", code)(exports, (name) => {
    assert.ok(name in imports, `Unexpected import: ${name}`);
    return imports[name];
  });
  return exports;
}
const utils = load("packages/shared-utils/src/index.ts");
const { reportGroups, financialReportHtml } = load("apps/admin-web/app/components/financialReportPresentation.ts", { "@fin-hub/shared-utils": utils });
const { mergeWorkspaces } = load("apps/admin-web/app/components/dividendAggregation.ts");
const data = { store: { name: "分配测试门店" }, period: "2026-09", metrics: { income_amount: "1000", expense_amount: "100", revenue_channel_summary: [] } };
const extra = { bank_balance: { status: "pending", date: "2026-10-10" }, distribution_amount: "100", preopening_coverage_amount: "600", preopening_investment: "4000", preopening_expense_amount: "6000", preopening_expense_source: "manual", preopening_balance: "-2000", preopening_profit_covered: "800", preopening_uncovered: "1200" };
const metrics = reportGroups(data, extra).flatMap(group => group.items);
assert.equal(metrics.find(item => item.title === "本月分红").value, utils.formatMoney(100));
assert.equal(metrics.find(item => item.title === "本月补充筹建超支").value, utils.formatMoney(600));
assert.equal(metrics.find(item => item.title === "筹建超支").value, utils.formatMoney(2000));
const html = financialReportHtml(data, extra, { expense_items: [], rows: [] }, [], []);
assert.ok(html.includes("本月补充筹建超支"));
assert.ok(html.includes(`经营利润已补充 ${utils.formatMoney(800)} / 超支未补充 ${utils.formatMoney(1200)}`));
assert.ok(!html.includes("本月分配利润"));
assert.ok(html.includes("门店预充值、备用金/借款及异常费用不计入经营支出。"));
const pending = reportGroups(data, { ...extra, preopening_expense_source: "missing", preopening_balance: null, preopening_uncovered: null }).flatMap(group => group.items);
assert.equal(pending.find(item => item.title === "筹建费用总支出").value, "待录入");
assert.equal(pending.find(item => item.title === "筹建结余/超支").value, "待计算");
function workspace(id, balance, uncovered, coverage, excluded = false) {
  const current = { period: "2026-09", entries: [], distribution_amount: "100", preopening_coverage_amount: coverage, cumulative_preopening_coverage: coverage, excluded_from_calculation: excluded };
  return { store: { id, name: id }, current, history: [current], shareholders: [], funding: { preopening_balance: balance, preopening_uncovered: uncovered, preopening_expense_source: "manual" } };
}
const merged = mergeWorkspaces([workspace("A", "-2000", "1200", "800"), workspace("B", "3000", "0", "0"), workspace("excluded", null, null, "999", true)], "2026-09");
assert.equal(merged.funding.preopening_overrun_amount, "2000.00");
assert.equal(merged.funding.preopening_surplus_amount, "3000.00");
assert.equal(merged.funding.preopening_uncovered, "1200.00");
assert.equal(merged.current.cumulative_preopening_coverage, "800.00");
assert.equal(merged.current.distribution_amount, "200.00");
console.log("Dividend report/HTML and company aggregation assertions passed.");

// Report grouping and export-only fee omission must not change profit totals.
const { reportCategorySections } = load("apps/admin-web/app/components/financialReportPresentation.ts", { "@fin-hub/shared-utils": utils });
const grouped = reportCategorySections([
  { key: "food", name: "食材成本", amount: "100", item_count: 1, share: "33.33%", revenue_share: "10%" },
  { key: "fee", name: "手续费", amount: "20", item_count: 1, share: "6.67%", revenue_share: "2%" },
  { key: "rent", name: "门店租管费用", amount: "180", item_count: 1, share: "60%", revenue_share: "18%" },
], "300", "100");
assert.deepEqual(grouped.map(section => [section.title, section.amount, section.rows.length]), [["食材成本", "100", 1], ["运营支出", "200", 2]]);
const reportData = { ...data, metrics: { ...data.metrics, expense_amount: "300", food_cost_amount: "100" } };
const expandedHtml = financialReportHtml(reportData, extra, { expense_items: [
  { description: "fee-detail-omit", source: "revenue_fee", category_l1: "手续费", amount: "20" },
  { description: "normal-detail-retain", source: "accrual", category_l1: "门店租管费用", amount: "180" },
], rows: [{ transaction: { id: "special-dividend", occurred_at: "2026-09-30", direction: "expense", amount: "50", special_type: "shareholder_dividend", summary: "special-dividend-remark" }, business: [] }] }, [], []);
const expenseSection = expandedHtml.split("<h2>支出明细</h2>")[1].split("</section>")[0];
assert.ok(!expenseSection.includes("fee-detail-omit"));
assert.ok(expenseSection.includes("normal-detail-retain"));
assert.ok(expandedHtml.includes("<h2>特殊流水</h2>"));
assert.ok(expandedHtml.includes("special-dividend-remark"));
assert.equal(reportGroups(reportData, extra).find(group => group.title === "门店支出").items[0].value, utils.formatMoney(300));
console.log("Report category split, fee detail omission and special-flow presentation assertions passed.");

const manualExtra = { ...extra, period: "2026-09", bank_balance: { date: "2026-09-30", status: "ready", amount: "23456.78", source: "manual" } };
const manualMetric = reportGroups(reportData, manualExtra).find(group => group.title === "资金流情况").items[0];
assert.equal(manualMetric.value, utils.formatMoney("23456.78"));
assert.equal(manualMetric.hint, "截至 2026-09-30 余额");
const manualHtml = financialReportHtml(reportData, manualExtra, { expense_items: [], rows: [] }, [], []);
assert.ok(manualHtml.includes(utils.formatMoney("23456.78")));
assert.ok(manualHtml.includes("截至 2026-09-30 余额"));
assert.equal(reportGroups(reportData, { ...manualExtra, bank_balance: { ...manualExtra.bank_balance, status: "missing_manual", amount: null } }).find(group => group.title === "资金流情况").items[0].value, "待录入");
assert.equal(reportGroups(reportData, { ...manualExtra, bank_balance: { ...manualExtra.bank_balance, amount: "0" } }).find(group => group.title === "资金流情况").items[0].value, utils.formatMoney(0));
console.log("Manual report balance HTML/value/missing/zero assertions passed.");

const tracedHtml = financialReportHtml({ ...reportData, store: { ...reportData.store, id: "report-store" }, period: "2026-10" }, extra,
  { expense_items: [], rows: [{ transaction: { id: "hidden-100", store_id: "report-store", ledger_period: "2026-09", occurred_at: "2026-10-31", direction: "expense", amount: "100", direct_posting_type: "bank_fee" }, business: [] }] }, [], [], "https://finance.example");
assert.ok(tracedHtml.includes("所属账期"));
assert.ok(tracedHtml.includes("入账月份"));
assert.ok(tracedHtml.includes("2026-09"));
assert.ok(tracedHtml.includes('href="https://finance.example/bank?store_id=report-store&amp;transaction_id=hidden-100&amp;ledger_period=2026-10"'));
console.log("Cross-period report source link/context assertions passed.");

const groupedExpenses = [
  { id: "detail-a", description: "分组租金", amount: "1300", category_l1: "租管", category_l2: "租金", expense_date: "2026-09-01", application_date: "2026-09-02" },
  { id: "detail-b", description: "分组电费", amount: "1159.20", category_l1: "租管", category_l2: "水电", expense_date: "2026-09-01" },
  { id: "accrual-c", description: "无流水计提", amount: "200", category_l1: "人力", category_l2: "工资", source: "accrual", expense_date: "2026-09-01" },
];
const groupedHtml = financialReportHtml(reportData, extra, {
  expense_items: groupedExpenses,
  rows: ["bank-a", "bank-b"].map((id) => ({
    transaction: { id, direction: "expense", occurred_at: "2026-10-01", amount: "2459.20", counterparty_name: "分组收款人" },
    business: [{ kind: "expense", description: "租金电费", accounting_amount: "2459.20", expense_details: groupedExpenses.slice(0, 2).map(item => ({ ...item, expense_id: item.id })) }],
  })),
}, [], []);
const groupedSection = groupedHtml.split('<h2>支出明细</h2>')[1].split('</section>')[0];
assert(groupedSection.includes('续流水 1'));
assert(groupedSection.includes('同流水 1 费用'));
assert.equal((groupedSection.match(/1,300\.00/g) || []).length, 1);
assert.equal((groupedSection.match(/1,159\.20/g) || []).length, 1);
assert(groupedSection.includes('未关联银行流水'));
assert(groupedSection.includes('无流水计提'));
assert(groupedSection.includes('2026-10-01'));
assert(groupedSection.includes('2026-09-02'));
console.log('Bank-grouped expense details, shared-expense deduplication and unlinked accrual assertions passed.');
