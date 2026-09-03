"use client";

import {
  Alert,
  Button,
  Card,
  Col,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Image,
  Input,
  Modal,
  Row,
  Select,
  Skeleton,
  Space,
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
  Attachment,
  DingTalkAutoSyncSetting,
  DingTalkAutoSyncSettingUpdate,
  DingTalkConfig,
  DingTalkDepartment,
  DingTalkDepartmentSyncPreview,
  SyncJob,
  TemplateFieldCandidate,
  TemplateFieldMapping,
  TemplateFieldMappingCreate,
} from "@fin-hub/shared-types";
import { AppShell } from "../components/AppShell";
import { EnterpriseTable } from "../components/EnterpriseTable";
import type { EnterpriseTableColumn } from "../components/EnterpriseTable";
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
  start_at?: dayjs.Dayjs;
  end_at?: dayjs.Dayjs;
  sync_to_now?: boolean;
  skip_existing?: boolean;
}

interface AutoSyncFormValues extends DingTalkAutoSyncSettingUpdate {}

type BusinessFieldOption = {
  value: string;
  label: string;
  description: string;
  required?: boolean;
};

type DepartmentTreeNode = DingTalkDepartment & {
  children?: DepartmentTreeNode[];
};

type DingTalkFormField = {
  id?: string;
  name?: string;
  componentType?: string;
  component_type?: string;
  value?: unknown;
};

type DingTalkTableRow = Record<string, unknown>;

type ImagePreviewState = {
  title: string;
  url: string;
};

type DingTalkTabKey = "auto-sync" | "departments" | "templates" | "instances";

const AUTO_SYNC_TIME_OPTIONS = Array.from({ length: 24 }, (_, hour) => {
  const value = `${String(hour).padStart(2, "0")}:00`;
  return { value, label: value };
});

