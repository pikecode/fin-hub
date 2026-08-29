"""expense categories and suppliers

Revision ID: 20260829_0005
Revises: 20260829_0004
Create Date: 2026-08-29
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260829_0005"
down_revision: str | Sequence[str] | None = "20260829_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "expense_categories",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("parent_id", sa.String(length=32), sa.ForeignKey("expense_categories.id")),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("name", "parent_id", name="uq_expense_category_name_parent"),
    )
    op.create_table(
        "suppliers",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("bank_account", sa.String(length=120)),
        sa.Column("contact_name", sa.String(length=80)),
        sa.Column("phone", sa.String(length=40)),
        sa.Column("remark", sa.String(length=240)),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("name", name="uq_suppliers_name"),
    )


def downgrade() -> None:
    op.drop_table("suppliers")
    op.drop_table("expense_categories")
