"""refresh approval processing status after expense backfill

Revision ID: 20260902_0004
Revises: 20260902_0003
Create Date: 2026-09-02
"""

from alembic import op

revision = "20260902_0004"
down_revision = "20260902_0003"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE approval_instances AS approval
        SET parse_status = 'parsed',
            parse_error = NULL
        WHERE EXISTS (
            SELECT 1
            FROM expense_items AS expense
            WHERE expense.approval_instance_id = approval.id
        )
          AND (approval.parse_status IS NULL OR approval.parse_status IN ('unparsed', 'skipped'))
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
    pass
