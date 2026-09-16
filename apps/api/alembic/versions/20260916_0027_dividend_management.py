"""add dividend management tables

Revision ID: 20260916_0027
Revises: 20260914_0026
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260916_0027"
down_revision: str | Sequence[str] | None = "20260914_0026"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "dividend_shareholders",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("holding_ratio", sa.Numeric(7, 4), nullable=False),
        sa.Column("status", sa.String(24), nullable=False, server_default="active"),
        sa.Column("remark", sa.String(240)),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("store_id", "name", name="uq_dividend_shareholders_store_name"),
    )
    op.create_index("ix_dividend_shareholders_store", "dividend_shareholders", ["store_id"])
    op.create_table(
        "dividend_months",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id", ondelete="CASCADE"), nullable=False),
        sa.Column("period", sa.String(7), nullable=False),
        sa.Column("reference_ratio", sa.Numeric(7, 4), nullable=False, server_default="60"),
        sa.Column("no_distribution", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("no_capital", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("locked", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("locked_at", sa.DateTime()),
        sa.Column("locked_by", sa.String(80)),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("store_id", "period", name="uq_dividend_months_store_period"),
    )
    op.create_table(
        "dividend_entries",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("month_id", sa.String(32), sa.ForeignKey("dividend_months.id", ondelete="CASCADE"), nullable=False),
        sa.Column("entry_type", sa.String(24), nullable=False),
        sa.Column("shareholder_id", sa.String(32), sa.ForeignKey("dividend_shareholders.id", ondelete="SET NULL")),
        sa.Column("shareholder_name", sa.String(80), nullable=False),
        sa.Column("holding_ratio", sa.Numeric(7, 4), nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("remark", sa.String(240)),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_dividend_entries_month_type", "dividend_entries", ["month_id", "entry_type"])


def downgrade() -> None:
    op.drop_index("ix_dividend_entries_month_type", table_name="dividend_entries")
    op.drop_table("dividend_entries")
    op.drop_table("dividend_months")
    op.drop_index("ix_dividend_shareholders_store", table_name="dividend_shareholders")
    op.drop_table("dividend_shareholders")
