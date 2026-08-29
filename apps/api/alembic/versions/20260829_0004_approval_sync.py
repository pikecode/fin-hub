"""approval sync jobs and instances

Revision ID: 20260829_0004
Revises: 20260829_0003
Create Date: 2026-08-29
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260829_0004"
down_revision: str | Sequence[str] | None = "20260829_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "sync_jobs",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("job_type", sa.String(length=60), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("started_by", sa.String(length=80)),
        sa.Column("started_at", sa.DateTime()),
        sa.Column("finished_at", sa.DateTime()),
        sa.Column("processed_count", sa.Integer(), nullable=False),
        sa.Column("success_count", sa.Integer(), nullable=False),
        sa.Column("failed_count", sa.Integer(), nullable=False),
        sa.Column("error_message", sa.Text()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_sync_jobs_type_status", "sync_jobs", ["job_type", "status"])
    op.create_table(
        "approval_instances",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column(
            "template_id",
            sa.String(length=32),
            sa.ForeignKey("approval_templates.id"),
            nullable=False,
        ),
        sa.Column("dingtalk_instance_id", sa.String(length=160), nullable=False),
        sa.Column("approval_no", sa.String(length=120)),
        sa.Column("store_id", sa.String(length=32), sa.ForeignKey("stores.id")),
        sa.Column("applicant_name", sa.String(length=80)),
        sa.Column("applicant_user_id", sa.String(length=120)),
        sa.Column("approval_status", sa.String(length=32), nullable=False),
        sa.Column("submit_at", sa.DateTime()),
        sa.Column("approved_at", sa.DateTime()),
        sa.Column("raw_payload", sa.Text()),
        sa.Column("synced_job_id", sa.String(length=32), sa.ForeignKey("sync_jobs.id")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("dingtalk_instance_id", name="uq_approval_instances_dingtalk_id"),
    )
    op.create_index(
        "ix_approval_instances_template_status",
        "approval_instances",
        ["template_id", "approval_status"],
    )


def downgrade() -> None:
    op.drop_index("ix_approval_instances_template_status", table_name="approval_instances")
    op.drop_table("approval_instances")
    op.drop_index("ix_sync_jobs_type_status", table_name="sync_jobs")
    op.drop_table("sync_jobs")
