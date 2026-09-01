"""link expense items to approval lines

Revision ID: 20260901_0025
Revises: 20260901_0024
Create Date: 2026-09-01
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260901_0025"
down_revision: str | Sequence[str] | None = "20260901_0024"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("expense_items", "source_document_id", type_=sa.String(length=220))
    op.add_column("expense_items", sa.Column("approval_instance_id", sa.String(length=32), nullable=True))
    op.add_column("expense_items", sa.Column("approval_line_no", sa.Integer(), nullable=True))
    op.add_column("expense_items", sa.Column("approval_line_key", sa.String(length=160), nullable=True))
    op.add_column("expense_items", sa.Column("parse_status", sa.String(length=24), nullable=True))
    op.add_column("expense_items", sa.Column("remark", sa.Text(), nullable=True))
    op.create_index("ix_expense_items_approval_instance", "expense_items", ["approval_instance_id"])
    op.create_index("ix_expense_items_approval_line", "expense_items", ["approval_instance_id", "approval_line_no"])
    op.create_foreign_key(
        "fk_expense_items_approval_instance",
        "expense_items",
        "approval_instances",
        ["approval_instance_id"],
        ["id"],
    )


def downgrade() -> None:
    op.drop_constraint("fk_expense_items_approval_instance", "expense_items", type_="foreignkey")
    op.drop_index("ix_expense_items_approval_line", table_name="expense_items")
    op.drop_index("ix_expense_items_approval_instance", table_name="expense_items")
    op.drop_column("expense_items", "remark")
    op.drop_column("expense_items", "parse_status")
    op.drop_column("expense_items", "approval_line_key")
    op.drop_column("expense_items", "approval_line_no")
    op.drop_column("expense_items", "approval_instance_id")
    op.alter_column("expense_items", "source_document_id", type_=sa.String(length=120))
