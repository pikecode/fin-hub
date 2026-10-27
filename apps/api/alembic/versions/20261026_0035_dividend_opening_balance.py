"""Per-store opening balances and first calculation month."""

from alembic import op
import sqlalchemy as sa

revision = "20261026_0035"
down_revision = "20261026_0034"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "dividend_opening_balances",
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id"), primary_key=True),
        sa.Column("start_period", sa.String(7), nullable=False),
        sa.Column("opening_remaining", sa.Numeric(14, 2), nullable=False),
        sa.Column("historical_profit", sa.Numeric(14, 2), nullable=False),
        sa.Column("historical_distribution", sa.Numeric(14, 2), nullable=False),
        sa.Column("operating_capital", sa.Numeric(14, 2), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("updated_by", sa.String(80), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )


def downgrade():
    op.drop_table("dividend_opening_balances")
