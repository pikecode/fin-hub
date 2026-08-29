"""add dingtalk department snapshot table

Revision ID: 20260830_0014
Revises: 20260829_0013
Create Date: 2026-08-30
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260830_0014"
down_revision: str | Sequence[str] | None = "20260829_0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dingtalk_departments",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("dept_id", sa.String(length=120), nullable=False),
        sa.Column("parent_id", sa.String(length=120)),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("path", sa.String(length=500), nullable=False),
        sa.Column("depth", sa.Integer(), nullable=False),
        sa.Column("is_store_candidate", sa.Boolean(), nullable=False),
        sa.Column("store_id", sa.String(length=32), sa.ForeignKey("stores.id")),
        sa.Column("raw_payload", sa.Text()),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(), nullable=False),
        sa.Column("last_synced_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("dept_id", name="uq_dingtalk_departments_dept_id"),
    )
    op.create_index("ix_dingtalk_departments_parent_id", "dingtalk_departments", ["parent_id"])
    op.create_index("ix_dingtalk_departments_store_candidate", "dingtalk_departments", ["is_store_candidate"])


def downgrade() -> None:
    op.drop_index("ix_dingtalk_departments_store_candidate", table_name="dingtalk_departments")
    op.drop_index("ix_dingtalk_departments_parent_id", table_name="dingtalk_departments")
    op.drop_table("dingtalk_departments")
