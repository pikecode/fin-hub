import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import {
  reportGroups,
  buildReportCategories,
  reportCategorySections,
  reportPercent,
  formatMoney,
} from "@fin-hub/shared-utils";
import type { ReportCategory, ReportGroup } from "@fin-hub/shared-utils";
import type { FinancialReportAppendix } from "@fin-hub/shared-types";
import { api, MobileReport } from "../../lib/api";
import "./index.css";

const cash = (value: unknown) =>
  value == null ? "—" : formatMoney(String(value));
const labels: Record<string, string> = {
  current_account: "往来款",
  shareholder_dividend: "股东分红",
  shareholder_capital: "股东注资",
  other_income_expense: "其他收支",
  counter_refund: "退款",
  loan_repayment: "借还款",
  bank_interest: "银行结息",
  other_income: "其他收入",
  bank_fee: "银行手续费",
  bank_sms_fee: "银行短信费",
  bank_other_expense: "银行其他支出",
};
const tabs = ["经营概览", "支出分析", "资金分红", "流水凭证"];
function receipts(type: string, id: string) {
  Taro.navigateTo({
    url: `/pages/receipts/index?type=${encodeURIComponent(type)}&id=${encodeURIComponent(id)}`,
  });
}
function Metrics({ group }: { group: ReportGroup }) {
  return (
    <View className="section report-card">
      <Text className="section-title">{group.title}</Text>
      <View className="report-metrics">
        {group.items.map((item) => (
          <View className="report-metric" key={item.title}>
            <Text className="label">{item.title}</Text>
            <Text className="report-metric-value">{item.value}</Text>
            {item.hint && <Text className="metric-hint">{item.hint}</Text>}
          </View>
        ))}
      </View>
    </View>
  );
}
export default function FinancialReport({ data }: { data: MobileReport }) {
  const { report, supplement: s } = data;
  const m = report.metrics,
    storeId = report.store.id,
    period = report.period;
  const categories = buildReportCategories(report, s),
    groups = reportGroups(report, s);
  const [tab, setTab] = useState(0),
    [expanded, expand] = useState<string[]>([]);
  const [loans, expandLoans] = useState<string[]>([]),
    [allChannels, showChannels] = useState(false);
  const [allRanking, showRanking] = useState(false);
  const [special, setSpecial] = useState<FinancialReportAppendix["rows"]>([]);
  const [specialTotal, setSpecialTotal] = useState<number | null>(null),
    [specialPage, setSpecialPage] = useState(0);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const alive = useRef(true),
    specialLoading = useRef(false),
    specialVersion = useRef(0);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  async function loadSpecial(page: number, force = false) {
    if (specialLoading.current && !force) return;
    const version = ++specialVersion.current;
    specialLoading.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api.reportSpecial(storeId, period, page);
      if (!alive.current || version !== specialVersion.current) return;
      setSpecial((rows) =>
        page === 1 ? result.items : [...rows, ...result.items],
      );
      setSpecialTotal(result.total);
      setSpecialPage(page);
    } catch (e) {
      if (alive.current && version === specialVersion.current)
        setError(e instanceof Error ? e.message : "加载失败");
    } finally {
      if (version === specialVersion.current) {
        specialLoading.current = false;
        if (alive.current) setBusy(false);
      }
    }
  }
  useEffect(() => {
    if (tab === 3 && specialTotal === null) void loadSpecial(1);
  }, [tab]);
  useEffect(() => {
    setSpecial([]);
    setSpecialTotal(null);
    setSpecialPage(0);
    setError("");
    if (tab === 3) void loadSpecial(1, true);
  }, [data.retrieved_at]);
  function detail(row: ReportCategory) {
    Taro.navigateTo({
      url: `/pages/expenses/index?storeId=${storeId}&period=${period}&category=${encodeURIComponent(row.key)}`,
    });
  }
  function category(row: ReportCategory, child = false) {
    const open = expanded.includes(row.key),
      hasChildren = Boolean(row.children?.length);
    return (
      <View
        className={child ? "category-item category-child" : "category-item"}
        key={row.key}
      >
        <View
          className="report-line category-heading"
          onClick={() =>
            hasChildren
              ? expand(
                  open
                    ? expanded.filter((x) => x !== row.key)
                    : [...expanded, row.key],
                )
              : detail(row)
          }
        >
          <View className="category-name">
            <Text>{row.name}</Text>
            <Text className="row-sub">
              {row.item_count} 条费用
              {hasChildren ? ` · ${row.children!.length} 个分类` : ""}
            </Text>
          </View>
          <View className="category-amount">
            <Text>{cash(row.amount)}</Text>
            <Text className="category-chevron">
              {hasChildren ? (open ? "收起 −" : "展开 +") : "明细 ›"}
            </Text>
          </View>
        </View>
        <View className="category-ratios">
          <Text>占营收 {row.revenue_share}</Text>
          <Text>占支出 {row.share}</Text>
        </View>
        <View className="report-line category-history">
          <Text>历史累计 {cash(row.historical_amount)}</Text>
          <Button className="text-button" onClick={() => detail(row)}>
            费用明细 ›
          </Button>
        </View>
        {open && row.children?.map((item) => category(item, true))}
      </View>
    );
  }
  const channels = [...m.revenue_channel_summary].sort(
    (a, b) => Number(b.gross_amount) - Number(a.gross_amount),
  );
  const ranking = allRanking ? categories : categories.slice(0, 5);
  const maxCategory = Math.max(1, ...categories.map((x) => Number(x.amount)));
  const netProfit = Number(m.income_amount) - Number(m.expense_amount);
  const stamp = data.retrieved_at ? new Date(data.retrieved_at) : null;
  const updated =
    stamp && !Number.isNaN(stamp.getTime())
      ? `${String(stamp.getHours()).padStart(2, "0")}:${String(stamp.getMinutes()).padStart(2, "0")}`
      : "本次加载";
  return (
    <View className="financial-report">
      <View className="report-hero">
        <View className="report-line">
          <Text className="hero-caption">本月净利润</Text>
          <Text className="report-status">
            {report.selected_ledger?.status === "closed"
              ? "已封账"
              : "更新中 · 未封账"}
          </Text>
        </View>
        <Text className="hero-profit">{cash(netProfit)}</Text>
        <View className="hero-totals">
          <View>
            <Text className="hero-caption">营业收入</Text>
            <Text className="hero-total">{cash(m.income_amount)}</Text>
          </View>
          <View>
            <Text className="hero-caption">总支出</Text>
            <Text className="hero-total">{cash(m.expense_amount)}</Text>
          </View>
        </View>
      </View>
      <View className="report-toolbar">
        <Text className="row-sub">{period.replace("-", "年")}月经营报告</Text>
        <Button
          className="text-button"
          onClick={() =>
            Taro.navigateTo({
              url: `/pages/report-export/index?storeId=${storeId}&period=${period}`,
            })
          }
        >
          导出报表 ↗
        </Button>
      </View>
      <View className="report-navigation">
        {tabs.map((name, index) => (
          <Button
            key={name}
            className={tab === index ? "report-nav active" : "report-nav"}
            onClick={() => setTab(index)}
          >
            {name}
          </Button>
        ))}
      </View>
      {tab === 0 && (
        <>
          <Metrics group={groups[0]} />
          <View className="section report-card">
            <Text className="section-title">收入渠道</Text>
            {!channels.length && (
              <Text className="empty-inline">本月暂无营业收入记录</Text>
            )}
            {(allChannels ? channels : channels.slice(0, 3)).map((channel) => (
              <View className="channel-item" key={channel.channel}>
                <View className="report-line">
                  <Text>{channel.channel}</Text>
                  <Text className="list-money">
                    {cash(channel.gross_amount)}
                  </Text>
                </View>
                <View className="mobile-track">
                  <View
                    style={{
                      width: `${Math.min(100, Math.max(0, (Number(channel.gross_amount) / Math.max(1, Number(m.income_amount))) * 100))}%`,
                    }}
                  />
                </View>
                <Text className="row-sub">
                  实收 {cash(channel.net_amount)} · 营收占比{" "}
                  {reportPercent(channel.gross_amount, m.income_amount)}
                </Text>
                <Text className="row-sub">
                  手续费 {cash(channel.fee_amount)} · 费率 {channel.fee_rate}%
                </Text>
              </View>
            ))}
            {channels.length > 3 && (
              <Button
                className="list-more"
                onClick={() => showChannels(!allChannels)}
              >
                {allChannels
                  ? "收起渠道"
                  : `查看全部 ${channels.length} 个渠道`}{" "}
                {allChannels ? "⌃" : "⌄"}
              </Button>
            )}
          </View>
          <Metrics group={groups[1]} />
          <View className="section report-card">
            <Text className="section-title">核心成本率</Text>
            {[
              ["食材成本", m.food_cost_amount, m.food_cost_rate],
              ["人工成本", m.labor_cost_amount, m.labor_cost_rate],
              ["租金成本", m.rent_cost_amount, m.rent_cost_rate],
            ].map(([name, amount, rate]) => (
              <View className="cost-item" key={name!}>
                <View className="report-line">
                  <Text>{name}</Text>
                  <Text className="list-money">{cash(amount)}</Text>
                </View>
                <View className="cost-track-row">
                  <View className="mobile-track">
                    <View
                      style={{
                        width: `${Math.min(100, Math.max(0, Number(rate) || 0))}%`,
                      }}
                    />
                  </View>
                  <Text>{rate == null ? "—" : `${rate}%`}</Text>
                </View>
              </View>
            ))}
          </View>
        </>
      )}
      {tab === 1 && (
        <>
          <View className="section report-card">
            <View className="report-line">
              <Text className="section-title">支出排行</Text>
              <Text className="row-sub">按一级分类</Text>
            </View>
            {!categories.length && (
              <Text className="empty-inline">本月暂无分类支出</Text>
            )}
            {ranking.map((item, index) => (
              <View
                className="ranking-row"
                key={item.key}
                onClick={() => detail(item)}
              >
                <Text className="rank-number">
                  {String(index + 1).padStart(2, "0")}
                </Text>
                <View className="rank-body">
                  <View className="report-line">
                    <Text>{item.name}</Text>
                    <Text className="list-money">{cash(item.amount)}</Text>
                  </View>
                  <View className="mobile-track">
                    <View
                      style={{
                        width: `${Math.min(100, Math.max(0, (Number(item.amount) / maxCategory) * 100))}%`,
                      }}
                    />
                  </View>
                </View>
                <Text className="chevron">›</Text>
              </View>
            ))}
            {categories.length > 5 && (
              <Button
                className="list-more"
                onClick={() => showRanking(!allRanking)}
              >
                {allRanking ? "收起排行" : "查看全部分类"} ⌄
              </Button>
            )}
          </View>
          {reportCategorySections(
            categories,
            m.expense_amount,
            m.food_cost_amount,
          ).map((section) => (
            <View className="section report-card" key={section.title}>
              <View className="report-line">
                <Text className="section-title">{section.title}</Text>
                <Text className="section-total">{cash(section.amount)}</Text>
              </View>
              <Text className="section-description">
                占营业收入 {reportPercent(section.amount, m.income_amount)} ·
                占总支出 {reportPercent(section.amount, m.expense_amount)}
              </Text>
              {!section.rows.length && (
                <Text className="empty-inline">暂无分类记录</Text>
              )}
              {section.rows.map((item) => category(item))}
            </View>
          ))}
          <View className="section report-card">
            <Text className="section-title">计提与冲销费用</Text>
            <Text className="section-description">
              已计入分类与总支出，冲销以负数展示
            </Text>
            {!s.accrual_details?.length && (
              <Text className="empty-inline">本月暂无计提与调整记录</Text>
            )}
            {s.accrual_details?.map((item) => (
              <View className="record-item" key={item.id}>
                <View className="report-line">
                  <Text>
                    {item.category_l1} / {item.category_l2}
                  </Text>
                  <Text className="list-money">{cash(item.amount)}</Text>
                </View>
                <Text className="record-description">{item.description}</Text>
                <View className="report-line">
                  <Text className="row-sub">{item.date}</Text>
                  <Button
                    className="text-button"
                    onClick={() => receipts("expense_item", item.id)}
                  >
                    查看凭证 ›
                  </Button>
                </View>
              </View>
            ))}
          </View>
          <Text className="report-footnote">
            历史累计截至 {period}（含当期）
          </Text>
        </>
      )}
      {tab === 2 && (
        <>
          <Metrics group={groups[2]} />
          {!!s.loan_receivables?.length && (
            <View className="section report-card">
              <Text className="section-title">外借款记录</Text>
              {s.loan_receivables.map((loan) => (
                <View className="record-item" key={loan.id}>
                  <View className="report-line">
                    <Text>{loan.borrower}</Text>
                    <Text className="status-badge">
                      {loan.status === "repaid"
                        ? "已归还"
                        : loan.status === "outstanding"
                          ? "未结清"
                          : loan.status}
                    </Text>
                  </View>
                  <Text className="loan-amount">
                    未还本金 {cash(loan.remaining)}
                  </Text>
                  <Text className="row-sub">
                    借出 {cash(loan.amount)} · 已还 {cash(loan.repaid)}
                  </Text>
                  <Button
                    className="list-more"
                    onClick={() =>
                      expandLoans(
                        loans.includes(loan.id)
                          ? loans.filter((x) => x !== loan.id)
                          : [...loans, loan.id],
                      )
                    }
                  >
                    {loans.includes(loan.id) ? "收起借还明细 ⌃" : "借还明细 ⌄"}
                  </Button>
                  {loans.includes(loan.id) &&
                    loan.events?.map((event) => (
                      <View className="loan-event" key={event.id}>
                        <View className="report-line">
                          <Text>
                            {event.kind === "lend" ? "借出" : "还款"}
                            {event.active === false ? " · 已撤销" : ""}
                          </Text>
                          <Text>{cash(event.amount)}</Text>
                        </View>
                        <Text className="row-sub">
                          {event.date} · {event.remark || "无备注"}
                        </Text>
                        <Button
                          className="text-button"
                          onClick={() => receipts("loan_event", event.id)}
                        >
                          查看凭证 ›
                        </Button>
                      </View>
                    ))}
                </View>
              ))}
            </View>
          )}
          <Metrics group={groups[3]} />
          <Metrics group={groups[4]} />
        </>
      )}
      {tab === 3 && (
        <>
          <View className="section report-card">
            <View className="report-line">
              <Text className="section-title">特殊流水</Text>
              {specialTotal != null && (
                <Text className="row-sub">共 {specialTotal} 笔</Text>
              )}
            </View>
            <Text className="section-description">
              查看往来、借还及银行直接入账记录
            </Text>
            {special.map(({ transaction: item }) => (
              <View
                className="record-item"
                key={item.id}
                onClick={() =>
                  Taro.navigateTo({
                    url: `/pages/bank-detail/index?id=${item.id}`,
                  })
                }
              >
                <View className="report-line">
                  <Text>
                    {labels[
                      item.direct_posting_type || item.special_type || ""
                    ] || "其他"}
                  </Text>
                  <Text className="list-money">
                    {item.direction === "income" ? "+" : "−"}
                    {cash(item.amount)}
                  </Text>
                </View>
                <Text className="record-description">
                  {item.counterparty_name || "未填写户名"} ·{" "}
                  {item.summary || "无备注"}
                </Text>
                <Text className="row-sub">
                  {item.occurred_at.slice(0, 10)} ·{" "}
                  {item.direct_posting_type
                    ? `入账月份 ${item.occurred_at.slice(0, 7)}`
                    : "入账月份以审批对账记录为准"}
                </Text>
                <Text className="record-link">查看流水详情 ›</Text>
              </View>
            ))}
            {specialTotal === 0 && (
              <Text className="empty-inline">本月暂无特殊流水</Text>
            )}
            {error && <Text className="error">{error}</Text>}
            {(specialTotal === null ||
              special.length < specialTotal ||
              error) && (
              <Button
                className="list-more"
                loading={busy}
                disabled={busy}
                onClick={() => loadSpecial(specialPage + 1)}
              >
                {error
                  ? "重新加载"
                  : specialPage
                    ? "加载更多流水"
                    : "正在加载流水"}
              </Button>
            )}
          </View>
          <View className="section report-card">
            <View className="report-line">
              <Text className="section-title">主要支出凭证</Text>
              <Text className="row-sub">
                {data.major_vouchers?.length || 0} 份
              </Text>
            </View>
            <Text className="section-description">
              展示金额{" "}
              {cash(
                (data.major_vouchers || []).reduce(
                  (sum, item) => sum + Number(item.display_amount),
                  0,
                ),
              )}{" "}
              · 仅归档，不计入利润
            </Text>
            {!data.major_vouchers?.length && (
              <Text className="empty-inline">本月暂无归档凭证</Text>
            )}
            {data.major_vouchers?.map((item) => (
              <View className="record-item" key={item.id}>
                <View className="report-line">
                  <Text>{item.expense_name}</Text>
                  <Text className="list-money">
                    {cash(item.display_amount)}
                  </Text>
                </View>
                <Text className="record-description">
                  {item.remark || "无备注"}
                </Text>
                <Text className="row-sub">
                  {item.ledger_period} · 录入{" "}
                  {item.created_at?.replace("T", " ")}
                </Text>
                <Button
                  className="text-button"
                  onClick={() => receipts("expense_item", item.id)}
                >
                  查看 {item.attachment_count || 0} 份附件 ›
                </Button>
              </View>
            ))}
          </View>
        </>
      )}
      <View className="report-footer">
        <Text>更新于 {updated} · 与财务后台同步</Text>
        <Button
          className="text-button"
          onClick={() =>
            Taro.showModal({
              title: "报表数据说明",
              content:
                "收入按收入日期、支出按入账月份统计；预充值、备用金/借款及异常费用不计入经营支出。计提、冲销和特殊流水均沿用财务后台规则，不重复累计。未封账月份会随财务更新。",
              showCancel: false,
            })
          }
        >
          数据说明 ⓘ
        </Button>
      </View>
    </View>
  );
}
