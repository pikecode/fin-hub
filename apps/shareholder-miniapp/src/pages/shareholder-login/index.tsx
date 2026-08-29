import { Button, Input, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { useState } from "react";
import { api, setShareholderToken } from "../../lib/api";
import "./index.css";

export default function ShareholderLoginPage() {
  const [accessCode, setAccessCode] = useState("");
  const [statusText, setStatusText] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  async function login() {
    if (!accessCode.trim()) {
      setStatusText("请输入授权码");
      return;
    }
    setIsLoading(true);
    setStatusText("");
    try {
      const result = await api.login(accessCode.trim());
      setShareholderToken(result.token);
      Taro.reLaunch({ url: "/pages/stores/index" });
    } catch {
      setStatusText("授权码无效或已停用");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <View className="page">
      <Text className="title">股东授权</Text>
      <Text className="muted">输入财务后台发放的授权码查看门店报表</Text>
      <Input
        className="input"
        password
        placeholder="请输入授权码"
        value={accessCode}
        onInput={(event) => setAccessCode(event.detail.value)}
      />
      {statusText ? <Text className="error">{statusText}</Text> : null}
      <Button className="login-button" loading={isLoading} onClick={login}>
        进入报表
      </Button>
    </View>
  );
}
