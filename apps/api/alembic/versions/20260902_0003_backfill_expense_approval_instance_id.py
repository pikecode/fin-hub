"""backfill expense approval instance ids

Revision ID: 20260902_0003
Revises: 20260902_0002
Create Date: 2026-09-02
"""

from alembic import op

revision = "20260902_0003"
down_revision = "20260902_0002"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        UPDATE expense_items AS expense
        SET approval_instance_id = approval.id
        FROM approval_instances AS approval
        WHERE expense.approval_instance_id IS NULL
          AND expense.source = 'dingtalk'
          AND expense.source_document_id IS NOT NULL
          AND (
              expense.source_document_id = approval.dingtalk_instance_id
              OR expense.source_document_id LIKE approval.dingtalk_instance_id || ':%'
          )
        """
    )


def downgrade() -> None:
    pass
