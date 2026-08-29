"""revenue bank matches

Revision ID: 20260829_0010
Revises: 20260829_0009
Create Date: 2026-08-29
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260829_0010"
down_revision: str | Sequence[str] | None = "20260829_0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "revenue_bank_matches",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("bank_transaction_id", sa.String(length=32), nullable=False),
        sa.Column("channel", sa.String(length=80), nullable=False),
        sa.Column("revenue_start_date", sa.Date(), nullable=False),
        sa.Column("revenue_end_date", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("confidence", sa.Numeric(5, 2), nullable=True),
        sa.Column("reason", sa.String(length=240), nullable=True),
        sa.Column("confirmed_by", sa.String(length=80), nullable=True),
        sa.Column("confirmed_at", sa.DateTime(), nullable=True),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["bank_transaction_id"], ["bank_transactions.id"]),
        sa.UniqueConstraint(
            "bank_transaction_id",
            "channel",
            "revenue_start_date",
            "revenue_end_date",
            name="uq_revenue_bank_match_range",
        ),
    )


def downgrade() -> None:
    op.drop_table("revenue_bank_matches")
