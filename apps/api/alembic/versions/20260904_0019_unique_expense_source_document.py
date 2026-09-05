"""add unique source document index for expense items

Revision ID: 20260904_0019
Revises: 20260904_0018
Create Date: 2026-09-04
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260904_0019"
down_revision: str | Sequence[str] | None = "20260904_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    ORDER BY COALESCE(started_at, created_at) DESC, id DESC
                ) AS row_number
            FROM sync_jobs
            WHERE status = 'running'
              AND job_type IN (
                  'dingtalk_approval_sync',
                  'dingtalk_store_approval_sync',
                  'dingtalk_auto_sync'
              )
        )
        UPDATE sync_jobs
        SET
            status = 'failed',
            finished_at = COALESCE(finished_at, CURRENT_TIMESTAMP),
            error_message = COALESCE(error_message, '迁移时发现重复运行中的钉钉同步任务，已自动标记失败')
        WHERE id IN (
            SELECT id FROM ranked WHERE row_number > 1
        )
        """
    )
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY source, source_document_id
                    ORDER BY created_at ASC, id ASC
                ) AS row_number
            FROM expense_items
            WHERE source_document_id IS NOT NULL
        ),
        matched_duplicates AS (
            SELECT DISTINCT expense_bank_matches.expense_item_id AS id
            FROM expense_bank_matches
            JOIN ranked ON ranked.id = expense_bank_matches.expense_item_id
            WHERE ranked.row_number > 1
        )
        UPDATE expense_items
        SET source_document_id = NULL
        WHERE id IN (SELECT id FROM matched_duplicates)
        """
    )
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                ROW_NUMBER() OVER (
                    PARTITION BY source, source_document_id
                    ORDER BY created_at ASC, id ASC
                ) AS row_number
            FROM expense_items
            WHERE source_document_id IS NOT NULL
        )
        DELETE FROM expense_items
        WHERE id IN (
            SELECT ranked.id
            FROM ranked
            LEFT JOIN expense_bank_matches
                ON expense_bank_matches.expense_item_id = ranked.id
            WHERE ranked.row_number > 1
              AND expense_bank_matches.id IS NULL
        )
        """
    )
    op.create_index(
        "uq_expense_items_source_document",
        "expense_items",
        ["source", "source_document_id"],
        unique=True,
        postgresql_where=sa.text("source_document_id IS NOT NULL"),
        sqlite_where=sa.text("source_document_id IS NOT NULL"),
    )
    op.create_index(
        "uq_sync_jobs_running_dingtalk",
        "sync_jobs",
        ["status"],
        unique=True,
        postgresql_where=sa.text(
            "status = 'running' AND job_type IN "
            "('dingtalk_approval_sync', 'dingtalk_store_approval_sync', 'dingtalk_auto_sync')"
        ),
        sqlite_where=sa.text(
            "status = 'running' AND job_type IN "
            "('dingtalk_approval_sync', 'dingtalk_store_approval_sync', 'dingtalk_auto_sync')"
        ),
    )


def downgrade() -> None:
    op.drop_index("uq_sync_jobs_running_dingtalk", table_name="sync_jobs")
    op.drop_index("uq_expense_items_source_document", table_name="expense_items")
