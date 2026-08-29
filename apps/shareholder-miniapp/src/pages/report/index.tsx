import { Button, Picker, View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useMemo, useState } from "react";
import type {
  ExpenseBreakdownItem,
  LedgerPeriodOption,
  LedgerReportDetail,
  LedgerTrend,
} from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";
import { api, clearShareholderToken, MiniappApiError } from "../../lib/api";
import "./index.css";

type ReportTab = "revenue" | "category" | "supplier" | "pendingExpense" | "pendingBank";

function BreakdownList({ title, items }: { title: string; items: ExpenseBreakdownItem[] }) {
  return (
    <View className="section">
      <Text className="section-title">{title}</Text>
      {items.length ? (
        items.map((item) => (
          <View key={item.name} className="row">
            <View>
              <Text className="row-main">{item.name}</Text>
              <Text className="row-sub">{item.item_count} 笔</Text>
            </View>
            <Text className="row-amount">{formatMoney(item.amount)}</Text>
          </View>
        ))
      ) : (
        <Text className="empty">暂无数据</Text>
      )}
    </View>
  );
}

function paymentStatusText(status?: string) {
  if (status === "paid") return "已付款";
  if (status === "partial_paid") return "部分付款";
  if (status === "unpaid") return "未付款";
  return status || "-";
}

function directionText(direction?: string) {
  if (direction === "income") return "收入";
  if (direction === "expense") return "支出";
  return direction || "-";
}

