"""add performance indexes

Revision ID: 20260902_0001
Revises: 20260901_0027
Create Date: 2026-09-02

添加核心业务查询索引以提升性能
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "20260902_0001"
down_revision = "20260901_0027"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 支出明细表索引
    op.create_index(
        "idx_expense_store_ledger",
        "expense_items",
        ["store_id", "ledger_id"],
        unique=False,
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
        "idx_expense_created",
        "expense_items",
        ["created_at"],
        unique=False,
        postgresql_using="btree",
        postgresql_ops={"created_at": "DESC"},
        if_not_exists=True,
    )

    # 银行流水表索引
    op.create_index(
        "idx_bank_store_occurred",
        "bank_transactions",
        ["store_id", "occurred_at"],
        unique=False,
        postgresql_using="btree",
        postgresql_ops={"occurred_at": "DESC"},
        if_not_exists=True,
    )
    op.create_index(
        "idx_bank_store_ledger",
        "bank_transactions",
        ["store_id", "ledger_id"],
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

    # 匹配关系表索引
    op.create_index(
        "idx_match_status_created",
        "matches",
        ["match_status", "created_at"],
        unique=False,
        postgresql_using="btree",
        postgresql_ops={"created_at": "DESC"},
        if_not_exists=True,
    )

    # 营业收入表索引
    op.create_index(
        "idx_revenue_store_ledger",
        "revenue_records",
        ["store_id", "ledger_id"],
        unique=False,
        if_not_exists=True,
    )
    op.create_index(
        "idx_revenue_occurred",
        "revenue_records",
        ["occurred_at"],
        unique=False,
        postgresql_using="btree",
        postgresql_ops={"occurred_at": "DESC"},
        if_not_exists=True,
    )

    # 审计日志表索引
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
        "idx_audit_user",
        "audit_logs",
        ["user_id"],
        unique=False,
        if_not_exists=True,
    )


def downgrade() -> None:
    # 删除索引（按相反顺序）
    op.drop_index("idx_audit_user", table_name="audit_logs", if_exists=True)
    op.drop_index("idx_audit_created", table_name="audit_logs", if_exists=True)
    op.drop_index("idx_revenue_occurred", table_name="revenue_records", if_exists=True)
    op.drop_index("idx_revenue_store_ledger", table_name="revenue_records", if_exists=True)
    op.drop_index("idx_match_status_created", table_name="matches", if_exists=True)
    op.drop_index("idx_bank_amount", table_name="bank_transactions", if_exists=True)
    op.drop_index("idx_bank_store_ledger", table_name="bank_transactions", if_exists=True)
    op.drop_index("idx_bank_store_occurred", table_name="bank_transactions", if_exists=True)
    op.drop_index("idx_expense_created", table_name="expense_items", if_exists=True)
    op.drop_index("idx_expense_payment_status", table_name="expense_items", if_exists=True)
    op.drop_index("idx_expense_store_ledger", table_name="expense_items", if_exists=True)
