"""Manual report display balance, independent of real bank accounting."""

import sqlalchemy as sa

from alembic import op

revision = "20261104_0041"
down_revision = "20261103_0040"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "financial_report_month_settings",
        sa.Column("bank_balance_manual", sa.Numeric(14, 2), nullable=True),
    )


def downgrade():
    op.drop_column("financial_report_month_settings", "bank_balance_manual")
