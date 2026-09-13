"""add bank transaction special type

Revision ID: 20260913_0025
Revises: 20260913_0024
"""

from alembic import op
import sqlalchemy as sa


revision = "20260913_0025"
down_revision = "20260913_0024"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("bank_transactions", sa.Column("special_type", sa.String(length=32), nullable=True))
    op.create_index("ix_bank_transactions_special_type", "bank_transactions", ["special_type"])


def downgrade() -> None:
    op.drop_index("ix_bank_transactions_special_type", table_name="bank_transactions")
    op.drop_column("bank_transactions", "special_type")
