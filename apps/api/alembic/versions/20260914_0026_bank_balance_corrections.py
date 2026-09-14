"""add bank balance correction records

Revision ID: 20260914_0026
Revises: 20260913_0025
"""

from alembic import op
import sqlalchemy as sa


revision = "20260914_0026"
down_revision = "20260913_0025"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "bank_balance_corrections",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("store_id", sa.String(length=32), nullable=False),
        sa.Column("correction_date", sa.Date(), nullable=False),
        sa.Column("balance_amount", sa.Numeric(precision=14, scale=2), nullable=False),
        sa.Column("remark", sa.String(length=500), nullable=False),
        sa.Column("created_by", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["created_by"], ["users.id"]),
        sa.ForeignKeyConstraint(["store_id"], ["stores.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "ix_bank_balance_corrections_store_date",
        "bank_balance_corrections",
        ["store_id", "correction_date"],
    )


def downgrade() -> None:
    op.drop_index("ix_bank_balance_corrections_store_date", table_name="bank_balance_corrections")
    op.drop_table("bank_balance_corrections")
