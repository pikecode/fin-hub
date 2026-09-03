"""persist approval sync watermark and continuation state

Revision ID: 20260903_0002
Revises: 20260903_0001
Create Date: 2026-09-03 10:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260903_0002"
down_revision = "20260903_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("sync_jobs", "next_cursor", type_=sa.Text())
    op.add_column(
        "dingtalk_auto_sync_settings",
        sa.Column("approval_watermark_at", sa.DateTime(), nullable=True),
    )
    op.add_column(
        "dingtalk_auto_sync_settings",
        sa.Column("approval_resume_state", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("dingtalk_auto_sync_settings", "approval_resume_state")
    op.drop_column("dingtalk_auto_sync_settings", "approval_watermark_at")
    op.alter_column("sync_jobs", "next_cursor", type_=sa.String(length=80))
