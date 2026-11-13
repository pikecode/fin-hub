import { Button, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import { api, setShareholderToken } from "../../lib/api";
import "./index.css";
export default function Login() {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [visible, showPassword] = useState(false);
  async function login() {
    if (busy) return;
    if (!username.trim() || !password) {
      setError("请输入用户名和密码");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const result = await api.login(username.trim(), password);
      setShareholderToken(result.token);
      Taro.switchTab({ url: "/pages/report/index" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <View className="page login-page">
      <View className="login-brand">
        <View className="brand-mark">蘑</View>
        <Text className="eyebrow">蘑说财务 · 股东端</Text>
        <Text className="title">门店经营，一目了然</Text>
        <Text className="muted">报表、流水与分红，随时查看</Text>
      </View>
      <View className="login-panel">
        <Text className="login-heading">账号登录</Text>
        <Text className="login-description">使用财务后台分配的账号和密码</Text>
        <Text className="field-label">用户名</Text>
        <Input
          className="login-input"
          placeholder="请输入用户名"
          value={username}
          onInput={(e) => {
            setUsername(e.detail.value);
            setError("");
          }}
        />
        <Text className="field-label">密码</Text>
        <View className="password-input">
          <Input
            className="login-input"
            placeholder="请输入登录密码"
            password={!visible}
            value={password}
            onInput={(e) => {
              setPassword(e.detail.value);
              setError("");
            }}
            confirmType="done"
            onConfirm={login}
          />
          <Button
            className="text-button"
            onClick={() => showPassword(!visible)}
          >
            {visible ? "隐藏" : "显示"}
          </Button>
        </View>
        {error && <Text className="login-error">{error}</Text>}
        <Button
          className="login-button"
          loading={busy}
          disabled={busy || !username.trim() || !password}
          onClick={login}
        >
          登录
        </Button>
      </View>
      <View className="login-footer">
        <Text>仅可查看已授权的门店数据</Text>
        <Text>如忘记密码或需调整授权，请联系管理员</Text>
      </View>
    </View>
  );
}
