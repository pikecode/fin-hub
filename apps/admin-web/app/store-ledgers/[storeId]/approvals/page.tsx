"use client";

import { Alert, Button, Card, DatePicker, Descriptions, Drawer, Empty, Image, Input, Modal, Select, Space, Table, Tag, Tooltip, Typography, message } from "antd";
import dayjs from "dayjs";
import zhCN from "antd/locale/zh_CN";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ApprovalInstance, ApprovalTemplate, Attachment, Store } from "@fin-hub/shared-types";
import { AppShell } from "../../../components/AppShell";
import { EnterpriseTable } from "../../../components/EnterpriseTable";
import type { EnterpriseTableColumn } from "../../../components/EnterpriseTable";
import { StoreLedgerWorkspaceNav } from "../../../components/StoreLedgerWorkspaceNav";
import { apiClient } from "../../../lib/api";
import { getApprovalTemplates, getStores } from "../../../lib/referenceData";
import { useClientSearchParams } from "../../../lib/searchParams";

type SyncDateRange = [dayjs.Dayjs, dayjs.Dayjs];

function syncRangeForPeriod(period: string): SyncDateRange | null {
  const periodStart = dayjs(`${period}-01`);
  if (!periodStart.isValid()) return null;
  const start = periodStart.startOf("day");
  const end = periodStart.add(1, "month").subtract(1, "day").endOf("day");
  const latestAllowed = dayjs().endOf("day");
  if (start.isAfter(latestAllowed)) return null;
  return [start, end.isAfter(latestAllowed) ? latestAllowed : end];
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

const APPROVAL_LIST_PAGE_SIZE = 20;
const MANUAL_MATCH_CUTOFF_DATE = "2026-09-30";

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

function formatBeijingDate(value?: string | null) {
  const formatted = formatBeijingDateTime(value);
  return formatted === "-" ? "" : formatted.slice(0, 10);
}

function manualMarkDisabledReason(instance: ApprovalInstance) {
  const submitDate = formatBeijingDate(instance.submit_at);
  if (!submitDate) return "审批单缺少申请日期，无法手动标记";
  if (submitDate >= MANUAL_MATCH_CUTOFF_DATE) return "仅支持申请日期为2026年9月30日前的审批单手动标记已匹配";
  return "";
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
  if (instance.title) return instance.title;
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
    matched: { label: "已匹配", color: "green" },
    manual_matched: { label: "已匹配", color: "green" },
    partial_matched: { label: "已匹配", color: "green" },
    pending_match: { label: "未匹配", color: "gold" },
    pending_classification: { label: "未匹配", color: "gold" },
    sync_conflict: { label: "未匹配", color: "gold" },
    unparsed: { label: "未匹配", color: "gold" },
  };
  return statusMap[normalized] ?? { label: "未匹配", color: "gold" };
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
  const [templates, setTemplates] = useState<ApprovalTemplate[]>([]);
  const [approvals, setApprovals] = useState<ApprovalInstance[]>([]);
  const [selectedApproval, setSelectedApproval] = useState<ApprovalInstance | null>(null);
  const [detailAttachments, setDetailAttachments] = useState<Attachment[]>([]);
  const [imagePreview, setImagePreview] = useState<ImagePreviewState | null>(null);
  const [keyword, setKeyword] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [approvalPage, setApprovalPage] = useState(1);
  const [approvalPageSize, setApprovalPageSize] = useState(APPROVAL_LIST_PAGE_SIZE);
  const [approvalTotal, setApprovalTotal] = useState(0);
  const [approvalReload, setApprovalReload] = useState(0);
  const detailRequest = useRef(0);
  const [isDetailLoading, setIsDetailLoading] = useState(false);

  const [applicationDateRange, setApplicationDateRange] = useState<SyncDateRange | null>(null);
  const [templateFilter, setTemplateFilter] = useState<string>();
  const [approvalStatusFilter, setApprovalStatusFilter] = useState<string>();
  const [matchStatusFilter, setMatchStatusFilter] = useState<string>();
  const [isLoading, setIsLoading] = useState(true);
  const [isApprovalLoading, setIsApprovalLoading] = useState(false);
  const [isStoreSyncing, setIsStoreSyncing] = useState(false);
  const [selectedApprovalIds, setSelectedApprovalIds] = useState<React.Key[]>([]);
  const [batchAction, setBatchAction] = useState<"mark" | "unmark" | null>(null);
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null);
  const [pendingMarkApproval, setPendingMarkApproval] = useState<ApprovalInstance | null>(null);
  const [markingApprovalId, setMarkingApprovalId] = useState<string | null>(null);
  const [isSyncModalOpen, setIsSyncModalOpen] = useState(false);
  const [syncDateRange, setSyncDateRange] = useState<SyncDateRange | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => { setSelectedApprovalIds([]); }, [storeId]);

  useEffect(() => {
    let ignore = false;
    async function loadData() {
      setIsLoading(true);
      setErrorMessage(null);
      try {
        const [storePage, templatePage] = await Promise.all([getStores(), getApprovalTemplates(500)]);
        if (!ignore) {
          setStore(storePage.find((item) => item.id === storeId) ?? null);
          setTemplates(templatePage);
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
  }, [storeId]);

  useEffect(() => {
    let ignore = false;
    async function loadApprovals() {
      if (!storeId) return;
      setIsApprovalLoading(true);
      setApprovals([]);
      setSelectedApprovalIds([]);
      setErrorMessage(null);
      try {
        const query = new URLSearchParams({ store_id: storeId, page: String(approvalPage), page_size: String(approvalPageSize), compact: "true" });
        if (searchKeyword.trim()) query.set("keyword", searchKeyword.trim());
        if (applicationDateRange) {
          query.set("submit_date_start", applicationDateRange[0].format("YYYY-MM-DD"));
          query.set("submit_date_end", applicationDateRange[1].format("YYYY-MM-DD"));
        }
        if (templateFilter) query.set("template_id", templateFilter);
        if (approvalStatusFilter) query.set("approval_status", approvalStatusFilter);
        if (matchStatusFilter) query.set("match_status", matchStatusFilter);
        const result = await apiClient.dingtalk.listApprovalInstances(`?${query}`);
        if (!ignore) {
          setApprovalTotal(result.total);
          const lastPage = Math.max(1, Math.ceil(result.total / approvalPageSize));
          if (approvalPage > lastPage) { setApprovalPage(lastPage); return; }
          setApprovals(result.items);
          setSelectedApprovalIds([]);
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
  }, [searchKeyword, storeId, approvalPage, approvalPageSize, templateFilter, approvalStatusFilter, matchStatusFilter, applicationDateRange, approvalReload]);

  const templateNameById = useMemo(
    () => new Map(templates.map((template) => [template.id, template.name])),
    [templates],
  );
  const templateSelectOptions = templates.filter((item) => item.is_enabled).map((item) => ({ label: item.name, value: item.id }));
  const approvalStatusSelectOptions = ["已通过", "已完成", "已撤销", "已取消", "已拒绝", "审批中"].map((value) => ({ label: value, value }));
  const approvalMatchStatusSelectOptions = ["已匹配", "未匹配"].map((value) => ({ label: value, value }));

  async function syncApprovalsByModifiedTime() {
    const range = syncDateRange;
    if (!range) {
      message.warning("请先选择日期范围");
      return;
    }
    setIsStoreSyncing(true);
    setErrorMessage(null);
    try {
      const result = await apiClient.dingtalk.resyncApprovalsByModifiedTime({
        store_id: storeId,
        start_at: range[0].toISOString(),
        end_at: range[1].toISOString(),
        started_by: "store-ledger",
      });
      setIsSyncModalOpen(false);
      setApprovalReload((value) => value + 1);
      message.success(`同步完成：处理 ${result.processed_count} 条，更新 ${result.updated_count} 条`);
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "无法同步审批单";
      setErrorMessage(nextError);
      message.error(nextError);
    } finally {
      setIsStoreSyncing(false);
    }
  }

  function openSyncModal() {
    setSyncDateRange(null);
    setIsSyncModalOpen(true);
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
    setIsDetailLoading(true);
    const request = ++detailRequest.current;
    try {
      setDetailAttachments([]);
      const [detail, attachmentPage] = await Promise.all([
        apiClient.dingtalk.readApprovalInstance(approval.id),
        apiClient.attachments.list(`?resource_type=approval_instance&resource_id=${encodeURIComponent(approval.id)}&page_size=100`),
      ]);
      if (request !== detailRequest.current) return;
      setSelectedApproval((current) => current?.id === approval.id ? detail : current);
      setDetailAttachments(attachmentPage.items);
    } catch (error) {
      if (request === detailRequest.current) setErrorMessage(error instanceof Error ? error.message : "无法加载审批单详情");
    } finally {
      if (request === detailRequest.current) setIsDetailLoading(false);
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

  async function executeMarkApprovalMatched(approval: ApprovalInstance) {
    setMarkingApprovalId(approval.id);
    setErrorMessage(null);
    try {
      const updated = await (approval.processing_status === "manual_matched"
        ? apiClient.dingtalk.unmarkApprovalInstanceMatched(approval.id)
        : apiClient.dingtalk.markApprovalInstanceMatched(approval.id));
      setApprovals((items) => items.map((item) => (item.id === updated.id ? updated : item)));
      if (selectedApproval?.id === updated.id) setSelectedApproval(updated);
      setApprovalReload((value) => value + 1);
      setPendingMarkApproval(null);
      message.success(approval.processing_status === "manual_matched" ? "已撤销标记，恢复未匹配" : "已标记为已匹配");
    } catch (error) {
      const nextError = error instanceof Error ? error.message : "标记已匹配失败";
      setErrorMessage(nextError);
      message.error(nextError);
    } finally {
      setMarkingApprovalId(null);
    }
  }

  function confirmMarkApprovalMatched(approval: ApprovalInstance) {
    const reason = approval.processing_status === "manual_matched" ? "" : manualMarkDisabledReason(approval);
    if (reason) {
      setErrorMessage(reason);
      message.warning(reason);
      return;
    }
    setPendingMarkApproval(approval);
  }

  const batchCandidates = approvals.filter((approval) => selectedApprovalIds.includes(approval.id) && (
    batchAction === "unmark"
      ? approval.processing_status === "manual_matched"
      : !manualMarkDisabledReason(approval) && !["matched", "manual_matched", "partial_matched"].includes(approval.processing_status)
  ));

  async function executeBatchAction() {
    if (!batchAction || batchProgress) return;
    const candidates = [...batchCandidates];
    const successfulIds = new Set<string>();
    const failures: string[] = [];
    setErrorMessage(null);
    setBatchProgress({ done: 0, total: candidates.length });
    try {
      for (const approval of candidates) {
        try {
          const updated = await (batchAction === "mark"
            ? apiClient.dingtalk.markApprovalInstanceMatched(approval.id)
            : apiClient.dingtalk.unmarkApprovalInstanceMatched(approval.id));
          successfulIds.add(approval.id);
          setApprovals((items) => items.map((item) => item.id === updated.id ? updated : item));
          setSelectedApproval((item) => item?.id === updated.id ? updated : item);
        } catch (error) {
          failures.push(`${approval.approval_no || approval.id}：${error instanceof Error ? error.message : "操作失败"}`);
        }
        setBatchProgress((progress) => progress ? { ...progress, done: progress.done + 1 } : progress);
      }
      setSelectedApprovalIds((ids) => ids.filter((id) => !successfulIds.has(String(id))));
      if (failures.length) setErrorMessage(`成功 ${successfulIds.size} 条，失败 ${failures.length} 条。${failures.join("；")}`);
      else message.success(`已完成 ${successfulIds.size} 条操作`);
      setApprovalReload((value) => value + 1);
      setBatchAction(null);
    } finally {
      setBatchProgress(null);
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
      width: 190,
      className: "table-action-column",
      render: (_, record) => {
        const isMatched = approvalMatchStatusMeta(record.processing_status).label === "已匹配";
        const disabledReason = manualMarkDisabledReason(record);
        const markButton = (
          <Button
            type="link"
            size="small"
            loading={markingApprovalId === record.id}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              confirmMarkApprovalMatched(record);
            }}
          >
            {record.processing_status === "manual_matched" ? "撤销标记" : "标记已匹配"}
          </Button>
        );
        return (
          <Space size={4}>
            <Button
              type="link"
              size="small"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                openApprovalDetail(record);
              }}
            >
              详情
            </Button>
            {record.processing_status === "manual_matched" ? markButton : isMatched ? null : disabledReason ? <Tooltip title={disabledReason}><span>{markButton}</span></Tooltip> : markButton}
          </Space>
        );
      },
    },
  ];
  return (
    <AppShell
      title={store?.name ? `${store.name} · 审批单管理` : "审批单管理"}
      kicker={store?.name ? "按门店展示全部审批单" : undefined}
    >
      <StoreLedgerWorkspaceNav
        storeId={storeId}
        storeName={store?.name}
        statusLabel={store?.status === "active" ? "启用门店" : store ? "停用门店" : undefined}
        activeKey="approvals"
      />
      {errorMessage ? <Alert className="dashboard-alert" message={errorMessage} type="warning" showIcon /> : null}
      <Card
        title="审批单列表"
        loading={isLoading}
        extra={
          <Space size={8} wrap>
            <DatePicker.RangePicker
              locale={zhCN.DatePicker}
              value={applicationDateRange}
              format="YYYY-MM-DD"
              placeholder={["申请开始日期", "申请结束日期"]}
              allowClear
              onChange={(dates) => { setApplicationDateRange(dates as SyncDateRange | null); setApprovalPage(1); }}
              style={{ width: 280 }}
            />
            <Input.Search
              allowClear
              placeholder="搜索编号、申请人、部门"
              value={keyword}
              onChange={(event) => { setKeyword(event.target.value); if (!event.target.value) { setSearchKeyword(""); setApprovalPage(1); } }}
              onSearch={(value) => { setSearchKeyword(value); setApprovalPage(1); }}
              style={{ width: 220 }}
            />
            <Select
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="模板"
              value={templateFilter}
              options={templateSelectOptions}
              onChange={(value) => { setTemplateFilter(value); setApprovalPage(1); }}
              style={{ width: 180 }}
            />
            <Select
              allowClear
              placeholder="状态"
              value={approvalStatusFilter}
              options={approvalStatusSelectOptions}
              onChange={(value) => { setApprovalStatusFilter(value); setApprovalPage(1); }}
              style={{ width: 110 }}
            />
            <Select
              allowClear
              placeholder="匹配状态"
              value={matchStatusFilter}
              options={approvalMatchStatusSelectOptions}
              onChange={(value) => { setMatchStatusFilter(value); setApprovalPage(1); }}
              style={{ width: 130 }}
            />
            <Button type="primary" loading={isStoreSyncing} onClick={openSyncModal}>
              同步审批单
            </Button>
          </Space>
        }
      >
        <Space wrap style={{ marginBottom: 16 }}>
          <Typography.Text type="secondary">已选择 {selectedApprovalIds.length} 条</Typography.Text>
          <Button disabled={!selectedApprovalIds.length || Boolean(batchProgress)} onClick={() => setBatchAction("mark")}>批量标记已匹配</Button>
          <Button disabled={!selectedApprovalIds.length || Boolean(batchProgress)} onClick={() => setBatchAction("unmark")}>批量撤销标记</Button>
          {selectedApprovalIds.length ? <Button type="link" disabled={Boolean(batchProgress)} onClick={() => setSelectedApprovalIds([])}>取消选择</Button> : null}
        </Space>
        {approvalTotal || isApprovalLoading ? (
          <EnterpriseTable<ApprovalInstance>
            rowSelection={{ selectedRowKeys: selectedApprovalIds, onChange: setSelectedApprovalIds, getCheckboxProps: () => ({ disabled: Boolean(batchProgress) }) }}
            rowKey="id"
            loading={isLoading || isApprovalLoading}
            columns={columns}
            dataSource={approvals}
            onRow={(record) => ({ onDoubleClick: () => openApprovalDetail(record) })}
            pagination={{ current: approvalPage, pageSize: approvalPageSize, total: approvalTotal, showSizeChanger: true, pageSizeOptions: [20, 50, 100, 200], showTotal: (total) => `共 ${total} 条`, onChange: (page, size) => { setApprovalPageSize(size); setApprovalPage(size !== approvalPageSize ? 1 : page); } }}
            showDensityToggle
            showColumnSettings
            fixedColumns={{ left: ["approval_no"], right: ["actions"] }}
          />
        ) : (
          <Empty description="当前门店暂无审批单" />
        )}
      </Card>
      <Modal
        title="同步审批单"
        open={isSyncModalOpen}
        onCancel={() => setIsSyncModalOpen(false)}
        onOk={() => void syncApprovalsByModifiedTime()}
        okText="开始同步"
        cancelText="关闭"
        confirmLoading={isStoreSyncing}
        okButtonProps={{ disabled: !syncDateRange }}
        destroyOnHidden
      >
        <Space direction="vertical" size={16} className="full-width">
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="门店">{store?.name ?? "-"}</Descriptions.Item>
          </Descriptions>
          <div>
            <Typography.Text strong>修改时间范围</Typography.Text>
            <DatePicker.RangePicker
              className="full-width"
              value={syncDateRange}
              format="YYYY-MM-DD"
              showTime
              disabled={isStoreSyncing}
              disabledDate={(current) => current.isAfter(dayjs(), "day")}
              onChange={(dates) => {
                setSyncDateRange(dates as SyncDateRange | null);
              }}
            />
            <Typography.Text type="secondary">仅同步最后修改时间落在所选范围内的本店审批单，按修改时间增量重刷。</Typography.Text>
          </div>
          <Alert
            type="info"
            showIcon
            message="同步说明"
            description="按所选日期范围同步当前门店最后修改时间落在范围内的审批单，做增量重刷。"
          />
        </Space>
      </Modal>
      <Drawer
        title={selectedApproval ? approvalTitle(selectedApproval) || selectedApproval.approval_no || "审批实例详情" : "审批实例详情"}
        open={Boolean(selectedApproval)}
        loading={isDetailLoading}
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
        title={batchAction === "unmark" ? "批量撤销已匹配标记" : "批量标记已匹配"}
        open={Boolean(batchAction)}
        okText={batchProgress ? `处理中 ${batchProgress.done}/${batchProgress.total}` : "确认"}
        cancelText="取消"
        confirmLoading={Boolean(batchProgress)}
        okButtonProps={{ disabled: !batchCandidates.length }}
        cancelButtonProps={{ disabled: Boolean(batchProgress) }}
        closable={!batchProgress}
        maskClosable={!batchProgress}
        onCancel={() => { if (!batchProgress) setBatchAction(null); }}
        onOk={() => void executeBatchAction()}
      >
        <Typography.Paragraph>已选择 {selectedApprovalIds.length} 条，可操作 {batchCandidates.length} 条，其余 {selectedApprovalIds.length - batchCandidates.length} 条将跳过。</Typography.Paragraph>
        <Typography.Paragraph type="secondary">{batchAction === "unmark" ? "仅撤销手动已匹配标记，实际银行流水对账记录不支持此操作。" : "仅处理申请日期为2026年9月30日前、未匹配的审批单。"}</Typography.Paragraph>
      </Modal>
      <Modal
        title={pendingMarkApproval?.processing_status === "manual_matched" ? "确认撤销已匹配标记？" : "确认标记为已匹配？"}
        open={Boolean(pendingMarkApproval)}
        okText="确认"
        cancelText="取消"
        confirmLoading={Boolean(markingApprovalId)}
        onCancel={() => { if (!markingApprovalId) setPendingMarkApproval(null); }}
        onOk={() => { if (pendingMarkApproval && !markingApprovalId) void executeMarkApprovalMatched(pendingMarkApproval); }}
      >
        <Typography.Paragraph>确认将审批单 {pendingMarkApproval?.approval_no || ""} {pendingMarkApproval?.processing_status === "manual_matched" ? "恢复为未匹配？" : "标记为已匹配？"}</Typography.Paragraph>
        <Typography.Paragraph type="secondary">该操作仅修改审批单匹配状态，不会生成银行流水匹配记录。</Typography.Paragraph>
      </Modal>
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
        审批单列表按门店展示；同步时可按修改时间范围增量重刷。
      </Typography.Paragraph>
    </AppShell>
  );
}
