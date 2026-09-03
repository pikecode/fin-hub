"""Add performance optimization indexes for dingtalk sync

Revision ID: 20260903_0010
Revises: 20260903_0009
Create Date: 2026-09-03

Performance improvements:
1. Index on approval_instance for dingtalk_instance_id lookups (freq query)
2. Index on approval_instance for template_id + approval_status (sync filtering)
3. Index on expense_item for source_document_id (idempotency checks)
4. Index on store for dingtalk_dept_id (department sync)
5. Composite index for approval expense stats queries
"""

from alembic import op
import sqlalchemy as sa

# revision identifiers
revision = "20260903_0010"
down_revision = "20260903_0009"
branch_labels = None
depends_on = None


def upgrade() -> None:
    """Create optimization indexes"""

    # Index 1: approval_instances.dingtalk_instance_id (frequent lookup)
    # Used in: sync_real_instance, run_approval_sync, approval_needs_detail_resync
    op.create_index(
        "idx_approval_instance_dingtalk_id",
        "approval_instances",
        ["dingtalk_instance_id"],
        unique=False,
    )

    # Index 2: approval_instances (template_id + approval_status)
    # Used in: run_approval_sync retry loop filtering
    op.create_index(
        "idx_approval_instance_template_status",
        "approval_instances",
        ["template_id", "approval_status"],
        unique=False,
    )

    # Index 3: approval_instances (template_id + parse_status + processing_status)
    # Used in: approval_needs_detail_resync checks
    op.create_index(
        "idx_approval_instance_template_parse",
        "approval_instances",
        ["template_id", "parse_status", "processing_status"],
        unique=False,
    )

    # Index 4: expense_items.source_document_id (idempotency check)
    # Used in: sync_expense_line, mark_removed_expense_lines
    # Note: Already has unique constraint in most DBs, but explicit index helps
    op.create_index(
        "idx_expense_item_source_document_id",
        "expense_items",
        ["source_document_id"],
        unique=False,
    )

    # Index 5: expense_items (approval_instance_id + source)
    # Used in: mark_removed_expense_lines filtering
    op.create_index(
        "idx_expense_item_approval_source",
        "expense_items",
        ["approval_instance_id", "source"],
        unique=False,
    )

    # Index 6: stores.dingtalk_dept_id (department sync lookup)
    # Used in: sync_departments_to_stores_core
    op.create_index(
        "idx_store_dingtalk_dept_id",
        "stores",
        ["dingtalk_dept_id"],
        unique=False,
    )

    # Index 7: dingtalk_departments (is_active + is_store_candidate)
    # Used in: load_local_departments filtering
    op.create_index(
        "idx_dingtalk_department_active_candidate",
        "dingtalk_departments",
        ["is_active", "is_store_candidate"],
        unique=False,
    )

    # Index 8: approval_templates.is_enabled (query optimization)
    # Used in: start_approval_sync, list_approval_instances
    op.create_index(
        "idx_approval_template_enabled",
        "approval_templates",
        ["is_enabled"],
        unique=False,
    )

    # Index 9: approval_instances (synced_job_id + created_at)
    # Used in: approval_expense_stats queries
    op.create_index(
        "idx_approval_instance_job_created",
        "approval_instances",
        ["synced_job_id", "created_at"],
        unique=False,
    )

    # Index 10: sync_jobs (status + created_at)
    # Used in: list_sync_jobs filtering
    op.create_index(
        "idx_sync_job_status_created",
        "sync_jobs",
        ["status", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    """Drop optimization indexes"""
    op.drop_index("idx_sync_job_status_created", table_name="sync_jobs")
    op.drop_index("idx_approval_instance_job_created", table_name="approval_instances")
    op.drop_index("idx_approval_template_enabled", table_name="approval_templates")
    op.drop_index(
        "idx_dingtalk_department_active_candidate",
        table_name="dingtalk_departments",
    )
    op.drop_index("idx_store_dingtalk_dept_id", table_name="stores")
    op.drop_index("idx_expense_item_approval_source", table_name="expense_items")
    op.drop_index("idx_expense_item_source_document_id", table_name="expense_items")
    op.drop_index("idx_approval_instance_template_parse", table_name="approval_instances")
    op.drop_index("idx_approval_instance_template_status", table_name="approval_instances")
    op.drop_index("idx_approval_instance_dingtalk_id", table_name="approval_instances")
