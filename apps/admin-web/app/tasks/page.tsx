"use client";

import { ReloadOutlined, SearchOutlined, SyncOutlined } from "@ant-design/icons";
import type { SyncJob } from "@fin-hub/shared-types";
import { Button, Card, Form, Select, Space, Tag, Typography } from "antd";
import { useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/AppShell";
import { EnterpriseTable } from "../components/EnterpriseTable";
import type { EnterpriseTableColumn } from "../components/EnterpriseTable";
import { apiClient } from "../lib/api";

interface TaskFilterValues {
  job_type?: string;
  status?: SyncJob["status"];
}

const jobTypeOptions = [
  { label: "钉钉自动同步", value: "dingtalk_auto_sync" },
  { label: "审批列表同步", value: "dingtalk_approval_sync" },
  { label: "审批重新解析", value: "dingtalk_approval_reparse" },
  { label: "银行流水导入", value: "bank_transaction_import" },
];

const statusOptions = [
  { label: "等待中", value: "pending" },
  { label: "运行中", value: "running" },
  { label: "成功", value: "succeeded" },
  { label: "失败", value: "failed" },
];

function jobTypeLabel(type: string) {
  return jobTypeOptions.find((option) => option.value === type)?.label ?? type;
}

function formatDateTime(value?: string | null) {
  return value?.replace("T", " ").slice(0, 16) || "-";
}

function statusTag(job: SyncJob) {
  if (job.status === "succeeded" && job.next_cursor) return <Tag color="blue">可续跑</Tag>;
  if (job.status === "succeeded") return <Tag color="green">成功</Tag>;
  if (job.status === "failed") return <Tag color="red">失败</Tag>;
  if (job.status === "running") return <Tag color="blue">运行中</Tag>;
  return <Tag>等待中</Tag>;
}

function parseSummary(job: SyncJob): Record<string, any> | null {
  if (!job.raw_summary) return null;
  try {
    const parsed = JSON.parse(job.raw_summary);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function summaryTags(job: SyncJob) {
  const summary = parseSummary(job);
  const tags = [];
  if (summary?.department_pull?.pulled_count !== undefined) {
    tags.push(<Tag key="departments">部门 {summary.department_pull.pulled_count}</Tag>);
  }
  if (summary?.department_sync) {
    tags.push(
      <Tag key="stores" color="cyan">
        门店 +{summary.department_sync.created_count ?? 0} / 更{summary.department_sync.updated_count ?? 0}
      </Tag>,
    );
  }
  if (summary?.template_sync) {
    tags.push(
      <Tag key="templates" color="blue">
        模板 {summary.template_sync.pulled ?? 0}
      </Tag>,
    );
  }
  if (summary?.approval_sync?.templates) {
    tags.push(
      <Tag key="approval-templates" color="purple">
        审批模板 {summary.approval_sync.templates.length}
      </Tag>,
    );
  }
  if (summary?.created_count !== undefined || summary?.skipped_count !== undefined) {
    tags.push(
      <Tag key="bank-import" color="geekblue">
        导入 {summary.created_count ?? 0} / 跳过 {summary.skipped_count ?? 0}
      </Tag>,
    );
  }
  if (job.processed_count || job.success_count || job.failed_count) {
    tags.push(
      <Tag key="counts" color={job.failed_count ? "red" : "green"}>
        处理 {job.processed_count} / 成功 {job.success_count} / 失败 {job.failed_count}
      </Tag>,
    );
  }
  return tags.length ? <Space wrap>{tags}</Space> : <Typography.Text type="secondary">-</Typography.Text>;
}

export default function TasksPage() {
  const [form] = Form.useForm<TaskFilterValues>();
  const [jobs, setJobs] = useState<SyncJob[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const metrics = useMemo(() => {
    const total = jobs.length;
    const running = jobs.filter((job) => job.status === "running").length;
    const failed = jobs.filter((job) => job.status === "failed").length;
    const resumable = jobs.filter((job) => job.next_cursor).length;
    return { total, running, failed, resumable };
  }, [jobs]);

  function buildParams(values?: TaskFilterValues) {
    const params = new URLSearchParams({ page_size: "100" });
    if (values?.job_type) params.set("job_type", values.job_type);
    if (values?.status) params.set("status", values.status);
    return `?${params.toString()}`;
  }

  async function loadData(values?: TaskFilterValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const page = await apiClient.dingtalk.listSyncJobs(buildParams(values ?? form.getFieldsValue()));
      setJobs(page.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法读取任务列表");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function resumeJob(job: SyncJob) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.dingtalk.resumeApprovalSync(job.id, { started_by: "admin" });
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法续跑任务");
      setIsLoading(false);
    }
  }

  const columns: EnterpriseTableColumn<SyncJob>[] = [
    { key: "job_type", title: "任务类型", dataIndex: "job_type", width: 150, render: (value) => jobTypeLabel(value) },
    { key: "status", title: "状态", dataIndex: "status", width: 90, render: (_, record) => statusTag(record) },
    { key: "summary", title: "摘要", width: 340, render: (_, record) => summaryTags(record) },
    { key: "processed_count", title: "处理", dataIndex: "processed_count", width: 70 },
    { key: "success_count", title: "成功", dataIndex: "success_count", width: 70 },
    { key: "failed_count", title: "失败", dataIndex: "failed_count", width: 70 },
    { key: "started_by", title: "发起人", dataIndex: "started_by", width: 110, render: (value) => value || "-" },
    { key: "started_at", title: "开始时间", dataIndex: "started_at", width: 150, render: formatDateTime },
    { key: "finished_at", title: "完成时间", dataIndex: "finished_at", width: 150, render: formatDateTime },
    {
      key: "error_message",
      title: "错误",
      dataIndex: "error_message",
      width: 240,
      render: (value) => (value ? <Typography.Text type="danger" ellipsis={{ tooltip: value }}>{value}</Typography.Text> : "-"),
    },
    {
      key: "actions",
      title: "操作",
      fixed: "right",
      width: 90,
      className: "table-action-column",
      render: (_, record) =>
        record.next_cursor ? (
          <Button type="link" onClick={() => resumeJob(record)}>
            续跑
          </Button>
        ) : null,
    },
  ];

  return (
    <AppShell
      title="任务中心"
      kicker="统一查看银行导入、钉钉同步和后台自动任务的执行结果"
      action={
        <Button icon={<ReloadOutlined />} onClick={() => loadData()} loading={isLoading}>
          刷新
        </Button>
      }
    >

      {errorMessage ? <div className="error-banner">{errorMessage}</div> : null}

      <div className="metric-grid compact">
        <Card><div className="metric"><span>任务数</span><strong>{metrics.total}</strong></div></Card>
        <Card><div className="metric"><span>运行中</span><strong>{metrics.running}</strong></div></Card>
        <Card><div className="metric"><span>失败</span><strong>{metrics.failed}</strong></div></Card>
        <Card><div className="metric"><span>可续跑</span><strong>{metrics.resumable}</strong></div></Card>
      </div>

      <Card className="filter-card">
        <Form form={form} layout="inline" onFinish={loadData}>
          <Form.Item name="job_type" label="任务类型">
            <Select allowClear options={jobTypeOptions} placeholder="全部类型" style={{ width: 180 }} />
          </Form.Item>
          <Form.Item name="status" label="状态">
            <Select allowClear options={statusOptions} placeholder="全部状态" style={{ width: 140 }} />
          </Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" icon={<SearchOutlined />}>查询</Button>
              <Button onClick={() => { form.resetFields(); loadData({}); }}>重置</Button>
            </Space>
          </Form.Item>
        </Form>
      </Card>

      <Card title={<Space><SyncOutlined />最近任务</Space>}>
        <EnterpriseTable<SyncJob>
          rowKey="id"
          columns={columns}
          dataSource={jobs}
          loading={isLoading}
          scroll={{ x: 1540 }}
          pagination={false}
          fixedColumns={{ right: ["actions"] }}
        />
      </Card>
    </AppShell>
  );
}
