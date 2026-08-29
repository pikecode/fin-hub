"use client";

import {
  Alert,
  AutoComplete,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Skeleton,
  Space,
  Statistic,
  Switch,
  Table,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import dayjs from "dayjs";
import { useEffect, useMemo, useState } from "react";
import type {
  ApprovalTemplate,
  ApprovalTemplateCreate,
  ApprovalInstance,
  DingTalkConfig,
  DingTalkDepartment,
  DingTalkDepartmentSyncPreview,
  SyncJob,
  TemplateFieldCandidate,
  TemplateFieldMapping,
  TemplateFieldMappingCreate,
} from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { apiClient } from "../lib/api";

interface DingTalkFormValues {
  corp_id?: string;
  app_key?: string;
  app_secret?: string;
  admin_user_id?: string;
  drive_union_id?: string;
}

interface ApprovalSyncFormValues {
  template_id?: string;
  time_range?: [dayjs.Dayjs, dayjs.Dayjs];
  page_size?: number;
  max_pages?: number;
  skip_existing?: boolean;
}

type DepartmentTreeNode = DingTalkDepartment & {
  children?: DepartmentTreeNode[];
};

function buildDepartmentTree(departments: DingTalkDepartment[]): DepartmentTreeNode[] {
  const nodeMap = new Map<string, DepartmentTreeNode>();
  departments.forEach((department) => {
    nodeMap.set(department.dept_id, { ...department });
  });

  const roots: DepartmentTreeNode[] = [];
  nodeMap.forEach((node) => {
    if (node.parent_id && nodeMap.has(node.parent_id)) {
      const parent = nodeMap.get(node.parent_id);
      if (!parent) return;
      parent.children = parent.children ?? [];
      parent.children.push(node);
    } else {
      roots.push(node);
    }
  });

  return roots;
}

export default function DingTalkPage() {
  const [config, setConfig] = useState<DingTalkConfig | null>(null);
  const [templates, setTemplates] = useState<ApprovalTemplate[]>([]);
  const [mappings, setMappings] = useState<TemplateFieldMapping[]>([]);
  const [fieldCandidates, setFieldCandidates] = useState<TemplateFieldCandidate[]>([]);
  const [syncJobs, setSyncJobs] = useState<SyncJob[]>([]);
  const [approvalInstances, setApprovalInstances] = useState<ApprovalInstance[]>([]);
  const [departmentPreview, setDepartmentPreview] = useState<DingTalkDepartmentSyncPreview | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<ApprovalTemplate | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isMappingModalOpen, setIsMappingModalOpen] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<DingTalkFormValues>();
  const [templateForm] = Form.useForm<ApprovalTemplateCreate>();
  const [mappingForm] = Form.useForm<TemplateFieldMappingCreate>();
  const [syncForm] = Form.useForm<ApprovalSyncFormValues>();
  const departmentTree = useMemo(
    () => buildDepartmentTree(departmentPreview?.departments ?? []),
    [departmentPreview],
  );
  const lastDepartmentPulledAt = useMemo(() => {
    const timestamps = (departmentPreview?.departments ?? [])
      .map((department) => department.last_synced_at)
      .filter((value): value is string => Boolean(value));
    if (!timestamps.length) return null;
    return timestamps.sort().at(-1) ?? null;
  }, [departmentPreview]);

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [data, templatePage, jobPage, instancePage, departmentData] = await Promise.all([
        apiClient.dingtalk.readConfig(),
        apiClient.dingtalk.listTemplates("?page_size=200"),
        apiClient.dingtalk.listSyncJobs("?page_size=20"),
        apiClient.dingtalk.listApprovalInstances("?page_size=50"),
        apiClient.dingtalk.previewDepartmentSync(),
      ]);
      setConfig(data);
      setTemplates(templatePage.items);
      setSyncJobs(jobPage.items);
      setApprovalInstances(instancePage.items);
      setDepartmentPreview(departmentData);
      form.setFieldsValue({
        corp_id: data.corp_id ?? undefined,
        app_key: data.app_key ?? undefined,
        admin_user_id: data.admin_user_id ?? undefined,
        drive_union_id: data.drive_union_id ?? undefined,
      });
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法读取钉钉配置");
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    loadData();
  }, []);

  async function submitConfig(values: DingTalkFormValues) {
    setIsLoading(true);
    try {
      const data = await apiClient.dingtalk.updateConfig(values);
      setConfig(data);
      form.setFieldValue("app_secret", undefined);
      setIsConfigModalOpen(false);
      message.success("钉钉配置已保存");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存钉钉配置");
    } finally {
      setIsLoading(false);
    }
  }

  async function syncTemplates() {
    setIsLoading(true);
    try {
      const result = await apiClient.dingtalk.syncTemplates();
      await loadData();
      message.success(`模板增量同步完成：拉取 ${result.pulled} 个，新增 ${result.created} 个，更新 ${result.updated} 个`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法同步模板");
    } finally {
      setIsLoading(false);
    }
  }

  async function testConnection() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.dingtalk.testConnection();
      await loadData();
      message.success("钉钉连接正常");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法连接钉钉 OpenAPI");
    } finally {
      setIsLoading(false);
    }
  }

  async function previewDepartments() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const preview = await apiClient.dingtalk.previewDepartmentSync();
      setDepartmentPreview(preview);
      message.success("已刷新本地部门预览");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法读取本地部门快照");
    } finally {
      setIsLoading(false);
    }
  }

  async function pullDepartments() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await apiClient.dingtalk.pullDepartments("?root_dept_id=1&max_depth=6");
      const preview = await apiClient.dingtalk.previewDepartmentSync();
      setDepartmentPreview(preview);
      message.success(
        `部门增量同步完成：拉取 ${result.pulled_count} 个，新增 ${result.created_count} 个，更新 ${result.updated_count} 个`,
      );
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法从钉钉拉取部门");
    } finally {
      setIsLoading(false);
    }
  }

  async function syncDepartments() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await apiClient.dingtalk.syncDepartments();
      const preview = await apiClient.dingtalk.previewDepartmentSync();
      setDepartmentPreview(preview);
      message.success(`门店落库完成：新增 ${result.created_count} 个，更新 ${result.updated_count} 个`);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法同步钉钉门店部门");
    } finally {
      setIsLoading(false);
    }
  }

  function openSyncModal() {
    syncForm.setFieldsValue({
      template_id: selectedTemplate?.id,
      time_range: [dayjs().subtract(7, "day"), dayjs()],
      page_size: 10,
      max_pages: 5,
      skip_existing: true,
    });
    setIsSyncModalOpen(true);
  }

  async function startApprovalSync(values: ApprovalSyncFormValues) {
    setIsLoading(true);
    try {
      await apiClient.dingtalk.startApprovalSync({
        template_id: values.template_id,
        started_by: "admin",
        start_at: values.time_range?.[0]?.toISOString(),
        end_at: values.time_range?.[1]?.toISOString(),
        page_size: values.page_size ?? 20,
        max_pages: values.max_pages ?? 20,
        skip_existing: values.skip_existing ?? true,
      });
      setIsSyncModalOpen(false);
      await loadData();
      message.success("审批列表增量同步完成");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法同步审批实例");
    } finally {
      setIsLoading(false);
    }
  }

  async function resumeApprovalSync(job: SyncJob) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.dingtalk.resumeApprovalSync(job.id, {
        started_by: "admin",
        page_size: 20,
        max_pages: 20,
        skip_existing: true,
      });
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法续跑审批同步");
    } finally {
      setIsLoading(false);
    }
  }

  async function submitTemplate(values: ApprovalTemplateCreate) {
    setIsLoading(true);
    try {
      await apiClient.dingtalk.createTemplate(values);
      setIsTemplateModalOpen(false);
      templateForm.resetFields();
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法新增模板");
    } finally {
      setIsLoading(false);
    }
  }

  async function loadMappings(template: ApprovalTemplate) {
    setSelectedTemplate(template);
    setIsLoading(true);
    try {
      const [data, candidates] = await Promise.all([
        apiClient.dingtalk.listMappings(template.id),
        apiClient.dingtalk.listFieldCandidates(template.id),
      ]);
      setMappings(data);
      setFieldCandidates(candidates);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载字段映射");
    } finally {
      setIsLoading(false);
    }
  }

  function applyFieldCandidate(sourceFieldName: string) {
    const candidate = fieldCandidates.find((item) => item.source_field_name === sourceFieldName);
    if (!candidate) return;
    mappingForm.setFieldsValue({
      source_field_id: candidate.source_field_id ?? undefined,
      source_path: candidate.source_path ?? undefined,
      field_type: candidate.field_type ?? undefined,
    });
  }

  async function submitMapping(values: TemplateFieldMappingCreate) {
    if (!selectedTemplate) return;
    setIsLoading(true);
    try {
      await apiClient.dingtalk.upsertMapping(selectedTemplate.id, values);
      setIsMappingModalOpen(false);
      mappingForm.resetFields();
      await loadMappings(selectedTemplate);
      await loadData();
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存字段映射");
    } finally {
      setIsLoading(false);
    }
  }

  const templateColumns: ColumnsType<ApprovalTemplate> = [
    { title: "模板名称", dataIndex: "name" },
    { title: "Process Code", dataIndex: "process_code" },
    {
      title: "映射状态",
      dataIndex: "mapping_status",
      render: (value) => (value === "mapped" ? <Tag color="green">已映射</Tag> : <Tag color="gold">未映射</Tag>),
    },
    { title: "启用", dataIndex: "is_enabled", render: (value) => (value ? "是" : "否") },
    { title: "上次同步", dataIndex: "last_sync_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    {
      title: "操作",
      render: (_, record) => (
        <Space>
          <Button type="link" onClick={() => loadMappings(record)}>
            字段映射
          </Button>
        </Space>
      ),
    },
  ];

  const mappingColumns: ColumnsType<TemplateFieldMapping> = [
    { title: "标准字段", dataIndex: "standard_field" },
    { title: "来源字段", dataIndex: "source_field_name" },
    { title: "字段路径", dataIndex: "source_path", render: (value) => value || "-" },
    { title: "类型", dataIndex: "field_type", render: (value) => value || "-" },
    { title: "必填", dataIndex: "is_required", render: (value) => (value ? "是" : "否") },
  ];

  const departmentColumns: ColumnsType<DingTalkDepartment> = [
    {
      title: "部门名称",
      dataIndex: "name",
      render: (value, record) => (
        <Space size={8}>
          <span style={{ fontWeight: record.is_store_candidate ? 700 : 500 }}>{value}</span>
          {record.is_store_candidate ? <Tag color="green">候选门店</Tag> : null}
          {record.store_name ? <Tag color="blue">已关联</Tag> : null}
        </Space>
      ),
    },
    { title: "部门 ID", dataIndex: "dept_id", width: 150 },
    {
      title: "层级路径",
      dataIndex: "path",
      render: (value) => <span style={{ color: "#64748b" }}>{value}</span>,
    },
    {
      title: "落地状态",
      dataIndex: "is_store_candidate",
      width: 120,
      render: (value, record) => {
        if (!value) return <Tag>部门</Tag>;
        if (record.store_name) return <Tag color="blue">已存在</Tag>;
        return <Tag color="gold">将新增</Tag>;
      },
    },
    { title: "本地门店", dataIndex: "store_name", width: 180, render: (value) => value || "-" },
  ];

  const jobColumns: ColumnsType<SyncJob> = [
    { title: "任务类型", dataIndex: "job_type" },
    {
      title: "状态",
      dataIndex: "status",
      render: (value: SyncJob["status"], record) => {
        if (value === "succeeded" && record.next_cursor) return <Tag color="blue">可续跑</Tag>;
        if (value === "succeeded") return <Tag color="green">成功</Tag>;
        if (value === "failed") return <Tag color="red">失败</Tag>;
        if (value === "running") return <Tag color="blue">运行中</Tag>;
        return <Tag>等待中</Tag>;
      },
    },
    { title: "处理", dataIndex: "processed_count" },
    { title: "成功", dataIndex: "success_count" },
    { title: "失败", dataIndex: "failed_count" },
    { title: "开始窗口", dataIndex: "request_start_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    { title: "结束窗口", dataIndex: "request_end_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    { title: "游标", dataIndex: "next_cursor", render: (value) => value || "-" },
    { title: "错误", dataIndex: "error_message", render: (value) => value || "-" },
    { title: "发起人", dataIndex: "started_by", render: (value) => value || "-" },
    { title: "完成时间", dataIndex: "finished_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    {
      title: "操作",
      render: (_, record) =>
        record.next_cursor ? (
          <Button type="link" onClick={() => resumeApprovalSync(record)}>
            续跑
          </Button>
        ) : (
          "-"
        ),
    },
  ];

  const instanceColumns: ColumnsType<ApprovalInstance> = [
    { title: "审批编号", dataIndex: "approval_no", render: (value) => value || "-" },
    { title: "实例 ID", dataIndex: "dingtalk_instance_id" },
    { title: "申请人", dataIndex: "applicant_name", render: (value) => value || "-" },
    {
      title: "状态",
      dataIndex: "approval_status",
      render: (value) => (value === "approved" ? <Tag color="green">已通过</Tag> : <Tag>{value}</Tag>),
    },
    { title: "提交时间", dataIndex: "submit_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    { title: "通过时间", dataIndex: "approved_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
  ];

  const credentialStatus = config?.status === "configured" ? "已配置" : "未完成";

  return (
    <AppShell
      title="钉钉同步工作台"
      kicker="DINGTALK DATA SYNC"
      action={
        <Space>
          <Button onClick={testConnection} loading={isLoading}>
            测试连接
          </Button>
          <Button type="primary" onClick={() => setIsConfigModalOpen(true)}>
            配置凭证
          </Button>
        </Space>
      }
    >
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}

      <Card className="integration-overview">
        <div className="integration-overview-grid">
          <div>
            <Typography.Text className="topbar-kicker">SYNC STATUS</Typography.Text>
            <Typography.Title level={4}>钉钉数据同步</Typography.Title>
            <Typography.Text type="secondary">
              部门、审批模板、审批列表均先增量同步到本地数据库，再由业务流程消费本地数据。
            </Typography.Text>
          </div>
          <Statistic title="凭证状态" value={credentialStatus} valueStyle={{ color: config?.status === "configured" ? "#059669" : "#d97706" }} />
          <Statistic title="本地部门" value={departmentPreview?.departments.length ?? 0} />
          <Statistic title="审批模板" value={templates.length} />
          <Statistic title="审批实例" value={approvalInstances.length} />
        </div>
      </Card>

      <Tabs
        className="sync-tabs"
        items={[
          {
            key: "departments",
            label: "部门",
            children: (
              <Card
                title="部门快照与门店落库"
                extra={
                  <Space>
                    <Button onClick={previewDepartments} loading={isLoading}>
                      刷新本地预览
                    </Button>
                    <Button onClick={pullDepartments} loading={isLoading}>
                      增量同步部门
                    </Button>
                    <Button type="primary" onClick={syncDepartments} loading={isLoading}>
                      落库门店
                    </Button>
                  </Space>
                }
              >
                {departmentPreview ? (
                  <>
                    <Space wrap className="dashboard-alert">
                      <Tag>本地部门 {departmentPreview.departments.length}</Tag>
                      <Tag color="blue">候选门店 {departmentPreview.candidate_count}</Tag>
                      <Tag color="green">已存在 {departmentPreview.existing_count}</Tag>
                      <Tag color="gold">将新增 {departmentPreview.create_count}</Tag>
                      <Tag color="purple">将更新 {departmentPreview.update_count}</Tag>
                      <Tag color="cyan">
                        上次同步 {lastDepartmentPulledAt ? lastDepartmentPulledAt.replace("T", " ").slice(0, 16) : "尚未同步"}
                      </Tag>
                    </Space>
                    <Table
                      rowKey="dept_id"
                      loading={isLoading}
                      columns={departmentColumns}
                      dataSource={departmentTree}
                      pagination={false}
                      rowClassName={(record) => (record.is_store_candidate ? "store-candidate-row" : "")}
                      expandable={{ defaultExpandAllRows: true }}
                    />
                  </>
                ) : (
                  <Alert message="先增量同步钉钉部门到本地快照，再确认门店候选并落库到门店档案。" type="info" showIcon />
                )}
              </Card>
            ),
          },
          {
            key: "templates",
            label: "审批模板",
            children: (
              <Space direction="vertical" size={16} className="full-width">
                <Card
                  title="审批模板快照"
                  extra={
                    <Space>
                      <Button onClick={syncTemplates} loading={isLoading}>
                        增量同步模板
                      </Button>
                      <Button type="primary" onClick={() => setIsTemplateModalOpen(true)}>
                        手动新增模板
                      </Button>
                    </Space>
                  }
                >
                  <Space wrap className="dashboard-alert">
                    <Tag>本地模板 {templates.length}</Tag>
                    <Tag color="green">已映射 {templates.filter((item) => item.mapping_status === "mapped").length}</Tag>
                    <Tag color="gold">未映射 {templates.filter((item) => item.mapping_status !== "mapped").length}</Tag>
                    <Tag color="cyan">
                      上次同步 {config?.last_template_sync_at ? config.last_template_sync_at.replace("T", " ").slice(0, 16) : "尚未同步"}
                    </Tag>
                  </Space>
                  <Table rowKey="id" loading={isLoading} columns={templateColumns} dataSource={templates} />
                </Card>
                <Card
                  title={selectedTemplate ? `${selectedTemplate.name} 字段映射` : "字段映射"}
                  extra={
                    <Button disabled={!selectedTemplate} onClick={() => setIsMappingModalOpen(true)}>
                      新增/更新映射
                    </Button>
                  }
                >
                  <Table rowKey="id" loading={isLoading} columns={mappingColumns} dataSource={mappings} />
                </Card>
              </Space>
            ),
          },
          {
            key: "instances",
            label: "审批列表",
            children: (
              <Space direction="vertical" size={16} className="full-width">
                <Card
                  title="审批实例快照"
                  extra={
                    <Button type="primary" onClick={openSyncModal} loading={isLoading}>
                      增量同步审批
                    </Button>
                  }
                >
                  <Space wrap className="dashboard-alert">
                    <Tag>本地实例 {approvalInstances.length}</Tag>
                    <Tag color="green">已通过 {approvalInstances.filter((item) => item.approval_status === "approved").length}</Tag>
                    <Tag color="blue">同步任务 {syncJobs.length}</Tag>
                    <Tag color="cyan">
                      上次同步 {config?.last_instance_sync_at ? config.last_instance_sync_at.replace("T", " ").slice(0, 16) : "尚未同步"}
                    </Tag>
                  </Space>
                  <Table
                    rowKey="id"
                    loading={isLoading}
                    columns={instanceColumns}
                    dataSource={approvalInstances}
                    pagination={{ pageSize: 8 }}
                  />
                </Card>
                <Card title="同步任务">
                  <Table
                    rowKey="id"
                    loading={isLoading}
                    columns={jobColumns}
                    dataSource={syncJobs}
                    pagination={{ pageSize: 5 }}
                  />
                </Card>
              </Space>
            ),
          },
        ]}
      />

      <Modal
        title="钉钉应用凭证"
        open={isConfigModalOpen}
        onCancel={() => setIsConfigModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={isLoading}
        width={640}
      >
        {isLoading && !config ? (
          <Skeleton active />
        ) : (
          <Form form={form} layout="vertical" onFinish={submitConfig}>
            <Form.Item label="Corp ID" name="corp_id">
              <Input />
            </Form.Item>
            <Form.Item label="App Key" name="app_key">
              <Input />
            </Form.Item>
            <Form.Item label="App Secret" name="app_secret">
              <Input.Password placeholder={config?.app_secret_configured ? "已配置，留空则不修改" : undefined} />
            </Form.Item>
            <Form.Item label="审批模板管理员 User ID" name="admin_user_id">
              <Input />
            </Form.Item>
            <Form.Item label="钉盘下载 Union ID" name="drive_union_id">
              <Input />
            </Form.Item>
            <Form.Item label="配置状态">
              <Space>
                <Tag color={config?.status === "configured" ? "green" : "gold"}>{credentialStatus}</Tag>
                <Tag color={config?.app_secret_configured ? "green" : "red"}>
                  Secret {config?.app_secret_configured ? "已保存" : "未保存"}
                </Tag>
              </Space>
            </Form.Item>
          </Form>
        )}
      </Modal>
      <Modal
        title="同步审批实例"
        open={isSyncModalOpen}
        onCancel={() => setIsSyncModalOpen(false)}
        onOk={() => syncForm.submit()}
        confirmLoading={isLoading}
      >
        <Form
          form={syncForm}
          layout="vertical"
          onFinish={startApprovalSync}
          initialValues={{ page_size: 10, max_pages: 5, skip_existing: true }}
        >
          <Form.Item name="template_id" label="审批模板">
            <Select
              allowClear
              placeholder="全部已启用模板"
              options={templates.map((template) => ({
                label: template.name,
                value: template.id,
              }))}
            />
          </Form.Item>
          <Form.Item name="time_range" label="同步时间窗口">
            <DatePicker.RangePicker showTime className="full-width" />
          </Form.Item>
          <Form.Item name="skip_existing" label="跳过本地已有审批" initialValue={true}>
            <Switch />
          </Form.Item>
          <Form.Item name="page_size" label="每页数量" rules={[{ required: true }]}>
            <InputNumber min={1} max={100} className="full-width" />
          </Form.Item>
          <Form.Item name="max_pages" label="最大页数" rules={[{ required: true }]}>
            <InputNumber min={1} max={200} className="full-width" />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="新增审批模板"
        open={isTemplateModalOpen}
        onCancel={() => setIsTemplateModalOpen(false)}
        onOk={() => templateForm.submit()}
        confirmLoading={isLoading}
      >
        <Form form={templateForm} layout="vertical" onFinish={submitTemplate} initialValues={{ is_enabled: true }}>
          <Form.Item name="name" label="模板名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item name="process_code" label="Process Code" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Form.Item label="启用" name="is_enabled">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="新增/更新字段映射"
        open={isMappingModalOpen}
        onCancel={() => setIsMappingModalOpen(false)}
        onOk={() => mappingForm.submit()}
        confirmLoading={isLoading}
      >
        <Form form={mappingForm} layout="vertical" onFinish={submitMapping}>
          <Form.Item name="standard_field" label="标准字段" rules={[{ required: true }]}>
            <Input placeholder="amount" />
          </Form.Item>
          <Form.Item name="source_field_name" label="来源字段名称" rules={[{ required: true }]}>
            <AutoComplete
              placeholder="金额"
              onSelect={applyFieldCandidate}
              options={fieldCandidates.map((candidate) => ({
                label: `${candidate.source_field_name}${candidate.field_type ? ` / ${candidate.field_type}` : ""}`,
                value: candidate.source_field_name,
              }))}
            >
              <Input />
            </AutoComplete>
          </Form.Item>
          <Form.Item name="source_field_id" label="来源字段 ID">
            <Input />
          </Form.Item>
          <Form.Item name="source_path" label="字段路径">
            <Input placeholder="费用明细[].金额" />
          </Form.Item>
          <Form.Item name="field_type" label="字段类型">
            <Input placeholder="MoneyField" />
          </Form.Item>
          <Form.Item label="必填" name="is_required" initialValue={false}>
            <Switch />
          </Form.Item>
          <Form.Item name="sort_order" label="排序" initialValue={0}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
