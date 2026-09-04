"""add paused flag to dingtalk auto sync settings

Revision ID: 20260904_0018
Revises: 20260904_0017
Create Date: 2026-09-04
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260904_0018"
down_revision: str | Sequence[str] | None = "20260904_0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "dingtalk_auto_sync_settings",
        sa.Column("paused", sa.Boolean(), nullable=False, server_default=sa.text("false")),
    )


def downgrade() -> None:
    op.drop_column("dingtalk_auto_sync_settings", "paused")
