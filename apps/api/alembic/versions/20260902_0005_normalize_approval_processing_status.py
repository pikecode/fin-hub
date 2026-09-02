"""normalize approval processing status for line items

Revision ID: 20260902_0005
Revises: 20260902_0004
Create Date: 2026-09-02
"""

from alembic import op

revision = "20260902_0005"
down_revision = "20260902_0004"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        WITH approvals_with_line_items AS (
            SELECT DISTINCT expense.approval_instance_id
            FROM expense_items AS expense
            JOIN approval_instances AS approval ON approval.id = expense.approval_instance_id
            WHERE expense.approval_instance_id IS NOT NULL
              AND expense.source = 'dingtalk'
              AND expense.source_document_id LIKE approval.dingtalk_instance_id || ':%'
        ),
        normalized_expenses AS (
            SELECT expense.*
            FROM expense_items AS expense
            JOIN approval_instances AS approval ON approval.id = expense.approval_instance_id
            LEFT JOIN approvals_with_line_items AS line_approval
              ON line_approval.approval_instance_id = expense.approval_instance_id
            WHERE line_approval.approval_instance_id IS NULL
               OR expense.source != 'dingtalk'
               OR expense.source_document_id IS NULL
               OR expense.source_document_id != approval.dingtalk_instance_id
        )
        UPDATE approval_instances AS approval
        SET processing_status = CASE
            WHEN NOT EXISTS (
                SELECT 1 FROM normalized_expenses AS expense WHERE expense.approval_instance_id = approval.id
            ) THEN 'unparsed'
            WHEN EXISTS (
                SELECT 1 FROM normalized_expenses AS expense
                WHERE expense.approval_instance_id = approval.id
                  AND expense.sync_conflict_status IS NOT NULL
                  AND expense.sync_conflict_status != 'none'
            ) THEN 'sync_conflict'
            WHEN EXISTS (
                SELECT 1 FROM normalized_expenses AS expense
                WHERE expense.approval_instance_id = approval.id
                  AND expense.category_l1 IS NULL
                  AND expense.category_l2 IS NULL
            ) THEN 'pending_classification'
            WHEN NOT EXISTS (
                SELECT 1 FROM normalized_expenses AS expense
                WHERE expense.approval_instance_id = approval.id
                  AND expense.payment_status != 'paid'
            ) THEN 'matched'
            WHEN EXISTS (
                SELECT 1 FROM normalized_expenses AS expense
                WHERE expense.approval_instance_id = approval.id
                  AND expense.payment_status = 'paid'
            ) THEN 'partial_matched'
            ELSE 'pending_match'
        END
        """
    )


def downgrade() -> None:
    pass
