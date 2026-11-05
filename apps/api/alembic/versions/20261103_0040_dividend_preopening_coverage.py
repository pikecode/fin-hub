"""Opening actual construction overrun coverage; existing estimates are not facts."""

import sqlalchemy as sa

from alembic import op

revision = "20261103_0040"
down_revision = "20261103_0039"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "dividend_opening_balances",
        sa.Column(
            "historical_preopening_coverage", sa.Numeric(14, 2), nullable=False, server_default="0"
        ),
    )


def downgrade():
    op.drop_column("dividend_opening_balances", "historical_preopening_coverage")
