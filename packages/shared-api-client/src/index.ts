import type {
  ApiEnvelope,
  ApprovalInstance,
  ApprovalParsePreview,
  ApprovalReparseRequest,
  ApprovalReparseResult,
  AttachmentAccessUrl,
  ApprovalTemplate,
  ApprovalTemplateCreate,
  ApprovalTemplateUpdate,
  Attachment,
  AuditLog,
  AutoMatchResult,
  BankImportPreviewResult,
  BankImportResult,
  BankImportRollbackResult,
  BankTransaction,
  BankTransactionCreate,
  BankTransactionUpdate,
  CurrentUser,
  DatabaseBackupStatus,
  DingTalkAutoSyncRunResult,
  DingTalkAutoSyncSetting,
  DingTalkAutoSyncSettingUpdate,
  DingTalkConfig,
  DingTalkDepartment,
  DingTalkDepartmentPullResult,
  DingTalkDepartmentSyncPreview,
  DingTalkDepartmentSyncResult,
  ExpenseBankMatch,
  ExpenseCategory,
  ExpenseCategoryCreate,
  ExpenseCategoryUpdate,
  ExpenseItem,
  ExpenseItemCreate,
  ExpenseItemUpdate,
  FinancialAnalyticsReport,
  FinancialAnalyticsDetailReport,
  Ledger,
  LedgerCloseCheck,
  LedgerCreate,
  LedgerPeriodOption,
  LedgerReportDetail,
  LedgerReportSummary,
  LedgerTrend,
  MatchCreate,
  Page,
  ReconciliationCandidateResult,
  ReconciliationRecord,
  ReconciliationRecordUpdate,
  ReportPeriodOption,
  RevenueChannel,
  RevenueChannelCreate,
  RevenueChannelUpdate,
  RevenueBankMatch,
  RevenueMatchCreate,
  RevenueRecord,
  RevenueRecordCreate,
  RevenueRecordUpdate,
  ResumeApprovalSyncRequest,
  ShareholderAccessGrant,
  ShareholderAccessGrantCreate,
  ShareholderAccessGrantUpdate,
  Store,
  StoreComparisonReport,
  StoreCreate,
  StoreUpdate,
  StoreLedgerWorkspace,
  StoreReportSummary,
  StartApprovalSyncRequest,
  Supplier,
  SupplierCreate,
  SupplierUpdate,
  SyncJob,
  SystemReadinessReport,
  TemplateFieldCandidate,
  TemplateFieldCandidateSampleRequest,
  TemplateFieldMapping,
  TemplateFieldMappingCreate,
  TemplateFieldMappingReorderRequest,
  TemplateSampleApprovalResult,
  UserAccount,
  UserAccountCreate,
  UserAccountUpdate,
} from "@fin-hub/shared-types";

