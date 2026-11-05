"""Persistent financial review notices for changed reconciled approvals."""

import sqlalchemy as sa

from alembic import op

revision = "20261103_0039"
down_revision = "20261103_0038"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "approval_change_notices",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column(
            "approval_id", sa.String(32), sa.ForeignKey("approval_instances.id"), nullable=False
        ),
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("before_json", sa.Text(), nullable=False),
        sa.Column("after_json", sa.Text(), nullable=False),
        sa.Column("changed_fields_json", sa.Text(), nullable=False),
        sa.Column("periods_json", sa.Text(), nullable=False),
        sa.Column("detected_at", sa.DateTime(), nullable=False),
        sa.Column("reviewed_at", sa.DateTime()),
        sa.Column("reviewed_by", sa.String(32), sa.ForeignKey("users.id")),
        sa.Column("review_note", sa.Text()),
        sa.UniqueConstraint("approval_id", "store_id", name="uq_approval_notice_store"),
    )
    for column in ("approval_id", "store_id", "status"):
        op.create_index(f"ix_approval_change_notices_{column}", "approval_change_notices", [column])
    # Existing conflicts have no reliable before snapshot: say so explicitly.
    op.execute("""INSERT INTO approval_change_notices
        (id,approval_id,store_id,status,version,before_json,after_json,changed_fields_json,periods_json,detected_at)
        SELECT md5(a.id || e.store_id),a.id,e.store_id,'pending',1,
        '{"说明":"历史变更前快照不可用"}',
        json_build_object('审批状态',a.approval_status)::text,
        '["审批状态","历史同步冲突或撤销，请对照原报表核实"]',
        COALESCE(json_agg(DISTINCT m.accounting_period) FILTER (WHERE m.accounting_period IS NOT NULL),'[]'::json)::text,CURRENT_TIMESTAMP
        FROM approval_instances a JOIN expense_items e ON
          (e.approval_instance_id=a.id OR e.source_document_id=a.dingtalk_instance_id
           OR starts_with(e.source_document_id,a.dingtalk_instance_id || ':'))
        JOIN expense_bank_matches m ON m.expense_item_id=e.id
        WHERE m.status='confirmed' AND m.expense_scope='operating' AND e.store_id IS NOT NULL
        AND ((e.sync_conflict_status IS NOT NULL AND e.sync_conflict_status <> 'none')
          OR lower(a.approval_status) IN ('terminated','canceled','cancelled','cancel','withdrawn','refuse','reject','rejected','refused','deny'))
        GROUP BY a.id,e.store_id""")


def downgrade():
    op.drop_table("approval_change_notices")
