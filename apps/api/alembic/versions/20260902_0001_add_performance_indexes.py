"""add performance indexes

Revision ID: 20260902_0001
Revises: 20260901_0027
Create Date: 2026-09-02
"""

from alembic import op

# revision identifiers, used by Alembic.
revision = "20260902_0001"
down_revision = "20260901_0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "idx_expense_store_ledger_created",
        "expense_items",
        ["store_id", "ledger_period", "created_at"],
        unique=False,
        postgresql_using="btree",
        postgresql_ops={"created_at": "DESC"},
        if_not_exists=True,
    )
    op.create_index(
        "idx_expense_payment_status",
        "expense_items",
        ["payment_status"],
        unique=False,
        if_not_exists=True,
    )
    op.create_index(
        "idx_expense_approval_instance",
        "expense_items",
        ["approval_instance_id"],
        unique=False,
        if_not_exists=True,
    )

    op.create_index(
        "idx_bank_store_ledger_occurred",
        "bank_transactions",
        ["store_id", "ledger_period", "occurred_at"],
        unique=False,
        postgresql_using="btree",
        postgresql_ops={"occurred_at": "DESC"},
        if_not_exists=True,
    )
    op.create_index(
        "idx_bank_store_direction",
        "bank_transactions",
        ["store_id", "direction"],
        unique=False,
        if_not_exists=True,
    )
    op.create_index(
        "idx_bank_amount",
        "bank_transactions",
        ["amount"],
        unique=False,
        if_not_exists=True,
    )

    op.create_index(
        "idx_expense_bank_match_status_created",
        "expense_bank_matches",
        ["status", "created_at"],
        unique=False,
        postgresql_using="btree",
        postgresql_ops={"created_at": "DESC"},
        if_not_exists=True,
    )
    op.create_index(
        "idx_expense_bank_match_bank",
        "expense_bank_matches",
        ["bank_transaction_id"],
        unique=False,
        if_not_exists=True,
    )
    op.create_index(
        "idx_expense_bank_match_expense",
        "expense_bank_matches",
        ["expense_item_id"],
        unique=False,
        if_not_exists=True,
    )

    op.create_index(
        "idx_revenue_bank_match_status_created",
        "revenue_bank_matches",
        ["status", "created_at"],
        unique=False,
        postgresql_using="btree",
        postgresql_ops={"created_at": "DESC"},
        if_not_exists=True,
    )
    op.create_index(
        "idx_revenue_bank_match_bank",
        "revenue_bank_matches",
        ["bank_transaction_id"],
        unique=False,
        if_not_exists=True,
    )

    op.create_index(
        "idx_revenue_store_ledger_date",
        "revenue_records",
        ["store_id", "ledger_period", "revenue_date"],
        unique=False,
        postgresql_using="btree",
        postgresql_ops={"revenue_date": "DESC"},
        if_not_exists=True,
    )
    op.create_index(
        "idx_revenue_channel",
        "revenue_records",
        ["channel"],
        unique=False,
        if_not_exists=True,
    )

    op.create_index(
        "idx_audit_created",
        "audit_logs",
        ["created_at"],
        unique=False,
        postgresql_using="btree",
        postgresql_ops={"created_at": "DESC"},
        if_not_exists=True,
    )
    op.create_index(
        "idx_audit_action",
        "audit_logs",
        ["action"],
        unique=False,
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("idx_audit_action", table_name="audit_logs", if_exists=True)
    op.drop_index("idx_audit_created", table_name="audit_logs", if_exists=True)
    op.drop_index("idx_revenue_channel", table_name="revenue_records", if_exists=True)
    op.drop_index("idx_revenue_store_ledger_date", table_name="revenue_records", if_exists=True)
    op.drop_index("idx_revenue_bank_match_bank", table_name="revenue_bank_matches", if_exists=True)
    op.drop_index(
        "idx_revenue_bank_match_status_created",
        table_name="revenue_bank_matches",
        if_exists=True,
    )
    op.drop_index("idx_expense_bank_match_expense", table_name="expense_bank_matches", if_exists=True)
    op.drop_index("idx_expense_bank_match_bank", table_name="expense_bank_matches", if_exists=True)
    op.drop_index(
        "idx_expense_bank_match_status_created",
        table_name="expense_bank_matches",
        if_exists=True,
    )
    op.drop_index("idx_bank_amount", table_name="bank_transactions", if_exists=True)
    op.drop_index("idx_bank_store_direction", table_name="bank_transactions", if_exists=True)
    op.drop_index("idx_bank_store_ledger_occurred", table_name="bank_transactions", if_exists=True)
    op.drop_index("idx_expense_approval_instance", table_name="expense_items", if_exists=True)
    op.drop_index("idx_expense_payment_status", table_name="expense_items", if_exists=True)
    op.drop_index("idx_expense_store_ledger_created", table_name="expense_items", if_exists=True)
