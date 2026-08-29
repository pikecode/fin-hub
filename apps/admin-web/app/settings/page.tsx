"use client";

import { Alert, Button, Card, Descriptions, Space, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import type { DatabaseBackupStatus, DingTalkConfig, SystemReadinessCheck, SystemReadinessReport } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8000";

export default function SettingsPage() {
  const [config, setConfig] = useState<DingTalkConfig | null>(null);
  const [backupStatus, setBackupStatus] = useState<DatabaseBackupStatus | null>(null);
  const [readiness, setReadiness] = useState<SystemReadinessReport | null>(null);
  const [healthStatus, setHealthStatus] = useState<"ok" | "failed" | "checking">("checking");
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    setHealthStatus("checking");
    try {
      const [dingtalkConfig, databaseBackupStatus, readinessReport] = await Promise.all([
        apiClient.dingtalk.readConfig(),
        apiClient.system.databaseBackupStatus(),
        apiClient.system.readiness(),
        apiClient.request<{ status: string }>("/api/health"),
      ]);
      setConfig(dingtalkConfig);
      setBackupStatus(databaseBackupStatus);
      setReadiness(readinessReport);
      setHealthStatus("ok");
    } catch (error) {
      setHealthStatus("failed");
      setErrorMessage(error instanceof Error ? error.message : "无法读取系统设置");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function downloadDatabaseBackup() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const blob = await apiClient.system.downloadDatabaseBackup();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `fin-hub-backup-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.db`;
      link.click();
      URL.revokeObjectURL(url);
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法导出数据库备份");
    } finally {
      setIsLoading(false);
    }
  }

  const runtimeChecks: SystemReadinessCheck[] = [
    {
      key: "api",
      name: "API 服务",
      status: healthStatus === "ok" ? "ok" : "warning",
      detail: healthStatus === "ok" ? "健康检查通过" : healthStatus === "checking" ? "正在检查" : "健康检查失败",
    },
    ...(readiness?.checks ?? []),
  ];

  const checkColumns: ColumnsType<SystemReadinessCheck> = [
    { title: "检查项", dataIndex: "name" },
    {
      title: "状态",
      dataIndex: "status",
      render: (value: SystemReadinessCheck["status"]) => {
        if (value === "ok") return <Tag color="green">正常</Tag>;
        if (value === "error") return <Tag color="red">阻断</Tag>;
        return <Tag color="gold">需确认</Tag>;
      },
    },
    { title: "说明", dataIndex: "detail" },
  ];

  return (
    <AppShell title="系统设置" action={<Button onClick={loadData}>刷新</Button>}>
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="运行配置">
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="后台 API 地址">{apiBaseUrl}</Descriptions.Item>
          <Descriptions.Item label="登录方式">后台 Cookie 会话</Descriptions.Item>
          <Descriptions.Item label="股东访问方式">授权码登录，小程序 Bearer Token</Descriptions.Item>
          <Descriptions.Item label="当前环境">
            {readiness?.environment ?? (process.env.NODE_ENV === "production" ? "production" : "development")}
          </Descriptions.Item>
          <Descriptions.Item label="生产就绪">
            {readiness ? (
              readiness.ready ? <Tag color="green">可发布</Tag> : <Tag color="red">存在阻断项</Tag>
            ) : (
              <Tag color="gold">未检查</Tag>
            )}
          </Descriptions.Item>
          <Descriptions.Item label="数据库类型">{backupStatus?.backend || "未检查"}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card
        title="数据备份"
        className="section-card"
        extra={
          <Button
            type="primary"
            onClick={downloadDatabaseBackup}
            disabled={!backupStatus?.supported}
            loading={isLoading}
          >
            下载数据库备份
          </Button>
        }
      >
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="状态">
            {backupStatus?.supported ? <Tag color="green">可导出</Tag> : <Tag color="gold">需外部备份</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="说明">{backupStatus?.message || "未检查"}</Descriptions.Item>
          <Descriptions.Item label="数据库文件">{backupStatus?.database_path || "-"}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="集成配置状态" className="section-card">
        <Descriptions column={1} bordered size="small">
          <Descriptions.Item label="Corp ID">{config?.corp_id || "未配置"}</Descriptions.Item>
          <Descriptions.Item label="App Key">{config?.app_key || "未配置"}</Descriptions.Item>
          <Descriptions.Item label="App Secret">
            {config?.app_secret_configured ? <Tag color="green">已配置</Tag> : <Tag color="gold">未配置</Tag>}
          </Descriptions.Item>
          <Descriptions.Item label="管理员 User ID">{config?.admin_user_id || "未配置"}</Descriptions.Item>
          <Descriptions.Item label="钉盘 Union ID">{config?.drive_union_id || "未配置"}</Descriptions.Item>
          <Descriptions.Item label="同步状态">{config?.status || "未初始化"}</Descriptions.Item>
        </Descriptions>
      </Card>

      <Card title="交付检查" className="section-card">
        <Table
          rowKey="key"
          loading={isLoading}
          columns={checkColumns}
          dataSource={runtimeChecks}
          pagination={false}
        />
      </Card>

      <Card title="安全约定" className="section-card">
        <Space direction="vertical" size={4}>
          <Typography.Text>钉钉 App Secret 只允许写入，不在 API 和后台页面回显。</Typography.Text>
          <Typography.Text>生产环境应把 `SESSION_SECRET`、数据库密码、钉钉凭证放入服务端环境变量或密钥管理系统。</Typography.Text>
          <Typography.Text>股东授权码可在“股东授权”页面禁用或重置，禁用后已签发 Token 立即失效。</Typography.Text>
        </Space>
      </Card>
    </AppShell>
  );
}
