"""add approval processing status

Revision ID: 20260902_0002
Revises: 20260902_0001
Create Date: 2026-09-02
"""

import sqlalchemy as sa

from alembic import op

revision = "20260902_0002"
down_revision = "20260902_0001"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "approval_instances",
        sa.Column("parse_status", sa.String(length=32), nullable=False, server_default="unparsed"),
    )
    op.add_column(
        "approval_instances",
        sa.Column("processing_status", sa.String(length=32), nullable=False, server_default="unparsed"),
    )
    op.add_column("approval_instances", sa.Column("parse_error", sa.Text(), nullable=True))
    op.add_column("approval_instances", sa.Column("last_parsed_at", sa.DateTime(), nullable=True))
    op.create_index(
        "idx_approval_instances_processing_status",
        "approval_instances",
        ["processing_status"],
        unique=False,
        if_not_exists=True,
    )
    op.execute(
        """
        UPDATE approval_instances AS approval
        SET parse_status = 'parsed'
        WHERE EXISTS (
            SELECT 1
            FROM expense_items AS expense
            WHERE expense.approval_instance_id = approval.id
        )
        """
    )
    op.execute(
        """
        UPDATE approval_instances AS approval
        SET processing_status = CASE
            WHEN NOT EXISTS (
                SELECT 1
                FROM expense_items AS expense
                WHERE expense.approval_instance_id = approval.id
            ) THEN 'unparsed'
            WHEN EXISTS (
                SELECT 1
                FROM expense_items AS expense
                WHERE expense.approval_instance_id = approval.id
                  AND expense.sync_conflict_status IS NOT NULL
                  AND expense.sync_conflict_status != 'none'
            ) THEN 'sync_conflict'
            WHEN EXISTS (
                SELECT 1
                FROM expense_items AS expense
                WHERE expense.approval_instance_id = approval.id
                  AND expense.category_l1 IS NULL
                  AND expense.category_l2 IS NULL
            ) THEN 'pending_classification'
            WHEN NOT EXISTS (
                SELECT 1
                FROM expense_items AS expense
                WHERE expense.approval_instance_id = approval.id
                  AND expense.payment_status != 'paid'
            ) THEN 'matched'
            WHEN EXISTS (
                SELECT 1
                FROM expense_items AS expense
                WHERE expense.approval_instance_id = approval.id
                  AND expense.payment_status = 'paid'
            ) THEN 'partial_matched'
            ELSE 'pending_match'
        END
        """
    )


def downgrade() -> None:
    op.drop_index("idx_approval_instances_processing_status", table_name="approval_instances", if_exists=True)
    op.drop_column("approval_instances", "last_parsed_at")
    op.drop_column("approval_instances", "parse_error")
    op.drop_column("approval_instances", "processing_status")
    op.drop_column("approval_instances", "parse_status")
