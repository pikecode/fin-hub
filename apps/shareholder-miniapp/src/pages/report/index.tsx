import { Button, Picker, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import type { BankTransaction, DividendMonth, FinancialReportSupplement } from "@fin-hub/shared-types";
import {
  api,
  MobileStore,
  MobileReport,
  MobileRevenue,
  MobileBank,
} from "../../lib/api";
import {
  selectedStore,
  selectStore,
  selectedPeriod,
  selectPeriod,
} from "../../lib/navigation";
import "./index.css";
const money = (n: unknown) =>
  n == null
    ? "—"
    : "¥" +
      Number(n).toLocaleString("zh-CN", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
const pct = (n: unknown) => (n == null ? "—" : Number(n).toFixed(1) + "%");
const tabs = ["财务报表", "营业收入", "银行流水", "筹建报表", "分红管理"];
function Metric({ label, value }: { label: string; value: unknown }) {
  return (
    <View className="metric">
      <Text className="label">{label}</Text>
      <Text className="value">{String(value)}</Text>
    </View>
  );
}
export default function Report() {
  const route = Taro.useRouter();
  const [stores, S] = useState<MobileStore[]>([]),
    [storeId, I] = useState(route.params.storeId || selectedStore()),
    [periods, PS] = useState<string[]>([]),
    [period, P] = useState(""),
    [tab, T] = useState(0),
    [busy, B] = useState(false),
    [error, E] = useState("");
  const [report, R] = useState<MobileReport | null>(null),
    [revenue, RV] = useState<MobileRevenue | null>(null),
    [bank, BK] = useState<MobileBank | null>(null),
    [pre, PR] = useState<Awaited<ReturnType<typeof api.preopening>> | null>(
      null,
    ),
    [div, D] = useState<DividendMonth[]>([]),
    [divSummary, DS] = useState<FinancialReportSupplement | null>(null),
    [page, PG] = useState(1),
    [start, ST] = useState(""),
    [end, EN] = useState(""),
    [status, MS] = useState(""),
    [refresh, RF] = useState(0);
  const version = useRef(0),
    periodVersion = useRef(0);
  Taro.useDidShow(() => {
    api
      .stores()
      .then((rows) => {
        S(rows);
        const saved = selectedStore();
        const next = rows.find((x) => x.id === saved)?.id || rows[0]?.id || "";
        if (next) selectStore(next);
        I(next);
      })
      .catch((e) => E(e.message));
  });
  useEffect(() => {
    if (!storeId) return;
    const v = ++periodVersion.current;
    P("");
    PS([]);
    api
      .periods(storeId)
      .then((rows) => {
        if (v !== periodVersion.current) return;
        PS(rows);
        P(
          rows.includes(selectedPeriod(storeId))
            ? selectedPeriod(storeId)
            : rows[0] || "",
        );
      })
      .catch((e) => {
        if (v === periodVersion.current) E(e.message);
      });
    return () => {
      periodVersion.current++;
    };
  }, [storeId]);
  useEffect(() => {
    const v = ++version.current;
    R(null);
    RV(null);
    BK(null);
    PR(null);
    D([]);
    DS(null);
    E("");
    if (!storeId) return;
    if ([0, 1, 4].includes(tab) && !period) {
      B(false);
      return;
    }
    B(true);
    async function load() {
      try {
        if (tab === 0) {
          const r = await api.report(storeId, period);
          if (v === version.current) R(r);
        } else if (tab === 1) {
          const r = await api.revenue(storeId, period, page);
          if (v === version.current) RV(r);
        } else if (tab === 2) {
          const q = ["page=" + page];
          if (start) q.push("start=" + start);
          if (end) q.push("end=" + end);
          if (status) q.push("match_status=" + status);
          const r = await api.bank(storeId, q.join("&"));
          if (v === version.current) BK(r);
        } else if (tab === 3) {
          const r = await api.preopening(storeId);
          if (v === version.current) PR(r);
        } else {
          const r = await api.dividend(storeId, period);
          if (v === version.current) { D(r.history); DS(r.supplement); }
        }
      } catch (e) {
        if (v === version.current)
          E(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (v === version.current) B(false);
      }
    }
    load();
    return () => {
      version.current++;
    };
  }, [storeId, period, tab, page, start, end, status, refresh]);
  const m = report?.report.metrics,
    s = report?.supplement;
  const storeIndex = Math.max(
    0,
    stores.findIndex((x) => x.id === storeId),
  );
  function selectTab(i: number) {
    PG(1);
    T(i);
  }
  return (
    <View className="page">
      <View className="hero">
        <Text className="eyebrow">门店经营</Text>
        <Picker
          mode="selector"
          range={stores.map((x) => x.name)}
          value={storeIndex}
          onChange={(e) => {
            PG(1);
            selectStore(stores[Number(e.detail.value)].id);
            I(stores[Number(e.detail.value)].id);
          }}
        >
          <Text className="title">
            {stores.find((x) => x.id === storeId)?.name || "门店"} ⌄
          </Text>
        </Picker>
        <Text className="hero-subtitle">
          报表按已封账月份查看 · 流水支持实时查询
        </Text>
      </View>
      <View className="tabs">
        {tabs.map((label, i) => (
          <Button
            key={label}
            className={tab === i ? "tab active" : "tab"}
            onClick={() => selectTab(i)}
          >
            {label}
          </Button>
        ))}
      </View>
      {[0, 1, 4].includes(tab) && (
        <Picker
          mode="selector"
          range={periods.map((x) => x.replace("-", "年") + "月")}
          value={Math.max(0, periods.indexOf(period))}
          onChange={(e) => {
            PG(1);
            const next = periods[Number(e.detail.value)];
            selectPeriod(storeId, next);
            P(next);
          }}
        >
          <View className="period-picker">{period || "暂无已封账月份"} ⌄</View>
        </Picker>
      )}
      {tab === 2 && (
        <View className="filters">
          <Picker
            mode="date"
            value={start}
            onChange={(e) => {
              PG(1);
              ST(e.detail.value);
            }}
          >
            <Text>{start || "开始日期"}</Text>
          </Picker>
          <Picker
            mode="date"
            value={end}
            onChange={(e) => {
              PG(1);
              EN(e.detail.value);
            }}
          >
            <Text>{end || "结束日期"}</Text>
          </Picker>
          <Picker
            mode="selector"
            range={["全部关联状态", "未完全关联", "已关联"]}
            onChange={(e) => {
              PG(1);
              MS(["", "unmatched", "matched"][Number(e.detail.value)]);
            }}
          >
            <Text>
              {status === "matched"
                ? "已关联"
                : status
                  ? "未完全关联"
                  : "全部关联状态"}{" "}
              ⌄
            </Text>
          </Picker>
          <Button
            onClick={() => {
              ST("");
              EN("");
              MS("");
              PG(1);
            }}
          >
            重置
          </Button>
        </View>
      )}
      {busy && <View className="section">正在加载，请稍候…</View>}
      {error && (
        <View className="section error">
          <Text>{error}</Text>
          <Button onClick={() => RF(refresh + 1)}>重新加载</Button>
        </View>
      )}
      {!busy && !error && [0, 1, 4].includes(tab) && !period && (
        <View className="section">暂无已封账月份，请联系财务</View>
      )}
      {m && (
        <>
          <View className="summary">
            <Metric label="营业收入" value={money(m.income_amount)} />
            <Metric label="业绩目标" value={money(s?.revenue_target)} />
            <Metric
              label="完成率"
              value={
                Number(s?.revenue_target) > 0
                  ? pct(
                      (Number(m.income_amount) / Number(s?.revenue_target)) *
                        100,
                    )
                  : "—"
              }
            />
            <Metric label="实收" value={money(m.net_income_amount)} />
            <Metric label="手续费" value={money(m.fee_amount)} />
            <Metric
              label="手续费率"
              value={
                Number(m.income_amount) > 0
                  ? pct((Number(m.fee_amount) / Number(m.income_amount)) * 100)
                  : "—"
              }
            />
            <Metric label="总支出" value={money(m.expense_amount)} />
            <Metric label="毛利润" value={money(m.gross_profit_amount)} />
            <Metric
              label="净利润"
              value={money(Number(m.income_amount) - Number(m.expense_amount))}
            />
          </View>
          <View className="section">
            <Text className="section-title">成本结构</Text>
            {[
              ["食材成本", m.food_cost_amount, m.food_cost_rate],
              ["人工成本", m.labor_cost_amount, m.labor_cost_rate],
              ["租金成本", m.rent_cost_amount, m.rent_cost_rate],
            ].map(([label, amount, rate]) => (
              <View className="row" key={String(label)}>
                <Text>
                  {label} {money(amount)}
                </Text>
                <Text>{pct(rate)}</Text>
                <View className="mobile-track">
                  <View
                    style={{
                      width:
                        Math.min(100, Math.max(0, Number(rate) || 0)) + "%",
                    }}
                  />
                </View>
              </View>
            ))}
          </View>
          <View className="section">
            <Text className="section-title">营业渠道</Text>
            {m.revenue_channel_summary.map((x) => (
              <View key={x.channel} className="row">
                <Text>{x.channel}</Text>
                <Text>
                  营业收入 {money(x.gross_amount)} · 实收 {money(x.net_amount)}
                </Text>
              </View>
            ))}
          </View>
          <View className="section">
            <Text className="section-title">各类别支出</Text>
            {m.expense_category_summary.map((x) => (
              <View
                className="row"
                key={x.name}
                onClick={() =>
                  Taro.navigateTo({
                    url: `/pages/expenses/index?storeId=${storeId}&period=${period}&category=${encodeURIComponent(x.name)}`,
                  })
                }
              >
                <Text>{x.name}</Text>
                <Text>{money(x.amount)}</Text>
              </View>
            ))}
          </View>
          <View className="section">
            <Text className="section-title">利润与资金</Text>
            <View className="row">
              <Text>报表银行余额</Text>
              <Text>
                {money((s?.bank_balance as { amount?: string })?.amount)}
              </Text>
              <Text className="row-sub">
                {String((s?.bank_balance as { date?: string })?.date || "")}
              </Text>
            </View>
            {[
              ["上月末未分配利润", s?.previous_remaining_undistributed],
              ["剩余未分配利润", s?.remaining_undistributed],
              ["历史累计利润", s?.historical_profit],
              ["本月补充筹建超支", s?.preopening_coverage_amount],
              ["本月分配", s?.distribution_amount],
              ["本月运营增资", s?.capital_amount],
              ["筹建投入资金", s?.preopening_investment],
              ["筹建费用总支出", s?.preopening_expense_amount],
              ["累计投入", s?.total_capital],
              ["累计分红", s?.cumulative_distribution],
            ].map(([l, v]) => (
              <View className="row" key={String(l)}>
                <Text>{String(l)}</Text>
                <Text>{money(v)}</Text>
              </View>
            ))}
          </View>
        </>
      )}
      {revenue && (
        <>
          <View className="section">
            <Text className="section-title">渠道月度统计</Text>
            {revenue.channels.map((x) => (
              <View key={x.channel} className="row">
                <Text>{x.channel}</Text>
                <Text>
                  营业 {money(x.gross)} · 实收 {money(x.net)}
                </Text>
                <Text className="row-sub">
                  手续费 {money(x.fee)} · 费率{" "}
                  {Number(x.gross) > 0
                    ? pct((Number(x.fee) / Number(x.gross)) * 100)
                    : "—"}
                </Text>
              </View>
            ))}
          </View>
          <View className="section">
            <Text className="section-title">
              每日明细 · 共 {revenue.total} 条
            </Text>
            {revenue.items.map((x) => (
              <View className="row" key={x.id}>
                <Text>
                  {x.revenue_date} · {x.channel}
                </Text>
                <Text>{money(x.gross_amount)}</Text>
                <Text className="row-sub">
                  实收 {money(x.net_amount)} · 手续费 {money(x.fee_amount)}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
      {bank && (
        <>
          <View className="section">
            <Text className="section-title">当前银行余额</Text>
            <Text className="value">
              {money(
                bank.balance.current_balance ?? bank.balance.balance_amount,
              )}
            </Text>
            <Text className="row-sub">当前余额，不随列表日期筛选改变</Text>
          </View>
          <View className="section">
            <Text className="section-title">
              银行流水 · 共 {bank.list.total} 笔
            </Text>
            {bank.list.items.map((x) => (
              <View
                className="row"
                key={x.id}
                onClick={() =>
                  Taro.navigateTo({
                    url: "/pages/bank-detail/index?id=" + x.id,
                  })
                }
              >
                <Text>
                  {x.counterparty_name || "未填写户名"} ·{" "}
                  {x.direction === "income" ? "收入" : "支出"} {money(x.amount)}
                </Text>
                <Text className="row-sub">
                  {x.occurred_at.slice(0, 10)} ·{" "}
                  {x.direct_posting_type
                    ? "直接入账"
                    : Number(x.matched_amount) >= Number(x.amount)
                      ? "已关联"
                      : Number(x.matched_amount) > 0
                        ? "部分关联"
                        : "未关联"}
                </Text>
                <Text className="row-sub">
                  余额 {money(x.running_balance)} · 查看业务详情 →
                </Text>
                <Button onClick={(event) => { event.stopPropagation(); Taro.navigateTo({ url: "/pages/bank-detail/index?id=" + x.id + "&details=1" }); }}>详情</Button>
              </View>
            ))}
          </View>
        </>
      )}
      {pre && (
        <View className="section">
          <Text className="section-title">筹建累计支出 {money(pre.total)}</Text>
          <Text className="row-sub">
            不分账期 · {pre.status === "closed" ? "已封账" : "筹建中"}
          </Text>
          {pre.details.map((x, i) => (
            <View className="row" key={x.id || i}>
              <Text>
                {x.category_l1} / {x.category_l2}
              </Text>
              <Text>{x.description}</Text>
              <Text>{money(x.amount)}</Text>
            </View>
          ))}
        </View>
      )}
      {tab === 4 && divSummary && <View className="section">
        <Text className="section-title">{period} · 投入与累计</Text>
        {[
          ["上月末未分配利润", divSummary.previous_remaining_undistributed],
          ["筹建投入资金", divSummary.preopening_investment],
          ["筹建费用总支出", divSummary.preopening_expense_source === "missing" ? null : divSummary.preopening_expense_amount],
          [Number(divSummary.preopening_balance) < 0 ? "筹建超支" : "筹建结余", divSummary.preopening_balance == null ? null : Math.abs(Number(divSummary.preopening_balance))],
          ["经营利润已补充筹建超支", divSummary.preopening_profit_covered],
          ["筹建超支未补充", divSummary.preopening_uncovered],
          ["累计投入", divSummary.total_capital],
        ].map(([label, value]) => <View className="row" key={String(label)}><Text>{label}</Text><Text>{money(value)}</Text></View>)}
      </View>}
      {tab === 4 &&
        div.map((x) => (
          <View className="section" key={x.period}>
            <Text className="section-title">
              {x.period} {x.period === period ? "· 当前查看月" : ""}
            </Text>
            <View className="row">
              <Text>净利润 {money(x.net_profit)}</Text>
              <Text>
                分配 {money(x.distribution_amount)} · 增资{" "}
                {money(x.capital_amount)}
              </Text>
              <Text>剩余未分配 {money(x.remaining_undistributed)}</Text>
              <Text>可分配利润 {money(x.available_profit)}</Text>
              <Text>本月补充筹建超支 {money(x.preopening_coverage_amount)}</Text>
              <Text>累计补充筹建超支 {money(x.cumulative_preopening_coverage)}</Text>
              <Text>历史累计利润 {money(x.historical_profit)}</Text>
              <Text>历史累计分红 {money(x.historical_distribution)}</Text>
              <Text>累计运营增资 {money(x.cumulative_capital)}</Text>
              <Text>建议分红 {money(x.suggested_distribution)} · 参考比例 {pct(x.reference_ratio)}</Text>
              <Text>{x.excluded_from_calculation ? "期初隔离前" : x.locked ? "已锁定" : "已出账"}</Text>
            </View>
            {x.entries.map((e, i) => (
              <View className="row" key={i}>
                <Text>
                  {e.shareholder_name} ·{" "}
                  {e.entry_type === "distribution" ? "分红" : e.entry_type === "preopening_coverage" ? "补充筹建超支" : "注资"}{" "}
                  {money(e.amount)}
                </Text>
                <Text className="row-sub">{e.remark || "无备注"}</Text>
              </View>
            ))}
          </View>
        ))}
      {!busy && !error && ((tab === 1 && revenue) || (tab === 2 && bank)) && (
        <View className="filters">
          <Button disabled={page === 1} onClick={() => PG(page - 1)}>
            上一页
          </Button>
          <Text>第 {page} 页</Text>
          <Button
            disabled={
              page * 30 >= (tab === 1 ? revenue!.total : bank!.list.total)
            }
            onClick={() => PG(page + 1)}
          >
            下一页
          </Button>
        </View>
      )}
    </View>
  );
}
