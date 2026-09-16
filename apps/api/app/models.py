from datetime import UTC, date, datetime
from decimal import Decimal
from enum import StrEnum
from uuid import uuid4

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


def new_id() -> str:
    return uuid4().hex


def utc_now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class StoreStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class LedgerStatus(StrEnum):
    OPEN = "open"
    CLOSED = "closed"


class ExpensePaymentStatus(StrEnum):
    UNPAID = "unpaid"
    PARTIAL_PAID = "partial_paid"
    PAID = "paid"
    NO_BANK_FLOW = "no_bank_flow"


class BankPaymentStatus(StrEnum):
    PAID = "paid"
    UNPAID = "unpaid"


class BankSpecialType(StrEnum):
    CURRENT_ACCOUNT = "current_account"
    SHAREHOLDER_DIVIDEND = "shareholder_dividend"
    SHAREHOLDER_CAPITAL = "shareholder_capital"
    OTHER_INCOME_EXPENSE = "other_income_expense"


class MatchStatus(StrEnum):
    CANDIDATE = "candidate"
    CONFIRMED = "confirmed"
    REJECTED = "rejected"


class SyncJobStatus(StrEnum):
    PENDING = "pending"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    CANCELED = "canceled"


class AttachmentStatus(StrEnum):
    STORED = "stored"
    PLACEHOLDER = "placeholder"
    FAILED = "failed"


class UserRole(StrEnum):
    ADMIN = "admin"
    FINANCE = "finance"
    VIEWER = "viewer"


