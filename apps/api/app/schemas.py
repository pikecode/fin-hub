from datetime import date, datetime
from decimal import Decimal
from typing import Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field

from app.models import (
    AttachmentStatus,
    ExpensePaymentStatus,
    LedgerStatus,
    MasterDataStatus,
    MatchStatus,
    ShareholderGrantStatus,
    StoreStatus,
    UserRole,
)

T = TypeVar("T")


class ApiEnvelope(BaseModel, Generic[T]):
    data: T


class Page(BaseModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    page_size: int


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=1, max_length=120)


class CurrentUser(BaseModel):
    id: str
    username: str
    display_name: str
    role: UserRole
    permissions: list[str] = []
    store_ids: list[str] = []


class UserCreate(BaseModel):
    username: str = Field(min_length=1, max_length=80)
    display_name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=8, max_length=120)
    role: UserRole = UserRole.FINANCE
    permissions: list[str] | None = None
    store_ids: list[str] = []


class UserUpdate(BaseModel):
    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    password: str | None = Field(default=None, min_length=8, max_length=120)
    role: UserRole | None = None
    status: str | None = Field(default=None, pattern=r"^(active|disabled)$")
    permissions: list[str] | None = None
    store_ids: list[str] | None = None


class UserRead(BaseModel):
    id: str
    username: str
    display_name: str
    role: UserRole
    status: str
    last_login_at: datetime | None
    created_at: datetime
    updated_at: datetime
    permissions: list[str] = []
    store_ids: list[str] = []


class ShareholderAccessGrantCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    access_code: str = Field(min_length=6, max_length=120)
    store_ids: list[str] = Field(min_length=1)
    expires_at: datetime | None = None


class ShareholderAccessGrantUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    access_code: str | None = Field(default=None, min_length=6, max_length=120)
    store_ids: list[str] | None = None
    status: ShareholderGrantStatus | None = None
    expires_at: datetime | None = None


class ShareholderAccessGrantRead(BaseModel):
    id: str
    name: str
    store_ids: list[str]
    status: ShareholderGrantStatus
    expires_at: datetime | None
    last_login_at: datetime | None
    created_at: datetime
    updated_at: datetime


class ShareholderLoginRequest(BaseModel):
    access_code: str = Field(min_length=1, max_length=120)


class ShareholderLoginResponse(BaseModel):
    token: str
    grant: ShareholderAccessGrantRead


class StoreCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    dingtalk_dept_id: str | None = None
    contact_person: str | None = None
    phone: str | None = None
    address: str | None = None


class StoreUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    dingtalk_dept_id: str | None = None
    contact_person: str | None = None
    phone: str | None = None
    address: str | None = None
    status: StoreStatus | None = None


