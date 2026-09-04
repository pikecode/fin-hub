"""Add accounting period to revenue bank matches

Revision ID: 20260904_0016
Revises: 20260904_0015
Create Date: 2026-09-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op


revision: str = "20260904_0016"
down_revision: str | Sequence[str] | None = "20260904_0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "revenue_bank_matches",
        sa.Column("accounting_period", sa.String(length=7), nullable=True),
    )
    op.execute(
        """
        UPDATE revenue_bank_matches AS rbm
        SET accounting_period = bt.ledger_period
        FROM bank_transactions AS bt
        WHERE rbm.bank_transaction_id = bt.id
          AND rbm.accounting_period IS NULL
        """
    )
    op.create_index(
        "ix_revenue_bank_matches_accounting_period",
        "revenue_bank_matches",
        ["accounting_period"],
    )


def downgrade() -> None:
    op.drop_index("ix_revenue_bank_matches_accounting_period", table_name="revenue_bank_matches")
    op.drop_column("revenue_bank_matches", "accounting_period")
