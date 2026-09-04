"""Backfill DingTalk approval modified time

Revision ID: 20260904_0015
Revises: 20260903_0014
Create Date: 2026-09-04
"""

from alembic import op


revision = "20260904_0015"
down_revision = "20260903_0014"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE approval_instances
        SET dingtalk_modified_at = COALESCE(approved_at, submit_at, updated_at, created_at)
        WHERE dingtalk_modified_at IS NULL
        """
    )


def downgrade() -> None:
    pass
