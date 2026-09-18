"""allow manual profit for non-ledger dividend history months

Revision ID: 20260919_0028
Revises: 20260916_0027
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260919_0028"
down_revision: str | Sequence[str] | None = "20260916_0027"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("dividend_months", sa.Column("manual_net_profit", sa.Numeric(14, 2), nullable=True))


def downgrade() -> None:
    op.drop_column("dividend_months", "manual_net_profit")
