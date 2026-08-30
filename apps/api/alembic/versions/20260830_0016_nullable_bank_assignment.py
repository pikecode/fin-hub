"""allow bank transactions without store assignment

Revision ID: 20260830_0016
Revises: 20260830_0015
Create Date: 2026-08-30
"""

from alembic import op


revision = "20260830_0016"
down_revision = "20260830_0015"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column("bank_transactions", "store_id", nullable=True)
    op.alter_column("bank_transactions", "ledger_period", nullable=True)


def downgrade() -> None:
    op.alter_column("bank_transactions", "ledger_period", nullable=False)
    op.alter_column("bank_transactions", "store_id", nullable=False)