export default function ReportPage() {
  const router = Taro.useRouter();
  const storeId = router.params.storeId ?? "";
  const initialPeriod = router.params.period ?? "";
  const [detail, setDetail] = useState<LedgerReportDetail | null>(null);
  const [periods, setPeriods] = useState<LedgerPeriodOption[]>([]);
  const [trend, setTrend] = useState<LedgerTrend | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState(initialPeriod);
  const [statusText, setStatusText] = useState("加载中");
  const [activeTab, setActiveTab] = useState<ReportTab>("revenue");

  useEffect(() => {
    async function loadReport() {
      if (!storeId) {
        setStatusText("缺少门店参数");
        return;
      }
      try {
        setStatusText("加载中");
        const visiblePeriods = await api.ledgerPeriods(storeId);
        setPeriods(visiblePeriods);
        if (!visiblePeriods.length) {
          setDetail(null);
          setSelectedPeriod("");
          setStatusText("暂无可查看账期");
          return;
        }
        const nextPeriod =
          visiblePeriods.find((item) => item.period === selectedPeriod)?.period ??
          visiblePeriods[0].period;
        setSelectedPeriod(nextPeriod);
        const [data, trends] = await Promise.all([
          api.ledgerDetail(storeId, nextPeriod),
          api.ledgerTrends(storeId),
        ]);
        setDetail(data);
        setTrend(trends[0] ?? null);
        setStatusText("");
      } catch (error) {
        setDetail(null);
        setTrend(null);
        if (error instanceof MiniappApiError && error.statusCode === 401) {
          clearShareholderToken();
          setStatusText("授权已失效，请重新登录");
          Taro.showToast({ title: "授权已失效，请重新登录", icon: "none" });
          setTimeout(() => {
            Taro.reLaunch({ url: "/pages/shareholder-login/index" });
          }, 800);
          return;
        }
        setStatusText("暂时无法加载报表");
      }
    }

    loadReport();
  }, [selectedPeriod, storeId]);

  async function changePeriod(index: number) {
    const nextPeriod = periods[index]?.period;
    if (nextPeriod) {
      setSelectedPeriod(nextPeriod);
    }
  }

  const report = detail?.summary;
  const selectedPeriodIndex = Math.max(
    0,
    periods.findIndex((item) => item.period === selectedPeriod),
  );
  const tabs: Array<{ key: ReportTab; label: string; count: number }> = [
    { key: "revenue", label: "收入", count: detail?.revenue_records.length ?? 0 },
    { key: "category", label: "分类", count: detail?.category_breakdown.length ?? 0 },
    { key: "supplier", label: "供应商", count: detail?.supplier_breakdown.length ?? 0 },
    { key: "pendingExpense", label: "待付", count: detail?.pending_expense_items.length ?? 0 },
    { key: "pendingBank", label: "流水", count: detail?.pending_bank_transactions.length ?? 0 },
  ];
  const trendItems = trend?.items ?? [];
  const trendMaxAmount = useMemo(() => {
    const amounts = trendItems.flatMap((item) => [
      Math.abs(Number(item.income_amount)),
      Math.abs(Number(item.profit_amount)),
    ]);
    return Math.max(...amounts, 1);
  }, [trendItems]);

  function barWidth(value: string) {
    return `${Math.max((Math.abs(Number(value)) / trendMaxAmount) * 100, 4).toFixed(2)}%`;
  }

  function reportShareText() {
    if (!report) return "暂无报表数据";
    return [
      `${report.store_name} ${formatPeriod(report.period)} 财务摘要`,
      `营业收入：${formatMoney(report.income_amount)}`,
      `支出合计：${formatMoney(report.expense_amount)}`,
      `利润：${formatMoney(report.profit_amount)}`,
      `待处理支出：${report.pending_expense_count} 笔`,
      `未匹配流水：${report.pending_bank_transaction_count} 笔`,
    ].join("\n");
  }

  async function copyReportSummary() {
    await Taro.setClipboardData({ data: reportShareText() });
    Taro.showToast({ title: "已复制摘要", icon: "success" });
  }

  return (
    <View className="page">
      <View className="header">
        <View>
          <Text className="title">{report?.store_name ?? "门店报表"}</Text>
          <Text className="muted">{statusText || formatPeriod(report?.period ?? selectedPeriod)}</Text>
        </View>
        <Text className={report?.ledger_status === "closed" ? "status closed" : "status open"}>
          {report?.ledger_status === "closed" ? "已封账" : "做账中"}
        </Text>
      </View>
      <Picker
        mode="selector"
        range={periods.map((item) => formatPeriod(item.period))}
        value={selectedPeriodIndex}
        onChange={(event) => changePeriod(Number(event.detail.value))}
      >
        <View className="period-picker">
          <Text className="label">查看账期</Text>
          <Text className="period-value">
            {selectedPeriod ? formatPeriod(selectedPeriod) : "暂无可选账期"}
          </Text>
        </View>
      </Picker>
      <View className="summary">
        <View className="item">
          <Text className="label">营业收入</Text>
          <Text className="value">{formatMoney(report?.income_amount ?? 0)}</Text>
        </View>
        <View className="item">
          <Text className="label">支出合计</Text>
          <Text className="value">{formatMoney(report?.expense_amount ?? 0)}</Text>
        </View>
        <View className="item">
          <Text className="label">利润</Text>
          <Text className="value">{formatMoney(report?.profit_amount ?? 0)}</Text>
        </View>
      </View>
      <View className="risk-strip">
        <View className="risk-item">
          <Text className="label">待处理支出</Text>
          <Text className="risk-value">{report?.pending_expense_count ?? 0}</Text>
        </View>
        <View className="risk-item">
          <Text className="label">未匹配流水</Text>
          <Text className="risk-value">{report?.pending_bank_transaction_count ?? 0}</Text>
        </View>
      </View>
      <View className="section">
        <View className="section-heading">
          <Text className="section-title">最近账期趋势</Text>
          <View className="share-actions">
            <Button className="mini-action" onClick={copyReportSummary}>
              复制摘要
            </Button>
            <Button className="mini-action" openType="share">
              分享
            </Button>
          </View>
        </View>
        {trendItems.length ? (
          trendItems.map((item) => (
            <View key={item.period} className="trend-card">
              <View className="trend-header">
                <Text className="trend-period">{formatPeriod(item.period)}</Text>
                <Text className={Number(item.profit_amount) >= 0 ? "profit positive" : "profit negative"}>
                  {formatMoney(item.profit_amount)}
                </Text>
              </View>
              <View className="bar-row">
                <Text className="bar-label">收入</Text>
                <View className="bar-track">
                  <View className="bar income" style={{ width: barWidth(item.income_amount) }} />
                </View>
                <Text className="bar-value">{formatMoney(item.income_amount)}</Text>
              </View>
              <View className="bar-row">
                <Text className="bar-label">利润</Text>
                <View className="bar-track">
                  <View
                    className={Number(item.profit_amount) >= 0 ? "bar profit-bar" : "bar loss-bar"}
                    style={{ width: barWidth(item.profit_amount) }}
                  />
                </View>
                <Text className="bar-value">{formatMoney(item.profit_amount)}</Text>
              </View>
            </View>
          ))
        ) : (
          <Text className="empty">暂无趋势数据</Text>
        )}
      </View>
      <View className="tabs">
        {tabs.map((tab) => (
          <Button
            key={tab.key}
            className={activeTab === tab.key ? "tab active" : "tab"}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label} {tab.count}
          </Button>
        ))}
      </View>
      {activeTab === "revenue" ? (
        <View className="section">
          <Text className="section-title">营业收入明细</Text>
          {(detail?.revenue_records ?? []).length ? (
            detail?.revenue_records.map((item) => (
              <View key={item.id} className="row">
                <View>
                  <Text className="row-main">{item.channel}</Text>
                  <Text className="row-sub">
                    {item.revenue_date} 实收 {formatMoney(item.net_amount)} 手续费 {formatMoney(item.fee_amount)}
                  </Text>
                </View>
                <Text className="row-amount">{formatMoney(item.gross_amount)}</Text>
              </View>
            ))
          ) : (
            <Text className="empty">暂无收入明细</Text>
          )}
        </View>
      ) : null}
      {activeTab === "category" ? <BreakdownList title="费用分类" items={detail?.category_breakdown ?? []} /> : null}
      {activeTab === "supplier" ? <BreakdownList title="供应商支出" items={detail?.supplier_breakdown ?? []} /> : null}
      {activeTab === "pendingExpense" ? (
        <View className="section">
          <Text className="section-title">待处理支出</Text>
          {(detail?.pending_expense_items ?? []).length ? (
            detail?.pending_expense_items.map((item) => (
              <View key={item.id} className="row">
                <View>
                  <Text className="row-main">{item.description}</Text>
                  <Text className="row-sub">
                    {item.expense_date} {item.supplier_name || "未关联供应商"} {paymentStatusText(item.payment_status)}
                  </Text>
                </View>
                <Text className="row-amount">{formatMoney(item.amount)}</Text>
              </View>
            ))
          ) : (
            <Text className="empty">暂无待处理支出</Text>
          )}
        </View>
      ) : null}
      {activeTab === "pendingBank" ? (
        <View className="section">
          <Text className="section-title">未匹配流水</Text>
          {(detail?.pending_bank_transactions ?? []).length ? (
            detail?.pending_bank_transactions.map((item) => (
              <View key={item.id} className="row">
                <View>
                  <Text className="row-main">{item.counterparty_name || "未知交易对方"}</Text>
                  <Text className="row-sub">
                    {directionText(item.direction)} {item.occurred_at.slice(0, 10)} 已匹配 {formatMoney(item.matched_amount)}
                  </Text>
                </View>
                <Text className="row-amount">{formatMoney(item.amount)}</Text>
              </View>
            ))
          ) : (
            <Text className="empty">暂无未匹配流水</Text>
          )}
        </View>
      ) : null}
    </View>
  );
}
