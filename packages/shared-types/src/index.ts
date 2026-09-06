export type LedgerStatus = "open" | "closed";
export type StoreStatus = "active" | "inactive";
export type MoneyDirection = "income" | "expense";
export type MatchStatus = "candidate" | "confirmed" | "rejected";
export type AttachmentStatus = "stored" | "placeholder" | "failed";
export type ExpensePaymentStatus = "unpaid" | "partial_paid" | "paid" | "no_bank_flow";
export type UserRole = string;
export type PermissionKey =
  | "dashboard.view"
  | "reconciliation.view"
  | "reconciliation.manage"
  | "dingtalk.view"
  | "dingtalk.manage"
  | "reports.view"
  | "revenue.view"
  | "revenue.manage"
  | "stores.view"
  | "stores.manage"
  | "categories.view"
  | "categories.manage"
  | "users.view"
  | "users.manage"
  | "audit.view"
  | "settings.manage";
export type MasterDataStatus = "active" | "inactive";

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}

export interface Store {
  id: string;
  name: string;
  group_id?: string | null;
  dingtalk_dept_id?: string | null;
  status: StoreStatus;
  contact_person?: string | null;
  phone?: string | null;
  address?: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoreCreate {
  name: string;
  group_id?: string | null;
  dingtalk_dept_id?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  address?: string | null;
}

export interface StoreUpdate {
  name?: string | null;
  group_id?: string | null;
  dingtalk_dept_id?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  address?: string | null;
  status?: StoreStatus | null;
}

export interface StoreGroup {
  id: string;
  name: string;
  sort_order: number;
  store_count: number;
  created_at: string;
  updated_at: string;
}

export interface StoreGroupCreate {
  name: string;
  sort_order?: number;
}

export interface StoreGroupUpdate {
  name?: string | null;
  sort_order?: number | null;
}

export interface Ledger {
  id: string;
  store_id: string;
  period: string;
  status: LedgerStatus;
  version: number;
  closed_at?: string | null;
  closed_by?: string | null;
  reopened_at?: string | null;
  reopened_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface LedgerCreate {
  store_id: string;
  period: string;
}

export interface LedgerCloseCheck {
  can_close: boolean;
  unpaid_expense_count: number;
  unmatched_bank_transaction_count: number;
  candidate_match_count: number;
  revenue_record_count: number;
  unmatched_revenue_record_count: number;
  unmatched_revenue_amount: string;
  issues: string[];
  warnings: string[];
}

export interface DatabaseBackupStatus {
  supported: boolean;
  backend: string;
  database_path?: string | null;
  message: string;
}

export interface SystemReadinessCheck {
  key: string;
  name: string;
  status: "ok" | "warning" | "error";
  detail: string;
}

export interface SystemReadinessReport {
  environment: string;
  ready: boolean;
  checks: SystemReadinessCheck[];
}

export interface RevenueRecord {
  id: string;
  store_id: string;
  ledger_period: string;
  revenue_date: string;
  channel: string;
  gross_amount: string;
  net_amount: string;
  fee_amount: string;
  remark?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RevenueRecordCreate {
  store_id: string;
  ledger_period?: string | null;
  revenue_date: string;
  channel: string;
  gross_amount: string;
  net_amount: string;
  fee_amount?: string;
  remark?: string | null;
}

export interface RevenueRecordUpdate {
  store_id?: string | null;
  ledger_period?: string | null;
  revenue_date?: string;
  channel?: string | null;
  gross_amount?: string | null;
  net_amount?: string | null;
  fee_amount?: string | null;
  remark?: string | null;
}

export interface RevenueChannel {
  id: string;
  name: string;
  sort_order: number;
  requires_bank_match: boolean;
  scope_mode: "all_stores" | "selected_stores";
  status: MasterDataStatus;
  store_ids?: string[];
  deleted_at?: string | null;
  deleted_by?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RevenueChannelCreate {
  name: string;
  sort_order?: number;
  requires_bank_match?: boolean;
  scope_mode?: "all_stores" | "selected_stores";
  store_ids?: string[];
}

export interface RevenueChannelUpdate {
  name?: string | null;
  sort_order?: number | null;
  requires_bank_match?: boolean | null;
  scope_mode?: "all_stores" | "selected_stores" | null;
  store_ids?: string[] | null;
  status?: MasterDataStatus | null;
}

export interface ExpenseCategory {
  id: string;
  name: string;
  parent_id?: string | null;
  sort_order: number;
  status: MasterDataStatus;
  created_at: string;
  updated_at: string;
}

export interface ExpenseCategoryCreate {
  name: string;
  parent_id?: string | null;
  sort_order?: number;
}

export interface ExpenseCategoryUpdate {
  name?: string | null;
  parent_id?: string | null;
  sort_order?: number | null;
  status?: MasterDataStatus | null;
}

export interface Supplier {
  id: string;
  name: string;
  bank_account?: string | null;
  contact_name?: string | null;
  phone?: string | null;
  remark?: string | null;
  status: MasterDataStatus;
  created_at: string;
  updated_at: string;
}

export interface SupplierCreate {
  name: string;
  bank_account?: string | null;
  contact_name?: string | null;
  phone?: string | null;
  remark?: string | null;
}

export interface SupplierUpdate {
  name?: string | null;
  bank_account?: string | null;
  contact_name?: string | null;
  phone?: string | null;
  remark?: string | null;
  status?: MasterDataStatus | null;
}

export interface AuditLog {
  id: string;
  actor: string;
  action: string;
  resource_type: string;
  resource_id?: string | null;
  summary?: string | null;
  metadata_json?: string | null;
  created_at: string;
}

export interface UserAccount {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  status: "active" | "disabled";
  last_login_at?: string | null;
  created_at: string;
  updated_at: string;
  permissions: PermissionKey[];
  store_ids: string[];
  store_group_ids: string[];
}

export interface UserAccountCreate {
  username: string;
  display_name: string;
  password: string;
  role: UserRole;
  store_ids?: string[];
  store_group_ids?: string[];
}

export interface UserAccountUpdate {
  display_name?: string | null;
  password?: string | null;
  role?: UserRole | null;
  status?: "active" | "disabled" | null;
  store_ids?: string[] | null;
  store_group_ids?: string[] | null;
}

export interface RolePermissionRead {
  role: UserRole;
  permissions: PermissionKey[];
}

export interface StoreGroupScope {
  id: string;
  name: string;
}

export interface RolePermissionUpdate {
  permissions: PermissionKey[];
}

export interface RoleRead {
  id: string;
  key: string;
  name: string;
  sort_order: number;
  is_system: boolean;
  is_admin: boolean;
  permissions: PermissionKey[];
  created_at: string;
  updated_at: string;
}

export interface RoleCreate {
  key: string;
  name: string;
  sort_order?: number;
}

export interface RoleUpdate {
  name?: string | null;
  sort_order?: number | null;
}

export interface ShareholderAccessGrant {
  id: string;
  name: string;
  store_ids: string[];
  status: "active" | "disabled";
  expires_at?: string | null;
  last_login_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShareholderAccessGrantCreate {
  name: string;
  access_code: string;
  store_ids: string[];
  expires_at?: string | null;
}

export interface ShareholderAccessGrantUpdate {
  name?: string | null;
  access_code?: string | null;
  store_ids?: string[] | null;
  status?: "active" | "disabled" | null;
  expires_at?: string | null;
}

export interface ShareholderLoginResponse {
  token: string;
  grant: ShareholderAccessGrant;
}

export interface ExpenseItem {
  id: string;
  store_id: string;
  ledger_period: string;
  expense_date?: string | null;
  description: string;
  amount: string;
  category_l1?: string | null;
  category_l2?: string | null;
  supplier_name?: string | null;
  payee_account?: string | null;
  approval_instance_id?: string | null;
  approval_line_no?: number | null;
  approval_line_key?: string | null;
  approval_line_source_type?: string | null;
  parse_status?: string | null;
  source_sync_hash?: string | null;
  source_snapshot_json?: string | null;
  user_edited_fields_json?: string | null;
  sync_conflict_status?: string | null;
  payee_name?: string | null;
  payee_bank_name?: string | null;
  payee_bank_branch?: string | null;
  payee_account_no?: string | null;
  payee_account_type?: string | null;
  payee_account_verify_status?: string | null;
  payee_account_snapshot_json?: string | null;
  voucher_count?: number;
  remark?: string | null;
  payment_status: ExpensePaymentStatus;
  source: string;
  source_document_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface Attachment {
  id: string;
  resource_type: string;
  resource_id: string;
  file_name: string;
  content_type?: string | null;
  file_size?: number | null;
  file_hash?: string | null;
  source: string;
  external_file_id?: string | null;
  download_status: AttachmentStatus;
  created_at: string;
  updated_at: string;
}

export interface AttachmentAccessUrl {
  url: string;
  file_name: string;
  expires_in?: number | null;
}

export interface ExpenseItemCreate {
  store_id: string;
  ledger_period: string;
  expense_date?: string | null;
  description: string;
  amount: string;
  category_l1?: string | null;
  category_l2?: string | null;
  supplier_name?: string | null;
  payee_account?: string | null;
  remark?: string | null;
}

export interface ExpenseItemUpdate {
  expense_date?: string | null;
  description?: string | null;
  amount?: string | null;
  category_l1?: string | null;
  category_l2?: string | null;
  supplier_name?: string | null;
  payee_account?: string | null;
  remark?: string | null;
}

export interface BankTransaction {
  id: string;
  store_id?: string | null;
  ledger_period?: string | null;
  occurred_at: string;
  direction: MoneyDirection;
  amount: string;
  counterparty_name?: string | null;
  counterparty_account?: string | null;
  summary?: string | null;
  bank_serial_no?: string | null;
  matched_amount: string;
  import_job_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface BankTransactionCreate {
  store_id?: string | null;
  ledger_period?: string | null;
  occurred_at: string;
  direction: MoneyDirection;
  amount: string;
  counterparty_name?: string | null;
  counterparty_account?: string | null;
  summary?: string | null;
  bank_serial_no?: string | null;
}

export interface BankTransactionBatchCreateRequest {
  items: BankTransactionCreate[];
}

export interface BankTransactionBatchCreateResult {
  created_count: number;
}

export interface BankTransactionUpdate {
  store_id?: string | null;
  ledger_period?: string | null;
  occurred_at?: string;
  direction?: MoneyDirection;
  amount?: string;
  counterparty_name?: string | null;
  counterparty_account?: string | null;
  summary?: string | null;
  bank_serial_no?: string | null;
}

export interface BankTransactionBatchDeleteResult {
  deleted_count: number;
}

export interface ExpenseBankMatch {
  id: string;
  expense_item_id: string;
  bank_transaction_id: string;
  amount: string;
  accounting_period?: string | null;
  bank_occurred: boolean;
  status: MatchStatus;
  confidence?: string | null;
  reason?: string | null;
  confirmed_by?: string | null;
  confirmed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface MatchCreate {
  expense_item_id: string;
  bank_transaction_id: string;
  amount: string;
  accounting_period?: string | null;
  bank_occurred?: boolean;
  category_l1?: string | null;
  category_l2?: string | null;
  confidence?: string | null;
  reason?: string | null;
}

export interface ReconciliationRecordUpdate {
  expense_item_id?: string | null;
  amount?: string | null;
  accounting_period?: string | null;
  bank_occurred?: boolean | null;
  category_l1?: string | null;
  category_l2?: string | null;
  reason?: string | null;
}

export interface AutoMatchResult {
  created_count: number;
  skipped_count: number;
  matches: ExpenseBankMatch[];
}

export interface ReconciliationExpenseCandidate {
  expense_item: ExpenseItem;
  approval_instance?: ApprovalInstance | null;
  template_name?: string | null;
  display_fields: Record<string, unknown>;
  voucher_count?: number;
  remaining_amount: string;
  score: string;
  reason: string;
}

export interface ReconciliationCandidateResult {
  bank_transaction?: BankTransaction | null;
  remaining_amount: string;
  candidates: ReconciliationExpenseCandidate[];
}

export interface ReconciliationRecord {
  match: ExpenseBankMatch;
  bank_transaction: BankTransaction;
  expense_item: ExpenseItem;
  approval_instance?: ApprovalInstance | null;
  template_name?: string | null;
  display_fields: Record<string, unknown>;
}

export interface RevenueBankMatch {
  id: string;
  bank_transaction_id: string;
  channel: string;
  revenue_start_date: string;
  revenue_end_date: string;
  amount: string;
  accounting_period?: string | null;
  revenue_record_ids: string[];
  status: MatchStatus;
  confidence?: string | null;
  reason?: string | null;
  confirmed_by?: string | null;
  confirmed_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface RevenueMatchCreate {
  bank_transaction_id: string;
  channel: string;
  revenue_start_date: string;
  revenue_end_date: string;
  amount: string;
  accounting_period?: string | null;
  revenue_record_ids?: string[];
  confidence?: string | null;
  reason?: string | null;
}

export interface RevenueMatchBatchCreate {
  bank_transaction_id: string;
  revenue_record_ids: string[];
  amount: string;
  accounting_period?: string | null;
  confidence?: string | null;
  reason?: string | null;
}

export interface DingTalkConfig {
  id: string;
  corp_id?: string | null;
  app_key?: string | null;
  app_secret_configured: boolean;
  admin_user_id?: string | null;
  drive_union_id?: string | null;
  status: string;
  last_template_sync_at?: string | null;
  last_instance_sync_at?: string | null;
}

export interface DingTalkAutoSyncSetting {
  id: string;
  enabled: boolean;
  scheduled_time: string;
  interval_minutes: number;
  window_days: number;
  root_dept_id: string;
  max_depth: number;
  page_size: number;
  max_pages: number;
  skip_existing: boolean;
  sync_departments: boolean;
  sync_templates: boolean;
  sync_approvals: boolean;
  paused: boolean;
  next_run_at?: string | null;
  last_run_at?: string | null;
  approval_watermark_at?: string | null;
  last_job_id?: string | null;
  last_status?: string | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
}

export interface DingTalkAutoSyncSettingUpdate {
  enabled?: boolean;
  scheduled_time?: string;
  sync_departments?: boolean;
  sync_templates?: boolean;
  sync_approvals?: boolean;
  paused?: boolean;
  skip_existing?: boolean;
}

export interface DingTalkAutoSyncRunResult {
  job: SyncJob;
  setting: DingTalkAutoSyncSetting;
  department_pull?: DingTalkDepartmentPullResult | null;
  department_sync?: DingTalkDepartmentSyncResult | null;
  template_sync?: { pulled: number; created: number; updated: number } | null;
  approval_sync?: SyncJob | null;
}

export interface ApprovalTemplate {
  id: string;
  process_code: string;
  name: string;
  is_enabled: boolean;
  mapping_status: string;
  last_sync_at?: string | null;
  raw_snapshot?: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApprovalTemplateCreate {
  process_code: string;
  name: string;
  is_enabled?: boolean;
}

export interface ApprovalTemplateUpdate {
  name?: string | null;
  is_enabled?: boolean | null;
}

export interface TemplateFieldMapping {
  id: string;
  template_id: string;
  standard_field: string;
  display_label?: string | null;
  source_field_id?: string | null;
  source_field_name: string;
  source_path?: string | null;
  field_type?: string | null;
  show_in_list: boolean;
  show_in_detail: boolean;
  is_required: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TemplateFieldMappingCreate {
  standard_field: string;
  display_label?: string | null;
  source_field_id?: string | null;
  source_field_name: string;
  source_path?: string | null;
  field_type?: string | null;
  show_in_list?: boolean;
  show_in_detail?: boolean;
  is_required?: boolean;
  sort_order?: number;
}

export interface TemplateFieldMappingReorderItem {
  id: string;
  sort_order: number;
}

export interface TemplateFieldMappingReorderRequest {
  items: TemplateFieldMappingReorderItem[];
}

export interface ApprovalTemplateNode {
  id: string;
  template_id: string;
  activity_id: string;
  node_name: string;
  node_type?: string | null;
  sort_order: number;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApprovalTemplateNodeCreate {
  activity_id: string;
  node_name: string;
  node_type?: string | null;
  sort_order?: number;
  is_active?: boolean;
}

export interface ApprovalTemplateNodeUpdate {
  activity_id?: string | null;
  node_name?: string | null;
  node_type?: string | null;
  sort_order?: number | null;
  is_active?: boolean | null;
}

export interface TemplateFieldCandidate {
  source_field_id?: string | null;
  source_field_name: string;
  source_path?: string | null;
  field_type?: string | null;
  sample_value?: unknown;
}

export interface TemplateSampleApprovalResult {
  instance?: ApprovalInstance | null;
  field_candidates: TemplateFieldCandidate[];
  pulled_count: number;
}

export interface TemplateFieldCandidateSampleRequest {
  approval_instance_id: string;
}

export interface ApprovalParseExpenseRow {
  description: string;
  amount: string;
  category_l1?: string | null;
  category_l2?: string | null;
  supplier_name?: string | null;
  payee_account?: string | null;
}

export interface ApprovalParsePreview {
  template_id: string;
  approval_instance_id: string;
  dingtalk_instance_id: string;
  approval_no?: string | null;
  store_id?: string | null;
  store_name?: string | null;
  store_text?: string | null;
  originator_dept_id?: string | null;
  originator_dept_name?: string | null;
  expense_date?: string | null;
  expense_row_count: number;
  rows: ApprovalParseExpenseRow[];
  voucher_count: number;
  missing_fields: string[];
  can_create_expense: boolean;
}

export interface ApprovalReparseRequest {
  instance_id?: string | null;
  limit?: number;
  started_by?: string;
}

export interface ApprovalReparseResult {
  processed_count: number;
  reparsed_count: number;
  skipped_count: number;
  created_expense_count: number;
  job: SyncJob;
}

export interface ApprovalModifiedResyncRequest {
  start_at?: string | null;
  end_at?: string | null;
  template_id?: string | null;
  store_id?: string | null;
  limit?: number;
  started_by?: string;
}

export interface ApprovalModifiedResyncResult {
  processed_count: number;
  updated_count: number;
  skipped_count: number;
  failed_count: number;
  job: SyncJob;
}

export interface DingTalkDepartment {
  dept_id: string;
  name: string;
  parent_id?: string | null;
  path: string;
  depth: number;
  is_store_candidate: boolean;
  store_id?: string | null;
  store_name?: string | null;
  is_active: boolean;
  last_seen_at?: string | null;
  last_synced_at?: string | null;
}

export interface DingTalkDepartmentPullResult {
  departments: DingTalkDepartment[];
  pulled_count: number;
  created_count: number;
  updated_count: number;
  deactivated_count: number;
  candidate_count: number;
}

export interface DingTalkDepartmentSyncPreview {
  departments: DingTalkDepartment[];
  candidate_count: number;
  existing_count: number;
  create_count: number;
  update_count: number;
}

export interface DingTalkDepartmentSyncResult {
  created_count: number;
  updated_count: number;
  skipped_count: number;
  stores: Store[];
}

export interface DingTalkSyncReadiness {
  sync_mode: string;
  config_ready: boolean;
  department_ready: boolean;
  store_mapping_ready: boolean;
  template_ready: boolean;
  approval_sync_ready: boolean;
  department_count: number;
  store_candidate_count: number;
  mapped_store_count: number;
  template_count: number;
  enabled_template_count: number;
  configured_enabled_template_count: number;
  unconfigured_enabled_templates: string[];
  blockers: string[];
  warnings: string[];
}

export interface StartApprovalSyncRequest {
  template_id?: string | null;
  started_by?: string;
  start_at?: string | null;
  end_at?: string | null;
  page_size?: number;
  max_pages?: number;
  skip_existing?: boolean;
  run_async?: boolean;
}

export interface StartStoreApprovalSyncRequest {
  store_id: string;
  ledger_period: string;
  template_id?: string | null;
  started_by?: string;
  start_at?: string | null;
  end_at?: string | null;
  skip_existing?: boolean;
}

export interface ResumeApprovalSyncRequest {
  started_by?: string;
  page_size?: number;
  max_pages?: number;
  skip_existing?: boolean;
  run_async?: boolean;
}

export interface SyncJob {
  id: string;
  job_type: string;
  status: "pending" | "running" | "succeeded" | "failed" | "canceled";
  started_by?: string | null;
  started_at?: string | null;
  finished_at?: string | null;
  request_start_at?: string | null;
  request_end_at?: string | null;
  next_cursor?: string | null;
  processed_count: number;
  success_count: number;
  failed_count: number;
  error_message?: string | null;
  raw_summary?: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoreApprovalSyncResult {
  job: SyncJob;
  store_id: string;
  ledger_period: string;
  scanned_count: number;
  matched_count: number;
  outside_scope_count: number;
  unresolved_store_count: number;
}

export interface BankImportRowError {
  row_number: number;
  message: string;
}

export interface BankImportResult {
  job: SyncJob;
  created_count: number;
  skipped_count: number;
  row_errors: BankImportRowError[];
}

export interface BankImportRollbackResult {
  job: SyncJob;
  deleted_count: number;
}

export interface BankImportPreviewRow {
  row_number: number;
  occurred_at: string;
  direction: MoneyDirection;
  amount: string;
  counterparty_name?: string | null;
  counterparty_account?: string | null;
  summary?: string | null;
  bank_serial_no?: string | null;
  duplicate: boolean;
}

export interface BankImportPreviewResult {
  valid_count: number;
  duplicate_count: number;
  error_count: number;
  preview_rows: BankImportPreviewRow[];
  row_errors: BankImportRowError[];
}

export interface ApprovalInstance {
  id: string;
  template_id: string;
  dingtalk_instance_id: string;
  approval_no?: string | null;
  store_id?: string | null;
  department_name?: string | null;
  applicant_name?: string | null;
  applicant_user_id?: string | null;
  approval_status: string;
  parse_status: "unparsed" | "parsed" | "skipped" | "failed" | string;
  parse_error?: string | null;
  last_parsed_at?: string | null;
  submit_at?: string | null;
  approved_at?: string | null;
  dingtalk_modified_at?: string | null;
  raw_payload?: string | null;
  synced_job_id?: string | null;
  node_name_map?: Record<string, string>;
  expense_item_count: number;
  classified_expense_item_count: number;
  matched_expense_item_count: number;
  pending_expense_item_count: number;
  sync_conflict_expense_item_count: number;
  total_expense_amount: string;
  confirmed_match_amount: string;
  candidate_match_count: number;
  processing_status: "unparsed" | "sync_conflict" | "pending_classification" | "pending_match" | "partial_matched" | "matched" | string;
  created_at: string;
  updated_at: string;
}

export interface LedgerReportSummary {
  store_id: string;
  store_name: string;
  period: string;
  ledger_status: LedgerStatus;
  income_amount: string;
  expense_amount: string;
  profit_amount: string;
  pending_expense_count: number;
  pending_bank_transaction_count: number;
}

export interface StoreReportSummary extends LedgerReportSummary {
  ledger_id: string;
}

export interface LedgerPeriodOption {
  ledger_id: string;
  store_id: string;
  period: string;
  ledger_status: LedgerStatus;
}

export interface ReportPeriodOption {
  period: string;
  store_count: number;
}

export interface ExpenseBreakdownItem {
  name: string;
  amount: string;
  item_count: number;
}

export interface RevenueChannelBreakdownItem {
  channel: string;
  gross_amount: string;
  net_amount: string;
  fee_amount: string;
  fee_rate: string;
  matched_amount: string;
  unmatched_amount: string;
  reconciliation_rate: string;
  record_count: number;
}

export interface LedgerReportDetail {
  summary: LedgerReportSummary;
  revenue_records: RevenueRecord[];
  revenue_channel_breakdown: RevenueChannelBreakdownItem[];
  category_breakdown: ExpenseBreakdownItem[];
  supplier_breakdown: ExpenseBreakdownItem[];
  pending_expense_items: ExpenseItem[];
  pending_bank_transactions: BankTransaction[];
}

export interface LedgerTrend {
  store_id: string;
  store_name: string;
  items: LedgerReportSummary[];
}

export interface StoreComparisonReport {
  period: string;
  items: LedgerReportSummary[];
  total_income_amount: string;
  total_expense_amount: string;
  total_profit_amount: string;
}

export interface StoreLedgerWorkspaceMetrics {
  revenue_record_count: number;
  income_amount: string;
  expense_amount: string;
  net_income_amount: string;
  fee_amount: string;
  bank_transaction_count: number;
  unmatched_bank_transaction_count: number;
  approval_count: number;
  pending_approval_count: number;
  revenue_match_count: number;
  pending_revenue_match_count: number;
}

export interface StoreLedgerWorkspace {
  store: Store;
  period: string;
  ledgers: Ledger[];
  selected_ledger?: Ledger | null;
  close_check?: LedgerCloseCheck | null;
  metrics: StoreLedgerWorkspaceMetrics;
  bank_transactions: BankTransaction[];
  revenue_records: RevenueRecord[];
  approval_instances: ApprovalInstance[];
  revenue_matches: RevenueBankMatch[];
}

export interface FinancialAnalyticsMetrics {
  store_count: number;
  period_count: number;
  total_income_amount: string;
  total_expense_amount: string;
  total_profit_amount: string;
  bank_expense_amount: string;
  matched_expense_amount: string;
  unmatched_bank_amount: string;
  unmatched_bank_count: number;
  pending_expense_amount: string;
  pending_expense_count: number;
  confirmed_match_count: number;
  pending_match_count: number;
  bank_not_occurred_count: number;
}

export interface FinancialAnalyticsTrendItem {
  period: string;
  income_amount: string;
  expense_amount: string;
  profit_amount: string;
  bank_expense_amount: string;
  matched_expense_amount: string;
  unmatched_bank_amount: string;
}

export interface FinancialAnalyticsStoreItem {
  store_id: string;
  store_name: string;
  income_amount: string;
  expense_amount: string;
  profit_amount: string;
  bank_expense_amount: string;
  matched_expense_amount: string;
  unmatched_bank_amount: string;
  unmatched_bank_count: number;
  pending_expense_amount: string;
  pending_expense_count: number;
}

export interface FinancialAnalyticsCategoryItem {
  category_l1: string;
  category_l2?: string | null;
  amount: string;
  item_count: number;
}

export interface FinancialAnalyticsTemplateItem {
  template_id: string;
  template_name: string;
  approval_count: number;
  expense_amount: string;
  matched_amount: string;
}

export interface FinancialAnalyticsReconciliationItem {
  status: MatchStatus;
  count: number;
  amount: string;
}

export interface FinancialAnalyticsReport {
  metrics: FinancialAnalyticsMetrics;
  trends: FinancialAnalyticsTrendItem[];
  stores: FinancialAnalyticsStoreItem[];
  categories: FinancialAnalyticsCategoryItem[];
  templates: FinancialAnalyticsTemplateItem[];
  reconciliation: FinancialAnalyticsReconciliationItem[];
}

export interface FinancialAnalyticsDetailReport {
  title: string;
  expense_items: ExpenseItem[];
  bank_transactions: BankTransaction[];
  approval_instances: ApprovalInstance[];
  reconciliation_records: ReconciliationRecord[];
}

export interface LedgerSummary {
  id: string;
  storeId: string;
  storeName: string;
  period: string;
  status: LedgerStatus;
  pendingTransactionCount: number;
  unclassifiedExpenseItemCount: number;
  missingSupplierCount: number;
}

export interface ApiEnvelope<T> {
  data: T;
  requestId?: string;
}

export interface CurrentUser {
  id: string;
  username: string;
  display_name: string;
  role: UserRole;
  permissions: PermissionKey[];
  store_ids: string[];
  store_group_ids: string[];
}
