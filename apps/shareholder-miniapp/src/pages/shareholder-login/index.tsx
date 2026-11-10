import { Button, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import { api, setShareholderToken } from "../../lib/api";
import "./index.css";
export default function Login() {
  const [username, U] = useState(""),
    [password, P] = useState(""),
    [busy, B] = useState(false),
    [error, E] = useState("");
  async function login() {
    if (busy) return;
    if (!username.trim() || !password) {
      E("请输入用户名和密码");
      return;
    }
    B(true);
    E("");
    try {
      const r = await api.login(username.trim(), password);
      setShareholderToken(r.token);
      Taro.switchTab({ url: "/pages/report/index" });
    } catch (e) {
      E(e instanceof Error ? e.message : "登录失败");
    } finally {
      B(false);
    }
  }
  return (
    <View className="page">
      <View className="brand">
        <Text className="eyebrow">蘑说财务 · 股东端</Text>
        <Text className="title">看见每一笔经营</Text>
        <Text className="muted">使用后台分配的账号，查看授权门店经营情况</Text>
      </View>
      <View className="login-panel">
        <Input
          className="input"
          placeholder="用户名"
          value={username}
          onInput={(e) => U(e.detail.value)}
        />
        <Input
          className="input"
          placeholder="密码"
          password
          value={password}
          onInput={(e) => P(e.detail.value)}
        />
        {error && <Text className="error">{error}</Text>}
        <Button
          className="login-button"
          loading={busy}
          disabled={busy}
          onClick={login}
        >
          登录
        </Button>
      </View>
    </View>
  );
}
