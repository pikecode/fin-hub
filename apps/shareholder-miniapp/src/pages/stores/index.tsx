import { Button, Input, Picker, View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useMemo, useState } from "react";
import type {
  LedgerReportSummary,
  LedgerTrend,
  ReportPeriodOption,
  ShareholderAccessGrant,
  StoreComparisonReport,
  StoreReportSummary,
} from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";
import { api, clearShareholderToken, getShareholderToken, MiniappApiError } from "../../lib/api";
import "./index.css";

type SortKey = "profit" | "income" | "profitRate" | "name";

interface AggregateTrendItem {
  period: string;
  incomeAmount: number;
  expenseAmount: number;
  profitAmount: number;
}

export default function StoresPage() {
  const [stores, setStores] = useState<StoreReportSummary[]>([]);
  const [comparison, setComparison] = useState<StoreComparisonReport | null>(null);
  const [grant, setGrant] = useState<ShareholderAccessGrant | null>(null);
  const [reportPeriods, setReportPeriods] = useState<ReportPeriodOption[]>([]);
  const [storeTrends, setStoreTrends] = useState<LedgerTrend[]>([]);
  const [statusText, setStatusText] = useState("加载中");
  const [isLoading, setIsLoading] = useState(false);
  const [hasLoadError, setHasLoadError] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("profit");
  const [selectedPeriod, setSelectedPeriod] = useState("");
  const [searchQuery, setSearchQuery] = useState("");

  async function loadComparison(period?: string) {
    const comparisonData = await api.storeComparison(period);
    setComparison(comparisonData);
    setSelectedPeriod(comparisonData.period);
    setStatusText(comparisonData.items.length ? "" : "当前账期暂无门店报表");
  }

  async function loadStores() {
    if (!getShareholderToken()) {
      Taro.reLaunch({ url: "/pages/shareholder-login/index" });
      return;
    }
    setIsLoading(true);
    setStatusText("加载中");
    setHasLoadError(false);
    try {
      const [profile, data, periodsData, comparisonData, trendData] = await Promise.all([
        api.shareholderMe(),
        api.storeSummaries(),
        api.reportPeriods(),
        api.storeComparison(),
        api.ledgerTrends(undefined, 6),
      ]);
      setGrant(profile);
      setStores(data);
      setReportPeriods(periodsData);
      setComparison(comparisonData);
      setStoreTrends(trendData);
      setSelectedPeriod(comparisonData.period);
      setStatusText(comparisonData.items.length ? "" : "暂无可查看门店");
    } catch (error) {
      if (error instanceof MiniappApiError && error.statusCode === 401) {
        clearShareholderToken();
        Taro.showToast({ title: "授权已失效，请重新登录", icon: "none" });
        Taro.reLaunch({ url: "/pages/shareholder-login/index" });
        return;
      }
      setHasLoadError(true);
      setStatusText("暂时无法加载报表数据");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadStores();
  }, []);

  async function changePeriod(index: number) {
    const period = periodOptions[index]?.period;
    if (!period || period === selectedPeriod) return;
    setIsLoading(true);
    setStatusText("加载中");
    try {
      await loadComparison(period);
    } catch {
      setStatusText("暂时无法加载该账期报表");
    } finally {
      setIsLoading(false);
    }
  }

  function profitRateOf(store: LedgerReportSummary) {
    return Number(store.income_amount) > 0 ? Number(store.profit_amount) / Number(store.income_amount) : -Infinity;
  }

  const periodOptions = useMemo(() => {
    const periods = new Map(reportPeriods.map((item) => [item.period, item]));
    stores.forEach((store) => {
      if (!periods.has(store.period)) {
        periods.set(store.period, { period: store.period, store_count: 1 });
      }
    });
    if (comparison?.period && !periods.has(comparison.period)) {
      periods.set(comparison.period, { period: comparison.period, store_count: comparison.items.length });
    }
    return [...periods.values()].sort((a, b) => b.period.localeCompare(a.period));
  }, [comparison?.items.length, comparison?.period, reportPeriods, stores]);
  const selectedPeriodIndex = Math.max(0, periodOptions.findIndex((item) => item.period === selectedPeriod));
  const selectedPeriodInfo = periodOptions.find((item) => item.period === selectedPeriod);
  const rankedStoreIds = useMemo(() => comparison?.items.map((item) => item.store_id) ?? [], [comparison]);
  const aggregateTrend = useMemo<AggregateTrendItem[]>(() => {
    const buckets = new Map<string, AggregateTrendItem>();
    storeTrends.forEach((trend) => {
      trend.items.forEach((item) => {
        const current = buckets.get(item.period) ?? {
          period: item.period,
          incomeAmount: 0,
          expenseAmount: 0,
          profitAmount: 0,
        };
        current.incomeAmount += Number(item.income_amount);
        current.expenseAmount += Number(item.expense_amount);
        current.profitAmount += Number(item.profit_amount);
        buckets.set(item.period, current);
      });
    });
    return [...buckets.values()].sort((a, b) => a.period.localeCompare(b.period)).slice(-6);
  }, [storeTrends]);
  const trendMaxAmount = useMemo(() => {
    const amounts = aggregateTrend.flatMap((item) => [Math.abs(item.incomeAmount), Math.abs(item.profitAmount)]);
    return Math.max(...amounts, 1);
  }, [aggregateTrend]);
  const visibleStores = useMemo(() => {
    const keyword = searchQuery.trim().toLowerCase();
    return [...(comparison?.items ?? [])]
      .filter((store) => !keyword || store.store_name.toLowerCase().includes(keyword))
      .sort((a, b) => {
        if (sortKey === "income") return Number(b.income_amount) - Number(a.income_amount);
        if (sortKey === "profitRate") return profitRateOf(b) - profitRateOf(a);
        if (sortKey === "name") return a.store_name.localeCompare(b.store_name, "zh-Hans-CN");
        return Number(b.profit_amount) - Number(a.profit_amount);
      });
  }, [comparison?.items, searchQuery, sortKey]);
  const topStore = comparison?.items[0];
  const profitRate =
    comparison && Number(comparison.total_income_amount) > 0
      ? (Number(comparison.total_profit_amount) / Number(comparison.total_income_amount)) * 100
      : 0;
  const isInitialLoading = isLoading && !comparison;

  function trendBarWidth(value: number) {
    return `${Math.max((Math.abs(value) / trendMaxAmount) * 100, 4).toFixed(2)}%`;
  }

  return (
    <View className="page">
      <View className="hero">
        <View>
          <Text className="eyebrow">股东报表</Text>
          <Text className="title">授权门店</Text>
          <Text className="hero-subtitle">
            {grant ? `${grant.name}，可查看 ${grant.store_ids.length} 家门店` : "正在读取授权"}
          </Text>
        </View>
        <Button className="refresh-button" loading={isLoading} onClick={loadStores}>
          刷新
        </Button>
      </View>
      {isInitialLoading ? (
        <View className="loading-card">
          <Text className="loading-title">正在加载报表</Text>
          <Text className="loading-text">读取授权门店、账期和经营汇总。</Text>
        </View>
      ) : null}
      {hasLoadError ? (
        <View className="empty-state error-state">
          <Text className="empty-title">报表加载失败</Text>
          <Text className="empty-text">请检查网络后重试。</Text>
          <Button className="retry-button" loading={isLoading} onClick={loadStores}>
            重新加载
          </Button>
        </View>
      ) : null}
      {statusText && !isInitialLoading && !hasLoadError ? <Text className="muted">{statusText}</Text> : null}
      {comparison ? (
        <View className="overview">
          <View className="overview-head">
            <View>
              <Text className="section-kicker">{formatPeriod(comparison.period)}</Text>
              <Text className="section-title">经营概览</Text>
            </View>
            <Text className="store-count">{comparison.items.length} 家门店</Text>
          </View>
          <View className="metric-grid">
            <View className="metric-card">
              <Text className="metric-label">总收入</Text>
              <Text className="metric-value">{formatMoney(comparison.total_income_amount)}</Text>
            </View>
            <View className="metric-card">
              <Text className="metric-label">总支出</Text>
              <Text className="metric-value expense">{formatMoney(comparison.total_expense_amount)}</Text>
            </View>
            <View className="metric-card wide">
              <Text className="metric-label">总利润</Text>
              <Text className="metric-value profit">{formatMoney(comparison.total_profit_amount)}</Text>
              <Text className="metric-note">利润率 {profitRate.toFixed(1)}%</Text>
            </View>
          </View>
          <View className="highlight">
            <Text className="highlight-label">当前领先门店</Text>
            <Text className="highlight-value">{topStore?.store_name ?? "-"}</Text>
          </View>
        </View>
      ) : null}
      {aggregateTrend.length ? (
        <View className="trend-section">
          <View className="overview-head">
            <View>
              <Text className="section-kicker">近 {aggregateTrend.length} 个账期</Text>
              <Text className="section-title">整体趋势</Text>
            </View>
          </View>
          {aggregateTrend.map((item) => (
            <View key={item.period} className="trend-row">
              <View className="trend-head">
                <Text className="trend-period">{formatPeriod(item.period)}</Text>
                <Text className={item.profitAmount >= 0 ? "trend-profit positive" : "trend-profit negative"}>
                  {formatMoney(item.profitAmount)}
                </Text>
              </View>
              <View className="trend-bar-row">
                <Text className="trend-label">收入</Text>
                <View className="trend-track">
                  <View className="trend-bar income" style={{ width: trendBarWidth(item.incomeAmount) }} />
                </View>
                <Text className="trend-value">{formatMoney(item.incomeAmount)}</Text>
              </View>
              <View className="trend-bar-row">
                <Text className="trend-label">利润</Text>
                <View className="trend-track">
                  <View
                    className={item.profitAmount >= 0 ? "trend-bar profit" : "trend-bar loss"}
                    style={{ width: trendBarWidth(item.profitAmount) }}
                  />
                </View>
                <Text className="trend-value">{formatMoney(item.profitAmount)}</Text>
              </View>
            </View>
          ))}
        </View>
      ) : null}
      <View className="toolbar">
        <Picker
          mode="selector"
          range={periodOptions.map((item) => `${formatPeriod(item.period)} · ${item.store_count} 家`)}
          value={selectedPeriodIndex}
          onChange={(event) => changePeriod(Number(event.detail.value))}
        >
          <View className="period-control">
            <Text className="control-label">账期</Text>
            <Text className="control-value">{selectedPeriod ? formatPeriod(selectedPeriod) : "暂无账期"}</Text>
            {selectedPeriodInfo ? (
              <Text className="control-subvalue">{selectedPeriodInfo.store_count} 家已封账</Text>
            ) : null}
          </View>
        </Picker>
        <Input
          className="search-input"
          placeholder="搜索门店"
          value={searchQuery}
          onInput={(event) => setSearchQuery(event.detail.value)}
        />
      </View>
      <View className="list-head">
        <View>
          <Text className="section-title">门店排行</Text>
          <Text className="list-subtitle">共 {visibleStores.length} 家</Text>
        </View>
        <View className="sort-tabs">
          {[
            ["profit", "利润"],
            ["income", "收入"],
            ["profitRate", "率"],
            ["name", "名称"],
          ].map(([key, label]) => (
            <Button
              key={key}
              className={sortKey === key ? "sort-tab active" : "sort-tab"}
              onClick={() => setSortKey(key as SortKey)}
            >
              {label}
            </Button>
          ))}
        </View>
      </View>
      {visibleStores.map((store) => (
        <View
          key={`${store.store_id}-${store.period}`}
          className="store-card"
          onClick={() =>
            Taro.navigateTo({
              url: `/pages/report/index?storeId=${store.store_id}&period=${store.period}`,
            })
          }
        >
          <View className="store-card-head">
            <View>
              <Text className="store-name">{store.store_name}</Text>
              <Text className="store-period">
                {formatPeriod(store.period)} {store.ledger_status === "closed" ? "已封账" : "做账中"}
              </Text>
            </View>
            <Text className="rank">#{rankedStoreIds.findIndex((item) => item === store.store_id) + 1 || "-"}</Text>
          </View>
          <View className="metrics">
            <View>
              <Text className="metric-label">收入</Text>
              <Text className="store-amount">{formatMoney(store.income_amount)}</Text>
            </View>
            <View>
              <Text className="metric-label">利润</Text>
              <Text className="store-amount strong">{formatMoney(store.profit_amount)}</Text>
            </View>
            <View>
              <Text className="metric-label">利润率</Text>
              <Text className="store-amount strong">
                {Number(store.income_amount) > 0 ? `${(profitRateOf(store) * 100).toFixed(1)}%` : "-"}
              </Text>
            </View>
          </View>
        </View>
      ))}
      {!statusText && !visibleStores.length ? (
        <View className="empty-state">
          <Text className="empty-title">没有匹配的门店</Text>
          <Text className="empty-text">换一个搜索关键词，或切换其他账期查看。</Text>
        </View>
      ) : null}
      <Button
        className="logout-button"
        onClick={() => {
          clearShareholderToken();
          Taro.reLaunch({ url: "/pages/shareholder-login/index" });
        }}
      >
        退出登录
      </Button>
    </View>
  );
}
