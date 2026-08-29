"""revenue records

Revision ID: 20260829_0008
Revises: 20260829_0007
Create Date: 2026-08-29
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260829_0008"
down_revision: str | Sequence[str] | None = "20260829_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "revenue_records",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("store_id", sa.String(length=32), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("ledger_period", sa.String(length=7), nullable=False),
        sa.Column("revenue_date", sa.Date(), nullable=False),
        sa.Column("channel", sa.String(length=80), nullable=False),
        sa.Column("gross_amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("net_amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("fee_amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("remark", sa.String(length=240)),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("store_id", "ledger_period", "revenue_date", "channel", name="uq_revenue_record_day_channel"),
    )
    op.create_index("ix_revenue_records_store_period", "revenue_records", ["store_id", "ledger_period"])


def downgrade() -> None:
    op.drop_index("ix_revenue_records_store_period", table_name="revenue_records")
    op.drop_table("revenue_records")
