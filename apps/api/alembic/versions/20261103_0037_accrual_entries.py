"""Independent accrual and reversal ledger (not yet included in reports)."""

import sqlalchemy as sa

from alembic import op

revision = "20261103_0037"
down_revision = "20261027_0036"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "accrual_entries",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("period", sa.String(7), nullable=False),
        sa.Column("entry_type", sa.String(20), nullable=False),
        sa.Column("original_id", sa.String(32), sa.ForeignKey("accrual_entries.id")),
        sa.Column("category_l1", sa.String(100), nullable=False),
        sa.Column("category_l2", sa.String(100), nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("remark", sa.Text(), nullable=False),
        sa.Column("request_key", sa.String(64), nullable=False),
        sa.Column("created_by", sa.String(32), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("store_id", "request_key", name="uq_accrual_request"),
        sa.CheckConstraint("amount > 0", name="ck_accrual_positive"),
        sa.CheckConstraint(
            "(entry_type = 'accrual' AND original_id IS NULL) OR (entry_type IN ('supplement', 'reversal') AND original_id IS NOT NULL)",
            name="ck_accrual_original",
        ),
    )
    for column in ("store_id", "period", "original_id"):
        op.create_index(f"ix_accrual_entries_{column}", "accrual_entries", [column])


def downgrade():
    op.drop_table("accrual_entries")