export interface DingTalkConfigUpdate {
  corp_id?: string;
  app_key?: string;
  app_secret?: string;
  admin_user_id?: string;
  drive_union_id?: string;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface ChangePasswordRequest {
  current_password: string;
  new_password: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: unknown,
  ) {
    super(message);
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetcher?: typeof fetch;
}

export function createApiClient(options: ApiClientOptions) {
  const fetcher = options.fetcher ?? fetch;
  const baseUrl = options.baseUrl.replace(/\/$/, "");

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const isFormData = typeof FormData !== "undefined" && init?.body instanceof FormData;
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      credentials: "include",
      headers: {
        ...(isFormData ? {} : { "content-type": "application/json" }),
        ...(init?.headers ?? {}),
      },
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      throw new ApiError(response.statusText || "Request failed", response.status, payload);
    }
    return (payload as ApiEnvelope<T>).data ?? payload;
  }

  async function requestBlob(path: string, init?: RequestInit): Promise<Blob> {
    const response = await fetcher(`${baseUrl}${path}`, {
      ...init,
      credentials: "include",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new ApiError(response.statusText || "Request failed", response.status, payload);
    }
    return response.blob();
  }

  return {
    request,
    auth: {
      login: (payload: LoginRequest) =>
        request<CurrentUser>("/api/auth/login", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      logout: () => request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }),
      changePassword: (payload: ChangePasswordRequest) =>
        request<{ ok: boolean }>("/api/auth/change-password", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      me: () => request<CurrentUser>("/api/auth/me"),
      myStores: () => request<Store[]>("/api/auth/me/stores"),
    },
    system: {
      databaseBackupStatus: () =>
        request<DatabaseBackupStatus>("/api/system/database-backup/status"),
      readiness: () => request<SystemReadinessReport>("/api/system/readiness"),
      downloadDatabaseBackup: () => requestBlob("/api/system/database-backup/download"),
    },
    stores: {
      list: (params = "") => request<Page<Store>>(`/api/stores${params}`),
      create: (payload: StoreCreate) =>
        request<Store>("/api/stores", { method: "POST", body: JSON.stringify(payload) }),
      update: (id: string, payload: StoreUpdate) =>
        request<Store>(`/api/stores/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
    },
    storeLedgers: {
      workspace: (storeId: string, params = "") =>
        request<StoreLedgerWorkspace>(`/api/store-ledgers/${storeId}/workspace${params}`),
    },
    ledgers: {
      list: (params = "") => request<Page<Ledger>>(`/api/ledgers${params}`),
      create: (payload: LedgerCreate) =>
        request<Ledger>("/api/ledgers", { method: "POST", body: JSON.stringify(payload) }),
      closeCheck: (id: string) => request<LedgerCloseCheck>(`/api/ledgers/${id}/close-check`),
      close: (id: string, operator = "system") =>
        request<Ledger>(`/api/ledgers/${id}/close`, {
          method: "POST",
          body: JSON.stringify({ operator }),
        }),
      reopen: (id: string, operator = "system") =>
        request<Ledger>(`/api/ledgers/${id}/reopen`, {
          method: "POST",
          body: JSON.stringify({ operator }),
        }),
    },
    auditLogs: {
      list: (params = "") => request<Page<AuditLog>>(`/api/audit-logs${params}`),
    },
    users: {
      list: (params = "") => request<Page<UserAccount>>(`/api/users${params}`),
      create: (payload: UserAccountCreate) =>
        request<UserAccount>("/api/users", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      update: (id: string, payload: UserAccountUpdate) =>
        request<UserAccount>(`/api/users/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
    },
    shareholderGrants: {
      list: (params = "") => request<Page<ShareholderAccessGrant>>(`/api/shareholder-grants${params}`),
      create: (payload: ShareholderAccessGrantCreate) =>
        request<ShareholderAccessGrant>("/api/shareholder-grants", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      update: (id: string, payload: ShareholderAccessGrantUpdate) =>
        request<ShareholderAccessGrant>(`/api/shareholder-grants/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
    },
    categories: {
      list: (params = "") => request<Page<ExpenseCategory>>(`/api/categories${params}`),
      create: (payload: ExpenseCategoryCreate) =>
        request<ExpenseCategory>("/api/categories", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      update: (id: string, payload: ExpenseCategoryUpdate) =>
        request<ExpenseCategory>(`/api/categories/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
    },
    suppliers: {
      list: (params = "") => request<Page<Supplier>>(`/api/suppliers${params}`),
      create: (payload: SupplierCreate) =>
        request<Supplier>("/api/suppliers", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      update: (id: string, payload: SupplierUpdate) =>
        request<Supplier>(`/api/suppliers/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
    },
    expenseItems: {
      list: (params = "") => request<Page<ExpenseItem>>(`/api/expense-items${params}`),
      create: (payload: ExpenseItemCreate) =>
        request<ExpenseItem>("/api/expense-items", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      update: (id: string, payload: ExpenseItemUpdate) =>
        request<ExpenseItem>(`/api/expense-items/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
    },
    revenueChannels: {
      list: (params = "") => request<Page<RevenueChannel>>(`/api/revenue-channels${params}`),
      create: (payload: RevenueChannelCreate) =>
        request<RevenueChannel>("/api/revenue-channels", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      update: (id: string, payload: RevenueChannelUpdate) =>
        request<RevenueChannel>(`/api/revenue-channels/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
    },
    revenueRecords: {
      list: (params = "") => request<Page<RevenueRecord>>(`/api/revenue-records${params}`),
      create: (payload: RevenueRecordCreate) =>
        request<RevenueRecord>("/api/revenue-records", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      update: (id: string, payload: RevenueRecordUpdate) =>
        request<RevenueRecord>(`/api/revenue-records/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
      delete: (id: string) =>
        request<RevenueRecord>(`/api/revenue-records/${id}`, {
          method: "DELETE",
        }),
    },
    attachments: {
      list: (params = "") => request<Page<Attachment>>(`/api/attachments${params}`),
      upload: (resourceType: string, resourceId: string, formData: FormData) =>
        request<Attachment>(
          `/api/attachments?resource_type=${encodeURIComponent(resourceType)}&resource_id=${encodeURIComponent(resourceId)}`,
          {
            method: "POST",
            body: formData,
          },
        ),
      download: (id: string) => requestBlob(`/api/attachments/${id}/download`),
      accessUrl: (id: string) => request<AttachmentAccessUrl>(`/api/attachments/${id}/access-url`),
      downloadDingtalk: (id: string) =>
        request<Attachment>(`/api/attachments/${id}/download-dingtalk`, {
          method: "POST",
        }),
    },
    bankTransactions: {
      list: (params = "") => request<Page<BankTransaction>>(`/api/bank-transactions${params}`),
      create: (payload: BankTransactionCreate) =>
        request<BankTransaction>("/api/bank-transactions", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      update: (id: string, payload: BankTransactionUpdate) =>
        request<BankTransaction>(`/api/bank-transactions/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
      delete: (id: string) =>
        request<BankTransaction>(`/api/bank-transactions/${id}`, {
          method: "DELETE",
        }),
      importFile: (payload: FormData) =>
        request<BankImportResult>("/api/bank-transactions/import", {
          method: "POST",
          body: payload,
          headers: {},
        }),
      previewImport: (payload: FormData) =>
        request<BankImportPreviewResult>("/api/bank-transactions/import/preview", {
          method: "POST",
          body: payload,
          headers: {},
        }),
      downloadImportTemplate: () => requestBlob("/api/bank-transactions/import/template.csv"),
      rollbackImport: (jobId: string, operator = "admin") =>
        request<BankImportRollbackResult>(
          `/api/bank-transactions/imports/${jobId}/rollback?operator=${encodeURIComponent(operator)}`,
          { method: "POST" },
        ),
      importCsv: (payload: FormData) =>
        request<BankImportResult>("/api/bank-transactions/import-csv", {
          method: "POST",
          body: payload,
          headers: {},
        }),
    },
    matches: {
      list: (params = "") => request<Page<ExpenseBankMatch>>(`/api/matches${params}`),
      create: (payload: MatchCreate) =>
        request<ExpenseBankMatch>("/api/matches", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      autoSuggest: (params = "") =>
        request<AutoMatchResult>(`/api/matches/auto-suggest${params}`, {
          method: "POST",
        }),
      reconciliationCandidates: (params = "") =>
        request<ReconciliationCandidateResult>(`/api/matches/reconciliation/candidates${params}`),
      reconciliationRecords: (params = "") =>
        request<Page<ReconciliationRecord>>(`/api/matches/reconciliation/records${params}`),
      updateReconciliationRecord: (id: string, payload: ReconciliationRecordUpdate) =>
        request<ExpenseBankMatch>(`/api/matches/reconciliation/records/${id}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
      unmatchReconciliationRecord: (id: string) =>
        request<ExpenseBankMatch>(`/api/matches/reconciliation/records/${id}/unmatch`, {
          method: "POST",
        }),
      confirm: (id: string, operator = "admin") =>
        request<ExpenseBankMatch>(`/api/matches/${id}/confirm?operator=${encodeURIComponent(operator)}`, {
          method: "POST",
        }),
      reject: (id: string) =>
        request<ExpenseBankMatch>(`/api/matches/${id}/reject`, {
          method: "POST",
        }),
      listRevenue: (params = "") => request<Page<RevenueBankMatch>>(`/api/matches/revenue${params}`),
      createRevenue: (payload: RevenueMatchCreate) =>
        request<RevenueBankMatch>("/api/matches/revenue", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      confirmRevenue: (id: string, operator = "admin") =>
        request<RevenueBankMatch>(`/api/matches/revenue/${id}/confirm?operator=${encodeURIComponent(operator)}`, {
          method: "POST",
        }),
      rejectRevenue: (id: string) =>
        request<RevenueBankMatch>(`/api/matches/revenue/${id}/reject`, {
          method: "POST",
        }),
      unmatchRevenue: (id: string) =>
        request<RevenueBankMatch>(`/api/matches/revenue/${id}/unmatch`, {
          method: "POST",
        }),
    },
    dingtalk: {
      readConfig: () => request<DingTalkConfig>("/api/dingtalk/config"),
      updateConfig: (payload: DingTalkConfigUpdate) =>
        request<DingTalkConfig>("/api/dingtalk/config", {
          method: "PUT",
          body: JSON.stringify(payload),
        }),
      readAutoSyncSetting: () =>
        request<DingTalkAutoSyncSetting>("/api/dingtalk/auto-sync/settings"),
      updateAutoSyncSetting: (payload: DingTalkAutoSyncSettingUpdate) =>
        request<DingTalkAutoSyncSetting>("/api/dingtalk/auto-sync/settings", {
          method: "PUT",
          body: JSON.stringify(payload),
        }),
      runAutoSync: () =>
        request<DingTalkAutoSyncRunResult>("/api/dingtalk/auto-sync/run", {
          method: "POST",
        }),
      testConnection: () =>
        request<{ status: string; access_token_prefix: string }>("/api/dingtalk/connection-test", {
          method: "POST",
        }),
      pullDepartments: (params = "") =>
        request<DingTalkDepartmentPullResult>(`/api/dingtalk/departments/pull${params}`, { method: "POST" }),
      listDepartments: (params = "") => request<DingTalkDepartment[]>(`/api/dingtalk/departments${params}`),
      previewDepartmentSync: (params = "") =>
        request<DingTalkDepartmentSyncPreview>(`/api/dingtalk/departments/sync-preview${params}`),
      syncDepartments: (params = "") =>
        request<DingTalkDepartmentSyncResult>(`/api/dingtalk/departments/sync${params}`, { method: "POST" }),
      listTemplates: (params = "") => request<Page<ApprovalTemplate>>(`/api/dingtalk/templates${params}`),
      createTemplate: (payload: ApprovalTemplateCreate) =>
        request<ApprovalTemplate>("/api/dingtalk/templates", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      updateTemplate: (templateId: string, payload: ApprovalTemplateUpdate) =>
        request<ApprovalTemplate>(`/api/dingtalk/templates/${templateId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
      syncTemplates: () =>
        request<{ pulled: number; created: number; updated: number }>("/api/dingtalk/templates/sync", {
          method: "POST",
        }),
      listMappings: (templateId: string) =>
        request<TemplateFieldMapping[]>(`/api/dingtalk/templates/${templateId}/mappings`),
      listFieldCandidates: (templateId: string) =>
        request<TemplateFieldCandidate[]>(`/api/dingtalk/templates/${templateId}/field-candidates`),
      pullTemplateSampleApproval: (templateId: string) =>
        request<TemplateSampleApprovalResult>(`/api/dingtalk/templates/${templateId}/sample-approval`, {
          method: "POST",
        }),
      useApprovalInstanceAsFieldCandidateSample: (templateId: string, payload: TemplateFieldCandidateSampleRequest) =>
        request<TemplateSampleApprovalResult>(`/api/dingtalk/templates/${templateId}/field-candidate-sample`, {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      upsertMapping: (templateId: string, payload: TemplateFieldMappingCreate) =>
        request<TemplateFieldMapping>(`/api/dingtalk/templates/${templateId}/mappings`, {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      updateMapping: (templateId: string, mappingId: string, payload: TemplateFieldMappingCreate) =>
        request<TemplateFieldMapping>(`/api/dingtalk/templates/${templateId}/mappings/${mappingId}`, {
          method: "PATCH",
          body: JSON.stringify(payload),
        }),
      reorderMappings: (templateId: string, payload: TemplateFieldMappingReorderRequest) =>
        request<TemplateFieldMapping[]>(`/api/dingtalk/templates/${templateId}/mappings/reorder`, {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      deleteMapping: (templateId: string, mappingId: string) =>
        request<{ ok: boolean }>(`/api/dingtalk/templates/${templateId}/mappings/${mappingId}`, {
          method: "DELETE",
        }),
      previewTemplateParse: (templateId: string, params = "") =>
        request<ApprovalParsePreview>(`/api/dingtalk/templates/${templateId}/parse-preview${params}`),
      reparseTemplate: (templateId: string, payload: ApprovalReparseRequest) =>
        request<ApprovalReparseResult>(`/api/dingtalk/templates/${templateId}/reparse`, {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      startApprovalSync: (payload: StartApprovalSyncRequest) =>
        request<SyncJob>("/api/dingtalk/approval-sync", {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      resumeApprovalSync: (jobId: string, payload: ResumeApprovalSyncRequest) =>
        request<SyncJob>(`/api/dingtalk/sync-jobs/${jobId}/resume`, {
          method: "POST",
          body: JSON.stringify(payload),
        }),
      listSyncJobs: (params = "") => request<Page<SyncJob>>(`/api/dingtalk/sync-jobs${params}`),
      listApprovalInstances: (params = "") =>
        request<Page<ApprovalInstance>>(`/api/dingtalk/approval-instances${params}`),
    },
    reports: {
      analytics: (params = "") => request<FinancialAnalyticsReport>(`/api/reports/analytics${params}`),
      analyticsDetails: (params = "") =>
        request<FinancialAnalyticsDetailReport>(`/api/reports/analytics/details${params}`),
      storeSummaries: () => request<StoreReportSummary[]>("/api/reports/store-summaries"),
      reportPeriods: () => request<ReportPeriodOption[]>("/api/reports/periods"),
      ledgerPeriods: (storeId: string) =>
        request<LedgerPeriodOption[]>(`/api/reports/ledger-periods?store_id=${encodeURIComponent(storeId)}`),
      ledgerTrends: (params = "") => request<LedgerTrend[]>(`/api/reports/ledger-trends${params}`),
      storeComparison: (params = "") => request<StoreComparisonReport>(`/api/reports/store-comparison${params}`),
      ledgerSummary: (storeId: string, period: string) =>
        request<LedgerReportSummary>(
          `/api/reports/ledger-summary?store_id=${encodeURIComponent(storeId)}&period=${encodeURIComponent(period)}`,
        ),
      ledgerDetail: (storeId: string, period: string) =>
        request<LedgerReportDetail>(
          `/api/reports/ledger-detail?store_id=${encodeURIComponent(storeId)}&period=${encodeURIComponent(period)}`,
        ),
      exportLedgerDetailCsv: (storeId: string, period: string) =>
        requestBlob(
          `/api/reports/ledger-detail.csv?store_id=${encodeURIComponent(storeId)}&period=${encodeURIComponent(period)}`,
        ),
      exportLedgerDetailXlsx: (storeId: string, period: string) =>
        requestBlob(
          `/api/reports/ledger-detail.xlsx?store_id=${encodeURIComponent(storeId)}&period=${encodeURIComponent(period)}`,
        ),
    },
  };
}
