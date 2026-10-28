import { Button, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import type { CurrentUser } from "@fin-hub/shared-types";
import { api, clearShareholderToken } from "../../lib/api";
export default function Profile() {
  const [user, U] = useState<CurrentUser | null>(null),
    [old, O] = useState(""),
    [next, N] = useState(""),
    [confirm, C] = useState(""),
    [error, E] = useState(""),
    [busy, B] = useState(false);
  Taro.useDidShow(() => {
    api
      .me()
      .then(U)
      .catch((e) => E(e.message));
  });
  function logout() {
    clearShareholderToken();
    Taro.reLaunch({ url: "/pages/shareholder-login/index" });
  }
  async function save() {
    if (busy) return;
    if (next.length < 8 || next !== confirm) {
      E("新密码至少8位，且两次输入需一致");
      return;
    }
    B(true);
    E("");
    try {
      await api.changePassword(old, next);
      Taro.showToast({ title: "密码已修改，请重新登录", icon: "none" });
      logout();
    } catch (e) {
      E(e instanceof Error ? e.message : "修改失败");
    } finally {
      B(false);
    }
  }
  return (
    <View className="page">
      <Text className="eyebrow">账户与权限</Text>
      <Text className="title">我的</Text>
      <View className="section profile-card">
        <Text className="avatar">
          {user?.display_name?.slice(0, 1) || "蘑"}
        </Text>
        <Text className="profile-name">{user?.display_name}</Text>
        <Text>账号：{user?.username}</Text>
        <Text>授权门店：{user?.store_ids.length ?? 0} 家</Text>
        <Text>小程序仅供查看经营信息</Text>
      </View>
      <View className="section">
        <Text className="section-title">修改密码</Text>
        <Input
          password
          placeholder="原密码"
          value={old}
          onInput={(e) => O(e.detail.value)}
        />
        <Input
          password
          placeholder="新密码（至少8位）"
          value={next}
          onInput={(e) => N(e.detail.value)}
        />
        <Input
          password
          placeholder="再次输入新密码"
          value={confirm}
          onInput={(e) => C(e.detail.value)}
        />
        {error && <Text className="error">{error}</Text>}
        <Button loading={busy} disabled={busy} onClick={save}>
          保存新密码
        </Button>
      </View>
      <Button className="logout-button" onClick={logout}>
        退出登录
      </Button>
    </View>
  );
}
