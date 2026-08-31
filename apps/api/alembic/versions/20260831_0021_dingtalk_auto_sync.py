"""add dingtalk auto sync settings

Revision ID: 20260831_0021
Revises: 20260831_0020
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260831_0021"
down_revision: str | Sequence[str] | None = "20260831_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dingtalk_auto_sync_settings",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("interval_minutes", sa.Integer(), nullable=False, server_default="60"),
        sa.Column("window_days", sa.Integer(), nullable=False, server_default="7"),
        sa.Column("root_dept_id", sa.String(length=120), nullable=False, server_default="1"),
        sa.Column("max_depth", sa.Integer(), nullable=False, server_default="6"),
        sa.Column("page_size", sa.Integer(), nullable=False, server_default="20"),
        sa.Column("max_pages", sa.Integer(), nullable=False, server_default="20"),
        sa.Column("skip_existing", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sync_departments", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sync_templates", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("sync_approvals", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("next_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_run_at", sa.DateTime(), nullable=True),
        sa.Column("last_job_id", sa.String(length=32), nullable=True),
        sa.Column("last_status", sa.String(length=24), nullable=True),
        sa.Column("last_error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["last_job_id"], ["sync_jobs.id"]),
        sa.PrimaryKeyConstraint("id"),
    )


def downgrade() -> None:
    op.drop_table("dingtalk_auto_sync_settings")
