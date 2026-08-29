"""initial domain tables

Revision ID: 20260828_0001
Revises:
Create Date: 2026-08-28
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260828_0001"
down_revision: str | Sequence[str] | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "stores",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("dingtalk_dept_id", sa.String(length=120)),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("contact_person", sa.String(length=80)),
        sa.Column("phone", sa.String(length=40)),
        sa.Column("address", sa.String(length=240)),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "dingtalk_configs",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("corp_id", sa.String(length=120)),
        sa.Column("app_key", sa.String(length=120)),
        sa.Column("app_secret_encrypted", sa.Text()),
        sa.Column("admin_user_id", sa.String(length=120)),
        sa.Column("drive_union_id", sa.String(length=120)),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("last_template_sync_at", sa.DateTime()),
        sa.Column("last_instance_sync_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "ledgers",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("store_id", sa.String(length=32), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("period", sa.String(length=7), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("closed_at", sa.DateTime()),
        sa.Column("closed_by", sa.String(length=80)),
        sa.Column("reopened_at", sa.DateTime()),
        sa.Column("reopened_by", sa.String(length=80)),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("store_id", "period", name="uq_ledgers_store_period"),
    )
    op.create_table(
        "expense_items",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("store_id", sa.String(length=32), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("ledger_period", sa.String(length=7), nullable=False),
        sa.Column("expense_date", sa.Date()),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("category_l1", sa.String(length=80)),
        sa.Column("category_l2", sa.String(length=80)),
        sa.Column("supplier_name", sa.String(length=120)),
        sa.Column("payee_account", sa.String(length=120)),
        sa.Column("payment_status", sa.String(length=24), nullable=False),
        sa.Column("source", sa.String(length=24), nullable=False),
        sa.Column("source_document_id", sa.String(length=120)),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_expense_items_store_period", "expense_items", ["store_id", "ledger_period"])
    op.create_index("ix_expense_items_payment_status", "expense_items", ["payment_status"])
    op.create_table(
        "bank_transactions",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("store_id", sa.String(length=32), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("ledger_period", sa.String(length=7), nullable=False),
        sa.Column("occurred_at", sa.DateTime(), nullable=False),
        sa.Column("direction", sa.String(length=12), nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("counterparty_name", sa.String(length=120)),
        sa.Column("counterparty_account", sa.String(length=120)),
        sa.Column("summary", sa.String(length=240)),
        sa.Column("bank_serial_no", sa.String(length=120)),
        sa.Column("matched_amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_bank_transactions_store_period", "bank_transactions", ["store_id", "ledger_period"])
    op.create_index("ix_bank_transactions_occurred_at", "bank_transactions", ["occurred_at"])
    op.create_table(
        "expense_bank_matches",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column(
            "expense_item_id", sa.String(length=32), sa.ForeignKey("expense_items.id"), nullable=False
        ),
        sa.Column(
            "bank_transaction_id",
            sa.String(length=32),
            sa.ForeignKey("bank_transactions.id"),
            nullable=False,
        ),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("confidence", sa.Numeric(5, 2)),
        sa.Column("reason", sa.String(length=240)),
        sa.Column("confirmed_by", sa.String(length=80)),
        sa.Column("confirmed_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("expense_item_id", "bank_transaction_id", name="uq_expense_bank_match"),
    )


def downgrade() -> None:
    op.drop_table("expense_bank_matches")
    op.drop_index("ix_bank_transactions_occurred_at", table_name="bank_transactions")
    op.drop_index("ix_bank_transactions_store_period", table_name="bank_transactions")
    op.drop_table("bank_transactions")
    op.drop_index("ix_expense_items_payment_status", table_name="expense_items")
    op.drop_index("ix_expense_items_store_period", table_name="expense_items")
    op.drop_table("expense_items")
    op.drop_table("ledgers")
    op.drop_table("dingtalk_configs")
    op.drop_table("stores")
