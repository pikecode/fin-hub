import { Button, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useEffect, useRef, useState } from "react";
import {
  api,
  setShareholderToken,
  getShareholderToken,
  clearShareholderToken,
} from "../../lib/api";
import { restoreSavedSession } from "../../lib/session";
import "./index.css";
export default function Login() {
  const [username, setUsername] = useState(""),
    [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [visible, showPassword] = useState(false);
  const [restoreState, setRestoreState] = useState<
    "form" | "checking" | "retry"
  >(() => (getShareholderToken() ? "checking" : "form"));
  const restoring = useRef(false),
    restoreVersion = useRef(0);
  useEffect(
    () => () => {
      restoreVersion.current++;
      restoring.current = false;
    },
    [],
  );
  async function restore() {
    if (!getShareholderToken()) {
      setRestoreState("form");
      return;
    }
    if (restoring.current) return;
    restoring.current = true;
    const version = ++restoreVersion.current;
    setRestoreState("checking");
    setError("");
    try {
      const restored = await restoreSavedSession(
        () => version === restoreVersion.current,
      );
      if (version === restoreVersion.current && !restored)
        setRestoreState("form");
    } catch (e) {
      if (version !== restoreVersion.current) return;
      setError(e instanceof Error ? e.message : "暂时无法验证登录，请重试");
      setRestoreState(getShareholderToken() ? "retry" : "form");
    } finally {
      if (version === restoreVersion.current) restoring.current = false;
    }
  }
  Taro.useDidShow(() => {
    void restore();
  });
  function useAnotherAccount() {
    restoreVersion.current++;
    restoring.current = false;
    clearShareholderToken();
    setPassword("");
    setError("");
    setRestoreState("form");
  }
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
      {restoreState !== "form" ? (
        <View className="login-panel restore-panel">
          <Text className="login-heading">
            {restoreState === "checking" ? "正在恢复登录" : "暂时无法恢复登录"}
          </Text>
          <Text className="login-description">
            {restoreState === "checking"
              ? "验证后将自动进入门店报表，无需再次输入密码"
              : error || "请检查网络后重试，登录信息仍为你保留"}
          </Text>
          {restoreState === "retry" && (
            <Button
              onClick={() => {
                void restore();
              }}
            >
              重试恢复登录
            </Button>
          )}
          <Button className="text-button" onClick={useAnotherAccount}>
            使用其他账号
          </Button>
        </View>
      ) : (
        <View className="login-panel">
          <Text className="login-heading">账号登录</Text>
          <Text className="login-description">
            使用财务后台分配的账号和密码
          </Text>
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
      )}
      <View className="login-footer">
        <Text>仅可查看已授权的门店数据</Text>
        <Text>如忘记密码或需调整授权，请联系管理员</Text>
      </View>
    </View>
  );
}
