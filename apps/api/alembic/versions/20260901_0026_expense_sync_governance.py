"""add expense sync governance fields

Revision ID: 20260901_0026
Revises: 20260901_0025
Create Date: 2026-09-01
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260901_0026"
down_revision: str | Sequence[str] | None = "20260901_0025"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("expense_items", sa.Column("source_sync_hash", sa.String(length=64), nullable=True))
    op.add_column("expense_items", sa.Column("source_snapshot_json", sa.Text(), nullable=True))
    op.add_column("expense_items", sa.Column("user_edited_fields_json", sa.Text(), nullable=True))
    op.add_column("expense_items", sa.Column("sync_conflict_status", sa.String(length=40), nullable=True))
    op.create_index("ix_expense_items_sync_conflict", "expense_items", ["sync_conflict_status"])


def downgrade() -> None:
    op.drop_index("ix_expense_items_sync_conflict", table_name="expense_items")
    op.drop_column("expense_items", "sync_conflict_status")
    op.drop_column("expense_items", "user_edited_fields_json")
    op.drop_column("expense_items", "source_snapshot_json")
    op.drop_column("expense_items", "source_sync_hash")
