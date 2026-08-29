export type LedgerStatus = "open" | "closed";
export type StoreStatus = "active" | "inactive";
export type MoneyDirection = "income" | "expense";
export type MatchStatus = "candidate" | "confirmed" | "rejected";
export type AttachmentStatus = "stored" | "placeholder" | "failed";
export type ExpensePaymentStatus = "unpaid" | "partial_paid" | "paid" | "no_bank_flow";
export type UserRole = "admin" | "finance" | "viewer";
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
  dingtalk_dept_id?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  address?: string | null;
}

export interface StoreUpdate {
  name?: string | null;
  dingtalk_dept_id?: string | null;
  contact_person?: string | null;
  phone?: string | null;
  address?: string | null;
  status?: StoreStatus | null;
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
  issues: string[];
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
  ledger_period: string;
  revenue_date: string;
  channel: string;
  gross_amount: string;
  net_amount: string;
  fee_amount?: string;
  remark?: string | null;
}

export interface RevenueRecordUpdate {
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
  status: MasterDataStatus;
  created_at: string;
  updated_at: string;
}

export interface RevenueChannelCreate {
  name: string;
  sort_order?: number;
  requires_bank_match?: boolean;
}

export interface RevenueChannelUpdate {
  name?: string | null;
  sort_order?: number | null;
  requires_bank_match?: boolean | null;
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
}

export interface UserAccountCreate {
  username: string;
  display_name: string;
  password: string;
  role: UserRole;
}

export interface UserAccountUpdate {
  display_name?: string | null;
  password?: string | null;
  role?: UserRole | null;
  status?: "active" | "disabled" | null;
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
}

export interface ExpenseItemUpdate {
  expense_date?: string | null;
  description?: string | null;
  amount?: string | null;
  category_l1?: string | null;
  category_l2?: string | null;
  supplier_name?: string | null;
  payee_account?: string | null;
}

export interface BankTransaction {
  id: string;
  store_id: string;
  ledger_period: string;
  occurred_at: string;
  direction: MoneyDirection;
  amount: string;
  counterparty_name?: string | null;
  counterparty_account?: string | null;
  summary?: string | null;
  bank_serial_no?: string | null;
  matched_amount: string;
  created_at: string;
  updated_at: string;
}

export interface BankTransactionCreate {
  store_id: string;
  ledger_period: string;
  occurred_at: string;
  direction: MoneyDirection;
  amount: string;
  counterparty_name?: string | null;
  counterparty_account?: string | null;
  summary?: string | null;
  bank_serial_no?: string | null;
}

export interface BankTransactionUpdate {
  occurred_at?: string;
  direction?: MoneyDirection;
  amount?: string;
  counterparty_name?: string | null;
  counterparty_account?: string | null;
  summary?: string | null;
  bank_serial_no?: string | null;
}

export interface ExpenseBankMatch {
  id: string;
  expense_item_id: string;
  bank_transaction_id: string;
  amount: string;
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
  confidence?: string | null;
  reason?: string | null;
}

export interface AutoMatchResult {
  created_count: number;
  skipped_count: number;
  matches: ExpenseBankMatch[];
}

export interface RevenueBankMatch {
  id: string;
  bank_transaction_id: string;
  channel: string;
  revenue_start_date: string;
  revenue_end_date: string;
  amount: string;
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

export interface TemplateFieldMapping {
  id: string;
  template_id: string;
  standard_field: string;
  source_field_id?: string | null;
  source_field_name: string;
  source_path?: string | null;
  field_type?: string | null;
  is_required: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TemplateFieldMappingCreate {
  standard_field: string;
  source_field_id?: string | null;
  source_field_name: string;
  source_path?: string | null;
  field_type?: string | null;
  is_required?: boolean;
  sort_order?: number;
}

export interface TemplateFieldCandidate {
  source_field_id?: string | null;
  source_field_name: string;
  source_path?: string | null;
  field_type?: string | null;
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

export interface StartApprovalSyncRequest {
  template_id?: string | null;
  started_by?: string;
  start_at?: string | null;
  end_at?: string | null;
  page_size?: number;
  max_pages?: number;
  skip_existing?: boolean;
}

export interface ResumeApprovalSyncRequest {
  started_by?: string;
  page_size?: number;
  max_pages?: number;
  skip_existing?: boolean;
}

export interface SyncJob {
  id: string;
  job_type: string;
  status: "pending" | "running" | "succeeded" | "failed";
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
  applicant_name?: string | null;
  applicant_user_id?: string | null;
  approval_status: string;
  submit_at?: string | null;
  approved_at?: string | null;
  raw_payload?: string | null;
  synced_job_id?: string | null;
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

export interface ExpenseBreakdownItem {
  name: string;
  amount: string;
  item_count: number;
}

export interface LedgerReportDetail {
  summary: LedgerReportSummary;
  revenue_records: RevenueRecord[];
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
}
