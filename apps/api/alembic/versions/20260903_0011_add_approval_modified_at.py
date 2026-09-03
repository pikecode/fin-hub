"""Add dingtalk_modified_at field to track approval modifications

Revision ID: 20260903_0011
Revises: 20260903_0010
Create Date: 2026-09-03

Problem: Approval modifications (修改) were not being tracked, causing:
- Updated approval amounts to not sync
- Rejected and resubmitted approvals to be skipped
- Financial data inconsistency

Solution: Add dingtalk_modified_at to detect approval changes beyond submit_at
"""

from alembic import op
import sqlalchemy as sa

revision = "20260903_0011"
down_revision = "20260903_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add dingtalk_modified_at and index"""

    # ✅ Add column to track modification time from DingTalk
    op.add_column(
        "approval_instance",
        sa.Column("dingtalk_modified_at", sa.DateTime(), nullable=True),
    )

    # ✅ Index for sync logic: prioritize recently modified approvals
    op.create_index(
        "idx_approval_instance_modified_at",
        "approval_instance",
        ["dingtalk_modified_at"],
        unique=False,
    )

    # ✅ Composite index: template_id + dingtalk_modified_at for sync queries
    op.create_index(
        "idx_approval_instance_template_modified",
        "approval_instance",
        ["template_id", "dingtalk_modified_at"],
        unique=False,
    )

    # ✅ Composite index: detect approvals modified after last sync
    op.create_index(
        "idx_approval_instance_modified_status",
        "approval_instance",
        ["dingtalk_modified_at", "parse_status", "approval_status"],
        unique=False,
    )


def downgrade() -> None:
    """Drop dingtalk_modified_at and indexes"""
    op.drop_index("idx_approval_instance_modified_status", table_name="approval_instance")
    op.drop_index("idx_approval_instance_template_modified", table_name="approval_instance")
    op.drop_index("idx_approval_instance_modified_at", table_name="approval_instance")
    op.drop_column("approval_instance", "dingtalk_modified_at")