class StoreRead(StoreCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: StoreStatus
    created_at: datetime
    updated_at: datetime


class LedgerCreate(BaseModel):
    store_id: str
    period: str = Field(pattern=r"^\d{4}-\d{2}$")


class LedgerRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    store_id: str
    period: str
    status: LedgerStatus
    version: int
    closed_at: datetime | None
    closed_by: str | None
    reopened_at: datetime | None
    reopened_by: str | None
    created_at: datetime
    updated_at: datetime


class LedgerStatusChange(BaseModel):
    operator: str = Field(default="system", max_length=80)


class LedgerCloseCheck(BaseModel):
    can_close: bool
    unpaid_expense_count: int
    unmatched_bank_transaction_count: int
    candidate_match_count: int
    issues: list[str]


class DatabaseBackupStatus(BaseModel):
    supported: bool
    backend: str
    database_path: str | None = None
    message: str


class SystemReadinessCheck(BaseModel):
    key: str
    name: str
    status: str
    detail: str


class SystemReadinessReport(BaseModel):
    environment: str
    ready: bool
    checks: list[SystemReadinessCheck]


class RevenueRecordCreate(BaseModel):
    store_id: str
    ledger_period: str = Field(pattern=r"^\d{4}-\d{2}$")
    revenue_date: date
    channel: str = Field(min_length=1, max_length=80)
    gross_amount: Decimal = Field(ge=0)
    net_amount: Decimal = Field(ge=0)
    fee_amount: Decimal = Field(default=Decimal("0.00"), ge=0)
    remark: str | None = None


class RevenueRecordUpdate(BaseModel):
    revenue_date: date | None = None
    channel: str | None = Field(default=None, min_length=1, max_length=80)
    gross_amount: Decimal | None = Field(default=None, ge=0)
    net_amount: Decimal | None = Field(default=None, ge=0)
    fee_amount: Decimal | None = Field(default=None, ge=0)
    remark: str | None = None


class RevenueRecordRead(RevenueRecordCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    created_at: datetime
    updated_at: datetime


class RevenueChannelCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    sort_order: int = 0
    requires_bank_match: bool = True


class RevenueChannelUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    sort_order: int | None = None
    requires_bank_match: bool | None = None
    status: MasterDataStatus | None = None


class RevenueChannelRead(RevenueChannelCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: MasterDataStatus
    created_at: datetime
    updated_at: datetime


class ExpenseCategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    parent_id: str | None = None
    sort_order: int = 0


class ExpenseCategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=80)
    parent_id: str | None = None
    sort_order: int | None = None
    status: MasterDataStatus | None = None


class ExpenseCategoryRead(ExpenseCategoryCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: MasterDataStatus
    created_at: datetime
    updated_at: datetime


class SupplierCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    bank_account: str | None = None
    contact_name: str | None = None
    phone: str | None = None
    remark: str | None = None


class SupplierUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    bank_account: str | None = None
    contact_name: str | None = None
    phone: str | None = None
    remark: str | None = None
    status: MasterDataStatus | None = None


class SupplierRead(SupplierCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: MasterDataStatus
    created_at: datetime
    updated_at: datetime


class AuditLogRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    actor: str
    action: str
    resource_type: str
    resource_id: str | None
    summary: str | None
    metadata_json: str | None
    created_at: datetime


class ExpenseItemCreate(BaseModel):
    store_id: str
    ledger_period: str = Field(pattern=r"^\d{4}-\d{2}$")
    expense_date: date | None = None
    description: str = Field(min_length=1)
    amount: Decimal = Field(gt=0)
    category_l1: str | None = None
    category_l2: str | None = None
    supplier_name: str | None = None
    payee_account: str | None = None


class ExpenseItemUpdate(BaseModel):
    expense_date: date | None = None
    description: str | None = Field(default=None, min_length=1)
    amount: Decimal | None = Field(default=None, gt=0)
    category_l1: str | None = None
    category_l2: str | None = None
    supplier_name: str | None = None
    payee_account: str | None = None


class ExpenseItemRead(ExpenseItemCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    payment_status: ExpensePaymentStatus
    source: str
    source_document_id: str | None
    created_at: datetime
    updated_at: datetime


class AttachmentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    resource_type: str
    resource_id: str
    file_name: str
    content_type: str | None
    file_size: int | None
    file_hash: str | None
    source: str
    external_file_id: str | None
    download_status: AttachmentStatus
    created_at: datetime
    updated_at: datetime


class AttachmentAccessUrl(BaseModel):
    url: str
    file_name: str
    expires_in: int | None = None


class BankTransactionCreate(BaseModel):
    store_id: str | None = None
    ledger_period: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}$")
    occurred_at: datetime
    direction: str = Field(pattern=r"^(income|expense)$")
    amount: Decimal = Field(gt=0)
    counterparty_name: str | None = None
    counterparty_account: str | None = None
    summary: str | None = None
    bank_serial_no: str | None = None


class BankTransactionUpdate(BaseModel):
    store_id: str | None = None
    ledger_period: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}$")
    occurred_at: datetime | None = None
    direction: str | None = Field(default=None, pattern=r"^(income|expense)$")
    amount: Decimal | None = Field(default=None, gt=0)
    counterparty_name: str | None = None
    counterparty_account: str | None = None
    summary: str | None = None
    bank_serial_no: str | None = None


class BankTransactionRead(BankTransactionCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    matched_amount: Decimal
    created_at: datetime
    updated_at: datetime


class MatchCreate(BaseModel):
    expense_item_id: str
    bank_transaction_id: str
    amount: Decimal = Field(gt=0)
    accounting_period: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}$")
    bank_occurred: bool = True
    category_l2: str | None = None
    confidence: Decimal | None = None
    reason: str | None = None


class MatchRead(MatchCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: MatchStatus
    confirmed_by: str | None
    confirmed_at: datetime | None
    created_at: datetime
    updated_at: datetime


class AutoMatchResult(BaseModel):
    created_count: int
    skipped_count: int
    matches: list[MatchRead]


class RevenueMatchCreate(BaseModel):
    bank_transaction_id: str
    channel: str
    revenue_start_date: date
    revenue_end_date: date
    amount: Decimal = Field(gt=0)
    confidence: Decimal | None = None
    reason: str | None = None


class RevenueMatchRead(RevenueMatchCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    status: MatchStatus
    confirmed_by: str | None
    confirmed_at: datetime | None
    created_at: datetime
    updated_at: datetime


class DingTalkConfigRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    corp_id: str | None
    app_key: str | None
    app_secret_configured: bool
    admin_user_id: str | None
    drive_union_id: str | None
    status: str
    last_template_sync_at: datetime | None
    last_instance_sync_at: datetime | None


class DingTalkConfigUpdate(BaseModel):
    corp_id: str | None = None
    app_key: str | None = None
    app_secret: str | None = None
    admin_user_id: str | None = None
    drive_union_id: str | None = None


class DingTalkAutoSyncSettingRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    enabled: bool
    interval_minutes: int
    window_days: int
    root_dept_id: str
    max_depth: int
    page_size: int
    max_pages: int
    skip_existing: bool
    sync_departments: bool
    sync_templates: bool
    sync_approvals: bool
    next_run_at: datetime | None
    last_run_at: datetime | None
    last_job_id: str | None
    last_status: str | None
    last_error: str | None
    created_at: datetime
    updated_at: datetime


class DingTalkAutoSyncSettingUpdate(BaseModel):
    enabled: bool | None = None
    interval_minutes: int | None = Field(default=None, ge=5, le=1440)
    window_days: int | None = Field(default=None, ge=1, le=365)
    root_dept_id: str | None = Field(default=None, min_length=1, max_length=120)
    max_depth: int | None = Field(default=None, ge=1, le=8)
    page_size: int | None = Field(default=None, ge=1, le=100)
    max_pages: int | None = Field(default=None, ge=1, le=500)
    skip_existing: bool | None = None
    sync_departments: bool | None = None
    sync_templates: bool | None = None
    sync_approvals: bool | None = None


class ApprovalTemplateCreate(BaseModel):
    process_code: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=160)
    is_enabled: bool = True


class ApprovalTemplateUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    is_enabled: bool | None = None


class ApprovalTemplateRead(ApprovalTemplateCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    mapping_status: str
    last_sync_at: datetime | None
    raw_snapshot: str | None
    created_at: datetime
    updated_at: datetime


class TemplateFieldMappingCreate(BaseModel):
    standard_field: str = Field(min_length=1, max_length=80)
    display_label: str | None = Field(default=None, max_length=120)
    source_field_id: str | None = None
    source_field_name: str = Field(min_length=1, max_length=120)
    source_path: str | None = None
    field_type: str | None = None
    show_in_list: bool = False
    show_in_detail: bool = True
    is_required: bool = False
    sort_order: int = 0


class TemplateFieldMappingRead(TemplateFieldMappingCreate):
    model_config = ConfigDict(from_attributes=True)

    id: str
    template_id: str
    created_at: datetime
    updated_at: datetime


class TemplateFieldMappingReorderItem(BaseModel):
    id: str
    sort_order: int


class TemplateFieldMappingReorderRequest(BaseModel):
    items: list[TemplateFieldMappingReorderItem]


class TemplateFieldCandidate(BaseModel):
    source_field_id: str | None = None
    source_field_name: str
    source_path: str | None = None
    field_type: str | None = None
    sample_value: object | None = None


class DingTalkDepartmentRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    dept_id: str
    name: str
    parent_id: str | None = None
    path: str
    depth: int
    is_store_candidate: bool
    store_id: str | None = None
    store_name: str | None = None
    is_active: bool = True
    last_seen_at: datetime | None = None
    last_synced_at: datetime | None = None


class DingTalkDepartmentPullResult(BaseModel):
    departments: list[DingTalkDepartmentRead]
    pulled_count: int
    created_count: int
    updated_count: int
    deactivated_count: int
    candidate_count: int


class DingTalkDepartmentSyncPreview(BaseModel):
    departments: list[DingTalkDepartmentRead]
    candidate_count: int
    existing_count: int
    create_count: int
    update_count: int


class DingTalkDepartmentSyncResult(BaseModel):
    created_count: int
    updated_count: int
    skipped_count: int
    stores: list[StoreRead]


class LedgerReportSummary(BaseModel):
    store_id: str
    store_name: str
    period: str
    ledger_status: LedgerStatus
    income_amount: Decimal
    expense_amount: Decimal
    profit_amount: Decimal
    pending_expense_count: int
    pending_bank_transaction_count: int


class StoreReportSummary(LedgerReportSummary):
    ledger_id: str


class LedgerPeriodOption(BaseModel):
    ledger_id: str
    store_id: str
    period: str
    ledger_status: LedgerStatus


class ExpenseBreakdownItem(BaseModel):
    name: str
    amount: Decimal
    item_count: int


class LedgerReportDetail(BaseModel):
    summary: LedgerReportSummary
    revenue_records: list[RevenueRecordRead]
    category_breakdown: list[ExpenseBreakdownItem]
    supplier_breakdown: list[ExpenseBreakdownItem]
    pending_expense_items: list[ExpenseItemRead]
    pending_bank_transactions: list[BankTransactionRead]


class LedgerTrend(BaseModel):
    store_id: str
    store_name: str
    items: list[LedgerReportSummary]


class StoreComparisonReport(BaseModel):
    period: str
    items: list[LedgerReportSummary]
    total_income_amount: Decimal
    total_expense_amount: Decimal
    total_profit_amount: Decimal


class FinancialAnalyticsMetrics(BaseModel):
    store_count: int
    period_count: int
    total_income_amount: Decimal
    total_expense_amount: Decimal
    total_profit_amount: Decimal
    bank_expense_amount: Decimal
    matched_expense_amount: Decimal
    unmatched_bank_amount: Decimal
    unmatched_bank_count: int
    pending_expense_amount: Decimal
    pending_expense_count: int
    confirmed_match_count: int
    pending_match_count: int
    bank_not_occurred_count: int


class FinancialAnalyticsTrendItem(BaseModel):
    period: str
    income_amount: Decimal
    expense_amount: Decimal
    profit_amount: Decimal
    bank_expense_amount: Decimal
    matched_expense_amount: Decimal
    unmatched_bank_amount: Decimal


class FinancialAnalyticsStoreItem(BaseModel):
    store_id: str
    store_name: str
    income_amount: Decimal
    expense_amount: Decimal
    profit_amount: Decimal
    bank_expense_amount: Decimal
    matched_expense_amount: Decimal
    unmatched_bank_amount: Decimal
    unmatched_bank_count: int
    pending_expense_amount: Decimal
    pending_expense_count: int


class FinancialAnalyticsCategoryItem(BaseModel):
    category_l1: str
    category_l2: str | None = None
    amount: Decimal
    item_count: int


class FinancialAnalyticsTemplateItem(BaseModel):
    template_id: str
    template_name: str
    approval_count: int
    expense_amount: Decimal
    matched_amount: Decimal


class FinancialAnalyticsReconciliationItem(BaseModel):
    status: str
    count: int
    amount: Decimal


class FinancialAnalyticsReport(BaseModel):
    metrics: FinancialAnalyticsMetrics
    trends: list[FinancialAnalyticsTrendItem]
    stores: list[FinancialAnalyticsStoreItem]
    categories: list[FinancialAnalyticsCategoryItem]
    templates: list[FinancialAnalyticsTemplateItem]
    reconciliation: list[FinancialAnalyticsReconciliationItem]


class StartApprovalSyncRequest(BaseModel):
    template_id: str | None = None
    started_by: str = Field(default="system", max_length=80)
    start_at: datetime | None = None
    end_at: datetime | None = None
    page_size: int = Field(default=20, ge=1, le=100)
    max_pages: int = Field(default=20, ge=1, le=200)
    skip_existing: bool = True


class ResumeApprovalSyncRequest(BaseModel):
    started_by: str = Field(default="system", max_length=80)
    page_size: int = Field(default=20, ge=1, le=100)
    max_pages: int = Field(default=20, ge=1, le=200)
    skip_existing: bool = True


class SyncJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    job_type: str
    status: str
    started_by: str | None
    started_at: datetime | None
    finished_at: datetime | None
    request_start_at: datetime | None
    request_end_at: datetime | None
    next_cursor: str | None
    processed_count: int
    success_count: int
    failed_count: int
    error_message: str | None
    raw_summary: str | None
    created_at: datetime
    updated_at: datetime


class DingTalkAutoSyncRunResult(BaseModel):
    job: SyncJobRead
    setting: DingTalkAutoSyncSettingRead
    department_pull: DingTalkDepartmentPullResult | None = None
    department_sync: DingTalkDepartmentSyncResult | None = None
    template_sync: dict[str, int] | None = None
    approval_sync: SyncJobRead | None = None


class ApprovalParseExpenseRow(BaseModel):
    description: str
    amount: Decimal
    category_l1: str | None = None
    category_l2: str | None = None
    supplier_name: str | None = None
    payee_account: str | None = None


class ApprovalParsePreview(BaseModel):
    template_id: str
    approval_instance_id: str
    dingtalk_instance_id: str
    approval_no: str | None = None
    store_id: str | None = None
    store_name: str | None = None
    store_text: str | None = None
    originator_dept_id: str | None = None
    originator_dept_name: str | None = None
    expense_date: datetime | None = None
    expense_row_count: int
    rows: list[ApprovalParseExpenseRow]
    voucher_count: int
    missing_fields: list[str]
    can_create_expense: bool


class ApprovalReparseRequest(BaseModel):
    instance_id: str | None = None
    limit: int = Field(default=100, ge=1, le=500)
    started_by: str = "system"


class ApprovalReparseResult(BaseModel):
    processed_count: int
    reparsed_count: int
    skipped_count: int
    created_expense_count: int
    job: SyncJobRead


class ApprovalInstanceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    template_id: str
    dingtalk_instance_id: str
    approval_no: str | None
    store_id: str | None
    department_name: str | None = None
    applicant_name: str | None
    applicant_user_id: str | None
    approval_status: str
    submit_at: datetime | None
    approved_at: datetime | None
    raw_payload: str | None
    synced_job_id: str | None
    created_at: datetime
    updated_at: datetime


class ReconciliationExpenseCandidate(BaseModel):
    expense_item: ExpenseItemRead
    approval_instance: ApprovalInstanceRead | None = None
    template_name: str | None = None
    display_fields: dict[str, object | None] = Field(default_factory=dict)
    remaining_amount: Decimal
    score: Decimal
    reason: str


class ReconciliationCandidateResult(BaseModel):
    bank_transaction: BankTransactionRead
    remaining_amount: Decimal
    candidates: list[ReconciliationExpenseCandidate]


class ReconciliationRecord(BaseModel):
    match: MatchRead
    bank_transaction: BankTransactionRead
    expense_item: ExpenseItemRead
    approval_instance: ApprovalInstanceRead | None = None
    template_name: str | None = None
    display_fields: dict[str, object | None] = Field(default_factory=dict)


class ReconciliationRecordUpdate(BaseModel):
    expense_item_id: str | None = None
    amount: Decimal | None = Field(default=None, gt=0)
    accounting_period: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}$")
    bank_occurred: bool | None = None
    category_l2: str | None = None
    reason: str | None = None


class FinancialAnalyticsDetailReport(BaseModel):
    title: str
    expense_items: list[ExpenseItemRead] = Field(default_factory=list)
    bank_transactions: list[BankTransactionRead] = Field(default_factory=list)
    approval_instances: list[ApprovalInstanceRead] = Field(default_factory=list)
    reconciliation_records: list[ReconciliationRecord] = Field(default_factory=list)


class TemplateSampleApprovalResult(BaseModel):
    instance: ApprovalInstanceRead | None = None
    field_candidates: list[TemplateFieldCandidate]
    pulled_count: int


class TemplateFieldCandidateSampleRequest(BaseModel):
    approval_instance_id: str


class BankImportRowError(BaseModel):
    row_number: int
    message: str


class BankImportResult(BaseModel):
    job: SyncJobRead
    created_count: int
    skipped_count: int
    row_errors: list[BankImportRowError] = Field(default_factory=list)


class BankImportPreviewRow(BaseModel):
    row_number: int
    occurred_at: datetime
    direction: str
    amount: Decimal
    counterparty_name: str | None
    counterparty_account: str | None
    summary: str | None
    bank_serial_no: str | None
    duplicate: bool


class BankImportPreviewResult(BaseModel):
    valid_count: int
    duplicate_count: int
    error_count: int
    preview_rows: list[BankImportPreviewRow] = Field(default_factory=list)
    row_errors: list[BankImportRowError] = Field(default_factory=list)
