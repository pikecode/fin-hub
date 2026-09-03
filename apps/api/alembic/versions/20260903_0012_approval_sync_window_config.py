"""Add approval sync window configuration

Revision ID: 20260903_0012
Revises: 20260903_0011
Create Date: 2026-09-03

Problem: Sync window was hardcoded to 7 days, causing data to be missed
Solution: Make window_days configurable (default 14), add approval_overlap_days (default 2)

Changes:
- Update window_days default from 7 to 14 days
- Add approval_overlap_days column to handle overlap between syncs
- Ensures no approval data is missed between sync runs
"""
from alembic import op
import sqlalchemy as sa


def upgrade() -> None:
    # Add approval_overlap_days column
    op.add_column(
        'dingtalk_auto_sync_settings',
        sa.Column('approval_overlap_days', sa.Integer(), nullable=False, server_default='2')
    )

    # Update existing records to use new window_days default
    op.execute("""
        UPDATE dingtalk_auto_sync_settings
        SET window_days = 14
        WHERE window_days = 7
    """)


def downgrade() -> None:
    # Revert window_days
    op.execute("""
        UPDATE dingtalk_auto_sync_settings
        SET window_days = 7
        WHERE window_days = 14
    """)

    # Remove approval_overlap_days column
    op.drop_column('dingtalk_auto_sync_settings', 'approval_overlap_days')
