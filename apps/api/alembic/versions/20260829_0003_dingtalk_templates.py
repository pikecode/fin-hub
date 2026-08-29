"""dingtalk templates and mappings

Revision ID: 20260829_0003
Revises: 20260829_0002
Create Date: 2026-08-29
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260829_0003"
down_revision: str | Sequence[str] | None = "20260829_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "approval_templates",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("process_code", sa.String(length=160), nullable=False),
        sa.Column("name", sa.String(length=160), nullable=False),
        sa.Column("is_enabled", sa.Boolean(), nullable=False),
        sa.Column("mapping_status", sa.String(length=24), nullable=False),
        sa.Column("last_sync_at", sa.DateTime()),
        sa.Column("raw_snapshot", sa.Text()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("process_code", name="uq_approval_templates_process_code"),
    )
    op.create_table(
        "template_field_mappings",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column(
            "template_id",
            sa.String(length=32),
            sa.ForeignKey("approval_templates.id"),
            nullable=False,
        ),
        sa.Column("standard_field", sa.String(length=80), nullable=False),
        sa.Column("source_field_id", sa.String(length=120)),
        sa.Column("source_field_name", sa.String(length=120), nullable=False),
        sa.Column("source_path", sa.String(length=240)),
        sa.Column("field_type", sa.String(length=60)),
        sa.Column("is_required", sa.Boolean(), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("template_id", "standard_field", name="uq_template_standard_field"),
    )


def downgrade() -> None:
    op.drop_table("template_field_mappings")
    op.drop_table("approval_templates")
