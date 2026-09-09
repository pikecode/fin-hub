"""require bank transactions to belong to a store

Revision ID: 20260909_0023
Revises: 20260908_0022
Create Date: 2026-09-09
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260909_0023"
down_revision: str | Sequence[str] | None = "20260908_0022"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    orphan_count = bind.execute(
        sa.text(
            """
            SELECT count(*)
            FROM bank_transactions
            WHERE store_id IS NULL OR ledger_period IS NULL
            """
        )
    ).scalar_one()
    if orphan_count:
        raise RuntimeError(
            "bank_transactions has rows without store_id or ledger_period; "
            "assign or delete them before applying this migration"
        )
    op.alter_column("bank_transactions", "store_id", existing_type=sa.String(length=32), nullable=False)
    op.alter_column("bank_transactions", "ledger_period", existing_type=sa.String(length=7), nullable=False)


def downgrade() -> None:
    op.alter_column("bank_transactions", "ledger_period", existing_type=sa.String(length=7), nullable=True)
    op.alter_column("bank_transactions", "store_id", existing_type=sa.String(length=32), nullable=True)
