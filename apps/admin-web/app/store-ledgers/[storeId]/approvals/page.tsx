"use client";

import { Alert, Button, Card, DatePicker, Descriptions, Drawer, Empty, Image, Input, InputNumber, Modal, Space, Table, Tag, Typography, message, Select, Row, Col, Form } from "antd";
import dayjs from "dayjs";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import type { ApprovalInstance, ApprovalTemplate, Attachment, Ledger, Store, StoreApprovalSyncResult, ApprovalModifiedResyncRequest } from "@fin-hub/shared-types";
import { AppShell } from "../../../components/AppShell";
import { EnterpriseTable } from "../../../components/EnterpriseTable";
import type { EnterpriseTableColumn } from "../../../components/EnterpriseTable";
import { StoreLedgerWorkspaceNav } from "../../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../../lib/api";
import { getApprovalTemplates, getStoreLedgers, getStores } from "../../../lib/referenceData";
import { useClientSearchParams } from "../../../lib/searchParams";

type SyncDateRange = [dayjs.Dayjs, dayjs.Dayjs];

type ModifiedResyncFormValues = {
  start_at?: dayjs.Dayjs;
  end_at?: dayjs.Dayjs;
  template_id?: string;
  limit?: number;
};

function syncRangeForPeriod(period: string): SyncDateRange | null {
  const periodStart = dayjs(`${period}-01`);
  if (!periodStart.isValid()) return null;
  const start = periodStart.startOf("day");
  const end = periodStart.add(1, "month").subtract(1, "day").endOf("day");
  const latestAllowed = dayjs().endOf("day");
  if (start.isAfter(latestAllowed)) return null;
  return [start, end.isAfter(latestAllowed) ? latestAllowed : end];
}

function defaultLedgerPeriod() {
  return dayjs().subtract(1, "month").format("YYYY-MM");
}

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

