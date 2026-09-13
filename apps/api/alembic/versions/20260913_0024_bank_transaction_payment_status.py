"""add bank transaction payment status

Revision ID: 20260913_0024
Revises: 20260909_0023
Create Date: 2026-09-13 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


revision = "20260913_0024"
down_revision = "20260909_0023"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "bank_transactions",
        sa.Column("payment_status", sa.String(length=24), nullable=False, server_default="paid"),
    )
    op.create_index("ix_bank_transactions_payment_status", "bank_transactions", ["payment_status"])
    op.alter_column("bank_transactions", "payment_status", server_default=None)


def downgrade() -> None:
    op.drop_index("ix_bank_transactions_payment_status", table_name="bank_transactions")
    op.drop_column("bank_transactions", "payment_status")
