"use client";

import { Alert, AutoComplete, Button, Card, DatePicker, Form, Input, InputNumber, Modal, Select, Skeleton, Space, Switch, Table, Tag } from "antd";
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
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<DingTalkFormValues>();
  const [templateForm] = Form.useForm<ApprovalTemplateCreate>();
  const [mappingForm] = Form.useForm<TemplateFieldMappingCreate>();
  const [syncForm] = Form.useForm<ApprovalSyncFormValues>();
  const departmentTree = useMemo(
    () => buildDepartmentTree(departmentPreview?.departments ?? []),
    [departmentPreview],
  );

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [data, templatePage, jobPage, instancePage] = await Promise.all([
        apiClient.dingtalk.readConfig(),
        apiClient.dingtalk.listTemplates("?page_size=200"),
        apiClient.dingtalk.listSyncJobs("?page_size=20"),
        apiClient.dingtalk.listApprovalInstances("?page_size=50"),
      ]);
      setConfig(data);
      setTemplates(templatePage.items);
      setSyncJobs(jobPage.items);
      setApprovalInstances(instancePage.items);
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
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存钉钉配置");
    } finally {
      setIsLoading(false);
    }
  }

  async function syncTemplates() {
    setIsLoading(true);
    try {
      await apiClient.dingtalk.syncTemplates();
      await loadData();
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
      const preview = await apiClient.dingtalk.previewDepartmentSync("?root_dept_id=1&max_depth=6");
      setDepartmentPreview(preview);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法拉取钉钉部门");
    } finally {
      setIsLoading(false);
    }
  }

  async function syncDepartments() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.dingtalk.syncDepartments("?root_dept_id=1&max_depth=6");
      const preview = await apiClient.dingtalk.previewDepartmentSync("?root_dept_id=1&max_depth=6");
      setDepartmentPreview(preview);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法同步钉钉门店部门");
    } finally {
      setIsLoading(false);
    }
  }

  function openSyncModal() {
    syncForm.setFieldsValue({
      template_id: selectedTemplate?.id,
      page_size: 20,
      max_pages: 20,
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
      });
      setIsSyncModalOpen(false);
      await loadData();
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
      render: (value: SyncJob["status"]) => {
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

  return (
    <AppShell title="钉钉同步设置" action={<Button type="primary" onClick={() => form.submit()}>保存配置</Button>}>
      {errorMessage ? (
        <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon />
      ) : null}
      <Card title="应用凭证">
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
            <Form.Item label="密钥状态">
              <Switch checked={Boolean(config?.app_secret_configured)} disabled />
            </Form.Item>
          </Form>
        )}
      </Card>
      <Card
        title="部门与门店"
        className="section-card"
        extra={
          <Space>
            <Button onClick={previewDepartments} loading={isLoading}>
              预览部门
            </Button>
            <Button type="primary" onClick={syncDepartments} loading={isLoading}>
              同步为门店
            </Button>
          </Space>
        }
      >
        {departmentPreview ? (
          <>
            <Space wrap className="dashboard-alert">
              <Tag color="blue">候选门店 {departmentPreview.candidate_count}</Tag>
              <Tag color="green">已存在 {departmentPreview.existing_count}</Tag>
              <Tag color="gold">将新增 {departmentPreview.create_count}</Tag>
              <Tag color="purple">将更新 {departmentPreview.update_count}</Tag>
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
          <Alert message="先预览钉钉部门，确认门店候选后再同步到本地门店档案。" type="info" showIcon />
        )}
      </Card>
      <Card
        title="审批模板"
        className="section-card"
        extra={
          <Space>
            <Button onClick={testConnection} loading={isLoading}>
              测试连接
            </Button>
            <Button onClick={syncTemplates} loading={isLoading}>
              同步模板
            </Button>
            <Button onClick={openSyncModal} loading={isLoading}>
              同步审批实例
            </Button>
            <Button type="primary" onClick={() => setIsTemplateModalOpen(true)}>
              新增模板
            </Button>
          </Space>
        }
      >
        <Table rowKey="id" loading={isLoading} columns={templateColumns} dataSource={templates} />
      </Card>
      <Card
        title={selectedTemplate ? `${selectedTemplate.name} 字段映射` : "字段映射"}
        className="section-card"
        extra={
          <Button disabled={!selectedTemplate} onClick={() => setIsMappingModalOpen(true)}>
            新增/更新映射
          </Button>
        }
      >
        <Table rowKey="id" loading={isLoading} columns={mappingColumns} dataSource={mappings} />
      </Card>
      <Card title="同步任务" className="section-card">
        <Table
          rowKey="id"
          loading={isLoading}
          columns={jobColumns}
          dataSource={syncJobs}
          pagination={{ pageSize: 5 }}
        />
      </Card>
      <Card title="审批实例" className="section-card">
        <Table
          rowKey="id"
          loading={isLoading}
          columns={instanceColumns}
          dataSource={approvalInstances}
          pagination={{ pageSize: 8 }}
        />
      </Card>
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
          initialValues={{ page_size: 20, max_pages: 20 }}
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
