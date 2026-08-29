import { Button, View, Text } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useState } from "react";
import type { ShareholderAccessGrant, StoreComparisonReport, StoreReportSummary } from "@fin-hub/shared-types";
import { formatMoney, formatPeriod } from "@fin-hub/shared-utils";
import { api, clearShareholderToken, getShareholderToken, MiniappApiError } from "../../lib/api";
import "./index.css";

export default function StoresPage() {
  const [stores, setStores] = useState<StoreReportSummary[]>([]);
  const [comparison, setComparison] = useState<StoreComparisonReport | null>(null);
  const [grant, setGrant] = useState<ShareholderAccessGrant | null>(null);
  const [statusText, setStatusText] = useState("加载中");
  const [isLoading, setIsLoading] = useState(false);

  async function loadStores() {
    if (!getShareholderToken()) {
      Taro.reLaunch({ url: "/pages/shareholder-login/index" });
      return;
    }
    setIsLoading(true);
    setStatusText("加载中");
    try {
      const [profile, data, comparisonData] = await Promise.all([
        api.shareholderMe(),
        api.storeSummaries(),
        api.storeComparison(),
      ]);
      setGrant(profile);
      setStores(data);
      setComparison(comparisonData);
      setStatusText(data.length ? "" : "暂无可查看门店");
    } catch (error) {
      clearShareholderToken();
      if (error instanceof MiniappApiError && error.statusCode === 401) {
        Taro.showToast({ title: "授权已失效，请重新登录", icon: "none" });
      }
      Taro.reLaunch({ url: "/pages/shareholder-login/index" });
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadStores();
  }, []);

  return (
    <View className="page">
      <View className="header">
        <View>
          <Text className="title">授权门店</Text>
          <Text className="muted">
            {grant ? `${grant.name}，可查看 ${grant.store_ids.length} 家门店` : "正在读取授权"}
          </Text>
        </View>
        <View className="header-actions">
          <Button className="action-button" loading={isLoading} onClick={loadStores}>
            刷新
          </Button>
          <Button
            className="action-button"
            onClick={() => {
              clearShareholderToken();
              Taro.reLaunch({ url: "/pages/shareholder-login/index" });
            }}
          >
            退出
          </Button>
        </View>
      </View>
      {statusText ? <Text className="muted">{statusText}</Text> : null}
      {comparison ? (
        <View className="comparison">
          <Text className="section-title">{formatPeriod(comparison.period)} 门店对比</Text>
          <View className="comparison-totals">
            <Text>总收入 {formatMoney(comparison.total_income_amount)}</Text>
            <Text>总利润 {formatMoney(comparison.total_profit_amount)}</Text>
          </View>
        </View>
      ) : null}
      {stores.map((store) => (
        <View
          key={store.ledger_id}
          className="store-card"
          onClick={() =>
            Taro.navigateTo({
              url: `/pages/report/index?storeId=${store.store_id}&period=${store.period}`,
            })
          }
        >
          <Text className="store-name">{store.store_name}</Text>
          <Text className="muted">
            {formatPeriod(store.period)} {store.ledger_status === "closed" ? "已封账" : "做账中"}
          </Text>
          <View className="metrics">
            <Text>收入 {formatMoney(store.income_amount)}</Text>
            <Text>利润 {formatMoney(store.profit_amount)}</Text>
          </View>
          {comparison ? (
            <Text className="rank">
              排名 {comparison.items.findIndex((item) => item.store_id === store.store_id) + 1 || "-"} /{" "}
              {comparison.items.length}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}
