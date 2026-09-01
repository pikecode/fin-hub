"""add expense line source and payee snapshot fields

Revision ID: 20260901_0027
Revises: 20260901_0026
Create Date: 2026-09-01
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260901_0027"
down_revision: str | Sequence[str] | None = "20260901_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("expense_items", sa.Column("approval_line_source_type", sa.String(length=32), nullable=True))
    op.add_column("expense_items", sa.Column("payee_name", sa.String(length=120), nullable=True))
    op.add_column("expense_items", sa.Column("payee_bank_name", sa.String(length=120), nullable=True))
    op.add_column("expense_items", sa.Column("payee_bank_branch", sa.String(length=180), nullable=True))
    op.add_column("expense_items", sa.Column("payee_account_no", sa.String(length=120), nullable=True))
    op.add_column("expense_items", sa.Column("payee_account_type", sa.String(length=60), nullable=True))
    op.add_column("expense_items", sa.Column("payee_account_verify_status", sa.String(length=60), nullable=True))
    op.add_column("expense_items", sa.Column("payee_account_snapshot_json", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("expense_items", "payee_account_snapshot_json")
    op.drop_column("expense_items", "payee_account_verify_status")
    op.drop_column("expense_items", "payee_account_type")
    op.drop_column("expense_items", "payee_account_no")
    op.drop_column("expense_items", "payee_bank_branch")
    op.drop_column("expense_items", "payee_bank_name")
    op.drop_column("expense_items", "payee_name")
    op.drop_column("expense_items", "approval_line_source_type")
