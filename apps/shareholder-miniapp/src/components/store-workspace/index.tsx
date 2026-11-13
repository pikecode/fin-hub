import FinancialReport from "../financial-report";
import { Button, Picker, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import type {
  DividendMonth,
  FinancialReportSupplement,
} from "@fin-hub/shared-types";
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
const tabs = ["财务报表", "营业收入"];
export default function StoreWorkspace({
  mode,
}: {
  mode: "report" | "bank" | "dividend";
}) {
  const [stores, S] = useState<MobileStore[]>([]),
    [storeId, I] = useState(""),
    [periods, PS] = useState<string[]>([]),
    [period, P] = useState(""),
    [tab, T] = useState(mode === "bank" ? 2 : mode === "dividend" ? 4 : 0),
    [busy, B] = useState(false),
    [error, E] = useState("");
  const [report, R] = useState<MobileReport | null>(null),
    [revenue, RV] = useState<MobileRevenue | null>(null),
    [bank, BK] = useState<MobileBank | null>(null),
    [div, D] = useState<DividendMonth[]>([]),
    [divSummary, DS] = useState<FinancialReportSupplement | null>(null),
    [page, PG] = useState(1),
    [start, ST] = useState(""),
    [end, EN] = useState(""),
    [status, MS] = useState(""),
    [refresh, RF] = useState(0);
  const version = useRef(0),
    periodVersion = useRef(0),
    periodStore = useRef("");
  const [storeRefresh, SR] = useState(0);
  const [storeReady, ready] = useState(false);
  const [storeError, storeFailed] = useState("");
  const [periodError, periodFailed] = useState("");
  const [periodBusy, periodLoading] = useState(false);
  function loadStores() {
    storeFailed("");
    version.current++;
    api
      .stores()
      .then((rows) => {
        S(rows);
        const saved = selectedStore();
        const next = rows.find((x) => x.id === saved)?.id || rows[0]?.id || "";
        if (next) selectStore(next);
        I(next);
        PG(1);
        SR((n) => n + 1);
        RF((n) => n + 1);
        ready(true);
      })
      .catch((e) => {
        storeFailed(e.message);
        B(false);
        Taro.stopPullDownRefresh();
      });
  }
  Taro.useDidShow(loadStores);
  Taro.usePullDownRefresh(loadStores);
  const [filtersOpen, showFilters] = useState(false);
  const [divOpen, openDiv] = useState<Record<string, boolean>>({});
  const [showInvestment, investment] = useState(false);
  useEffect(() => {
    if (!storeId || mode === "bank") return;
    const v = ++periodVersion.current;
    if (periodStore.current !== storeId) {
      P("");
      PS([]);
      periodStore.current = storeId;
    }
    periodFailed("");
    periodLoading(true);
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
        if (v === periodVersion.current) periodFailed(e.message);
      })
      .finally(() => {
        if (v === periodVersion.current) periodLoading(false);
      });
    return () => {
      periodVersion.current++;
    };
  }, [storeId, mode, storeRefresh]);
  useEffect(() => {
    const v = ++version.current;
    if (tab !== 0) R(null);
    RV(null);
    BK(null);
    D([]);
    DS(null);
    E("");
    if (!storeReady || !storeId) {
      B(false);
      Taro.stopPullDownRefresh();
      return;
    }
    if ([0, 1, 4].includes(tab) && !period) {
      B(false);
      Taro.stopPullDownRefresh();
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
        } else {
          const r = await api.dividend(storeId, period);
          if (v === version.current) {
            D(r.history);
            DS(r.supplement);
          }
        }
      } catch (e) {
        if (v === version.current)
          E(e instanceof Error ? e.message : "加载失败");
      } finally {
        if (v === version.current) {
          B(false);
          Taro.stopPullDownRefresh();
        }
      }
    }
    load();
    return () => {
      version.current++;
    };
  }, [storeReady, storeId, period, tab, page, start, end, status, refresh]);
  const storeIndex = Math.max(
    0,
    stores.findIndex((x) => x.id === storeId),
  );
  function selectTab(i: number) {
    PG(1);
    T(i);
  }
  const activeReport =
    tab === 0 &&
    report?.report.store.id === storeId &&
    report.report.period === period
      ? report
      : null;
  const hasContent = Boolean(activeReport || revenue || bank || divSummary);
  const dividendRows = [...div].sort((a, b) =>
    a.period === period
      ? -1
      : b.period === period
        ? 1
        : b.period.localeCompare(a.period),
  );
  const storeName = stores.find((x) => x.id === storeId)?.name;
  const storeSelector = (
    <Picker
      mode="selector"
      disabled={!storeReady || !stores.length}
      range={stores.map((x) => x.name)}
      value={storeIndex}
      onChange={(e) => {
        const next = stores[Number(e.detail.value)];
        if (!next) return;
        PG(1);
        P("");
        selectStore(next.id);
        I(next.id);
      }}
    >
      <View className="store-select">
        <Text>{storeName || "选择门店"}</Text>
        <Text className="select-arrow">⌄</Text>
      </View>
    </Picker>
  );
  return (
    <View className="page workspace-page">
      <View className="workspace-header">
        <View className="workspace-heading">
          <View className="store-heading">
            <Text className="eyebrow">
              {mode === "report"
                ? "门店经营"
                : mode === "bank"
                  ? "资金明细"
                  : "利润分配"}
            </Text>
            {storeSelector}
          </View>
          {mode === "bank" ? (
            <Button
              className={
                filtersOpen ? "filter-toggle selected" : "filter-toggle"
              }
              onClick={() => showFilters(!filtersOpen)}
            >
              筛选 {filtersOpen ? "⌃" : "⌄"}
            </Button>
          ) : (
            <Picker
              mode="selector"
              disabled={periodBusy || !periods.length}
              range={periods.map((x) => x.replace("-", "年") + "月")}
              value={Math.max(0, periods.indexOf(period))}
              onChange={(e) => {
                const next = periods[Number(e.detail.value)];
                if (!next) return;
                PG(1);
                selectPeriod(storeId, next);
                P(next);
              }}
            >
              <View className="month-select">
                <Text>
                  {periodBusy
                    ? "加载月份"
                    : period
                      ? period.replace("-", ".")
                      : "暂无账期"}
                </Text>
                <Text>⌄</Text>
              </View>
            </Picker>
          )}
        </View>
        {mode === "report" && (
          <View className="tabs workspace-tabs">
            {tabs.map((label, index) => (
              <Button
                key={label}
                className={tab === index ? "tab active" : "tab"}
                onClick={() => selectTab(index)}
              >
                {label}
              </Button>
            ))}
          </View>
        )}
        {mode === "bank" && (
          <Text className="workspace-caption">全部银行流水 · 不受账期限制</Text>
        )}
        {mode === "dividend" && (
          <Text className="workspace-caption">查看月度分红与累计收益</Text>
        )}
      </View>
      {tab === 2 && filtersOpen && (
        <View className="section bank-filters">
          <Text className="section-title">筛选流水</Text>
          <View className="date-filter">
            <Picker
              mode="date"
              value={start}
              end={end || undefined}
              onChange={(e) => {
                PG(1);
                ST(e.detail.value);
              }}
            >
              <Text>{start || "开始日期"}</Text>
            </Picker>
            <Text>至</Text>
            <Picker
              mode="date"
              value={end}
              start={start || undefined}
              onChange={(e) => {
                PG(1);
                EN(e.detail.value);
              }}
            >
              <Text>{end || "结束日期"}</Text>
            </Picker>
          </View>
          <View className="filter-statuses">
            {[
              ["", "全部状态"],
              ["unmatched", "未完全关联"],
              ["matched", "已关联"],
            ].map(([value, label]) => (
              <Button
                key={label}
                className={
                  status === value ? "filter-chip active" : "filter-chip"
                }
                onClick={() => {
                  PG(1);
                  MS(value);
                }}
              >
                {label}
              </Button>
            ))}
          </View>
          <Button
            className="list-more"
            onClick={() => {
              ST("");
              EN("");
              MS("");
              PG(1);
            }}
          >
            清除筛选
          </Button>
        </View>
      )}
      {tab === 2 && !filtersOpen && !!(start || end || status) && (
        <View className="filter-applied" onClick={() => showFilters(true)}>
          <Text>
            {start || "不限开始日期"} 至 {end || "不限结束日期"} ·{" "}
            {status === "matched"
              ? "已关联"
              : status
                ? "未完全关联"
                : "全部状态"}
          </Text>
          <Text>修改 ›</Text>
        </View>
      )}
      {((!storeReady && !storeError) || periodBusy || busy) && !hasContent && (
        <View className="skeleton-panel">
          <View className="skeleton-line short" />
          <View className="skeleton-line amount" />
          <View className="skeleton-pair">
            <View className="skeleton-line" />
            <View className="skeleton-line" />
          </View>
          <Text>正在加载经营数据…</Text>
        </View>
      )}
      {busy && hasContent && (
        <Text className="refresh-note">正在更新数据…</Text>
      )}
      {(storeError || periodError || error) && (
        <View className="section empty-state">
          <Text className="empty-symbol">!</Text>
          <Text className="empty-title">暂时无法加载</Text>
          <Text className="empty-description">
            {storeError || periodError || error}
          </Text>
          <Button
            className="secondary-button"
            onClick={() => {
              if (storeError || periodError) loadStores();
              else RF((n) => n + 1);
            }}
          >
            重新加载
          </Button>
        </View>
      )}
      {!busy &&
        !error &&
        !periodError &&
        !periodBusy &&
        storeReady &&
        !!storeId &&
        [0, 1, 4].includes(tab) &&
        !period && (
          <View className="section empty-state">
            <Text className="empty-symbol">—</Text>
            <Text className="empty-title">这家门店暂未建立账期</Text>
            <Text className="empty-description">
              可在顶部切换门店，或联系财务建立账期。银行流水可在底部独立查看。
            </Text>
            <Button
              className="secondary-button"
              onClick={() => Taro.switchTab({ url: "/pages/bank/index" })}
            >
              查看银行流水
            </Button>
          </View>
        )}
      {storeReady && !storeId && !storeError && (
        <View className="section empty-state">
          <Text className="empty-symbol">⌂</Text>
          <Text className="empty-title">还没有授权门店</Text>
          <Text className="empty-description">
            请联系管理员分配需要查看的门店，授权后下拉刷新即可。
          </Text>
        </View>
      )}
      {storeReady && activeReport && (
        <FinancialReport key={`${storeId}:${period}`} data={activeReport} />
      )}
      {storeReady && revenue && (
        <>
          <View className="section revenue-overview">
            <Text className="label">渠道营业收入</Text>
            <Text className="balance-value">
              {money(
                revenue.channels.reduce(
                  (sum, item) => sum + Number(item.gross),
                  0,
                ),
              )}
            </Text>
            <Text className="row-sub">
              {period.replace("-", "年")}月 · 渠道记录合计
            </Text>
            <View className="revenue-totals">
              <View>
                <Text className="label">实收金额</Text>
                <Text>
                  {money(
                    revenue.channels.reduce(
                      (sum, item) => sum + Number(item.net),
                      0,
                    ),
                  )}
                </Text>
              </View>
              <View>
                <Text className="label">渠道手续费</Text>
                <Text>
                  {money(
                    revenue.channels.reduce(
                      (sum, item) => sum + Number(item.fee),
                      0,
                    ),
                  )}
                </Text>
              </View>
            </View>
          </View>
          <View className="section">
            <Text className="section-title">收入渠道</Text>
            {!revenue.channels.length && (
              <Text className="empty-inline">本月暂无渠道收入</Text>
            )}
            {revenue.channels.map((item) => (
              <View className="record-item" key={item.channel}>
                <View className="report-line">
                  <Text>{item.channel}</Text>
                  <Text className="list-money">{money(item.gross)}</Text>
                </View>
                <Text className="row-sub">实收 {money(item.net)}</Text>
                <Text className="row-sub">
                  手续费 {money(item.fee)} · 费率{" "}
                  {Number(item.gross) > 0
                    ? pct((Number(item.fee) / Number(item.gross)) * 100)
                    : "—"}
                </Text>
              </View>
            ))}
          </View>
          <View className="section">
            <View className="report-line">
              <Text className="section-title">每日明细</Text>
              <Text className="row-sub">共 {revenue.total} 条</Text>
            </View>
            {!revenue.items.length && (
              <Text className="empty-inline">本月暂无收入记录</Text>
            )}
            {revenue.items.map((item) => (
              <View className="record-item" key={item.id}>
                <View className="report-line">
                  <View>
                    <Text>{item.channel}</Text>
                    <Text className="row-sub">{item.revenue_date}</Text>
                  </View>
                  <Text className="list-money">{money(item.gross_amount)}</Text>
                </View>
                <Text className="row-sub">
                  实收 {money(item.net_amount)} · 手续费{" "}
                  {money(item.fee_amount)}
                </Text>
              </View>
            ))}
          </View>
        </>
      )}
      {storeReady && bank && (
        <>
          <View className="section bank-balance">
            <View className="report-line">
              <Text className="label">当前银行卡余额</Text>
              <Text className="balance-mark">实时余额</Text>
            </View>
            <Text className="balance-value">
              {money(
                bank.balance.current_balance ?? bank.balance.balance_amount,
              )}
            </Text>
            <Text className="row-sub">
              独立于列表筛选，按余额基准及后续流水计算
            </Text>
          </View>
          <View className="section bank-list">
            <View className="report-line">
              <Text className="section-title">银行流水</Text>
              <Text className="row-sub">{bank.list.total} 笔</Text>
            </View>
            {!bank.list.items.length && (
              <View className="empty-state compact">
                <Text className="empty-title">暂无符合条件的流水</Text>
                <Text className="empty-description">
                  试试调整日期、关联状态，或切换门店。
                </Text>
              </View>
            )}
            {bank.list.items.map((item) => (
              <View
                className="bank-item"
                key={item.id}
                onClick={() =>
                  Taro.navigateTo({
                    url: "/pages/bank-detail/index?id=" + item.id,
                  })
                }
              >
                <View
                  className={
                    item.direction === "income"
                      ? "direction-icon income"
                      : "direction-icon"
                  }
                >
                  {item.direction === "income" ? "+" : "−"}
                </View>
                <View className="bank-item-body">
                  <View className="report-line">
                    <Text className="bank-name">
                      {item.counterparty_name || "未填写户名"}
                    </Text>
                    <Text
                      className={
                        item.direction === "income"
                          ? "bank-money income-text"
                          : "bank-money"
                      }
                    >
                      {item.direction === "income" ? "+" : "−"}
                      {money(item.amount)}
                    </Text>
                  </View>
                  <View className="report-line">
                    <Text className="row-sub">
                      {item.occurred_at.slice(0, 10)}
                    </Text>
                    <Text
                      className={
                        Number(item.matched_amount) >= Number(item.amount) ||
                        item.direct_posting_type
                          ? "status-badge"
                          : "status-badge pending"
                      }
                    >
                      {item.direct_posting_type
                        ? "直接入账"
                        : Number(item.matched_amount) >= Number(item.amount)
                          ? "已关联"
                          : Number(item.matched_amount) > 0
                            ? "部分关联"
                            : "未关联"}
                    </Text>
                  </View>
                  {item.summary && (
                    <Text className="bank-note">{item.summary}</Text>
                  )}
                  <View className="bank-item-footer">
                    <Text>余额 {money(item.running_balance)}</Text>
                    <Button
                      className="text-button"
                      onClick={(event) => {
                        event.stopPropagation();
                        Taro.navigateTo({
                          url:
                            "/pages/bank-detail/index?id=" +
                            item.id +
                            "&details=1",
                        });
                      }}
                    >
                      流水信息 ›
                    </Button>
                  </View>
                  <Text className="record-link">查看关联业务 ›</Text>
                </View>
              </View>
            ))}
          </View>
        </>
      )}
      {storeReady && tab === 4 && divSummary && (
        <>
          {dividendRows.map((item) => {
            const open = divOpen[item.period] ?? false;
            return (
              <View className="section dividend-card" key={item.period}>
                <View
                  className="report-line dividend-heading"
                  onClick={() => openDiv({ ...divOpen, [item.period]: !open })}
                >
                  <View>
                    <Text className="section-title">
                      {item.period.replace("-", "年")}月
                    </Text>
                    <Text className="row-sub">
                      {item.period === period ? "当前查看月 · " : ""}
                      {item.excluded_from_calculation
                        ? "期初隔离前"
                        : item.locked
                          ? "已锁定"
                          : "未锁定，数据可能更新"}
                    </Text>
                  </View>
                  <Text className="chevron">{open ? "⌃" : "⌄"}</Text>
                </View>
                <View className="dividend-primary">
                  <Text className="label">本月分红</Text>
                  <Text className="balance-value">
                    {money(item.distribution_amount)}
                  </Text>
                </View>
                <View className="dividend-pair">
                  <View>
                    <Text className="label">本月净利润</Text>
                    <Text>{money(item.net_profit)}</Text>
                  </View>
                  <View>
                    <Text className="label">剩余未分配</Text>
                    <Text>{money(item.remaining_undistributed)}</Text>
                  </View>
                </View>
                {open && (
                  <>
                    <View className="dividend-details">
                      {[
                        ["可分配利润", item.available_profit],
                        ["本月运营增资", item.capital_amount],
                        ["本月补充筹建超支", item.preopening_coverage_amount],
                        [
                          "累计补充筹建超支",
                          item.cumulative_preopening_coverage,
                        ],
                        ["历史累计利润", item.historical_profit],
                        ["历史累计分红", item.historical_distribution],
                        ["累计运营增资", item.cumulative_capital],
                        ["建议分红", item.suggested_distribution],
                      ].map(([label, value]) => (
                        <View
                          className="report-line detail-pair"
                          key={String(label)}
                        >
                          <Text>{label}</Text>
                          <Text>{money(value)}</Text>
                        </View>
                      ))}
                      <View className="report-line detail-pair">
                        <Text>参考比例</Text>
                        <Text>{pct(item.reference_ratio)}</Text>
                      </View>
                    </View>
                    <View className="dividend-entries">
                      <Text className="section-title">股东记录</Text>
                      {!item.entries.length && (
                        <Text className="empty-inline">
                          本月暂无股东分配记录
                        </Text>
                      )}
                      {item.entries.map((entry, index) => (
                        <View className="record-item" key={index}>
                          <View className="report-line">
                            <View>
                              <Text>{entry.shareholder_name}</Text>
                              <Text className="row-sub">
                                {entry.entry_type === "distribution"
                                  ? "分红"
                                  : entry.entry_type === "preopening_coverage"
                                    ? "补充筹建超支"
                                    : "注资"}
                              </Text>
                            </View>
                            <Text className="list-money">
                              {money(entry.amount)}
                            </Text>
                          </View>
                          <Text className="row-sub">
                            {entry.remark || "无备注"}
                          </Text>
                        </View>
                      ))}
                    </View>
                  </>
                )}
                <Button
                  className="list-more"
                  onClick={() => openDiv({ ...divOpen, [item.period]: !open })}
                >
                  {open ? "收起分红明细 ⌃" : "查看分红明细 ⌄"}
                </Button>
              </View>
            );
          })}
          {!div.length && (
            <View className="section empty-state">
              <Text className="empty-title">暂无分红记录</Text>
              <Text className="empty-description">
                财务确认后的分红数据会同步在这里展示。
              </Text>
            </View>
          )}
          <View className="section">
            <View
              className="report-line"
              onClick={() => investment(!showInvestment)}
            >
              <Text className="section-title">投入与累计</Text>
              <Text className="chevron">{showInvestment ? "⌃" : "⌄"}</Text>
            </View>
            {showInvestment &&
              [
                [
                  "上月末未分配利润",
                  divSummary.previous_remaining_undistributed,
                ],
                ["筹建投入资金", divSummary.preopening_investment],
                [
                  "筹建费用总支出",
                  divSummary.preopening_expense_source === "missing"
                    ? null
                    : divSummary.preopening_expense_amount,
                ],
                [
                  Number(divSummary.preopening_balance) < 0
                    ? "筹建超支"
                    : "筹建结余",
                  divSummary.preopening_balance == null
                    ? null
                    : Math.abs(Number(divSummary.preopening_balance)),
                ],
                [
                  "经营利润已补充筹建超支",
                  divSummary.preopening_profit_covered,
                ],
                ["筹建超支未补充", divSummary.preopening_uncovered],
                ["累计投入", divSummary.total_capital],
              ].map(([label, value]) => (
                <View className="report-line detail-pair" key={String(label)}>
                  <Text>{label}</Text>
                  <Text>{money(value)}</Text>
                </View>
              ))}
          </View>
        </>
      )}
      {storeReady &&
        !busy &&
        !error &&
        ((tab === 1 && revenue) || (tab === 2 && bank)) && (
          <View className="mobile-pagination">
            <Button disabled={page === 1} onClick={() => PG(page - 1)}>
              上一页
            </Button>
            <Text>
              {page} /{" "}
              {Math.max(
                1,
                Math.ceil((tab === 1 ? revenue!.total : bank!.list.total) / 30),
              )}
            </Text>
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
      {hasContent && (
        <Text className="workspace-footnote">
          仅查看 · 下拉刷新获取最新数据
        </Text>
      )}
    </View>
  );
}
