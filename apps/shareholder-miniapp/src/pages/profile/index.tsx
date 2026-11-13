import { Button, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import type { CurrentUser } from "@fin-hub/shared-types";
import { api, clearShareholderToken, MobileStore } from "../../lib/api";
import "./index.css";

export default function Profile() {
  const [user, setUser] = useState<CurrentUser | null>(null),
    [stores, setStores] = useState<MobileStore[]>([]);
  const [old, setOld] = useState(""),
    [next, setNext] = useState(""),
    [confirm, setConfirm] = useState("");
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [editPassword, showPasswordForm] = useState(false),
    [showStores, setShowStores] = useState(false);
  const [allStores, setAllStores] = useState(false);
  Taro.useDidShow(() => {
    setError("");
    Promise.all([api.me(), api.stores()])
      .then(([account, rows]) => {
        setUser(account);
        setStores(rows);
      })
      .catch((e) => setError(e.message));
  });
  function logout() {
    clearShareholderToken();
    Taro.reLaunch({ url: "/pages/shareholder-login/index" });
  }
  async function confirmLogout() {
    const result = await Taro.showModal({
      title: "退出登录？",
      content: "下次查看经营数据时需要重新登录。",
      confirmText: "退出登录",
      confirmColor: "#22634e",
    });
    if (result.confirm) logout();
  }
  async function save() {
    if (busy) return;
    if (!old || next.length < 8 || next !== confirm) {
      setError("请填写原密码，新密码至少8位且两次输入需一致");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await api.changePassword(old, next);
      Taro.showToast({ title: "密码已修改，请重新登录", icon: "none" });
      logout();
    } catch (e) {
      setError(e instanceof Error ? e.message : "修改失败");
    } finally {
      setBusy(false);
    }
  }
  const role =
    user?.role === "admin"
      ? "管理员"
      : user?.role === "finance"
        ? "财务"
        : "查看者";
  return (
    <View className="page profile-page">
      <View className="profile-intro">
        <Text className="eyebrow">蘑说财务</Text>
        <Text className="title">账号与设置</Text>
      </View>
      <View className="section account-card">
        <View className="account-avatar">
          {user?.display_name?.slice(0, 1) || "蘑"}
        </View>
        <View className="account-info">
          <Text className="profile-name">
            {user?.display_name || "正在加载账号…"}
          </Text>
          <Text className="row-sub">
            {user?.username || "—"} · {role}
          </Text>
        </View>
        <Text className="status-badge">只读访问</Text>
      </View>
      <View className="section account-settings">
        <View
          className="settings-row"
          onClick={() => setShowStores(!showStores)}
        >
          <View>
            <Text>授权门店</Text>
            <Text className="row-sub">可查看的门店与经营数据</Text>
          </View>
          <View className="settings-end">
            <Text>{stores.length} 家</Text>
            <Text className="chevron">{showStores ? "⌃" : "›"}</Text>
          </View>
        </View>
        {showStores && (
          <View className="authorized-stores">
            {!stores.length && (
              <Text className="row-sub">暂无授权门店，请联系管理员</Text>
            )}
            {(allStores ? stores : stores.slice(0, 6)).map((store) => (
              <Text key={store.id}>{store.name}</Text>
            ))}
            {stores.length > 6 && (
              <Button
                className="text-button"
                onClick={() => setAllStores(!allStores)}
              >
                {allStores
                  ? "收起门店 ⌃"
                  : `查看全部 ${stores.length} 家门店 ⌄`}
              </Button>
            )}
          </View>
        )}
        <View
          className="settings-row"
          onClick={() => {
            showPasswordForm(!editPassword);
            setError("");
          }}
        >
          <View>
            <Text>修改登录密码</Text>
            <Text className="row-sub">与后台管理共用同一密码</Text>
          </View>
          <Text className="chevron">{editPassword ? "⌃" : "›"}</Text>
        </View>
        {editPassword && (
          <View className="password-form">
            <Text className="field-label">原密码</Text>
            <Input
              password
              placeholder="请输入原密码"
              value={old}
              onInput={(e) => setOld(e.detail.value)}
            />
            <Text className="field-label">新密码</Text>
            <Input
              password
              placeholder="至少8位"
              value={next}
              onInput={(e) => setNext(e.detail.value)}
            />
            <Text className="field-label">确认新密码</Text>
            <Input
              password
              placeholder="再次输入新密码"
              value={confirm}
              onInput={(e) => setConfirm(e.detail.value)}
              confirmType="done"
              onConfirm={save}
            />
            {error && <Text className="error">{error}</Text>}
            <Button loading={busy} disabled={busy} onClick={save}>
              保存并重新登录
            </Button>
          </View>
        )}
      </View>
      {error && !editPassword && (
        <View className="section error">
          <Text>{error}</Text>
        </View>
      )}
      <View className="account-note">
        <Text>门店数据由财务后台同步</Text>
        <Text>如需调整查看范围，请联系管理员</Text>
      </View>
      <Button className="logout-button" onClick={confirmLogout}>
        退出登录
      </Button>
    </View>
  );
}
