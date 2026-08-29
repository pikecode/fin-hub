"use client";

import {
  Alert,
  Button,
  Card,
  DatePicker,
  Descriptions,
  Drawer,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
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
  Attachment,
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

interface MappingFormValues extends TemplateFieldMappingCreate {
  selected_field_key?: string;
}

type DepartmentTreeNode = DingTalkDepartment & {
  children?: DepartmentTreeNode[];
};

type DingTalkFormField = {
  id?: string;
  name?: string;
  componentType?: string;
  value?: unknown;
};

type DingTalkTableRow = Record<string, unknown>;

type ImagePreviewState = {
  title: string;
  url: string;
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

function approvalCountByTemplate(instances: ApprovalInstance[]) {
  return instances.reduce<Record<string, number>>((result, instance) => {
    result[instance.template_id] = (result[instance.template_id] ?? 0) + 1;
    return result;
  }, {});
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

function isSeedTemplate(template: ApprovalTemplate) {
  return template.process_code.startsWith("seed-");
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
  if (mapping.source_path?.startsWith("table:")) {
    const [, tableKey, cellKey] = mapping.source_path.split(":");
    if (tableKey && cellKey) return tableValueFromPayload(payload, tableKey, cellKey);
  }
  const values = formValueMapFromPayload(payload);
  if (mapping.source_field_id && mapping.source_field_id in values) return values[mapping.source_field_id];
  return values[mapping.source_field_name];
}

function mappingDisplayLabel(mapping: TemplateFieldMapping) {
  return mapping.display_label || mapping.source_field_name || mapping.standard_field;
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
  const [templates, setTemplates] = useState<ApprovalTemplate[]>([]);
  const [mappings, setMappings] = useState<TemplateFieldMapping[]>([]);
  const [fieldCandidates, setFieldCandidates] = useState<TemplateFieldCandidate[]>([]);
  const [syncJobs, setSyncJobs] = useState<SyncJob[]>([]);
  const [approvalInstances, setApprovalInstances] = useState<ApprovalInstance[]>([]);
  const [departmentPreview, setDepartmentPreview] = useState<DingTalkDepartmentSyncPreview | null>(null);
  const [selectedTemplate, setSelectedTemplate] = useState<ApprovalTemplate | null>(null);
  const [instanceTemplateFilterId, setInstanceTemplateFilterId] = useState<string | null>(null);
  const [instanceDisplayMappings, setInstanceDisplayMappings] = useState<TemplateFieldMapping[]>([]);
  const [selectedInstance, setSelectedInstance] = useState<ApprovalInstance | null>(null);
  const [selectedInstanceAttachments, setSelectedInstanceAttachments] = useState<Attachment[]>([]);
  const [editingMapping, setEditingMapping] = useState<TemplateFieldMapping | null>(null);
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isTemplateModalOpen, setIsTemplateModalOpen] = useState(false);
  const [isMappingModalOpen, setIsMappingModalOpen] = useState(false);
  const [isMappingDrawerOpen, setIsMappingDrawerOpen] = useState(false);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [isConfigModalOpen, setIsConfigModalOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [form] = Form.useForm<DingTalkFormValues>();
  const [templateForm] = Form.useForm<ApprovalTemplateCreate>();
  const [mappingForm] = Form.useForm<MappingFormValues>();
  const [syncForm] = Form.useForm<ApprovalSyncFormValues>();
  const selectedSourceFieldName = Form.useWatch("source_field_name", mappingForm);
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
  const selectedInstancePayload = useMemo(() => {
    if (!selectedInstance?.raw_payload) return null;
    try {
      return JSON.parse(selectedInstance.raw_payload);
    } catch {
      return null;
    }
  }, [selectedInstance]);
  const selectedInstanceParse = selectedInstancePayload?._fin_hub_parse;
  const selectedInstanceFields = useMemo<DingTalkFormField[]>(() => {
    const fields = selectedInstancePayload?.form_component_values;
    return Array.isArray(fields) ? fields.filter((item) => item && typeof item === "object") : [];
  }, [selectedInstancePayload]);
  const selectedInstanceTables = useMemo(() => {
    return selectedInstanceFields
      .map((field) => ({
        name: field.name || "表格",
        rows: parseDingTalkTableValue(field.value),
      }))
      .filter((table) => table.rows.length > 0);
  }, [selectedInstanceFields]);
  const templateApprovalCounts = useMemo(() => approvalCountByTemplate(approvalInstances), [approvalInstances]);
  const detailDisplayMappings = mappings;
  const selectedTemplateSampleInstance = selectedTemplate
    ? approvalInstances.find((instance) => instance.template_id === selectedTemplate.id)
    : undefined;
  const instanceTemplateFilter = instanceTemplateFilterId
    ? templates.find((template) => template.id === instanceTemplateFilterId) ?? null
    : null;
  const displayedApprovalInstances = instanceTemplateFilterId
    ? approvalInstances.filter((instance) => instance.template_id === instanceTemplateFilterId)
    : approvalInstances;

  useEffect(() => {
    return () => {
      if (imagePreview?.url.startsWith("blob:")) URL.revokeObjectURL(imagePreview.url);
    };
  }, [imagePreview]);

  async function loadData() {
    setIsLoading(true);
    setErrorMessage(null);
    try {
      const [data, templatePage, jobPage, instancePage, departmentData] = await Promise.all([
        apiClient.dingtalk.readConfig(),
        apiClient.dingtalk.listTemplates("?page_size=200"),
        apiClient.dingtalk.listSyncJobs("?page_size=20"),
        apiClient.dingtalk.listApprovalInstances("?page_size=500"),
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
      template_id: instanceTemplateFilterId ?? selectedTemplate?.id,
      time_range: [dayjs().subtract(7, "day"), dayjs()],
      page_size: 10,
      max_pages: 5,
      skip_existing: true,
    });
    setIsSyncModalOpen(true);
  }

  async function changeInstanceTemplateFilter(templateId?: string) {
    setInstanceTemplateFilterId(templateId ?? null);
    setErrorMessage(null);
    if (!templateId) {
      setInstanceDisplayMappings([]);
      return;
    }
    setIsLoading(true);
    try {
      const data = await apiClient.dingtalk.listMappings(templateId);
      setInstanceDisplayMappings(data);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载模板显示字段");
    } finally {
      setIsLoading(false);
    }
  }

  async function startApprovalSync(values: ApprovalSyncFormValues) {
    setIsLoading(true);
    try {
      const job = await apiClient.dingtalk.startApprovalSync({
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
      if (instanceTemplateFilterId) {
        setInstanceDisplayMappings(await apiClient.dingtalk.listMappings(instanceTemplateFilterId));
      }
      if (job.status === "failed") {
        message.error(job.error_message || "审批列表同步失败");
      } else if (job.next_cursor) {
        message.warning("审批列表已同步一部分，可在同步任务中续跑");
      } else {
        message.success("审批列表增量同步完成");
      }
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
      const nextJob = await apiClient.dingtalk.resumeApprovalSync(job.id, {
        started_by: "admin",
        page_size: 20,
        max_pages: 20,
        skip_existing: true,
      });
      await loadData();
      if (nextJob.status === "failed") {
        message.error(nextJob.error_message || "审批同步续跑失败");
      } else if (nextJob.next_cursor) {
        message.warning("审批同步续跑已处理一部分，可继续续跑");
      } else {
        message.success("审批同步续跑完成");
      }
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

  function applyFieldCandidate(fieldKey: string) {
    const candidate = fieldCandidates.find((item) => candidateKey(item) === fieldKey || item.source_field_name === fieldKey);
    if (!candidate) return;
    mappingForm.setFieldsValue({
      selected_field_key: candidateKey(candidate),
      source_field_name: candidate.source_field_name,
      display_label: mappingForm.getFieldValue("display_label") || candidate.source_field_name,
      source_field_id: candidate.source_field_id ?? undefined,
      source_path: candidate.source_path ?? undefined,
      field_type: candidate.field_type ?? undefined,
    });
  }

  function openMappingModal(candidate?: TemplateFieldCandidate, mapping?: TemplateFieldMapping) {
    setEditingMapping(mapping ?? null);
    mappingForm.resetFields();
    if (mapping) {
      mappingForm.setFieldsValue({
        selected_field_key: mapping.source_field_id || mapping.source_field_name,
        standard_field: mapping.standard_field,
        display_label: mapping.display_label ?? mapping.source_field_name,
        source_field_name: mapping.source_field_name,
        source_field_id: mapping.source_field_id ?? undefined,
        source_path: mapping.source_path ?? undefined,
        field_type: mapping.field_type ?? undefined,
        show_in_list: mapping.show_in_list,
        show_in_detail: mapping.show_in_detail,
        is_required: mapping.is_required,
        sort_order: mapping.sort_order,
      });
      setIsMappingModalOpen(true);
      return;
    }
    mappingForm.setFieldsValue({
      standard_field: candidate ? `display:${candidate.source_field_id || candidate.source_field_name}` : undefined,
      display_label: candidate?.source_field_name,
      selected_field_key: candidate ? candidateKey(candidate) : undefined,
      source_field_name: candidate?.source_field_name,
      source_field_id: candidate?.source_field_id ?? undefined,
      source_path: candidate?.source_path ?? undefined,
      field_type: candidate?.field_type ?? undefined,
      show_in_list: true,
      show_in_detail: true,
      is_required: false,
      sort_order: mappings.length,
    });
    setIsMappingModalOpen(true);
  }

  async function deleteMapping(mapping: TemplateFieldMapping) {
    if (!selectedTemplate) return;
    setIsLoading(true);
    setErrorMessage(null);
    try {
      await apiClient.dingtalk.deleteMapping(selectedTemplate.id, mapping.id);
      await loadMappings(selectedTemplate);
      message.success("字段映射已删除");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法删除字段映射");
    } finally {
      setIsLoading(false);
    }
  }

  async function submitMapping(values: MappingFormValues) {
    if (!selectedTemplate) return;
    const sourceKey = values.source_field_id || values.source_field_name;
    setIsLoading(true);
    try {
      const payload = {
        ...values,
        standard_field: values.standard_field || `display:${sourceKey}`,
        display_label: values.display_label || values.source_field_name,
        show_in_detail: values.show_in_detail ?? true,
        show_in_list: true,
        is_required: false,
      };
      if (editingMapping) {
        await apiClient.dingtalk.updateMapping(selectedTemplate.id, editingMapping.id, payload);
      } else {
        await apiClient.dingtalk.upsertMapping(selectedTemplate.id, payload);
      }
      setIsMappingModalOpen(false);
      setEditingMapping(null);
      mappingForm.resetFields();
      await loadMappings(selectedTemplate);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法保存字段映射");
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
      setErrorMessage(error instanceof Error ? error.message : "无法读取审批附件");
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
      message.success("已用当前审批单生成字段候选");
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
      setErrorMessage(error instanceof Error ? error.message : "无法打开附件");
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
      setErrorMessage(error instanceof Error ? error.message : "无法获取钉钉附件链接");
    }
  }

  const templateColumns: ColumnsType<ApprovalTemplate> = [
    {
      title: "模板名称",
      dataIndex: "name",
      render: (value, record) => (
        <Space size={8}>
          <span>{value}</span>
          {isSeedTemplate(record) ? <Tag>演示</Tag> : null}
        </Space>
      ),
    },
    { title: "Process Code", dataIndex: "process_code" },
    {
      title: "映射状态",
      dataIndex: "mapping_status",
      render: (value) => (value === "mapped" ? <Tag color="green">已映射</Tag> : <Tag color="gold">未映射</Tag>),
    },
    { title: "启用", dataIndex: "is_enabled", render: (value) => (value ? "是" : "否") },
    {
      title: "本地审批数",
      dataIndex: "id",
      width: 110,
      render: (value) => templateApprovalCounts[value] ?? 0,
    },
    { title: "上次同步", dataIndex: "last_sync_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    {
      title: "操作",
      render: (_, record) => (
        <Space>
          <Button type="link" onClick={() => openMappingDrawer(record)}>
            字段显示配置
          </Button>
        </Space>
      ),
    },
  ];

  const mappingColumns: ColumnsType<TemplateFieldMapping> = [
    { title: "钉钉字段", dataIndex: "source_field_name" },
    { title: "显示名称", dataIndex: "display_label", render: (_, record) => mappingDisplayLabel(record) },
    {
      title: "字段样例",
      render: (_, record) =>
        selectedTemplateSampleInstance ? renderDingTalkValue(mappedDisplayValue(selectedTemplateSampleInstance, record)) : "-",
    },
    {
      title: "操作",
      width: 120,
      render: (_, record) => (
        <Space>
          <Button size="small" onClick={() => openMappingModal(undefined, record)}>
            编辑
          </Button>
          <Popconfirm title="删除这个字段映射？" onConfirm={() => deleteMapping(record)}>
            <Button size="small" danger>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const fieldCandidateColumns: ColumnsType<TemplateFieldCandidate> = [
    { title: "钉钉字段", dataIndex: "source_field_name", width: 150 },
    {
      title: "真实样例",
      dataIndex: "sample_value",
      render: renderDingTalkValue,
    },
    {
      title: "操作",
      width: 90,
      render: (_, record) => (
        <Button size="small" onClick={() => openMappingModal(record)}>
          配置
        </Button>
      ),
    },
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

  const listDisplayMappings = instanceTemplateFilterId ? instanceDisplayMappings : [];
  const instanceColumns: ColumnsType<ApprovalInstance> = [
    { title: "审批编号", dataIndex: "approval_no", render: (value) => value || "-" },
    ...listDisplayMappings.map((mapping): ColumnsType<ApprovalInstance>[number] => ({
      title: mappingDisplayLabel(mapping),
      key: `mapping-${mapping.id}`,
      width: 160,
      render: (_, record) => renderDingTalkValue(mappedDisplayValue(record, mapping)),
    })),
    { title: "实例 ID", dataIndex: "dingtalk_instance_id" },
    { title: "申请人", dataIndex: "applicant_name", render: (value) => value || "-" },
    {
      title: "状态",
      dataIndex: "approval_status",
      render: (value) => (value === "approved" ? <Tag color="green">已通过</Tag> : <Tag>{value}</Tag>),
    },
    { title: "提交时间", dataIndex: "submit_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    { title: "通过时间", dataIndex: "approved_at", render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    {
      title: "操作",
      width: 90,
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
                    <Tag color="green">已通过 {displayedApprovalInstances.filter((item) => item.approval_status === "approved").length}</Tag>
                    {instanceTemplateFilter ? <Tag color="purple">显示字段 {instanceDisplayMappings.length}</Tag> : null}
                    <Tag color="blue">同步任务 {syncJobs.length}</Tag>
                    <Tag color="cyan">
                      上次同步 {config?.last_instance_sync_at ? config.last_instance_sync_at.replace("T", " ").slice(0, 16) : "尚未同步"}
                    </Tag>
                  </Space>
                  <Table
                    rowKey="id"
                    loading={isLoading}
                    columns={instanceColumns}
                    dataSource={displayedApprovalInstances}
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

      <Drawer
        title={selectedTemplate ? `${selectedTemplate.name} 字段显示配置` : "字段显示配置"}
        open={isMappingDrawerOpen}
        onClose={() => setIsMappingDrawerOpen(false)}
        width={1040}
        extra={
          <Space>
            <Button disabled={!selectedTemplate} onClick={syncTemplateSample} loading={isLoading}>
              拉取一条样例审批
            </Button>
            <Button type="primary" disabled={!selectedTemplate} onClick={() => openMappingModal()}>
              新增字段
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" size={16} className="full-width">
          <Alert
            type="info"
            showIcon
            message="字段显示配置用于从这个审批模板里挑选需要展示的字段。"
            description="配置后，审批列表会按这些字段显示；其他业务场景选择这个审批模板数据时，也优先展示这些字段。完整原始数据仍可在详情里查看。"
          />
          <Card size="small" title="已选显示字段">
            <Table rowKey="id" loading={isLoading} columns={mappingColumns} dataSource={mappings} pagination={false} />
          </Card>
          <Card size="small" title="可选钉钉字段样例">
            {fieldCandidates.length ? (
              <Table
                size="small"
                rowKey={(record, index) => `${record.source_field_name}-${record.source_field_id || index}`}
                columns={fieldCandidateColumns}
                dataSource={fieldCandidates}
                pagination={{ pageSize: 8 }}
                rowClassName={(record) => (record.source_field_name === selectedSourceFieldName ? "selected-candidate-row" : "")}
              />
            ) : (
              <Alert
                type="warning"
                showIcon
                message="这个模板还没有可选字段"
                description="字段下拉来自这个模板的真实审批数据。请先拉取一条样例审批，系统解析出字段后再配置显示名称。"
                action={
                  <Button size="small" type="primary" onClick={syncTemplateSample} loading={isLoading}>
                    拉取样例
                  </Button>
                }
              />
            )}
          </Card>
        </Space>
      </Drawer>

      <Modal
        title="审批实例详情"
        open={Boolean(selectedInstance)}
        onCancel={() => setSelectedInstance(null)}
        footer={
          <Space>
            <Button onClick={() => setSelectedInstance(null)}>关闭</Button>
            {selectedInstance ? (
              <Button type="primary" loading={isLoading} onClick={() => useSelectedInstanceAsFieldSample(selectedInstance)}>
                用这条配置显示字段
              </Button>
            ) : null}
          </Space>
        }
        width={920}
      >
        {selectedInstance ? (
          <Space direction="vertical" size={16} className="full-width">
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="审批编号">{selectedInstance.approval_no || "-"}</Descriptions.Item>
              <Descriptions.Item label="审批状态">{selectedInstance.approval_status}</Descriptions.Item>
              <Descriptions.Item label="实例 ID" span={2}>
                {selectedInstance.dingtalk_instance_id}
              </Descriptions.Item>
              <Descriptions.Item label="申请人">{selectedInstance.applicant_name || "-"}</Descriptions.Item>
              <Descriptions.Item label="申请人 User ID">{selectedInstance.applicant_user_id || "-"}</Descriptions.Item>
              <Descriptions.Item label="本地门店 ID" span={2}>
                {selectedInstance.store_id || "-"}
              </Descriptions.Item>
              <Descriptions.Item label="提交时间">
                {selectedInstance.submit_at?.replace("T", " ").slice(0, 16) || "-"}
              </Descriptions.Item>
              <Descriptions.Item label="通过时间">
                {selectedInstance.approved_at?.replace("T", " ").slice(0, 16) || "-"}
              </Descriptions.Item>
            </Descriptions>

            {detailDisplayMappings.length ? (
              <Card size="small" title="已配置显示字段">
                <Descriptions bordered size="small" column={2}>
                  {detailDisplayMappings.map((mapping) => (
                    <Descriptions.Item label={mappingDisplayLabel(mapping)} key={mapping.id}>
                      {renderDingTalkValue(mappedDisplayValue(selectedInstance, mapping))}
                    </Descriptions.Item>
                  ))}
                </Descriptions>
              </Card>
            ) : null}

            <Card size="small" title="解析诊断">
              {selectedInstanceParse ? (
                <Space direction="vertical" size={8} className="full-width">
                  <Space wrap>
                    <Tag color={selectedInstanceParse.expense_parse_status === "skipped" ? "gold" : "green"}>
                      {selectedInstanceParse.expense_parse_status === "skipped" ? "未生成支出" : "已解析"}
                    </Tag>
                    <Tag>明细行 {selectedInstanceParse.expense_row_count ?? 0}</Tag>
                    <Tag>生成支出 {selectedInstanceParse.created_expense_ids?.length ?? 0}</Tag>
                  </Space>
                  <Descriptions bordered size="small" column={1}>
                    <Descriptions.Item label="表单门店">{selectedInstanceParse.store_text || "-"}</Descriptions.Item>
                    <Descriptions.Item label="发起部门 ID">{selectedInstanceParse.originator_dept_id || "-"}</Descriptions.Item>
                    <Descriptions.Item label="发起部门">{selectedInstanceParse.originator_dept_name || "-"}</Descriptions.Item>
                    <Descriptions.Item label="解析门店 ID">{selectedInstanceParse.resolved_store_id || "-"}</Descriptions.Item>
                    <Descriptions.Item label="缺失字段">
                      {selectedInstanceParse.missing_fields?.length ? selectedInstanceParse.missing_fields.join(", ") : "-"}
                    </Descriptions.Item>
                  </Descriptions>
                </Space>
              ) : (
                <Typography.Text type="secondary">暂无解析诊断</Typography.Text>
              )}
            </Card>

            <Card size="small" title="钉钉表单字段">
              <Table
                size="small"
                rowKey={(record, index) => `${record.name || record.id || "field"}-${index}`}
                pagination={false}
                dataSource={selectedInstanceFields}
                columns={[
                  { title: "字段", dataIndex: "name", width: 180, render: (value) => value || "-" },
                  { title: "类型", dataIndex: "componentType", width: 140, render: (value) => value || "-" },
                  {
                    title: "值",
                    dataIndex: "value",
                    render: renderDingTalkValue,
                  },
                ]}
              />
            </Card>

            {selectedInstanceTables.map((table) => {
              const keys = Array.from(new Set(table.rows.flatMap((row) => Object.keys(row))));
              return (
                <Card size="small" title={`${table.name}明细`} key={table.name}>
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

            <Card size="small" title="报销凭证文档">
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={selectedInstanceAttachments}
                columns={[
                  { title: "文件名", dataIndex: "file_name", render: (value) => value || "钉钉凭证" },
                  {
                    title: "状态",
                    dataIndex: "download_status",
                    width: 110,
                    render: (value) => {
                      if (value === "stored") return <Tag color="green">已下载</Tag>;
                      if (value === "failed") return <Tag color="red">失败</Tag>;
                      return <Tag color="gold">待下载</Tag>;
                    },
                  },
                  { title: "类型", dataIndex: "content_type", width: 150, render: (value) => value || "-" },
                  {
                    title: "操作",
                    width: 280,
                    render: (_, record) => {
                      const sourceUrl = externalAttachmentUrl(record);
                      return (
                        <Space>
                          {sourceUrl ? (
                            <Button size="small" href={sourceUrl} target="_blank" rel="noreferrer">
                              源链接
                            </Button>
                          ) : null}
                          <Button size="small" onClick={() => openAttachmentAccessUrl(record)}>
                            {isImageAttachment(record) ? "预览图片" : "链接访问"}
                          </Button>
                          <Button size="small" onClick={() => openAttachment(record, "download")}>
                            保存到本地
                          </Button>
                        </Space>
                      );
                    },
                  },
                ]}
              />
            </Card>

            <Card size="small" title="原始数据">
              <pre className="json-block">
                {selectedInstance.raw_payload
                  ? JSON.stringify(selectedInstancePayload ?? selectedInstance.raw_payload, null, 2)
                  : "-"}
              </pre>
            </Card>
          </Space>
        ) : null}
      </Modal>
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
        title={editingMapping ? "编辑显示字段" : "新增显示字段"}
        open={isMappingModalOpen}
        onCancel={() => {
          setIsMappingModalOpen(false);
          setEditingMapping(null);
        }}
        onOk={() => mappingForm.submit()}
        confirmLoading={isLoading}
        okButtonProps={{ disabled: !fieldCandidates.length }}
        width={560}
      >
        <Form form={mappingForm} layout="vertical" onFinish={submitMapping}>
          {!fieldCandidates.length ? (
            <Alert
              className="dashboard-alert"
              type="warning"
              showIcon
              message="还没有可选择的钉钉字段"
              description="字段必须从当前审批模板的真实审批数据解析出来。先拉取一条样例审批，成功后这里会变成下拉选择。"
              action={
                <Button size="small" type="primary" onClick={syncTemplateSample} loading={isLoading}>
                  拉取一条样例审批
                </Button>
              }
            />
          ) : null}
          <Form.Item name="selected_field_key" label="选择钉钉字段" rules={[{ required: true }]}>
            <Select
              showSearch
              placeholder={fieldCandidates.length ? "选择这个模板里的钉钉字段" : "请先同步当前模板审批"}
              optionLabelProp="fieldName"
              filterOption={(input, option) =>
                String(option?.searchText ?? "").toLowerCase().includes(input.toLowerCase())
              }
              disabled={!fieldCandidates.length}
              onChange={applyFieldCandidate}
              options={fieldCandidates.map((candidate) => ({
                label: renderFieldCandidateOption(candidate),
                fieldName: candidate.source_field_name,
                searchText: fieldCandidateSearchText(candidate),
                value: candidateKey(candidate),
              }))}
            />
          </Form.Item>
          <Form.Item name="display_label" label="显示名称" rules={[{ required: true }]}>
            <Input placeholder="例如：门店、金额、凭证" />
          </Form.Item>
          <Form.Item name="standard_field" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="source_field_name" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="source_field_id" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="source_path" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="field_type" hidden>
            <Input />
          </Form.Item>
          <Form.Item name="show_in_list" hidden initialValue={true}>
            <Input />
          </Form.Item>
          <Form.Item name="show_in_detail" hidden initialValue={true}>
            <Input />
          </Form.Item>
          <Form.Item name="is_required" hidden initialValue={false}>
            <Input />
          </Form.Item>
          <Form.Item name="sort_order" hidden initialValue={0}>
            <Input />
          </Form.Item>
        </Form>
      </Modal>
    </AppShell>
  );
}
