"""add dingtalk auto sync schedule time

Revision ID: 20260831_0023
Revises: 20260831_0022
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260831_0023"
down_revision: str | Sequence[str] | None = "20260831_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "dingtalk_auto_sync_settings",
        sa.Column("scheduled_time", sa.String(length=5), nullable=False, server_default="02:00"),
    )


def downgrade() -> None:
    op.drop_column("dingtalk_auto_sync_settings", "scheduled_time")
