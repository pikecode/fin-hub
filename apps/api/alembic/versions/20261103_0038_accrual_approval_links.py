"""Approval coverage for accruals."""

import sqlalchemy as sa

from alembic import op

revision = "20261103_0038"
down_revision = "20261103_0037"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("expense_bank_matches", sa.Column("accrual_coverage_json", sa.Text()))
    op.create_table(
        "accrual_approval_links",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column(
            "original_id", sa.String(32), sa.ForeignKey("accrual_entries.id"), nullable=False
        ),
        sa.Column(
            "approval_id", sa.String(32), sa.ForeignKey("approval_instances.id"), nullable=False
        ),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("active", sa.Boolean(), nullable=False),
        sa.Column("remark", sa.Text(), nullable=False),
        sa.Column("request_key", sa.String(64), nullable=False),
        sa.Column("created_by", sa.String(32), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("request_key", name="uq_accrual_link_request"),
        sa.CheckConstraint("amount > 0", name="ck_accrual_link_positive"),
    )
    for column in ("original_id", "approval_id"):
        op.create_index(f"ix_accrual_approval_links_{column}", "accrual_approval_links", [column])
    # Materialize phase-one entries as immutable reporting expenses.
    op.execute("""INSERT INTO expense_items
        (id,store_id,ledger_period,expense_date,description,amount,category_l1,category_l2,
         expense_scope,payment_status,source,source_document_id,created_at,updated_at)
        SELECT id,store_id,period,to_date(period || '-01','YYYY-MM-DD'),
          '[' || CASE entry_type WHEN 'reversal' THEN '冲销' WHEN 'supplement' THEN '补提' ELSE '计提' END || '] ' || remark,
          CASE WHEN entry_type='reversal' THEN -amount ELSE amount END,
          category_l1,category_l2,'operating','no_bank_flow','accrual',id,created_at,created_at
        FROM accrual_entries ON CONFLICT (id) DO NOTHING""")


def downgrade():
    op.drop_column("expense_bank_matches", "accrual_coverage_json")
    op.drop_table("accrual_approval_links")
    # Existing reporting expenses are intentionally retained to avoid losing financial history.