class UserStatus(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"


class ShareholderGrantStatus(StrEnum):
    ACTIVE = "active"
    DISABLED = "disabled"


class MasterDataStatus(StrEnum):
    ACTIVE = "active"
    INACTIVE = "inactive"


class User(Base):
    __tablename__ = "users"
    __table_args__ = (UniqueConstraint("username", name="uq_users_username"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    username: Mapped[str] = mapped_column(String(80), nullable=False)
    display_name: Mapped[str] = mapped_column(String(80), nullable=False)
    password_hash: Mapped[str] = mapped_column(String(240), nullable=False)
    role: Mapped[str] = mapped_column(String(24), default=UserRole.ADMIN.value, nullable=False)
    status: Mapped[str] = mapped_column(String(24), default=UserStatus.ACTIVE.value, nullable=False)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class Role(Base):
    __tablename__ = "roles"
    __table_args__ = (UniqueConstraint("key", name="uq_roles_key"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    key: Mapped[str] = mapped_column(String(24), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    sort_order: Mapped[int] = mapped_column(default=0, nullable=False)
    is_system: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class RolePermission(Base):
    __tablename__ = "role_permissions"
    __table_args__ = (
        UniqueConstraint("role", "permission", name="uq_role_permission"),
        Index("ix_role_permissions_role", "role"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    role: Mapped[str] = mapped_column(String(24), nullable=False)
    permission: Mapped[str] = mapped_column(String(80), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class RolePermissionSetting(Base):
    __tablename__ = "role_permission_settings"

    role: Mapped[str] = mapped_column(String(24), primary_key=True)
    permissions_configured: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class UserStorePermission(Base):
    __tablename__ = "user_store_permissions"
    __table_args__ = (
        UniqueConstraint("user_id", "store_id", name="uq_user_store_permission"),
        Index("ix_user_store_permissions_user_id", "user_id"),
        Index("ix_user_store_permissions_store_id", "store_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class UserStoreGroupPermission(Base):
    __tablename__ = "user_store_group_permissions"
    __table_args__ = (
        UniqueConstraint("user_id", "group_id", name="uq_user_store_group_permission"),
        Index("ix_user_store_group_permissions_user_id", "user_id"),
        Index("ix_user_store_group_permissions_group_id", "group_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    group_id: Mapped[str] = mapped_column(ForeignKey("store_groups.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class StoreGroup(Base):
    __tablename__ = "store_groups"
    __table_args__ = (UniqueConstraint("name", name="uq_store_groups_name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    sort_order: Mapped[int] = mapped_column(default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )

    stores: Mapped[list["Store"]] = relationship(back_populates="group")


class Store(Base):
    __tablename__ = "stores"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    group_id: Mapped[str | None] = mapped_column(ForeignKey("store_groups.id", ondelete="SET NULL"))
    dingtalk_dept_id: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(24), default=StoreStatus.ACTIVE.value, nullable=False)
    contact_person: Mapped[str | None] = mapped_column(String(80))
    phone: Mapped[str | None] = mapped_column(String(40))
    address: Mapped[str | None] = mapped_column(String(240))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )

    ledgers: Mapped[list["Ledger"]] = relationship(back_populates="store")
    group: Mapped[StoreGroup | None] = relationship(back_populates="stores")


class Ledger(Base):
    __tablename__ = "ledgers"
    __table_args__ = (UniqueConstraint("store_id", "period", name="uq_ledgers_store_period"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), nullable=False)
    period: Mapped[str] = mapped_column(String(7), nullable=False)
    status: Mapped[str] = mapped_column(String(24), default=LedgerStatus.OPEN.value, nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime)
    closed_by: Mapped[str | None] = mapped_column(String(80))
    reopened_at: Mapped[datetime | None] = mapped_column(DateTime)
    reopened_by: Mapped[str | None] = mapped_column(String(80))
    version: Mapped[int] = mapped_column(default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )

    store: Mapped[Store] = relationship(back_populates="ledgers")


class DividendShareholder(Base):
    __tablename__ = "dividend_shareholders"
    __table_args__ = (
        UniqueConstraint("store_id", "name", name="uq_dividend_shareholders_store_name"),
        Index("ix_dividend_shareholders_store", "store_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), nullable=False)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    holding_ratio: Mapped[Decimal] = mapped_column(Numeric(7, 4), nullable=False)
    status: Mapped[str] = mapped_column(String(24), default=MasterDataStatus.ACTIVE.value, nullable=False)
    remark: Mapped[str | None] = mapped_column(String(240))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)


class DividendMonth(Base):
    __tablename__ = "dividend_months"
    __table_args__ = (UniqueConstraint("store_id", "period", name="uq_dividend_months_store_period"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), nullable=False)
    period: Mapped[str] = mapped_column(String(7), nullable=False)
    reference_ratio: Mapped[Decimal] = mapped_column(Numeric(7, 4), default=60, nullable=False)
    no_distribution: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    no_capital: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    locked: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    locked_at: Mapped[datetime | None] = mapped_column(DateTime)
    locked_by: Mapped[str | None] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)


class DividendEntry(Base):
    __tablename__ = "dividend_entries"
    __table_args__ = (Index("ix_dividend_entries_month_type", "month_id", "entry_type"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    month_id: Mapped[str] = mapped_column(ForeignKey("dividend_months.id", ondelete="CASCADE"), nullable=False)
    entry_type: Mapped[str] = mapped_column(String(24), nullable=False)
    shareholder_id: Mapped[str | None] = mapped_column(ForeignKey("dividend_shareholders.id", ondelete="SET NULL"))
    shareholder_name: Mapped[str] = mapped_column(String(80), nullable=False)
    holding_ratio: Mapped[Decimal] = mapped_column(Numeric(7, 4), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    remark: Mapped[str | None] = mapped_column(String(240))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now, nullable=False)


class RevenueChannel(Base):
    __tablename__ = "revenue_channels"
    __table_args__ = (UniqueConstraint("name", name="uq_revenue_channels_name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    sort_order: Mapped[int] = mapped_column(default=0, nullable=False)
    requires_bank_match: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    scope_mode: Mapped[str] = mapped_column(String(24), default="all_stores", nullable=False)
    status: Mapped[str] = mapped_column(String(24), default=MasterDataStatus.ACTIVE.value, nullable=False)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime)
    deleted_by: Mapped[str | None] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class RevenueChannelStoreLink(Base):
    __tablename__ = "revenue_channel_store_links"
    __table_args__ = (
        UniqueConstraint("channel_id", "store_id", name="uq_revenue_channel_store_link"),
        Index("ix_revenue_channel_store_links_store_id", "store_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    channel_id: Mapped[str] = mapped_column(ForeignKey("revenue_channels.id", ondelete="CASCADE"), nullable=False)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id", ondelete="CASCADE"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class RevenueRecord(Base):
    __tablename__ = "revenue_records"
    __table_args__ = (
        Index("ix_revenue_records_store_period", "store_id", "ledger_period"),
        UniqueConstraint("store_id", "ledger_period", "revenue_date", "channel", name="uq_revenue_record_day_channel"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), nullable=False)
    ledger_period: Mapped[str] = mapped_column(String(7), nullable=False)
    revenue_date: Mapped[datetime] = mapped_column(Date, nullable=False)
    channel: Mapped[str] = mapped_column(String(80), nullable=False)
    gross_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    net_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    fee_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0, nullable=False)
    remark: Mapped[str | None] = mapped_column(String(240))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class ExpenseCategory(Base):
    __tablename__ = "expense_categories"
    __table_args__ = (UniqueConstraint("name", "parent_id", name="uq_expense_category_name_parent"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(80), nullable=False)
    parent_id: Mapped[str | None] = mapped_column(ForeignKey("expense_categories.id"))
    sort_order: Mapped[int] = mapped_column(default=0, nullable=False)
    status: Mapped[str] = mapped_column(String(24), default=MasterDataStatus.ACTIVE.value, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class Supplier(Base):
    __tablename__ = "suppliers"
    __table_args__ = (UniqueConstraint("name", name="uq_suppliers_name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    bank_account: Mapped[str | None] = mapped_column(String(120))
    contact_name: Mapped[str | None] = mapped_column(String(80))
    phone: Mapped[str | None] = mapped_column(String(40))
    remark: Mapped[str | None] = mapped_column(String(240))
    status: Mapped[str] = mapped_column(String(24), default=MasterDataStatus.ACTIVE.value, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"
    __table_args__ = (
        Index("ix_audit_logs_resource", "resource_type", "resource_id"),
        Index("ix_audit_logs_created_at", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    actor: Mapped[str] = mapped_column(String(80), default="system", nullable=False)
    action: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(80), nullable=False)
    resource_id: Mapped[str | None] = mapped_column(String(80))
    summary: Mapped[str | None] = mapped_column(String(240))
    metadata_json: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class ShareholderAccessGrant(Base):
    __tablename__ = "shareholder_access_grants"
    __table_args__ = (UniqueConstraint("name", name="uq_shareholder_access_grants_name"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    name: Mapped[str] = mapped_column(String(120), nullable=False)
    access_code_hash: Mapped[str] = mapped_column(String(240), nullable=False)
    store_ids_json: Mapped[str] = mapped_column(Text, nullable=False)
    status: Mapped[str] = mapped_column(
        String(24), default=ShareholderGrantStatus.ACTIVE.value, nullable=False
    )
    expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class ExpenseItem(Base):
    __tablename__ = "expense_items"
    __table_args__ = (
        Index("ix_expense_items_store_period", "store_id", "ledger_period"),
        Index("ix_expense_items_payment_status", "payment_status"),
        Index("ix_expense_items_approval_instance", "approval_instance_id"),
        Index("ix_expense_items_approval_line", "approval_instance_id", "approval_line_no"),
        Index("ix_expense_items_sync_conflict", "sync_conflict_status"),
        Index(
            "uq_expense_items_source_document",
            "source",
            "source_document_id",
            unique=True,
            sqlite_where=text("source_document_id IS NOT NULL"),
            postgresql_where=text("source_document_id IS NOT NULL"),
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    store_id: Mapped[str | None] = mapped_column(ForeignKey("stores.id"))
    ledger_period: Mapped[str | None] = mapped_column(String(7))
    expense_date: Mapped[datetime | None] = mapped_column(Date)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    category_l1: Mapped[str | None] = mapped_column(String(80))
    category_l2: Mapped[str | None] = mapped_column(String(80))
    supplier_name: Mapped[str | None] = mapped_column(String(120))
    payee_account: Mapped[str | None] = mapped_column(String(120))
    approval_instance_id: Mapped[str | None] = mapped_column(ForeignKey("approval_instances.id"))
    approval_line_no: Mapped[int | None] = mapped_column()
    approval_line_key: Mapped[str | None] = mapped_column(String(160))
    approval_line_source_type: Mapped[str | None] = mapped_column(String(32))
    parse_status: Mapped[str | None] = mapped_column(String(24))
    remark: Mapped[str | None] = mapped_column(Text)
    source_sync_hash: Mapped[str | None] = mapped_column(String(64))
    source_snapshot_json: Mapped[str | None] = mapped_column(Text)
    user_edited_fields_json: Mapped[str | None] = mapped_column(Text)
    sync_conflict_status: Mapped[str | None] = mapped_column(String(40))
    payee_name: Mapped[str | None] = mapped_column(String(120))
    payee_bank_name: Mapped[str | None] = mapped_column(String(120))
    payee_bank_branch: Mapped[str | None] = mapped_column(String(180))
    payee_account_no: Mapped[str | None] = mapped_column(String(120))
    payee_account_type: Mapped[str | None] = mapped_column(String(60))
    payee_account_verify_status: Mapped[str | None] = mapped_column(String(60))
    payee_account_snapshot_json: Mapped[str | None] = mapped_column(Text)
    payment_status: Mapped[str] = mapped_column(
        String(24), default=ExpensePaymentStatus.UNPAID.value, nullable=False
    )
    source: Mapped[str] = mapped_column(String(24), default="manual", nullable=False)
    source_document_id: Mapped[str | None] = mapped_column(String(220))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class Attachment(Base):
    __tablename__ = "attachments"
    __table_args__ = (
        Index("ix_attachments_resource", "resource_type", "resource_id"),
        UniqueConstraint(
            "resource_type",
            "resource_id",
            "source",
            "external_file_id",
            name="uq_attachment_resource_external_file",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    resource_type: Mapped[str] = mapped_column(String(60), nullable=False)
    resource_id: Mapped[str] = mapped_column(String(32), nullable=False)
    file_name: Mapped[str] = mapped_column(String(240), nullable=False)
    content_type: Mapped[str | None] = mapped_column(String(120))
    file_size: Mapped[int | None] = mapped_column()
    file_path: Mapped[str | None] = mapped_column(String(500))
    file_hash: Mapped[str | None] = mapped_column(String(128))
    source: Mapped[str] = mapped_column(String(24), default="manual", nullable=False)
    external_file_id: Mapped[str | None] = mapped_column(Text)
    download_status: Mapped[str] = mapped_column(
        String(24), default=AttachmentStatus.STORED.value, nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class BankTransaction(Base):
    __tablename__ = "bank_transactions"
    __table_args__ = (
        Index("ix_bank_transactions_store_period", "store_id", "ledger_period"),
        Index("ix_bank_transactions_occurred_at", "occurred_at"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), nullable=False)
    ledger_period: Mapped[str] = mapped_column(String(7), nullable=False)
    occurred_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    direction: Mapped[str] = mapped_column(String(12), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    counterparty_name: Mapped[str | None] = mapped_column(String(120))
    counterparty_account: Mapped[str | None] = mapped_column(String(120))
    summary: Mapped[str | None] = mapped_column(String(240))
    bank_serial_no: Mapped[str | None] = mapped_column(String(120))
    payment_status: Mapped[str] = mapped_column(String(24), default=BankPaymentStatus.PAID.value, nullable=False)
    special_type: Mapped[str | None] = mapped_column(String(32))
    matched_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=0, nullable=False)
    import_job_id: Mapped[str | None] = mapped_column(ForeignKey("sync_jobs.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class BankBalanceCorrection(Base):
    __tablename__ = "bank_balance_corrections"
    __table_args__ = (
        Index("ix_bank_balance_corrections_store_date", "store_id", "correction_date"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), nullable=False)
    correction_date: Mapped[date] = mapped_column(Date, nullable=False)
    balance_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    remark: Mapped[str] = mapped_column(String(500), nullable=False)
    created_by: Mapped[str] = mapped_column(ForeignKey("users.id"), nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class ExpenseBankMatch(Base):
    __tablename__ = "expense_bank_matches"
    __table_args__ = (
        UniqueConstraint("expense_item_id", "bank_transaction_id", name="uq_expense_bank_match"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    expense_item_id: Mapped[str] = mapped_column(ForeignKey("expense_items.id"), nullable=False)
    bank_transaction_id: Mapped[str] = mapped_column(ForeignKey("bank_transactions.id"), nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    accounting_period: Mapped[str | None] = mapped_column(String(7))
    bank_occurred: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    status: Mapped[str] = mapped_column(String(24), default=MatchStatus.CANDIDATE.value, nullable=False)
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    reason: Mapped[str | None] = mapped_column(String(240))
    confirmed_by: Mapped[str | None] = mapped_column(String(80))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class RevenueBankMatch(Base):
    __tablename__ = "revenue_bank_matches"
    __table_args__ = (
        UniqueConstraint(
            "bank_transaction_id",
            "channel",
            "revenue_start_date",
            "revenue_end_date",
            name="uq_revenue_bank_match_range",
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    bank_transaction_id: Mapped[str] = mapped_column(ForeignKey("bank_transactions.id"), nullable=False)
    channel: Mapped[str] = mapped_column(String(80), nullable=False)
    revenue_start_date: Mapped[datetime] = mapped_column(Date, nullable=False)
    revenue_end_date: Mapped[datetime] = mapped_column(Date, nullable=False)
    amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    accounting_period: Mapped[str | None] = mapped_column(String(7))
    status: Mapped[str] = mapped_column(String(24), default=MatchStatus.CANDIDATE.value, nullable=False)
    confidence: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    reason: Mapped[str | None] = mapped_column(String(240))
    confirmed_by: Mapped[str | None] = mapped_column(String(80))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class RevenueBankMatchRecord(Base):
    __tablename__ = "revenue_bank_match_records"
    __table_args__ = (
        UniqueConstraint(
            "revenue_bank_match_id",
            "revenue_record_id",
            name="uq_revenue_bank_match_record",
        ),
        Index("ix_revenue_bank_match_records_record", "revenue_record_id"),
        Index("ix_revenue_bank_match_records_match", "revenue_bank_match_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    revenue_bank_match_id: Mapped[str] = mapped_column(
        ForeignKey("revenue_bank_matches.id"), nullable=False
    )
    revenue_record_id: Mapped[str] = mapped_column(
        ForeignKey("revenue_records.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)


class DingTalkConfig(Base):
    __tablename__ = "dingtalk_configs"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    corp_id: Mapped[str | None] = mapped_column(String(120))
    app_key: Mapped[str | None] = mapped_column(String(120))
    app_secret_encrypted: Mapped[str | None] = mapped_column(Text)
    admin_user_id: Mapped[str | None] = mapped_column(String(120))
    drive_union_id: Mapped[str | None] = mapped_column(String(120))
    status: Mapped[str] = mapped_column(String(24), default="not_configured", nullable=False)
    last_template_sync_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_instance_sync_at: Mapped[datetime | None] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class DingTalkAutoSyncSetting(Base):
    __tablename__ = "dingtalk_auto_sync_settings"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    scheduled_time: Mapped[str] = mapped_column(String(5), default="02:00", nullable=False)
    interval_minutes: Mapped[int] = mapped_column(default=60, nullable=False)
    window_days: Mapped[int] = mapped_column(default=120, nullable=False)
    approval_overlap_days: Mapped[int] = mapped_column(default=2, nullable=False)
    root_dept_id: Mapped[str] = mapped_column(String(120), default="1", nullable=False)
    max_depth: Mapped[int] = mapped_column(default=6, nullable=False)
    page_size: Mapped[int] = mapped_column(default=20, nullable=False)
    max_pages: Mapped[int] = mapped_column(default=500, nullable=False)
    skip_existing: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sync_departments: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sync_templates: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    sync_approvals: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    paused: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    next_run_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_run_at: Mapped[datetime | None] = mapped_column(DateTime)
    approval_watermark_at: Mapped[datetime | None] = mapped_column(DateTime)
    approval_resume_state: Mapped[str | None] = mapped_column(Text)
    last_job_id: Mapped[str | None] = mapped_column(ForeignKey("sync_jobs.id"))
    last_status: Mapped[str | None] = mapped_column(String(24))
    last_error: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class DingTalkDepartment(Base):
    __tablename__ = "dingtalk_departments"

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    dept_id: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    parent_id: Mapped[str | None] = mapped_column(String(120))
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    path: Mapped[str] = mapped_column(String(500), nullable=False)
    depth: Mapped[int] = mapped_column(default=0, nullable=False)
    is_store_candidate: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    store_id: Mapped[str | None] = mapped_column(ForeignKey("stores.id"))
    raw_payload: Mapped[str | None] = mapped_column(Text)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    last_synced_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class ApprovalTemplate(Base):
    __tablename__ = "approval_templates"
    __table_args__ = (UniqueConstraint("process_code", name="uq_approval_templates_process_code"),)

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    process_code: Mapped[str] = mapped_column(String(160), nullable=False)
    name: Mapped[str] = mapped_column(String(160), nullable=False)
    is_enabled: Mapped[bool] = mapped_column(default=True, nullable=False)
    mapping_status: Mapped[str] = mapped_column(String(24), default="unmapped", nullable=False)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime)
    raw_snapshot: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )

    mappings: Mapped[list["TemplateFieldMapping"]] = relationship(
        back_populates="template",
        cascade="all, delete-orphan",
    )
    nodes: Mapped[list["ApprovalTemplateNode"]] = relationship(
        back_populates="template",
        cascade="all, delete-orphan",
    )


class TemplateFieldMapping(Base):
    __tablename__ = "template_field_mappings"
    __table_args__ = (
        UniqueConstraint("template_id", "standard_field", name="uq_template_standard_field"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    template_id: Mapped[str] = mapped_column(ForeignKey("approval_templates.id"), nullable=False)
    standard_field: Mapped[str] = mapped_column(String(80), nullable=False)
    display_label: Mapped[str | None] = mapped_column(String(120))
    source_field_id: Mapped[str | None] = mapped_column(String(120))
    source_field_name: Mapped[str] = mapped_column(String(120), nullable=False)
    source_path: Mapped[str | None] = mapped_column(String(240))
    field_type: Mapped[str | None] = mapped_column(String(60))
    show_in_list: Mapped[bool] = mapped_column(default=False, nullable=False)
    show_in_detail: Mapped[bool] = mapped_column(default=True, nullable=False)
    is_required: Mapped[bool] = mapped_column(default=False, nullable=False)
    sort_order: Mapped[int] = mapped_column(default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )

    template: Mapped[ApprovalTemplate] = relationship(back_populates="mappings")


class ApprovalTemplateNode(Base):
    __tablename__ = "approval_template_nodes"
    __table_args__ = (
        UniqueConstraint("template_id", "activity_id", name="uq_approval_template_node_activity"),
        Index("ix_approval_template_nodes_template", "template_id"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    template_id: Mapped[str] = mapped_column(ForeignKey("approval_templates.id"), nullable=False)
    activity_id: Mapped[str] = mapped_column(String(120), nullable=False)
    node_name: Mapped[str] = mapped_column(String(160), nullable=False)
    node_type: Mapped[str | None] = mapped_column(String(60))
    sort_order: Mapped[int] = mapped_column(default=0, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )

    template: Mapped[ApprovalTemplate] = relationship(back_populates="nodes")


class SyncJob(Base):
    __tablename__ = "sync_jobs"
    __table_args__ = (
        Index("ix_sync_jobs_type_status", "job_type", "status"),
        Index(
            "uq_sync_jobs_running_dingtalk",
            "status",
            unique=True,
            sqlite_where=text(
                "status = 'running' AND job_type IN "
                "('dingtalk_approval_sync', 'dingtalk_store_approval_sync', 'dingtalk_auto_sync')"
            ),
            postgresql_where=text(
                "status = 'running' AND job_type IN "
                "('dingtalk_approval_sync', 'dingtalk_store_approval_sync', 'dingtalk_auto_sync')"
            ),
        ),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    job_type: Mapped[str] = mapped_column(String(60), nullable=False)
    status: Mapped[str] = mapped_column(String(24), default=SyncJobStatus.PENDING.value, nullable=False)
    started_by: Mapped[str | None] = mapped_column(String(80))
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)
    request_start_at: Mapped[datetime | None] = mapped_column(DateTime)
    request_end_at: Mapped[datetime | None] = mapped_column(DateTime)
    next_cursor: Mapped[str | None] = mapped_column(Text)
    processed_count: Mapped[int] = mapped_column(default=0, nullable=False)
    success_count: Mapped[int] = mapped_column(default=0, nullable=False)
    failed_count: Mapped[int] = mapped_column(default=0, nullable=False)
    error_message: Mapped[str | None] = mapped_column(Text)
    raw_summary: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )


class ApprovalInstance(Base):
    __tablename__ = "approval_instances"
    __table_args__ = (
        UniqueConstraint("dingtalk_instance_id", name="uq_approval_instances_dingtalk_id"),
        Index("ix_approval_instances_template_status", "template_id", "approval_status"),
    )

    id: Mapped[str] = mapped_column(String(32), primary_key=True, default=new_id)
    template_id: Mapped[str] = mapped_column(ForeignKey("approval_templates.id"), nullable=False)
    dingtalk_instance_id: Mapped[str] = mapped_column(String(160), nullable=False)
    approval_no: Mapped[str | None] = mapped_column(String(120))
    store_id: Mapped[str | None] = mapped_column(ForeignKey("stores.id"))
    department_name: Mapped[str | None] = mapped_column(String(240))
    applicant_name: Mapped[str | None] = mapped_column(String(80))
    applicant_user_id: Mapped[str | None] = mapped_column(String(120))
    approval_status: Mapped[str] = mapped_column(String(32), nullable=False)
    parse_status: Mapped[str] = mapped_column(String(32), default="unparsed", nullable=False)
    processing_status: Mapped[str] = mapped_column(String(32), default="unparsed", nullable=False)
    parse_error: Mapped[str | None] = mapped_column(Text)
    last_parsed_at: Mapped[datetime | None] = mapped_column(DateTime)
    submit_at: Mapped[datetime | None] = mapped_column(DateTime)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    dingtalk_modified_at: Mapped[datetime | None] = mapped_column(DateTime)
    raw_payload: Mapped[str | None] = mapped_column(Text)
    synced_job_id: Mapped[str | None] = mapped_column(ForeignKey("sync_jobs.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=utc_now, onupdate=utc_now, nullable=False
    )
