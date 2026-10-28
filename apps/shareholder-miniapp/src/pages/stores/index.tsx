import { Button, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import { api, getShareholderToken, MobileStore } from "../../lib/api";
import { selectStore } from "../../lib/navigation";
import "./index.css";
export default function Stores() {
  const [rows, R] = useState<MobileStore[]>([]),
    [error, E] = useState(""),
    [busy, B] = useState(true);
  async function load() {
    if (!getShareholderToken()) {
      Taro.reLaunch({ url: "/pages/shareholder-login/index" });
      return;
    }
    B(true);
    E("");
    try {
      R(await api.stores());
    } catch (e) {
      E(e instanceof Error ? e.message : "加载失败");
    } finally {
      B(false);
    }
  }
  Taro.useDidShow(() => {
    load();
  });
  return (
    <View className="page">
      <View className="brand-line">
        <Text className="brand-dot" />
        <Text className="eyebrow">蘑说 · 股东经营台</Text>
      </View>
      <Text className="title">我的门店</Text>
      <Text className="muted">经营有据，收支清晰。请选择要查看的门店。</Text>
      {busy && <Text>正在加载授权门店…</Text>}
      {error && (
        <View>
          <Text>{error}</Text>
          <Button onClick={load}>重试</Button>
        </View>
      )}
      {!busy && !error && !rows.length && (
        <Text>暂无授权门店，请联系管理员分配</Text>
      )}
      <Text className="list-caption">已授权门店 · {rows.length}</Text>
      {rows.map((s, index) => (
        <View
          className="store-card"
          key={s.id}
          onClick={() => {
            selectStore(s.id);
            Taro.switchTab({ url: "/pages/report/index" });
          }}
        >
          <View className="store-topline">
            <Text className="store-number">
              {String(index + 1).padStart(2, "0")}
            </Text>
            <Text className="store-name">{s.name}</Text>
            <Text className="store-arrow">›</Text>
          </View>
          <Text className="muted">报表 / 收入 / 流水 / 筹建 / 分红</Text>
        </View>
      ))}
    </View>
  );
}