function formatBeijingDateTime(value?: string | null) {
  if (!value) {
    return "-";
  }
  const normalized = value.endsWith("Z") ? value : `${value}Z`;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(new Date(normalized))
    .replace(/\//g, "-");
}

const BUSINESS_FIELD_OPTIONS: BusinessFieldOption[] = [
  { value: "amount", label: "单据总金额", description: "对账时与银行流水金额匹配", required: true },
  { value: "store", label: "门店/部门", description: "用于归属门店和门店维度分析", required: true },
  { value: "expense_date", label: "业务日期", description: "用于入账期间和日期分析", required: true },
  { value: "category_l1", label: "一级分类", description: "用于费用分类统计" },
  { value: "payee_account", label: "收款账户", description: "用于辅助识别付款对象" },
  { value: "description", label: "摘要说明", description: "用于候选匹配和列表识别" },
  { value: "expense_table", label: "明细表格", description: "用于详情查看审批明细" },
  { value: "voucher_images", label: "凭证图片", description: "用于凭证图片预览" },
  { value: "voucher_files", label: "凭证文件", description: "用于凭证文件访问或下载" },
];

const BUSINESS_FIELD_SET = new Set(BUSINESS_FIELD_OPTIONS.map((item) => item.value));

function isBusinessMapping(mapping: TemplateFieldMapping) {
  return BUSINESS_FIELD_SET.has(mapping.standard_field);
}

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

function parseDingTalkTableValue(value: unknown): DingTalkTableRow[] {
  if (!value) return [];
  if (typeof value === "string") {
    try {
      return parseDingTalkTableValue(JSON.parse(value));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((row) => {
      if (!row || typeof row !== "object") return null;
      const source = row as Record<string, unknown>;
      const cells = source.rowValue ?? source.row_value ?? source.value;
      if (!Array.isArray(cells)) return source;
      const parsed: DingTalkTableRow = {};
      cells.forEach((cell) => {
        if (!cell || typeof cell !== "object") return;
        const item = cell as Record<string, unknown>;
        const label = item.label ?? item.name ?? item.title;
        if (!label) return;
        parsed[String(label)] = item.value ?? item.ext_value ?? item.extValue ?? "";
      });
      return parsed;
    })
    .filter((row): row is DingTalkTableRow => Boolean(row));
}

function isImageAttachment(attachment: Attachment, blob?: Blob) {
  const contentType = blob?.type || attachment.content_type || "";
  if (contentType.startsWith("image/")) return true;
  return /\.(apng|avif|gif|jpe?g|png|webp)$/i.test(attachment.file_name);
}

function isImageUrl(value: string) {
  return /\.(apng|avif|gif|jpe?g|png|webp)(\?.*)?$/i.test(value);
}

function parseUrlValues(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^https?:\/\//i.test(trimmed)) return [trimmed];
    try {
      return parseUrlValues(JSON.parse(trimmed));
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap((item) => parseUrlValues(item));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    return parseUrlValues(source.url ?? source.downloadUrl ?? source.download_url);
  }
  return [];
}

function externalAttachmentUrl(attachment: Attachment) {
  const value = attachment.external_file_id;
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    const url = parsed?.url ?? parsed?.downloadUrl ?? parsed?.download_url;
    return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
  } catch {
    return /^https?:\/\//i.test(value) ? value : null;
  }
}

function renderDingTalkValue(value: unknown) {
  const urls = parseUrlValues(value);
  if (urls.length > 0) {
    return (
      <Space wrap size={8}>
        {urls.map((url) =>
          isImageUrl(url) ? (
            <Image
              key={url}
              src={url}
              alt="报销凭证"
              width={72}
              height={96}
              style={{ objectFit: "cover", borderRadius: 4 }}
            />
          ) : (
            <Button key={url} size="small" href={url} target="_blank" rel="noreferrer">
              打开链接
            </Button>
          ),
        )}
      </Space>
    );
  }
  return (
    <Typography.Text className="json-preview">
      {typeof value === "string" ? value : JSON.stringify(value)}
    </Typography.Text>
  );
}

function compactSampleValue(value: unknown) {
  if (value === undefined || value === null || value === "") return "-";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function fieldCandidateSearchText(candidate: TemplateFieldCandidate) {
  return [
    candidate.source_field_name,
    candidate.source_field_id,
    candidate.field_type,
    compactSampleValue(candidate.sample_value),
  ]
    .filter(Boolean)
    .join(" ");
}

function renderFieldCandidateOption(candidate: TemplateFieldCandidate) {
  return (
    <Space direction="vertical" size={2}>
      <Typography.Text strong>{candidate.source_field_name}</Typography.Text>
      <Typography.Text
        type="secondary"
        style={{ display: "block", maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
      >
        样例：{compactSampleValue(candidate.sample_value)}
      </Typography.Text>
    </Space>
  );
}

function apiErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === "object" && "payload" in error) {
    const payload = (error as { payload?: unknown }).payload;
    if (payload && typeof payload === "object" && "detail" in payload) {
      const detail = (payload as { detail?: unknown }).detail;
      if (typeof detail === "string") return detail;
    }
  }
  return error instanceof Error ? error.message : fallback;
}

function isUnauthorizedError(error: unknown) {
  return Boolean(error && typeof error === "object" && "status" in error && (error as { status?: unknown }).status === 401);
}

function dingtalkPageErrorMessage(error: unknown, fallback: string) {
  if (isUnauthorizedError(error)) return "登录已失效或当前账号没有权限，请重新登录后再操作钉钉同步。";
  return apiErrorMessage(error, fallback);
}

function isSeedTemplate(template: ApprovalTemplate) {
  return template.process_code.startsWith("seed-");
}

function approvalPayload(instance: ApprovalInstance) {
  if (!instance.raw_payload) return null;
  try {
    return JSON.parse(instance.raw_payload) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function approvalTitle(instance: ApprovalInstance) {
  const payload = approvalPayload(instance);
  const title = payload?.title ?? payload?.titleName;
  return typeof title === "string" ? title : "";
}

function applicantDisplayName(instance: ApprovalInstance) {
  if (instance.applicant_name) return instance.applicant_name;
  const matched = approvalTitle(instance).match(/^(.+?)提交的/);
  if (matched?.[1]) return matched[1];
  return instance.applicant_user_id || "-";
}

function approvalDepartmentName(instance: ApprovalInstance) {
  if (instance.department_name) return instance.department_name;
  const payload = approvalPayload(instance);
  const directName = payload?.originator_dept_name ?? payload?.originatorDeptName;
  if (typeof directName === "string" && directName) return directName;
  const parsed = payload?._fin_hub_parse;
  if (parsed && typeof parsed === "object") {
    const parsedName = (parsed as Record<string, unknown>).originator_dept_name;
    if (typeof parsedName === "string" && parsedName) return parsedName;
  }
  return "-";
}

function approvalStatusMeta(status: string) {
  const normalized = status.toUpperCase();
  const statusMap: Record<string, { label: string; color: string }> = {
    APPROVED: { label: "已通过", color: "green" },
    AGREE: { label: "已通过", color: "green" },
    COMPLETED: { label: "已完成", color: "green" },
    TERMINATED: { label: "已撤销", color: "gold" },
    CANCELED: { label: "已取消", color: "default" },
    CANCELLED: { label: "已取消", color: "default" },
    REJECTED: { label: "已拒绝", color: "red" },
    REFUSE: { label: "已拒绝", color: "red" },
    REFUSED: { label: "已拒绝", color: "red" },
    RUNNING: { label: "审批中", color: "blue" },
    NEW: { label: "审批中", color: "blue" },
  };
  return statusMap[normalized] ?? { label: status || "-", color: "default" };
}

function payloadArray(payload: unknown, ...keys: string[]) {
  if (!payload || typeof payload !== "object") return [];
  const source = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value.filter((item) => item && typeof item === "object") as Record<string, unknown>[];
  }
  return [];
}

function fieldLabel(field: DingTalkFormField) {
  return field.name || field.id || "字段";
}

function fieldValue(field: DingTalkFormField) {
  return field.value ?? (field as Record<string, unknown>).ext_value ?? (field as Record<string, unknown>).extValue;
}

function operationTitle(record: Record<string, unknown>) {
  return String(record.name ?? record.task_name ?? record.activity_name ?? record.type ?? "审批节点");
}

function operationActor(record: Record<string, unknown>) {
  return String(record.user_name ?? record.userid ?? record.userId ?? record.operator ?? "-");
}

function operationAction(record: Record<string, unknown>) {
  return String(record.action ?? record.result ?? record.status ?? "-");
}

function operationTime(record: Record<string, unknown>) {
  const value = record.date ?? record.time ?? record.create_time ?? record.finish_time;
  return value ? formatBeijingDateTime(String(value)) : "-";
}

function syncJobTypeLabel(type: string) {
  const labels: Record<string, string> = {
    dingtalk_auto_sync: "钉钉自动同步",
    dingtalk_approval_sync: "审批列表同步",
    dingtalk_approval_reparse: "审批重新解析",
    bank_transaction_import: "银行流水导入",
  };
  return labels[type] ?? type;
}

function parseSyncJobSummary(job: SyncJob): Record<string, any> | null {
  if (!job.raw_summary) return null;
  try {
    const parsed = JSON.parse(job.raw_summary);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function renderSyncJobSummary(job: SyncJob) {
  const summary = parseSyncJobSummary(job);
  if (!summary) return <Typography.Text type="secondary">-</Typography.Text>;
  const tags = [];
  const departmentPull = summary.department_pull;
  const departmentSync = summary.department_sync;
  const templateSync = summary.template_sync;
  const approvalSync = summary.approval_sync;
  const progress = summary.progress;

  if (departmentPull?.pulled_count !== undefined) tags.push(<Tag key="departments">部门 {departmentPull.pulled_count}</Tag>);
  if (departmentSync) {
    tags.push(
      <Tag key="stores" color="cyan">
        门店 +{departmentSync.created_count ?? 0} / 更{departmentSync.updated_count ?? 0}
      </Tag>,
    );
  }
  if (templateSync) tags.push(<Tag key="templates" color="blue">模板 {templateSync.pulled ?? 0}</Tag>);
  if (approvalSync?.templates) tags.push(<Tag key="approval-templates" color="purple">审批模板 {approvalSync.templates.length}</Tag>);
  if (job.processed_count || job.success_count || job.failed_count) {
    tags.push(
      <Tag key="approval-count" color={job.failed_count ? "red" : "green"}>
        审批 {job.success_count}/{job.processed_count}
      </Tag>,
    );
  }
  if (progress?.current_stage) tags.push(<Tag key="stage">阶段 {progress.current_stage}</Tag>);
  if (summary.error) tags.push(<Tag key="error" color="red">有错误</Tag>);

  return tags.length ? <Space size={[4, 4]} wrap>{tags}</Space> : <Typography.Text type="secondary">-</Typography.Text>;
}

function tableFilters(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value !== "-"))))
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
    .map((value) => ({ text: value, value }));
}

function sortTemplates(templates: ApprovalTemplate[]) {
  return [...templates].sort((left, right) => {
    if (left.is_enabled !== right.is_enabled) return left.is_enabled ? -1 : 1;
    return right.created_at.localeCompare(left.created_at);
  });
}

function formValueMapFromPayload(payload: unknown) {
  const values: Record<string, unknown> = {};
  if (!payload || typeof payload !== "object") return values;
  const source = payload as Record<string, unknown>;
  const components = source.form_component_values ?? source.formComponentValues;
  if (!Array.isArray(components)) return values;
  components.forEach((component) => {
    if (!component || typeof component !== "object") return;
    const item = component as Record<string, unknown>;
    const value = item.value ?? item.ext_value ?? item.extValue;
    const name = item.name ?? item.label ?? item.id;
    if (name) values[String(name)] = value;
    if (item.id) values[String(item.id)] = value;
  });
  return values;
}

function tableValueFromPayload(payload: unknown, tableKey: string, cellKey: string) {
  if (!payload || typeof payload !== "object") return undefined;
  const source = payload as Record<string, unknown>;
  const components = source.form_component_values ?? source.formComponentValues;
  if (!Array.isArray(components)) return undefined;
  const table = components.find((component) => {
    if (!component || typeof component !== "object") return false;
    const item = component as Record<string, unknown>;
    return [item.id, item.name, item.label, item.key].some((value) => value != null && String(value) === tableKey);
  });
  if (!table || typeof table !== "object") return undefined;
  const tableSource = table as Record<string, unknown>;
  let rows = tableSource.value;
  if (typeof rows === "string") {
    try {
      rows = JSON.parse(rows);
    } catch {
      rows = [];
    }
  }
  if (!Array.isArray(rows)) return undefined;
  const values: unknown[] = [];
  rows.forEach((row) => {
    if (!row || typeof row !== "object") return;
    const cells = (row as Record<string, unknown>).rowValue ?? (row as Record<string, unknown>).row_value;
    if (!Array.isArray(cells)) return;
    cells.forEach((cell) => {
      if (!cell || typeof cell !== "object") return;
      const item = cell as Record<string, unknown>;
      const matched = [item.key, item.id, item.name, item.label, item.title].some(
        (value) => value != null && String(value) === cellKey,
      );
      const value = item.value ?? item.ext_value ?? item.extValue;
      if (matched && value !== undefined && value !== null && value !== "") values.push(value);
    });
  });
  if (!values.length) return undefined;
  return values.length === 1 ? values[0] : values;
}

function mappedValueFromPayload(payload: unknown, mapping: TemplateFieldMapping) {
  if (mapping.source_path?.startsWith("root:")) {
    const [, key] = mapping.source_path.split(":");
    if (!key || !payload || typeof payload !== "object") return undefined;
    return (payload as Record<string, unknown>)[key];
  }
  if (mapping.source_path?.startsWith("table:")) {
    const [, tableKey, cellKey] = mapping.source_path.split(":");
    if (tableKey && cellKey) return tableValueFromPayload(payload, tableKey, cellKey);
  }
  const values = formValueMapFromPayload(payload);
  if (mapping.source_field_id && mapping.source_field_id in values) return values[mapping.source_field_id];
  return values[mapping.source_field_name];
}

function mappedDisplayValue(instance: ApprovalInstance, mapping: TemplateFieldMapping) {
  if (!instance.raw_payload) return undefined;
  try {
    return mappedValueFromPayload(JSON.parse(instance.raw_payload), mapping);
  } catch {
    return undefined;
  }
}

function candidateKey(candidate: TemplateFieldCandidate) {
  return candidate.source_field_id || candidate.source_field_name;
}

export default function DingTalkPage() {
  const [config, setConfig] = useState<DingTalkConfig | null>(null);
  const [autoSyncSetting, setAutoSyncSetting] = useState<DingTalkAutoSyncSetting | null>(null);
  const [templates, setTemplates] = useState<ApprovalTemplate[]>([]);
  const [mappings, setMappings] = useState<TemplateFieldMapping[]>([]);
  const [fieldCandidates, setFieldCandidates] = useState<TemplateFieldCandidate[]>([]);
  const [syncJobs, setSyncJobs] = useState<SyncJob[]>([]);
  const [approvalInstances, setApprovalInstances] = useState<ApprovalInstance[]>([]);
  const [departmentPreview, setDepartmentPreview] = useState<DingTalkDepartmentSyncPreview | null>(null);
  const [activeTabKey, setActiveTabKey] = useState<DingTalkTabKey>("auto-sync");
  const [loadedTabKeys, setLoadedTabKeys] = useState<DingTalkTabKey[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<ApprovalTemplate | null>(null);
  const [instanceTemplateFilterId, setInstanceTemplateFilterId] = useState<string | null>(null);
  const [selectedInstance, setSelectedInstance] = useState<ApprovalInstance | null>(null);
  const [selectedInstanceAttachments, setSelectedInstanceAttachments] = useState<Attachment[]>([]);
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isMappingDrawerOpen, setIsMappingDrawerOpen] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<DingTalkFormValues>();
  const [templateForm] = Form.useForm<ApprovalTemplateCreate>();
  const [syncForm] = Form.useForm<ApprovalSyncFormValues>();
  const [autoSyncForm] = Form.useForm<AutoSyncFormValues>();
  const departmentTree = useMemo(
    () => buildDepartmentTree(departmentPreview?.departments ?? []),
    [departmentPreview],
  );
  const templateNameById = useMemo(
    () => new Map(templates.map((template) => [template.id, template.name])),
    [templates],
  );
  const lastDepartmentPulledAt = useMemo(() => {
    const timestamps = (departmentPreview?.departments ?? [])
      .map((department) => department.last_synced_at)
      .filter((value): value is string => Boolean(value));
    if (!timestamps.length) return null;
    return timestamps.sort().at(-1) ?? null;
  }, [departmentPreview]);
  const selectedInstancePayload = useMemo(() => {
    if (!selectedInstance?.raw_payload) return null;
    try {
      return JSON.parse(selectedInstance.raw_payload);
    } catch {
      return null;
    }
  }, [selectedInstance]);
  const selectedInstanceFields = useMemo<DingTalkFormField[]>(() => {
    const fields = selectedInstancePayload?.form_component_values ?? selectedInstancePayload?.formComponentValues;
    return Array.isArray(fields) ? fields.filter((item) => item && typeof item === "object") : [];
  }, [selectedInstancePayload]);
  const selectedInstanceBasicFields = useMemo(() => {
    return selectedInstanceFields.filter((field) => {
      const componentType = field.componentType ?? field.component_type;
      return componentType !== "TableField" && !parseDingTalkTableValue(fieldValue(field)).length;
    });
  }, [selectedInstanceFields]);
  const selectedInstanceTables = useMemo(() => {
    return selectedInstanceFields
      .map((field) => ({
        name: fieldLabel(field),
        rows: parseDingTalkTableValue(fieldValue(field)),
      }))
      .filter((table) => table.rows.length > 0);
  }, [selectedInstanceFields]);
  const selectedInstanceOperations = useMemo(
    () => payloadArray(selectedInstancePayload, "operation_records", "operationRecords", "tasks", "task_list", "taskList"),
    [selectedInstancePayload],
  );
  const businessMappings = useMemo(() => mappings.filter(isBusinessMapping), [mappings]);
  const selectedTemplateSampleInstance = selectedTemplate
    ? approvalInstances.find((instance) => instance.template_id === selectedTemplate.id)
    : undefined;
  const instanceTemplateFilter = instanceTemplateFilterId
    ? templates.find((template) => template.id === instanceTemplateFilterId) ?? null
    : null;
  const enabledTemplateIds = useMemo(
    () => new Set(templates.filter((t) => t.is_enabled).map((t) => t.id)),
    [templates],
  );
  const displayedApprovalInstances = useMemo(() => {
    let instances = instanceTemplateFilterId
      ? approvalInstances.filter((instance) => instance.template_id === instanceTemplateFilterId)
      : approvalInstances;
    return instances.filter((instance) => enabledTemplateIds.has(instance.template_id));
  }, [instanceTemplateFilterId, approvalInstances, enabledTemplateIds]);
  const syncExecutionLogs = useMemo(
    () =>
      syncJobs.filter((job) =>
        ["dingtalk_auto_sync", "dingtalk_approval_sync"].includes(job.job_type),
      ),
    [syncJobs],
  );
  const approvalStatusFilters = useMemo(
    () => {
      const filters = new Map<string, { text: string; value: string }>();
      approvalInstances.forEach((item) => {
        if (!item.approval_status) return;
        const meta = approvalStatusMeta(item.approval_status);
        filters.set(meta.label, { text: meta.label, value: meta.label });
      });
      return Array.from(filters.values());
    },
    [approvalInstances],
  );
  const templateNameFilters = useMemo(
    () => tableFilters(approvalInstances.map((item) => templateNameById.get(item.template_id))),
    [approvalInstances, templateNameById],
  );
  const applicantFilters = useMemo(
    () => tableFilters(approvalInstances.map((item) => applicantDisplayName(item))),
    [approvalInstances],
  );
  const departmentFilters = useMemo(
    () => tableFilters(approvalInstances.map((item) => approvalDepartmentName(item))),
    [approvalInstances],
  );

  useEffect(() => {
    return () => {
      if (imagePreview?.url.startsWith("blob:")) URL.revokeObjectURL(imagePreview.url);
    };
  }, [imagePreview]);

  function applyConfig(data: DingTalkConfig) {
    setConfig(data);
    form.setFieldsValue({
      corp_id: data.corp_id ?? undefined,
      app_key: data.app_key ?? undefined,
      admin_user_id: data.admin_user_id ?? undefined,
      drive_union_id: data.drive_union_id ?? undefined,
    });
  }

  function applyAutoSyncSetting(data: DingTalkAutoSyncSetting) {
    setAutoSyncSetting(data);
    autoSyncForm.setFieldsValue({
      enabled: data.enabled,
      scheduled_time: data.scheduled_time,
      sync_departments: data.sync_departments,
      sync_templates: data.sync_templates,
      sync_approvals: data.sync_approvals,
    });
  }

  function markTabLoaded(key: DingTalkTabKey) {
    setLoadedTabKeys((items) => (items.includes(key) ? items : [...items, key]));
  }

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    const results = await Promise.allSettled([
      apiClient.dingtalk.readConfig(),
      apiClient.dingtalk.readAutoSyncSetting(),
      apiClient.dingtalk.listSyncJobs("?page_size=50"),
    ]);
    const [configResult, autoSyncResult, jobResult] = results;
    const errors: string[] = [];

    if (configResult.status === "fulfilled") {
      applyConfig(configResult.value);
    } else {
      errors.push(dingtalkPageErrorMessage(configResult.reason, "无法读取钉钉配置"));
    }

    if (autoSyncResult.status === "fulfilled") {
      applyAutoSyncSetting(autoSyncResult.value);
    } else {
      errors.push(dingtalkPageErrorMessage(autoSyncResult.reason, "无法读取自动同步设置"));
    }

    if (jobResult.status === "fulfilled") {
      setSyncJobs(jobResult.value.items);
    } else {
      errors.push(dingtalkPageErrorMessage(jobResult.reason, "无法读取同步执行日志"));
    }

    if (errors.length) {
      setErrorMessage(Array.from(new Set(errors)).join("；"));
    }
    markTabLoaded("auto-sync");
    setIsLoading(false);
  }

  useEffect(() => {
    loadData();
  }, []);

  async function loadTemplatesTab(force = false) {
    if (!force && loadedTabKeys.includes("templates")) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [configData, templatePage] = await Promise.all([
        apiClient.dingtalk.readConfig(),
        apiClient.dingtalk.listTemplates("?page_size=200"),
      ]);
      applyConfig(configData);
      setTemplates(sortTemplates(templatePage.items));
      markTabLoaded("templates");
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法读取审批模板"));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadDepartmentsTab(force = false) {
    if (!force && loadedTabKeys.includes("departments")) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const preview = await apiClient.dingtalk.previewDepartmentSync();
      setDepartmentPreview(preview);
      markTabLoaded("departments");
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法读取本地部门快照"));
    } finally {
      setIsLoading(false);
    }
  }

  async function loadInstancesTab(force = false) {
    if (!force && loadedTabKeys.includes("instances")) return;
    setIsLoading(true);
    setErrorMessage(null);
    const results = await Promise.allSettled([
      apiClient.dingtalk.readConfig(),
      apiClient.dingtalk.listTemplates("?page_size=200"),
      apiClient.dingtalk.listSyncJobs("?page_size=20"),
      apiClient.dingtalk.listApprovalInstances("?page_size=100"),
    ]);
    const [configResult, templateResult, jobResult, instanceResult] = results;
    const errors: string[] = [];

    if (configResult.status === "fulfilled") {
      applyConfig(configResult.value);
    } else {
      errors.push(dingtalkPageErrorMessage(configResult.reason, "无法读取钉钉配置"));
    }
    if (templateResult.status === "fulfilled") {
      setTemplates(sortTemplates(templateResult.value.items));
      markTabLoaded("templates");
    } else {
      errors.push(dingtalkPageErrorMessage(templateResult.reason, "无法读取审批模板"));
    }
    if (jobResult.status === "fulfilled") {
      setSyncJobs(jobResult.value.items);
    } else {
      errors.push(dingtalkPageErrorMessage(jobResult.reason, "无法读取同步任务"));
    }
    if (instanceResult.status === "fulfilled") {
      setApprovalInstances(instanceResult.value.items);
    } else {
      errors.push(dingtalkPageErrorMessage(instanceResult.reason, "无法读取审批列表"));
    }

    if (errors.length) {
      setErrorMessage(Array.from(new Set(errors)).join("；"));
    } else {
      markTabLoaded("instances");
    }
    setIsLoading(false);
  }

  function handleTabChange(key: string) {
    const nextKey = key as DingTalkTabKey;
    setActiveTabKey(nextKey);
    if (nextKey === "departments") void loadDepartmentsTab();
    if (nextKey === "templates") void loadTemplatesTab();
    if (nextKey === "instances") void loadInstancesTab();
  }

  async function submitConfig(values: DingTalkFormValues) {
    setIsLoading(true);
    try {
      const data = await apiClient.dingtalk.updateConfig(values);
      setConfig(data);
      form.setFieldValue("app_secret", undefined);
      setIsConfigModalOpen(false);
      message.success("钉钉配置已保存");
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法保存钉钉配置"));
    } finally {
      setIsLoading(false);
    }
  }

  async function syncTemplates() {
    setIsLoading(true);
    try {
      const result = await apiClient.dingtalk.syncTemplates();
      await loadTemplatesTab(true);
      message.success(`模板增量同步完成：拉取 ${result.pulled} 个，新增 ${result.created} 个，更新 ${result.updated} 个`);
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法同步模板"));
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
      setErrorMessage(dingtalkPageErrorMessage(error, "无法连接钉钉 OpenAPI"));
    } finally {
      setIsLoading(false);
    }
  }

  async function submitAutoSyncSetting(values: AutoSyncFormValues) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const setting = await apiClient.dingtalk.updateAutoSyncSetting(values);
      setAutoSyncSetting(setting);
      autoSyncForm.setFieldsValue({
        enabled: setting.enabled,
        scheduled_time: setting.scheduled_time,
        sync_departments: setting.sync_departments,
        sync_templates: setting.sync_templates,
        sync_approvals: setting.sync_approvals,
      });
      message.success("自动同步设置已保存");
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法保存自动同步设置"));
    } finally {
      setIsLoading(false);
    }
  }

  async function runAutoSync() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await apiClient.dingtalk.runAutoSync();
      await loadData();
      if (loadedTabKeys.includes("departments")) await loadDepartmentsTab(true);
      if (loadedTabKeys.includes("templates")) await loadTemplatesTab(true);
      if (loadedTabKeys.includes("instances")) await loadInstancesTab(true);
      if (result.job.status === "failed") {
        message.error(result.job.error_message || "自动同步执行失败");
      } else {
        message.success(
          `自动同步完成：审批处理 ${result.job.processed_count} 条，成功 ${result.job.success_count} 条，失败 ${result.job.failed_count} 条`,
        );
      }
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法执行自动同步"));
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
      markTabLoaded("departments");
      message.success("已刷新本地部门预览");
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法读取本地部门快照"));
    } finally {
      setIsLoading(false);
    }
  }

  async function pullDepartments() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await apiClient.dingtalk.pullDepartments("?root_dept_id=1&max_depth=8");
      const preview = await apiClient.dingtalk.previewDepartmentSync();
      setDepartmentPreview(preview);
      markTabLoaded("departments");
      message.success(
        `部门增量同步完成：拉取 ${result.pulled_count} 个，新增 ${result.created_count} 个，更新 ${result.updated_count} 个`,
      );
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法从钉钉拉取部门"));
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
      markTabLoaded("departments");
      message.success(`门店落库完成：新增 ${result.created_count} 个，更新 ${result.updated_count} 个`);
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法同步钉钉门店部门"));
    } finally {
      setIsLoading(false);
    }
  }

  function openSyncModal() {
    syncForm.setFieldsValue({
      template_id: instanceTemplateFilterId ?? selectedTemplate?.id,
      start_at: dayjs().subtract(7, "day"),
      end_at: undefined,
      sync_to_now: true,
      skip_existing: true,
    });
    setIsSyncModalOpen(true);
  }

  function openManualSyncModal() {
    syncForm.setFieldsValue({
      template_id: undefined,
      start_at: dayjs().subtract(7, "day"),
      end_at: undefined,
      sync_to_now: true,
      skip_existing: true,
    });
    setIsSyncModalOpen(true);
  }

  async function changeInstanceTemplateFilter(templateId?: string) {
    setInstanceTemplateFilterId(templateId ?? null);
    setErrorMessage(null);
  }

  async function startApprovalSync(values: ApprovalSyncFormValues) {
    const endAt = values.sync_to_now ? dayjs() : values.end_at;
    if (values.start_at && endAt && endAt.diff(values.start_at, "day", true) > 120) {
      message.error("单次审批同步时间范围不能超过 120 天");
      return;
    }
    setIsLoading(true);
    try {
      const job = await apiClient.dingtalk.startApprovalSync({
        template_id: values.template_id,
        started_by: "admin",
        start_at: values.start_at?.toISOString(),
        end_at: values.sync_to_now ? undefined : values.end_at?.toISOString(),
        skip_existing: values.skip_existing ?? true,
      });
      setIsSyncModalOpen(false);
      await loadInstancesTab(true);
      if (job.next_cursor) {
        message.warning("审批列表已同步一部分，可在同步任务中续跑");
      } else if (job.status === "failed") {
        message.error(job.error_message || "审批列表同步失败");
      } else {
        message.success("审批列表增量同步完成");
      }
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法同步审批实例"));
    } finally {
      setIsLoading(false);
    }
  }

  async function resumeApprovalSync(job: SyncJob) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const nextJob = await apiClient.dingtalk.resumeApprovalSync(job.id, {
        started_by: "admin",
        page_size: 20,
        max_pages: 20,
        skip_existing: true,
      });
      await loadInstancesTab(true);
      if (nextJob.next_cursor) {
        message.warning("审批同步续跑已处理一部分，可继续续跑");
      } else if (nextJob.status === "failed") {
        message.error(nextJob.error_message || "审批同步续跑失败");
      } else {
        message.success("审批同步续跑完成");
      }
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法续跑审批同步"));
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
      await loadTemplatesTab(true);
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法新增模板"));
    } finally {
      setIsLoading(false);
    }
  }

  async function updateTemplateEnabled(template: ApprovalTemplate, isEnabled: boolean) {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const updated = await apiClient.dingtalk.updateTemplate(template.id, { is_enabled: isEnabled });
      setTemplates((items) => sortTemplates(items.map((item) => (item.id === updated.id ? updated : item))));
      if (!isEnabled && instanceTemplateFilterId === template.id) {
        await changeInstanceTemplateFilter(undefined);
      }
      message.success(isEnabled ? "模板已启用，将参与同步和对账" : "模板已停用，将不参与同步和对账");
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法更新模板启用状态"));
    } finally {
      setIsLoading(false);
    }
  }

  function updateTemplateMappingStatus(templateId: string, mappingStatus: ApprovalTemplate["mapping_status"]) {
    setTemplates((items) =>
      sortTemplates(items.map((item) => (item.id === templateId ? { ...item, mapping_status: mappingStatus } : item))),
    );
    setSelectedTemplate((current) => (current?.id === templateId ? { ...current, mapping_status: mappingStatus } : current));
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
      updateTemplateMappingStatus(template.id, data.some(isBusinessMapping) ? "mapped" : "unmapped");
      return data;
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法加载解析规则"));
      return [];
    } finally {
      setIsLoading(false);
    }
  }

  async function openMappingDrawer(template: ApprovalTemplate) {
    setIsMappingDrawerOpen(true);
    await loadMappings(template);
  }

  async function syncTemplateSample() {
    if (!selectedTemplate) return;
    const template = selectedTemplate;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await apiClient.dingtalk.pullTemplateSampleApproval(template.id);
      setFieldCandidates(result.field_candidates);
      if (result.instance) {
        setApprovalInstances((items) => {
          const index = items.findIndex((item) => item.id === result.instance?.id);
          if (index < 0) return [result.instance!, ...items];
          return items.map((item) => (item.id === result.instance?.id ? result.instance! : item));
        });
      }
      if (result.pulled_count > 0) {
        message.success("已拉取一条真实审批样例，钉钉字段下拉已刷新");
      } else {
        message.warning("当前模板最近 30 天没有审批样例");
      }
    } catch (error) {
      setErrorMessage(apiErrorMessage(error, "无法拉取审批样例"));
    } finally {
      setIsLoading(false);
    }
  }

  async function saveBusinessFieldMapping(field: BusinessFieldOption, fieldKey?: string) {
    if (!selectedTemplate) return;
    const existing = businessMappings.find((item) => item.standard_field === field.value);
    if (!fieldKey) {
      if (!existing) return;
      await deleteMapping(existing);
      return;
    }
    const candidate = fieldCandidates.find((item) => candidateKey(item) === fieldKey || item.source_field_name === fieldKey);
    if (!candidate) return;
    const payload: TemplateFieldMappingCreate = {
      standard_field: field.value,
      display_label: field.label,
      source_field_name: candidate.source_field_name,
      source_field_id: candidate.source_field_id ?? undefined,
      source_path: candidate.source_path ?? undefined,
      field_type: candidate.field_type ?? undefined,
      show_in_list: false,
      show_in_detail: false,
      is_required: Boolean(field.required),
      sort_order: existing?.sort_order ?? businessMappings.length,
    };
    setIsLoading(true);
    setErrorMessage(null);
    try {
      if (existing) {
        await apiClient.dingtalk.updateMapping(selectedTemplate.id, existing.id, payload);
      } else {
        await apiClient.dingtalk.upsertMapping(selectedTemplate.id, payload);
      }
      await loadMappings(selectedTemplate);
      updateTemplateMappingStatus(selectedTemplate.id, "mapped");
      message.success(`${field.label}已更新`);
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法保存解析规则"));
    } finally {
      setIsLoading(false);
    }
  }

  async function deleteMapping(mapping: TemplateFieldMapping) {
    if (!selectedTemplate) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.dingtalk.deleteMapping(selectedTemplate.id, mapping.id);
      const nextMappings = await loadMappings(selectedTemplate);
      updateTemplateMappingStatus(selectedTemplate.id, nextMappings.some(isBusinessMapping) ? "mapped" : "unmapped");
      message.success("解析规则已删除");
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法删除解析规则"));
    } finally {
      setIsLoading(false);
    }
  }

  async function openInstanceDetail(instance: ApprovalInstance) {
    setSelectedInstance(instance);
    setSelectedInstanceAttachments([]);
    try {
      const data = await apiClient.attachments.list(
        `?resource_type=approval_instance&resource_id=${encodeURIComponent(instance.id)}&page_size=50`,
      );
      setSelectedInstanceAttachments(data.items);
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法读取审批详情"));
    }
  }

  async function useSelectedInstanceAsFieldSample(instance: ApprovalInstance) {
    const template = templates.find((item) => item.id === instance.template_id);
    if (!template) {
      setErrorMessage("未找到审批实例对应的模板");
      return;
    }
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const result = await apiClient.dingtalk.useApprovalInstanceAsFieldCandidateSample(template.id, {
        approval_instance_id: instance.id,
      });
      setSelectedTemplate(template);
      setMappings(await apiClient.dingtalk.listMappings(template.id));
      setFieldCandidates(result.field_candidates);
      setSelectedInstance(null);
      setIsMappingDrawerOpen(true);
      message.success("已用当前审批单生成解析字段候选");
    } catch (error) {
      setErrorMessage(apiErrorMessage(error, "无法设置字段候选样例"));
    } finally {
      setIsLoading(false);
    }
  }

  async function ensureAttachmentStored(attachment: Attachment): Promise<Attachment> {
    if (attachment.download_status === "stored") return attachment;
    const stored = await apiClient.attachments.downloadDingtalk(attachment.id);
    setSelectedInstanceAttachments((items) => items.map((item) => (item.id === stored.id ? stored : item)));
    return stored;
  }

  async function openAttachment(attachment: Attachment, mode: "preview" | "download") {
    try {
      const stored = await ensureAttachmentStored(attachment);
      const blob = await apiClient.attachments.download(stored.id);
      const url = URL.createObjectURL(blob);
      if (mode === "download") {
        const link = document.createElement("a");
        link.href = url;
        link.download = stored.file_name;
        link.click();
        URL.revokeObjectURL(url);
        return;
      }
      if (isImageAttachment(stored, blob)) {
        setImagePreview((current) => {
          if (current?.url.startsWith("blob:")) URL.revokeObjectURL(current.url);
          return { title: stored.file_name || "图片预览", url };
        });
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法打开附件"));
    }
  }

  async function openAttachmentAccessUrl(attachment: Attachment) {
    try {
      const data = await apiClient.attachments.accessUrl(attachment.id);
      if (isImageAttachment(attachment) || isImageUrl(data.url)) {
        setImagePreview((current) => {
          if (current?.url && current.url.startsWith("blob:")) URL.revokeObjectURL(current.url);
          return { title: data.file_name || attachment.file_name || "图片预览", url: data.url };
        });
        return;
      }
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setErrorMessage(dingtalkPageErrorMessage(error, "无法获取钉钉附件链接"));
    }
  }

  const templateColumns: EnterpriseTableColumn<ApprovalTemplate>[] = [
    {
      key: "name",
      title: "模板名称",
      dataIndex: "name",
      render: (value, record) => (
        <Space size={8}>
          <span>{value}</span>
          {isSeedTemplate(record) ? <Tag>演示</Tag> : null}
        </Space>
      ),
    },
    { key: "process_code", title: "Process Code", dataIndex: "process_code" },
    {
      key: "mapping_status",
      title: "解析状态",
      dataIndex: "mapping_status",
      render: (value) => (value === "mapped" ? <Tag color="green">已配置</Tag> : <Tag color="gold">未配置</Tag>),
    },
    {
      key: "is_enabled",
      title: "启用",
      dataIndex: "is_enabled",
      width: 110,
      render: (value, record) => (
        <Switch
          checked={value}
          checkedChildren="启用"
          unCheckedChildren="停用"
          loading={isLoading}
          onChange={(checked) => updateTemplateEnabled(record, checked)}
        />
      ),
    },
    {
      key: "last_sync_at",
      title: "上次同步",
      dataIndex: "last_sync_at",
      render: (value) => value?.replace("T", " ").slice(0, 16) || "-",
    },
    {
      key: "actions",
      title: "操作",
      fixed: "right",
      width: 140,
      className: "table-action-column",
      render: (_, record) => (
        <Space>
          <Button type="link" onClick={() => openMappingDrawer(record)}>
            解析规则
          </Button>
        </Space>
      ),
    },
  ];

  const businessMappingColumns: ColumnsType<BusinessFieldOption> = [
    {
      title: "系统字段",
      dataIndex: "label",
      width: 190,
      render: (value, record) => (
        <Space direction="vertical" size={0}>
          <Space size={6}>
            <Typography.Text strong>{value}</Typography.Text>
            {record.required ? <Tag color="red">必配</Tag> : null}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {record.description}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "对应钉钉字段",
      width: 320,
      render: (_, record) => {
        const mapping = businessMappings.find((item) => item.standard_field === record.value);
        const currentValue = mapping ? mapping.source_field_id || mapping.source_field_name : undefined;
        const options = fieldCandidates.map((candidate) => ({
          label: renderFieldCandidateOption(candidate),
          fieldName: candidate.source_field_name,
          searchText: fieldCandidateSearchText(candidate),
          value: candidateKey(candidate),
        }));
        if (mapping && currentValue && !options.some((item) => item.value === currentValue)) {
          options.unshift({
            label: renderFieldCandidateOption({
              source_field_id: mapping.source_field_id,
              source_field_name: mapping.source_field_name,
              source_path: mapping.source_path,
              field_type: mapping.field_type,
              sample_value: selectedTemplateSampleInstance ? mappedDisplayValue(selectedTemplateSampleInstance, mapping) : undefined,
            }),
            fieldName: mapping.source_field_name,
            searchText: [mapping.source_field_name, mapping.source_field_id, mapping.field_type].filter(Boolean).join(" "),
            value: currentValue,
          });
        }
        return (
          <Select
            allowClear={!record.required}
            showSearch
            value={currentValue}
            placeholder={fieldCandidates.length ? "选择钉钉字段" : "先刷新可选字段"}
            optionLabelProp="fieldName"
            filterOption={(input, option) =>
              String(option?.searchText ?? "").toLowerCase().includes(input.toLowerCase())
            }
            disabled={!fieldCandidates.length && !mapping}
            options={options}
            onChange={(value) => saveBusinessFieldMapping(record, value)}
            style={{ width: "100%" }}
          />
        );
      },
    },
    {
      title: "当前样例",
      render: (_, record) => {
        const mapping = businessMappings.find((item) => item.standard_field === record.value);
        if (!mapping || !selectedTemplateSampleInstance) return "-";
        return renderDingTalkValue(mappedDisplayValue(selectedTemplateSampleInstance, mapping));
      },
    },
    {
      title: "状态",
      width: 110,
      render: (_, record) => {
        const mapping = businessMappings.find((item) => item.standard_field === record.value);
        if (mapping) return <Tag color="green">已配置</Tag>;
        return <Tag color={record.required ? "red" : "default"}>{record.required ? "必填缺失" : "未配置"}</Tag>;
      },
    },
  ];

  const departmentColumns: EnterpriseTableColumn<DepartmentTreeNode>[] = [
    {
      key: "name",
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
    { key: "dept_id", title: "部门 ID", dataIndex: "dept_id", width: 150 },
    {
      key: "path",
      title: "层级路径",
      dataIndex: "path",
      render: (value) => <span style={{ color: "#64748b" }}>{value}</span>,
    },
    {
      key: "landing_status",
      title: "落地状态",
      dataIndex: "is_store_candidate",
      width: 120,
      render: (value, record) => {
        if (!value) return <Tag>部门</Tag>;
        if (record.store_name) return <Tag color="blue">已存在</Tag>;
        return <Tag color="gold">将新增</Tag>;
      },
    },
    { key: "store_name", title: "本地门店", dataIndex: "store_name", width: 180, render: (value) => value || "-" },
  ];

  const hasResumableSyncJob = syncJobs.some((job) => Boolean(job.next_cursor));
  const syncExecutionLogColumns: EnterpriseTableColumn<SyncJob>[] = [
    { key: "job_type", title: "执行类型", dataIndex: "job_type", width: 140, render: (value) => syncJobTypeLabel(value) },
    {
      key: "status",
      title: "状态",
      dataIndex: "status",
      width: 90,
      render: (value: SyncJob["status"], record) => {
        if (record.next_cursor) return <Tag color="blue">可续跑</Tag>;
        if (value === "succeeded") return <Tag color="green">成功</Tag>;
        if (value === "failed") return <Tag color="red">失败</Tag>;
        if (value === "running") return <Tag color="blue">运行中</Tag>;
        return <Tag>等待中</Tag>;
      },
    },
    {
      key: "time_window",
      title: "审批日期范围",
      width: 280,
      render: (_, record) =>
        record.request_start_at || record.request_end_at
          ? `${formatBeijingDateTime(record.request_start_at)} 至 ${formatBeijingDateTime(record.request_end_at)}`
          : "按自动增量窗口",
    },
    { key: "processed_count", title: "处理", dataIndex: "processed_count", width: 72 },
    { key: "success_count", title: "成功", dataIndex: "success_count", width: 72 },
    { key: "failed_count", title: "失败", dataIndex: "failed_count", width: 72 },
    {
      key: "error_message",
      title: "结果",
      width: 260,
      render: (_, record) =>
        record.error_message ? (
          <Typography.Text type="danger" ellipsis={{ tooltip: record.error_message }}>
            {record.error_message}
          </Typography.Text>
        ) : (
          renderSyncJobSummary(record)
        ),
    },
    { key: "started_by", title: "发起人", dataIndex: "started_by", width: 110, render: (value) => value || "-" },
    {
      key: "started_at",
      title: "开始时间",
      dataIndex: "started_at",
      width: 160,
      render: (value) => formatBeijingDateTime(value),
    },
    {
      key: "finished_at",
      title: "结束时间",
      dataIndex: "finished_at",
      width: 160,
      render: (value) => formatBeijingDateTime(value),
    },
  ];
  const jobColumns: EnterpriseTableColumn<SyncJob>[] = [
    { key: "job_type", title: "任务类型", dataIndex: "job_type", width: 140, render: (value) => syncJobTypeLabel(value) },
    {
      key: "status",
      title: "状态",
      dataIndex: "status",
      width: 90,
      render: (value: SyncJob["status"], record) => {
        if (record.next_cursor) return <Tag color="blue">可续跑</Tag>;
        if (value === "succeeded") return <Tag color="green">成功</Tag>;
        if (value === "failed") return <Tag color="red">失败</Tag>;
        if (value === "running") return <Tag color="blue">运行中</Tag>;
        return <Tag>等待中</Tag>;
      },
    },
    { key: "summary", title: "阶段摘要", width: 320, render: (_, record) => renderSyncJobSummary(record) },
    { key: "processed_count", title: "处理", dataIndex: "processed_count", width: 70 },
    { key: "success_count", title: "成功", dataIndex: "success_count", width: 70 },
    { key: "failed_count", title: "失败", dataIndex: "failed_count", width: 70 },
    { key: "request_start_at", title: "开始窗口", dataIndex: "request_start_at", width: 140, render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    { key: "request_end_at", title: "结束窗口", dataIndex: "request_end_at", width: 140, render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    { key: "next_cursor", title: "游标", dataIndex: "next_cursor", width: 120, ellipsis: true, render: (value) => value || "-" },
    {
      key: "error_message",
      title: "错误",
      dataIndex: "error_message",
      width: 220,
      render: (value) => (value ? <Typography.Text type="danger" ellipsis={{ tooltip: value }}>{value}</Typography.Text> : "-"),
    },
    { key: "started_by", title: "发起人", dataIndex: "started_by", width: 110, render: (value) => value || "-" },
    { key: "finished_at", title: "完成时间", dataIndex: "finished_at", width: 140, render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    ...(hasResumableSyncJob
      ? [
          {
            key: "actions",
            title: "操作",
            fixed: "right" as const,
            width: 90,
            className: "table-action-column",
            render: (_: unknown, record: SyncJob) =>
              record.next_cursor ? (
                <Button type="link" onClick={() => resumeApprovalSync(record)}>
                  续跑
                </Button>
              ) : null,
          },
        ]
      : []),
  ];

  const instanceColumns: EnterpriseTableColumn<ApprovalInstance>[] = [
    {
      key: "approval_no",
      title: "审批编号",
      dataIndex: "approval_no",
      width: 170,
      ellipsis: true,
      render: (value) =>
        value ? (
          <Typography.Text code ellipsis={{ tooltip: value }} className="approval-no-cell">
            {value}
          </Typography.Text>
        ) : (
          "-"
        ),
    },
    {
      key: "template_name",
      title: "模板名称",
      width: 180,
      filters: templateNameFilters,
      onFilter: (value, record) => templateNameById.get(record.template_id) === value,
      render: (_, record) => templateNameById.get(record.template_id) || "-",
    },
    {
      key: "applicant_name",
      title: "申请人",
      dataIndex: "applicant_name",
      width: 150,
      filters: applicantFilters,
      onFilter: (value, record) => applicantDisplayName(record) === value,
      render: (_, record) => (
        <Space direction="vertical" size={0}>
          <Typography.Text>{applicantDisplayName(record)}</Typography.Text>
          {record.applicant_user_id ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {record.applicant_user_id}
            </Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      key: "department_name",
      title: "部门",
      width: 220,
      filters: departmentFilters,
      onFilter: (value, record) => approvalDepartmentName(record) === value,
      render: (_, record) => approvalDepartmentName(record),
    },
    {
      key: "approval_status",
      title: "状态",
      dataIndex: "approval_status",
      filters: approvalStatusFilters,
      onFilter: (value, record) => approvalStatusMeta(record.approval_status).label === value,
      render: (value) => {
        const meta = approvalStatusMeta(value);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    { key: "submit_at", title: "提交时间", dataIndex: "submit_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    { key: "approved_at", title: "通过时间", dataIndex: "approved_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    {
      key: "actions",
      title: "操作",
      fixed: "right",
      width: 90,
      className: "table-action-column",
      render: (_, record) => (
        <Button type="link" onClick={() => openInstanceDetail(record)}>
          详情
        </Button>
      ),
    },
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

      <Tabs
        className="sync-tabs"
        activeKey={activeTabKey}
        onChange={handleTabChange}
        items={[
          {
            key: "auto-sync",
            label: "自动同步",
            children: (
              <Space direction="vertical" size={16} className="full-width">
                <Card
                  title="自动同步任务"
                  extra={
                    <Space>
                      <Tag color={autoSyncSetting?.enabled ? "green" : "default"}>
                        {autoSyncSetting?.enabled ? "已启用" : "未启用"}
                      </Tag>
                      <Button onClick={runAutoSync} loading={isLoading}>
                        立即执行自动任务
                      </Button>
                      <Button onClick={openManualSyncModal} loading={isLoading}>
                        手动同步审批
                      </Button>
                      <Button type="primary" onClick={() => autoSyncForm.submit()} loading={isLoading}>
                        保存设置
                      </Button>
                    </Space>
                  }
                >
                  <Space direction="vertical" size={16} className="full-width">
                    <Space wrap>
                      <Tag color="cyan">
                        上次执行 {autoSyncSetting?.last_run_at ? formatBeijingDateTime(autoSyncSetting.last_run_at) : "尚未执行"}
                      </Tag>
                      <Tag color={autoSyncSetting?.last_status === "failed" ? "red" : "green"}>
                        上次状态 {autoSyncSetting?.last_status ?? "-"}
                      </Tag>
                      <Tag>
                        下次计划 {formatBeijingDateTime(autoSyncSetting?.next_run_at)}
                      </Tag>
                      {autoSyncSetting?.last_error ? <Tag color="red">{autoSyncSetting.last_error}</Tag> : null}
                    </Space>

                    <Alert
                      type="info"
                      showIcon
                      message="计划任务和“立即执行自动任务”都会按下方开关执行部门、门店、模板和审批同步；首次审批自动同步仅覆盖最近 120 天，历史数据请用“手动同步审批”分段补拉。"
                    />

                    <Form
                      form={autoSyncForm}
                      layout="vertical"
                      onFinish={submitAutoSyncSetting}
                      initialValues={{
                        enabled: false,
                        scheduled_time: "02:15",
                        sync_departments: true,
                        sync_templates: true,
                        sync_approvals: true,
                      }}
                    >
                      <Row gutter={[16, 0]}>
                        <Col xs={24} md={8}>
                          <Form.Item name="enabled" label="启用计划任务" valuePropName="checked">
                            <Switch />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                          <Form.Item name="scheduled_time" label="每天开始时间（北京时间）" rules={[{ required: true }]}>
                            <Select options={AUTO_SYNC_TIME_OPTIONS} />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                          <Form.Item name="sync_departments" label="同步部门和门店" valuePropName="checked">
                            <Switch />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                          <Form.Item name="sync_templates" label="同步审批模板" valuePropName="checked">
                            <Switch />
                          </Form.Item>
                        </Col>
                        <Col xs={24} md={8}>
                          <Form.Item name="sync_approvals" label="同步审批列表" valuePropName="checked">
                            <Switch />
                          </Form.Item>
                        </Col>
                      </Row>
                    </Form>
                  </Space>
                </Card>
                <Card title="执行日志">
                  <EnterpriseTable<SyncJob>
                    rowKey="id"
                    loading={isLoading}
                    columns={syncExecutionLogColumns}
                    dataSource={syncExecutionLogs}
                    pagination={{ defaultPageSize: 8, showSizeChanger: true }}
                    showDensityToggle
                    showColumnSettings
                  />
                </Card>
              </Space>
            ),
          },
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
                    <EnterpriseTable<DepartmentTreeNode>
                      rowKey="dept_id"
                      loading={isLoading}
                      columns={departmentColumns}
                      dataSource={departmentTree}
                      pagination={false}
                      showDensityToggle
                      fixedColumns={{ left: ["name"] }}
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
                  <Tag color="green">已配置解析 {templates.filter((item) => item.mapping_status === "mapped").length}</Tag>
                  <Tag color="gold">未配置解析 {templates.filter((item) => item.mapping_status !== "mapped").length}</Tag>
                  <Tag color="cyan">
                    上次同步 {config?.last_template_sync_at ? config.last_template_sync_at.replace("T", " ").slice(0, 16) : "尚未同步"}
                  </Tag>
                </Space>
                <EnterpriseTable<ApprovalTemplate>
                  rowKey="id"
                  loading={isLoading}
                  columns={templateColumns}
                  dataSource={templates}
                  pagination={{ defaultPageSize: 12, showSizeChanger: true }}
                  showDensityToggle
                  showColumnSettings
                  fixedColumns={{ left: ["name"], right: ["actions"] }}
                />
              </Card>
            ),
          },
          {
            key: "instances",
            label: "审批列表",
            children: (
              <Space direction="vertical" size={16} className="full-width">
                <Card
                  title={instanceTemplateFilter ? `${instanceTemplateFilter.name} 审批列表` : "审批实例快照"}
                  extra={
                    <Space>
                      <Select
                        allowClear
                        showSearch
                        placeholder="按审批模板筛选"
                        value={instanceTemplateFilterId ?? undefined}
                        style={{ width: 260 }}
                        optionFilterProp="label"
                        onChange={changeInstanceTemplateFilter}
                        options={templates.map((template) => ({
                          label: template.name,
                          value: template.id,
                          disabled: !template.is_enabled,
                        }))}
                      />
                      <Button type="primary" onClick={openSyncModal} loading={isLoading}>
                        增量同步审批
                      </Button>
                    </Space>
                  }
                >
                  <Space wrap className="dashboard-alert">
                    {instanceTemplateFilter ? <Tag color="blue">当前模板 {instanceTemplateFilter.name}</Tag> : <Tag>全部模板</Tag>}
                    <Tag>本地实例 {displayedApprovalInstances.length}</Tag>
                    <Tag color="green">
                      已通过{" "}
                      {
                        displayedApprovalInstances.filter((item) =>
                          ["APPROVED", "AGREE", "COMPLETED"].includes(item.approval_status.toUpperCase()),
                        ).length
                      }
                    </Tag>
                    <Tag color="blue">同步任务 {syncJobs.length}</Tag>
                    <Tag color="cyan">
                      上次同步 {config?.last_instance_sync_at ? config.last_instance_sync_at.replace("T", " ").slice(0, 16) : "尚未同步"}
                    </Tag>
                  </Space>
                  <EnterpriseTable<ApprovalInstance>
                    rowKey="id"
                    loading={isLoading}
                    columns={instanceColumns}
                    dataSource={displayedApprovalInstances}
                    pagination={{ defaultPageSize: 8, showSizeChanger: true }}
                    showDensityToggle
                    showColumnSettings
                    fixedColumns={{ left: ["approval_no"], right: ["actions"] }}
                  />
                </Card>
                <Card title="同步任务">
                  <EnterpriseTable<SyncJob>
                    rowKey="id"
                    loading={isLoading}
                    columns={jobColumns}
                    dataSource={syncJobs}
                    pagination={{ defaultPageSize: 5, showSizeChanger: true }}
                    showDensityToggle
                    showColumnSettings
                    fixedColumns={hasResumableSyncJob ? { right: ["actions"] } : undefined}
                  />
                </Card>
              </Space>
            ),
          },
        ]}
      />

      <Drawer
        title={selectedTemplate ? `${selectedTemplate.name} 解析规则` : "模板解析规则"}
        open={isMappingDrawerOpen}
        onClose={() => setIsMappingDrawerOpen(false)}
        width={1040}
        extra={
          <Space>
            <Button disabled={!selectedTemplate} onClick={syncTemplateSample} loading={isLoading}>
              刷新可选字段
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type="info"
            showIcon
            message="解析规则只用于把钉钉审批转换为系统审批支出明细。"
            description="审批列表和审批详情始终展示钉钉原始同步数据；金额、门店、业务日期、明细表格和凭证字段会影响后续门店套帐、银行流水对账和报表统计。"
          />
          <Card
            size="small"
            title="业务解析字段"
            extra={
              <Space size={8}>
                <Tag color={fieldCandidates.length ? "blue" : "gold"}>可选字段 {fieldCandidates.length}</Tag>
                {selectedTemplateSampleInstance ? <Tag color="green">已有样例</Tag> : <Tag>无样例</Tag>}
              </Space>
            }
          >
            {!fieldCandidates.length ? (
              <Alert
                className="dashboard-alert"
                type="warning"
                showIcon
                message="还没有可选择的钉钉字段"
                description="点击右上角“刷新可选字段”，系统会从这个模板拉取一条真实审批作为字段来源。"
              />
            ) : null}
            <Table
              size="small"
              rowKey="value"
              loading={isLoading}
              columns={businessMappingColumns}
              dataSource={BUSINESS_FIELD_OPTIONS}
              pagination={false}
            />
          </Card>
        </Space>
      </Drawer>

      <Drawer
        title={selectedInstance ? approvalTitle(selectedInstance) || selectedInstance.approval_no || "审批实例详情" : "审批实例详情"}
        open={Boolean(selectedInstance)}
        onClose={() => setSelectedInstance(null)}
        extra={
          selectedInstance ? (
            <Space>
              <Button onClick={() => setSelectedInstance(null)}>关闭</Button>
              <Button loading={isLoading} onClick={() => useSelectedInstanceAsFieldSample(selectedInstance)}>
                用这条作为解析样例
              </Button>
            </Space>
          ) : null
        }
        width={1080}
        className="dingtalk-approval-detail"
      >
        {selectedInstance ? (
          <Space direction="vertical" size={16} className="full-width">
            <div className="dingtalk-approval-hero">
              <div className="dingtalk-approval-hero__main">
                <Space wrap size={8}>
                  <Tag color={approvalStatusMeta(selectedInstance.approval_status).color}>
                    {approvalStatusMeta(selectedInstance.approval_status).label}
                  </Tag>
                  <Tag>{templateNameById.get(selectedInstance.template_id) || "未知模板"}</Tag>
                </Space>
                <Typography.Title level={4}>
                  {approvalTitle(selectedInstance) || selectedInstance.approval_no || selectedInstance.dingtalk_instance_id}
                </Typography.Title>
                <Space wrap className="dingtalk-approval-hero__meta">
                  <span>申请人：{applicantDisplayName(selectedInstance)}</span>
                  <span>部门：{approvalDepartmentName(selectedInstance)}</span>
                  <span>提交：{formatBeijingDateTime(selectedInstance.submit_at)}</span>
                  <span>完成：{formatBeijingDateTime(selectedInstance.approved_at)}</span>
                </Space>
              </div>
            </div>

            <div className="dingtalk-approval-layout">
              <div className="dingtalk-approval-layout__main">
                <Card size="small" title="审批详情">
                  <div className="dingtalk-approval-field-list">
                    {selectedInstanceBasicFields.map((field, index) => (
                      <div className="dingtalk-approval-field" key={`${fieldLabel(field)}-${index}`}>
                        <div className="dingtalk-approval-field__label">{fieldLabel(field)}</div>
                        <div className="dingtalk-approval-field__value">{renderDingTalkValue(fieldValue(field))}</div>
                      </div>
                    ))}
                  </div>
                </Card>

                {selectedInstanceTables.map((table) => {
                  const keys = Array.from(new Set(table.rows.flatMap((row) => Object.keys(row))));
                  return (
                    <Card size="small" title={table.name} key={table.name}>
                      <Table
                        size="small"
                        rowKey={(_, index) => `${table.name}-${index}`}
                        pagination={false}
                        dataSource={table.rows}
                        columns={keys.map((key) => ({
                          title: key,
                          dataIndex: key,
                          render: renderDingTalkValue,
                        }))}
                      />
                    </Card>
                  );
                })}

                <Card size="small" title="报销凭证与附件">
                  {selectedInstanceAttachments.length ? (
                    <div className="dingtalk-attachment-list">
                      {selectedInstanceAttachments.map((attachment) => {
                        const sourceUrl = externalAttachmentUrl(attachment);
                        const statusColor = attachment.download_status === "stored" ? "green" : attachment.download_status === "failed" ? "red" : "gold";
                        const statusLabel = attachment.download_status === "stored" ? "已下载" : attachment.download_status === "failed" ? "失败" : "待下载";
                        return (
                          <div className="dingtalk-attachment-item" key={attachment.id}>
                            <div className={`dingtalk-attachment-item__icon${isImageAttachment(attachment) ? " is-image" : ""}`}>
                              {isImageAttachment(attachment) ? "图" : "文"}
                            </div>
                            <div className="dingtalk-attachment-item__main">
                              <Typography.Text strong ellipsis={{ tooltip: attachment.file_name }}>
                                {attachment.file_name || "钉钉凭证"}
                              </Typography.Text>
                              <Space size={6} wrap>
                                <Tag color={statusColor}>{statusLabel}</Tag>
                                {attachment.content_type ? <Typography.Text type="secondary">{attachment.content_type}</Typography.Text> : null}
                              </Space>
                            </div>
                            <Space size={6}>
                              {sourceUrl ? (
                                <Button size="small" href={sourceUrl} target="_blank" rel="noreferrer">
                                  源链接
                                </Button>
                              ) : null}
                              <Button size="small" onClick={() => openAttachmentAccessUrl(attachment)}>
                                {isImageAttachment(attachment) ? "预览" : "打开"}
                              </Button>
                              <Button size="small" onClick={() => openAttachment(attachment, "download")}>
                                下载
                              </Button>
                            </Space>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <Typography.Text type="secondary">暂无附件</Typography.Text>
                  )}
                </Card>

                <Card size="small" title="原始数据">
                  <pre className="json-block">
                    {selectedInstance.raw_payload
                      ? JSON.stringify(selectedInstancePayload ?? selectedInstance.raw_payload, null, 2)
                      : "-"}
                  </pre>
                </Card>
              </div>

              <div className="dingtalk-approval-layout__side">
                <Card size="small" title="流程">
                  {selectedInstanceOperations.length ? (
                    <div className="dingtalk-flow-list">
                      {selectedInstanceOperations.map((record, index) => (
                        <div className="dingtalk-flow-item" key={`operation-${index}`}>
                          <div className="dingtalk-flow-item__dot">{index + 1}</div>
                          <div className="dingtalk-flow-item__body">
                            <div className="dingtalk-flow-item__head">
                              <Typography.Text strong>{operationTitle(record)}</Typography.Text>
                              <Typography.Text type="secondary">{operationTime(record)}</Typography.Text>
                            </div>
                            <Typography.Text>{operationActor(record)}</Typography.Text>
                            <Space size={6} wrap>
                              <Tag color="blue">{operationAction(record)}</Tag>
                              {record.remark || record.comment || record.reason ? (
                                <Typography.Text type="secondary">
                                  {String(record.remark ?? record.comment ?? record.reason)}
                                </Typography.Text>
                              ) : null}
                            </Space>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Typography.Text type="secondary">当前同步数据暂无流程记录</Typography.Text>
                  )}
                </Card>

                <Card size="small" title="基础信息">
                  <Descriptions size="small" column={1}>
                    <Descriptions.Item label="审批编号">{selectedInstance.approval_no || "-"}</Descriptions.Item>
                    <Descriptions.Item label="实例 ID">{selectedInstance.dingtalk_instance_id}</Descriptions.Item>
                    <Descriptions.Item label="申请人 User ID">{selectedInstance.applicant_user_id || "-"}</Descriptions.Item>
                  </Descriptions>
                </Card>
              </div>
            </div>
          </Space>
        ) : null}
      </Drawer>
      <Modal
        title={imagePreview?.title || "图片预览"}
        open={Boolean(imagePreview)}
        footer={null}
        width={880}
        onCancel={() =>
          setImagePreview((current) => {
            if (current?.url.startsWith("blob:")) URL.revokeObjectURL(current.url);
            return null;
          })
        }
      >
        {imagePreview ? <Image src={imagePreview.url} alt={imagePreview.title} width="100%" /> : null}
      </Modal>
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
        title="手动同步审批实例"
        open={isSyncModalOpen}
        onCancel={() => setIsSyncModalOpen(false)}
        onOk={() => syncForm.submit()}
        confirmLoading={isLoading}
      >
        <Form
          form={syncForm}
          layout="vertical"
          onFinish={startApprovalSync}
          initialValues={{ sync_to_now: true, skip_existing: true }}
        >
          <Form.Item name="template_id" label="审批模板">
            <Select
              allowClear
              placeholder="全部已启用模板"
              options={templates
                .filter((template) => template.is_enabled)
                .map((template) => ({
                label: template.name,
                value: template.id,
              }))}
            />
          </Form.Item>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="start_at" label="开始时间" rules={[{ required: true, message: "请选择开始时间" }]}>
                <DatePicker
                  showTime
                  className="full-width"
                  disabledDate={(current) => current.isBefore(dayjs().subtract(365, "day").startOf("day")) || current.isAfter(dayjs().endOf("day"))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item noStyle shouldUpdate={(previous, current) => previous.sync_to_now !== current.sync_to_now}>
                {({ getFieldValue }) =>
                  getFieldValue("sync_to_now") ? null : (
                    <Form.Item name="end_at" label="结束时间" rules={[{ required: true, message: "请选择结束时间" }]}>
                      <DatePicker
                        showTime
                        className="full-width"
                        disabledDate={(current) => {
                          const startAt = syncForm.getFieldValue("start_at") as dayjs.Dayjs | undefined;
                          return (
                            current.isAfter(dayjs().endOf("day")) ||
                            (startAt ? current.isBefore(startAt.startOf("day")) || current.isAfter(startAt.add(120, "day").endOf("day")) : false)
                          );
                        }}
                      />
                    </Form.Item>
                  )
                }
              </Form.Item>
            </Col>
          </Row>
          <Form.Item
            name="sync_to_now"
            label="结束时间"
            valuePropName="checked"
            extra="开启后不需要设置结束时间，将同步至实际执行时刻。"
          >
            <Switch checkedChildren="同步至当前时间" unCheckedChildren="指定结束时间" />
          </Form.Item>
          <Typography.Text type="secondary">
            钉钉仅支持同步最近 365 天内的数据，单次日期范围最多 120 天。
          </Typography.Text>
          <Form.Item name="skip_existing" label="跳过本地已有审批" initialValue={true}>
            <Switch />
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
    </AppShell>
  );
}
