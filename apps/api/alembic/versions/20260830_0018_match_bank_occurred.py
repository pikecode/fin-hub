"""add bank occurred flag to expense bank matches

Revision ID: 20260830_0018
Revises: 20260830_0017
Create Date: 2026-08-30
"""

from alembic import op
import sqlalchemy as sa


revision = "20260830_0018"
down_revision = "20260830_0017"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "expense_bank_matches",
        sa.Column("bank_occurred", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.alter_column("expense_bank_matches", "bank_occurred", server_default=None)


def downgrade() -> None:
    op.drop_column("expense_bank_matches", "bank_occurred")
