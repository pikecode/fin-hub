"""Financial report targets and store preopening funding settings."""

from alembic import op
import sqlalchemy as sa

revision = "20261026_0034"
down_revision = "20261026_0033"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "financial_report_month_settings",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("period", sa.String(7), nullable=False),
        sa.Column("revenue_target", sa.Numeric(14, 2)),
        sa.UniqueConstraint("store_id", "period", name="uq_report_setting_store_period"),
    )
    op.create_table(
        "dividend_funding_settings",
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id"), primary_key=True),
        sa.Column("preopening_investment", sa.Numeric(14, 2), nullable=False, server_default="0"),
        sa.Column("preopening_expense_override", sa.Numeric(14, 2)),
    )


def downgrade():
    op.drop_table("dividend_funding_settings")
    op.drop_table("financial_report_month_settings")