function formatBeijingDateTime(value?: string | null) {
  if (!value) return "-";
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
  if (typeof title === "string" && title) return title;
  return instance.approval_no || instance.dingtalk_instance_id;
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

function approvalMatchStatusMeta(status?: string | null) {
  const normalized = (status || "").toLowerCase();
  const statusMap: Record<string, { label: string; color: string }> = {
    matched: { label: "已对账", color: "green" },
    partial_matched: { label: "已对账", color: "green" },
    pending_match: { label: "待对账", color: "blue" },
    pending_classification: { label: "待分类", color: "orange" },
    sync_conflict: { label: "同步冲突", color: "red" },
    unparsed: { label: "未解析", color: "default" },
  };
  return statusMap[normalized] ?? { label: status || "-", color: "default" };
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

function isImageUrl(value: string) {
  return /\.(apng|avif|gif|jpe?g|png|webp)(\?.*)?$/i.test(value);
}

function isImageAttachment(attachment: Attachment) {
  const contentType = attachment.content_type || "";
  if (contentType.startsWith("image/")) return true;
  return /\.(apng|avif|gif|jpe?g|png|webp)$/i.test(attachment.file_name);
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
            <Image key={url} src={url} alt="报销凭证" width={72} height={96} style={{ objectFit: "cover", borderRadius: 4 }} />
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

function fieldLabel(field: DingTalkFormField) {
  return field.name || field.id || "字段";
}

function fieldValue(field: DingTalkFormField) {
  return field.value ?? (field as Record<string, unknown>).ext_value ?? (field as Record<string, unknown>).extValue;
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

function operationActivityId(record: Record<string, unknown>) {
  const value = record.activity_id ?? record.activityId ?? record.activity_code ?? record.activityCode;
  return value ? String(value) : "";
}

function operationTitle(record: Record<string, unknown>, nodeNameMap?: Record<string, string>) {
  const activityId = operationActivityId(record);
  if (activityId && nodeNameMap?.[activityId]) return nodeNameMap[activityId];
  const title = record.name ?? record.task_name ?? record.activity_name ?? record.type;
  if (title) return String(title);
  return activityId ? `审批节点 ${activityId}` : "审批节点";
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

function uniqueSelectOptions(values: Array<string | null | undefined>) {
  return Array.from(new Set(values.filter((value): value is string => Boolean(value && value !== "-"))))
    .sort((left, right) => left.localeCompare(right, "zh-CN"))
    .map((value) => ({ text: value, value }));
}

function tableFiltersToSelectOptions(filters: Array<{ text: string; value: string }>) {
  return filters.map((filter) => ({ label: filter.text, value: filter.value }));
}

export default function StoreLedgerApprovalsPage() {
  const params = useParams<{ storeId: string }>();
  const searchParams = useClientSearchParams();
  const storeId = params.storeId;
  const [store, setStore] = useState<Store | null>(null);
  const [ledgers, setLedgers] = useState<Ledger[]>([]);
  const [templates, setTemplates] = useState<ApprovalTemplate[]>([]);
  const [approvals, setApprovals] = useState<ApprovalInstance[]>([]);
  const [selectedApproval, setSelectedApproval] = useState<ApprovalInstance | null>(null);
  const [detailAttachments, setDetailAttachments] = useState<Attachment[]>([]);
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const fallbackPeriod = useMemo(() => defaultLedgerPeriod(), []);
  const [selectedPeriod, setSelectedPeriod] = useState(searchParams.get("period") || fallbackPeriod);
  const [keyword, setKeyword] = useState("");
  const [templateFilter, setTemplateFilter] = useState<string>();
  const [approvalStatusFilter, setApprovalStatusFilter] = useState<string>();
  const [matchStatusFilter, setMatchStatusFilter] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [isApprovalLoading, setIsApprovalLoading] = useState(false);
  const [isStoreSyncing, setIsStoreSyncing] = useState(false);
  const [isStoreSyncModalOpen, setIsStoreSyncModalOpen] = useState(false);
  const [storeSyncResult, setStoreSyncResult] = useState<StoreApprovalSyncResult | null>(null);
  const [storeSyncError, setStoreSyncError] = useState<string | null>(null);
  const [storeSyncDateRange, setStoreSyncDateRange] = useState<SyncDateRange | null>(null);
  const [isModifiedResyncModalOpen, setIsModifiedResyncModalOpen] = useState(false);
  const [modifiedResyncForm] = Form.useForm<ModifiedResyncFormValues>();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let ignore = false;
    async function loadData() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const [storePage, ledgerPage, templatePage] = await Promise.all([
          getStores(),
          getStoreLedgers(storeId),
          getApprovalTemplates(500),
        ]);
        if (!ignore) {
          const nextLedgers = ledgerPage.sort((left, right) => right.period.localeCompare(left.period));
          setStore(storePage.find((item) => item.id === storeId) ?? null);
          setLedgers(nextLedgers);
          setTemplates(templatePage);
          setSelectedPeriod((current) => current || fallbackPeriod);
        }
      } catch (error) {
        if (!ignore) setErrorMessage(error instanceof Error ? error.message : "无法加载审批单");
      } finally {
        if (!ignore) setIsLoading(false);
      }
    }
    void loadData();
    return () => {
      ignore = true;
    };
  }, [fallbackPeriod, storeId]);

  useEffect(() => {
    let ignore = false;
    async function loadApprovals() {
      if (!storeId) return;
      setIsApprovalLoading(true);
      setErrorMessage(null);
      try {
        const params = new URLSearchParams({ store_id: storeId, page_size: "500" });
        if (keyword.trim().length > 0) {
          params.set("include_matched", "true");
        }
        const approvalPage = await apiClient.dingtalk.listApprovalInstances(`?${params.toString()}`);
        if (!ignore) {
          setApprovals(approvalPage.items);
        }
      } catch (error) {
        if (!ignore) setErrorMessage(error instanceof Error ? error.message : "无法加载审批单");
      } finally {
        if (!ignore) setIsApprovalLoading(false);
      }
    }
    void loadApprovals();
    return () => {
      ignore = true;
    };
  }, [keyword, storeId]);

  const periodOptions = useMemo(() => {
    const periods = new Set(ledgers.map((ledger) => ledger.period));
    if (selectedPeriod) periods.add(selectedPeriod);
    return Array.from(periods)
      .sort()
      .reverse()
      .map((period) => ({ label: period, value: period }));
  }, [ledgers, selectedPeriod]);
  const templateNameById = useMemo(
    () => new Map(templates.map((template) => [template.id, template.name])),
    [templates],
  );
  const templateNameFilters = useMemo(
    () => uniqueSelectOptions(approvals.map((approval) => templateNameById.get(approval.template_id))),
    [approvals, templateNameById],
  );
  const applicantFilters = useMemo(
    () => uniqueSelectOptions(approvals.map((approval) => applicantDisplayName(approval))),
    [approvals],
  );
  const departmentFilters = useMemo(
    () => uniqueSelectOptions(approvals.map((approval) => approvalDepartmentName(approval))),
    [approvals],
  );
  const approvalStatusFilters = useMemo(
    () => uniqueSelectOptions(approvals.map((approval) => approvalStatusMeta(approval.approval_status).label)),
    [approvals],
  );
  const approvalMatchStatusFilters = useMemo(
    () => uniqueSelectOptions(approvals.map((approval) => approvalMatchStatusMeta(approval.processing_status).label)),
    [approvals],
  );
  const templateSelectOptions = useMemo(() => tableFiltersToSelectOptions(templateNameFilters), [templateNameFilters]);
  const approvalStatusSelectOptions = useMemo(() => tableFiltersToSelectOptions(approvalStatusFilters), [approvalStatusFilters]);
  const approvalMatchStatusSelectOptions = useMemo(() => tableFiltersToSelectOptions(approvalMatchStatusFilters), [approvalMatchStatusFilters]);
  const filteredApprovals = approvals.filter((approval) => {
    const value = keyword.trim().toLowerCase();
    const templateName = templateNameById.get(approval.template_id) || "-";
    const approvalStatusLabel = approvalStatusMeta(approval.approval_status).label;
    const matchStatusLabel = approvalMatchStatusMeta(approval.processing_status).label;
    if (templateFilter && templateName !== templateFilter) return false;
    if (approvalStatusFilter && approvalStatusLabel !== approvalStatusFilter) return false;
    if (matchStatusFilter && matchStatusLabel !== matchStatusFilter) return false;
    if (!value) return true;
    return [
      approval.approval_no,
      approval.dingtalk_instance_id,
      approval.applicant_name,
      approval.applicant_user_id,
      approval.department_name,
      approval.approval_status,
      approvalStatusLabel,
      matchStatusLabel,
      templateName,
    ]
      .filter(Boolean)
      .some((text) => String(text).toLowerCase().includes(value));
  });

  async function syncStoreApprovals() {
    if (!selectedPeriod || !storeSyncDateRange) {
      message.warning("请先选择账期");
      return;
    }
    setIsStoreSyncing(true);
    setErrorMessage(null);
    setStoreSyncError(null);
    try {
      const result = await apiClient.dingtalk.startStoreApprovalSync({
        store_id: storeId,
        ledger_period: selectedPeriod,
        started_by: "store-ledger",
        start_at: storeSyncDateRange[0].toISOString(),
        end_at: storeSyncDateRange[1].toISOString(),
        skip_existing: false,
      });
      const params = new URLSearchParams({
        store_id: storeId,
        page_size: "500",
      });
      const approvalPage = await apiClient.dingtalk.listApprovalInstances(`?${params.toString()}`);
      setApprovals(approvalPage.items);
      setStoreSyncResult(result);
      if (result.job.status === "failed") {
        message.warning(result.job.error_message || "审批同步已完成，但存在未处理的数据");
      } else {
        message.success(
          `审批同步完成：归入当前门店账期 ${result.matched_count} 条`,
        );
      }
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "无法同步本门店审批";
      setStoreSyncError(nextError);
      setErrorMessage(nextError);
    } finally {
      setIsStoreSyncing(false);
    }
  }

  function openModifiedResyncModal() {
    const range = selectedPeriod ? syncRangeForPeriod(selectedPeriod) : null;
    modifiedResyncForm.setFieldsValue({
      start_at: range?.[0] ?? dayjs().startOf("month"),
      end_at: range?.[1] ?? dayjs(),
      limit: 200,
    });
    setIsModifiedResyncModalOpen(true);
  }

  async function startModifiedResync(values: ModifiedResyncFormValues) {
    if (!values.start_at || !values.end_at) {
      message.warning("请选择修改时间范围");
      return;
    }
    if (values.end_at.diff(values.start_at, "day", true) > 120) {
      message.error("单次重刷时间范围不能超过 120 天");
      return;
    }
    setIsStoreSyncing(true);
    setErrorMessage(null);
    setStoreSyncError(null);
    try {
      const payload: ApprovalModifiedResyncRequest = {
        store_id: storeId,
        start_at: values.start_at.toISOString(),
        end_at: values.end_at.toISOString(),
        template_id: values.template_id,
        limit: values.limit ?? 200,
        started_by: "store-ledger",
      };
      const result = await apiClient.dingtalk.resyncApprovalsByModifiedTime(payload);
      setIsModifiedResyncModalOpen(false);
      const params = new URLSearchParams({
        store_id: storeId,
        page_size: "500",
      });
      const approvalPage = await apiClient.dingtalk.listApprovalInstances(`?${params.toString()}`);
      setApprovals(approvalPage.items);
      message.success(`修改重刷已提交：处理 ${result.processed_count} 条，更新 ${result.updated_count} 条`);
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "无法按修改时间重刷审批";
      setStoreSyncError(nextError);
      setErrorMessage(nextError);
    } finally {
      setIsStoreSyncing(false);
    }
  }

  function openStoreSyncModal() {
    if (!selectedPeriod) {
      message.warning("请先选择账期");
      return;
    }
    setStoreSyncResult(null);
    setStoreSyncError(null);
    setStoreSyncDateRange(syncRangeForPeriod(selectedPeriod));
    setIsStoreSyncModalOpen(true);
  }
  const selectedApprovalPayload = useMemo(() => {
    return selectedApproval ? approvalPayload(selectedApproval) : null;
  }, [selectedApproval]);
  const selectedApprovalFields = useMemo<DingTalkFormField[]>(() => {
    const fields = selectedApprovalPayload?.form_component_values ?? selectedApprovalPayload?.formComponentValues;
    return Array.isArray(fields) ? fields.filter((item) => item && typeof item === "object") : [];
  }, [selectedApprovalPayload]);
  const selectedApprovalBasicFields = useMemo(() => {
    return selectedApprovalFields.filter((field) => {
      const componentType = field.componentType ?? field.component_type;
      return componentType !== "TableField" && !parseDingTalkTableValue(fieldValue(field)).length;
    });
  }, [selectedApprovalFields]);
  const selectedApprovalTables = useMemo(() => {
    return selectedApprovalFields
      .map((field) => ({
        name: fieldLabel(field),
        rows: parseDingTalkTableValue(fieldValue(field)),
      }))
      .filter((table) => table.rows.length > 0);
  }, [selectedApprovalFields]);
  const selectedApprovalOperations = useMemo(
    () => payloadArray(selectedApprovalPayload, "operation_records", "operationRecords", "tasks", "task_list", "taskList"),
    [selectedApprovalPayload],
  );

  async function openApprovalDetail(approval: ApprovalInstance) {
    setSelectedApproval(approval);
    try {
      const attachmentPage = await apiClient.attachments.list(`?resource_type=approval_instance&resource_id=${encodeURIComponent(approval.id)}&page_size=100`);
      setDetailAttachments(attachmentPage.items);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法加载审批单详情");
    } finally {
    }
  }

  async function openAttachmentAccessUrl(attachment: Attachment) {
    try {
      const data = await apiClient.attachments.accessUrl(attachment.id);
      if (isImageAttachment(attachment) || isImageUrl(data.url)) {
        setImagePreview({ title: data.file_name || attachment.file_name || "图片预览", url: data.url });
        return;
      }
      window.open(data.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "无法获取钉钉附件链接");
    }
  }

  const columns: EnterpriseTableColumn<ApprovalInstance>[] = [
    {
      key: "approval_no",
      title: "审批编号",
      dataIndex: "approval_no",
      width: 150,
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
      width: 160,
      ellipsis: true,
      filters: templateNameFilters,
      onFilter: (value, record) => templateNameById.get(record.template_id) === value,
      render: (_, record) => {
        const templateName = templateNameById.get(record.template_id) || "-";
        return <Typography.Text ellipsis={{ tooltip: templateName }}>{templateName}</Typography.Text>;
      },
    },
    {
      key: "applicant_name",
      title: "申请人",
      dataIndex: "applicant_name",
      width: 120,
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
      width: 150,
      ellipsis: true,
      filters: departmentFilters,
      onFilter: (value, record) => approvalDepartmentName(record) === value,
      render: (_, record) => {
        const departmentName = approvalDepartmentName(record);
        return <Typography.Text ellipsis={{ tooltip: departmentName }}>{departmentName}</Typography.Text>;
      },
    },
    {
      key: "approval_status",
      title: "状态",
      dataIndex: "approval_status",
      width: 90,
      filters: approvalStatusFilters,
      onFilter: (value, record) => approvalStatusMeta(record.approval_status).label === value,
      render: (value: string) => {
        const meta = approvalStatusMeta(value);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    {
      key: "processing_status",
      title: "匹配状态",
      dataIndex: "processing_status",
      width: 100,
      filters: approvalMatchStatusFilters,
      onFilter: (value, record) => approvalMatchStatusMeta(record.processing_status).label === value,
      render: (value: string | null | undefined) => {
        const meta = approvalMatchStatusMeta(value);
        return <Tag color={meta.color}>{meta.label}</Tag>;
      },
    },
    { key: "submit_at", title: "提交时间", dataIndex: "submit_at", width: 135, render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    { key: "approved_at", title: "通过时间", dataIndex: "approved_at", width: 135, render: (value) => value?.replace("T", " ").slice(0, 16) || "-" },
    {
      key: "actions",
      title: "操作",
      fixed: "right",
      width: 90,
      className: "table-action-column",
      render: (_, record) => (
        <Button type="link" onClick={() => openApprovalDetail(record)}>
          详情
        </Button>
      ),
    },
  ];
  return (
    <AppShell
      title={store?.name ? `${store.name} · 审批单管理` : "审批单管理"}
      kicker={selectedPeriod ? `账期：${selectedPeriod}` : "按门店展示全部审批单"}
    >
      <StoreLedgerWorkspaceNav
        storeId={storeId}
        storeName={store?.name}
        period={selectedPeriod}
        periodOptions={periodOptions}
        statusLabel={store?.status === "active" ? "启用门店" : store ? "停用门店" : undefined}
        activeKey="approvals"
        onPeriodChange={setSelectedPeriod}
      />
      {errorMessage ? <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon /> : null}
      <Card
        title="审批单列表"
        loading={isLoading}
        extra={
          <Space size={8} wrap>
            <Input.Search
              allowClear
              placeholder="搜索编号、申请人、部门"
              value={keyword}
              onChange={(event) => setKeyword(event.target.value)}
              style={{ width: 220 }}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="模板"
              value={templateFilter}
              options={templateSelectOptions}
              onChange={setTemplateFilter}
              style={{ width: 180 }}
            />
            <Select
              allowClear
              placeholder="状态"
              value={approvalStatusFilter}
              options={approvalStatusSelectOptions}
              onChange={setApprovalStatusFilter}
              style={{ width: 110 }}
            />
            <Select
              allowClear
              placeholder="匹配状态"
              value={matchStatusFilter}
              options={approvalMatchStatusSelectOptions}
              onChange={setMatchStatusFilter}
              style={{ width: 130 }}
            />
            <Button type="primary" loading={isStoreSyncing} disabled={!selectedPeriod} onClick={openStoreSyncModal}>
              同步本账期审批
            </Button>
            <Button loading={isStoreSyncing} disabled={!selectedPeriod} onClick={openModifiedResyncModal}>
              按修改时间重刷
            </Button>
          </Space>
        }
      >
        {filteredApprovals.length || isApprovalLoading ? (
          <EnterpriseTable<ApprovalInstance>
            rowKey="id"
            loading={isLoading || isApprovalLoading}
            columns={columns}
            dataSource={filteredApprovals}
            onRow={(record) => ({ onDoubleClick: () => openApprovalDetail(record) })}
            pagination={{ defaultPageSize: 8, showSizeChanger: true }}
            showDensityToggle
            showColumnSettings
            fixedColumns={{ left: ["approval_no"], right: ["actions"] }}
          />
        ) : (
          <Empty description="当前门店账期暂无审批单" />
        )}
      </Card>
      <Modal
        title="同步本门店审批"
        open={isStoreSyncModalOpen}
        onCancel={() => setIsStoreSyncModalOpen(false)}
        onOk={() => {
          if (storeSyncResult) {
            setIsStoreSyncModalOpen(false);
            return;
          }
          void syncStoreApprovals();
        }}
        okText={storeSyncResult ? "完成" : "开始同步"}
        cancelText="关闭"
        confirmLoading={isStoreSyncing}
        okButtonProps={{ disabled: !selectedPeriod || !storeSyncDateRange }}
        destroyOnHidden
      >
        <Space direction="vertical" size={16} className="full-width">
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="门店">{store?.name ?? "-"}</Descriptions.Item>
            <Descriptions.Item label="账期">{selectedPeriod || "-"}</Descriptions.Item>
          </Descriptions>
          <div>
            <Typography.Text strong>审批提交日期</Typography.Text>
            <DatePicker.RangePicker
              className="full-width"
              value={storeSyncDateRange}
              format="YYYY-MM-DD"
              disabled={isStoreSyncing || Boolean(storeSyncResult)}
              disabledDate={(current) => {
                const range = selectedPeriod ? syncRangeForPeriod(selectedPeriod) : null;
                return Boolean(
                  !range
                  || current.isBefore(range[0], "day")
                  || current.isAfter(range[1], "day")
                  || current.isAfter(dayjs(), "day"),
                );
              }}
              onChange={(dates) => {
                setStoreSyncDateRange(dates as SyncDateRange | null);
                setStoreSyncResult(null);
                setStoreSyncError(null);
              }}
            />
            <Typography.Text type="secondary">
              默认当前账期整月，可按需要缩小范围。
            </Typography.Text>
          </div>
          <Alert
            type="info"
            showIcon
            message="同步方式"
            description="钉钉只能按审批模板和提交时间查询，不能直接按本地门店筛选。系统会逐条读取审批详情，通过审批表单中的门店字段或发起部门归属识别门店；只有归属当前门店和账期的数据会出现在本页。"
          />
          <Typography.Text type="secondary">
            本次会重新读取该账期内已存在的审批详情，以同步审批状态和明细变更；已做对账的费用明细仍按现有保护规则处理。
          </Typography.Text>
          {storeSyncError ? <Alert type="error" showIcon message={storeSyncError} /> : null}
          {storeSyncResult ? (
            <Descriptions size="small" bordered column={1} title="同步结果">
              <Descriptions.Item label="已扫描审批">{storeSyncResult.scanned_count} 条</Descriptions.Item>
              <Descriptions.Item label="归入当前门店账期">{storeSyncResult.matched_count} 条</Descriptions.Item>
              <Descriptions.Item label="不属于当前范围">{storeSyncResult.outside_scope_count} 条</Descriptions.Item>
              <Descriptions.Item label="未能识别门店">{storeSyncResult.unresolved_store_count} 条</Descriptions.Item>
            </Descriptions>
          ) : null}
        </Space>
      </Modal>
      <Modal
        title="按修改时间重刷审批"
        open={isModifiedResyncModalOpen}
        onCancel={() => setIsModifiedResyncModalOpen(false)}
        onOk={() => modifiedResyncForm.submit()}
        okText="开始重刷"
        cancelText="关闭"
        confirmLoading={isStoreSyncing}
        destroyOnHidden
      >
        <Form form={modifiedResyncForm} layout="vertical" onFinish={startModifiedResync} initialValues={{ limit: 200 }}>
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item name="start_at" label="开始时间" rules={[{ required: true, message: "请选择开始时间" }]}>
                <DatePicker showTime className="full-width" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="end_at" label="结束时间" rules={[{ required: true, message: "请选择结束时间" }]}>
                <DatePicker showTime className="full-width" />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item name="template_id" label="审批模板">
            <Select
              allowClear
              placeholder="全部模板"
              options={templates.map((template) => ({ label: template.name, value: template.id }))}
            />
          </Form.Item>
          <Form.Item name="limit" label="最多重刷条数">
            <InputNumber className="full-width" min={1} max={1000} />
          </Form.Item>
        </Form>
      </Modal>
      <Drawer
        title={selectedApproval ? approvalTitle(selectedApproval) || selectedApproval.approval_no || "审批实例详情" : "审批实例详情"}
        open={Boolean(selectedApproval)}
        onClose={() => setSelectedApproval(null)}
        extra={selectedApproval ? <Button onClick={() => setSelectedApproval(null)}>关闭</Button> : null}
        width={1080}
        className="dingtalk-approval-detail"
      >
        {selectedApproval ? (
          <Space direction="vertical" size={16} className="full-width">
            <div className="dingtalk-approval-hero">
              <div className="dingtalk-approval-hero__main">
                <Space wrap size={8}>
                  <Tag color={approvalStatusMeta(selectedApproval.approval_status).color}>
                    {approvalStatusMeta(selectedApproval.approval_status).label}
                  </Tag>
                  <Tag>{templateNameById.get(selectedApproval.template_id) || "未知模板"}</Tag>
                </Space>
                <Typography.Title level={4}>
                  {approvalTitle(selectedApproval) || selectedApproval.approval_no || selectedApproval.dingtalk_instance_id}
                </Typography.Title>
                <Space wrap className="dingtalk-approval-hero__meta">
                  <span>申请人：{applicantDisplayName(selectedApproval)}</span>
                  <span>部门：{approvalDepartmentName(selectedApproval)}</span>
                  <span>提交：{formatBeijingDateTime(selectedApproval.submit_at)}</span>
                  <span>完成：{formatBeijingDateTime(selectedApproval.approved_at)}</span>
                </Space>
              </div>
            </div>

            <div className="dingtalk-approval-layout">
              <div className="dingtalk-approval-layout__main">
                <Card size="small" title="审批详情">
                  {selectedApprovalBasicFields.length ? (
                    <div className="dingtalk-approval-field-list">
                      {selectedApprovalBasicFields.map((field, index) => (
                        <div className="dingtalk-approval-field" key={`${fieldLabel(field)}-${index}`}>
                          <div className="dingtalk-approval-field__label">{fieldLabel(field)}</div>
                          <div className="dingtalk-approval-field__value">{renderDingTalkValue(fieldValue(field))}</div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <Typography.Text type="secondary">暂无审批字段</Typography.Text>
                  )}
                </Card>

                {selectedApprovalTables.map((table) => {
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
                  {detailAttachments.length ? (
                    <div className="dingtalk-attachment-list">
                      {detailAttachments.map((attachment) => {
                        const sourceUrl = externalAttachmentUrl(attachment);
                        const statusColor = attachment.download_status === "failed" ? "red" : "blue";
                        const statusLabel = attachment.download_status === "failed" ? "链接异常" : "在线查看";
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
                    {selectedApproval.raw_payload
                      ? JSON.stringify(selectedApprovalPayload ?? selectedApproval.raw_payload, null, 2)
                      : "-"}
                  </pre>
                </Card>
              </div>

              <div className="dingtalk-approval-layout__side">
                <Card size="small" title="流程">
                  {selectedApprovalOperations.length ? (
                    <div className="dingtalk-flow-list">
                      {selectedApprovalOperations.map((record, index) => (
                        <div className="dingtalk-flow-item" key={`operation-${index}`}>
                          <div className="dingtalk-flow-item__dot">{index + 1}</div>
                          <div className="dingtalk-flow-item__body">
                            <div className="dingtalk-flow-item__head">
                              <Typography.Text strong>{operationTitle(record, selectedApproval.node_name_map)}</Typography.Text>
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
                    <Descriptions.Item label="审批编号">{selectedApproval.approval_no || "-"}</Descriptions.Item>
                    <Descriptions.Item label="实例 ID">{selectedApproval.dingtalk_instance_id}</Descriptions.Item>
                    <Descriptions.Item label="申请人 User ID">{selectedApproval.applicant_user_id || "-"}</Descriptions.Item>
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
        width={760}
        onCancel={() => setImagePreview(null)}
      >
        {imagePreview ? <Image src={imagePreview.url} alt={imagePreview.title} width="100%" /> : null}
      </Modal>
      <Typography.Paragraph type="secondary" className="store-ledger-page-note">
        审批单列表不按账期筛选展示；账期仅用于同步本账期审批。
      </Typography.Paragraph>
    </AppShell>
  );
}
