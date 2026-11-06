"""Add reporting balance as-of date."""
import sqlalchemy as sa

from alembic import op

revision = "20261106_0043"
down_revision = "20261105_0042"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("financial_report_month_settings", sa.Column("bank_balance_date", sa.Date(), nullable=True))


def downgrade():
    op.drop_column("financial_report_month_settings", "bank_balance_date")
