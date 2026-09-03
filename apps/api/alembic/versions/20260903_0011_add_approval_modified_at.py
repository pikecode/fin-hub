"""Add indexes for approval modification tracking

Revision ID: 20260903_0011
Revises: 20260903_0010
Create Date: 2026-09-03

Problem: Approval modifications (修改) were not being tracked, causing:
- Updated approval amounts to not sync
- Rejected and resubmitted approvals to be skipped
- Financial data inconsistency

Solution: Index dingtalk_modified_at to support approval change detection.
"""

from alembic import op

revision = "20260903_0011"
down_revision = "20260903_0010"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Add dingtalk_modified_at indexes"""

    op.create_index(
        "idx_approval_instance_modified_at",
        "approval_instances",
        ["dingtalk_modified_at"],
        unique=False,
    )

    op.create_index(
        "idx_approval_instance_template_modified",
        "approval_instances",
        ["template_id", "dingtalk_modified_at"],
        unique=False,
    )

    op.create_index(
        "idx_approval_instance_modified_status",
        "approval_instances",
        ["dingtalk_modified_at", "parse_status", "approval_status"],
        unique=False,
    )


def downgrade() -> None:
    """Drop dingtalk_modified_at indexes"""
    op.drop_index("idx_approval_instance_modified_status", table_name="approval_instances")
    op.drop_index("idx_approval_instance_template_modified", table_name="approval_instances")
    op.drop_index("idx_approval_instance_modified_at", table_name="approval_instances")
