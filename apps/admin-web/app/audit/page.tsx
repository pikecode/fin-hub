"use client";

import { Alert, Button, Card, Form, Input, Select, Table, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { useEffect, useState } from "react";
import type { AuditLog } from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

interface AuditFilterValues {
  actor?: string;
  action?: string;
  resource_type?: string;
}

const resourceOptions = [
  { label: "门店", value: "store" },
  { label: "账套", value: "ledger" },
  { label: "费用分类", value: "expense_category" },
  { label: "供应商", value: "supplier" },
  { label: "支出明细", value: "expense_item" },
  { label: "银行流水", value: "bank_transaction" },
  { label: "流水匹配", value: "expense_bank_match" },
  { label: "同步任务", value: "sync_job" },
];

function buildQuery(values: AuditFilterValues) {
  const params = new URLSearchParams({ page_size: "100" });
  if (values.actor) {
    params.set("actor", values.actor);
  }
  if (values.action) {
    params.set("action", values.action);
  }
  if (values.resource_type) {
    params.set("resource_type", values.resource_type);
  }
  return `?${params.toString()}`;
}

export default function AuditPage() {
  const [logs, setLogs] = useState<AuditLog[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<AuditFilterValues>();

  async function loadLogs(values: AuditFilterValues = {}) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await apiClient.auditLogs.list(buildQuery(values));
      setLogs(page.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载操作日志");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadLogs();
  }, []);

  const columns: ColumnsType<AuditLog> = [
    { title: "时间", dataIndex: "created_at", width: 190, render: (value: string) => value.replace("T", " ").slice(0, 19) },
    { title: "操作者", dataIndex: "actor", width: 120 },
    { title: "动作", dataIndex: "action", width: 180, render: (value: string) => <Tag color="blue">{value}</Tag> },
    { title: "资源", dataIndex: "resource_type", width: 160 },
    { title: "资源 ID", dataIndex: "resource_id", width: 240, render: (value) => value || "-" },
    { title: "摘要", dataIndex: "summary", render: (value) => value || "-" },
    {
      title: "元数据",
      dataIndex: "metadata_json",
      width: 260,
      render: (value) =>
        value ? (
          <Typography.Text code ellipsis className="audit-metadata">
            {value}
          </Typography.Text>
        ) : (
          "-"
        ),
    },
  ];

  return (
    <AppShell title="操作日志" action={<Button onClick={() => loadLogs(form.getFieldsValue())}>刷新</Button>}>
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="日志筛选">
        <Form form={form} layout="inline" onFinish={loadLogs}>
          <Form.Item name="actor" label="操作者">
            <Input allowClear className="audit-filter-input" />
          </Form.Item>
          <Form.Item name="action" label="动作">
            <Input allowClear className="audit-filter-input" />
          </Form.Item>
          <Form.Item name="resource_type" label="资源类型">
            <Select allowClear className="audit-filter-input" options={resourceOptions} />
          </Form.Item>
          <Form.Item>
            <Button type="primary" htmlType="submit" loading={isLoading}>
              查询
            </Button>
          </Form.Item>
        </Form>
      </Card>
      <Card title="操作日志" className="section-card">
        <Table rowKey="id" loading={isLoading} columns={columns} dataSource={logs} scroll={{ x: 1320 }} />
      </Card>
    </AppShell>
  );
}
