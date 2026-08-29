"use client";

import { Alert, Button, Card, Form, Input, Typography } from "antd";
import { useState } from "react";
import type { LoginRequest } from "@fin-hub/shared-api-client";
import { apiClient } from "../lib/api";

export default function LoginPage() {
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function submit(values: LoginRequest) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.auth.login(values);
      window.location.href = "/";
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "登录失败");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="login-page">
      <Card className="login-card">
        <Typography.Title level={3}>fin-hub 后台登录</Typography.Title>
        <Typography.Text type="secondary">蘑说财务管理系统</Typography.Text>
        {errorMessage ? (
          <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
        ) : null}
        <Form
          className="login-form"
          layout="vertical"
          onFinish={submit}
          initialValues={{ username: "admin", password: "admin123456" }}
        >
          <Form.Item name="username" label="账号" rules={[{ required: true }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button block type="primary" htmlType="submit" loading={isLoading}>
            登录
          </Button>
        </Form>
      </Card>
    </main>
  );
}
