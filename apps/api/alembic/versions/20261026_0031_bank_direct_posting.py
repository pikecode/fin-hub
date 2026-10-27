"""Bank direct posting and protected derived interest revenue."""

from alembic import op
import sqlalchemy as sa

revision = "20261026_0031"
down_revision = "20261007_0030"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "bank_transactions", sa.Column("direct_posting_type", sa.String(32), nullable=True)
    )
    op.add_column(
        "revenue_records",
        sa.Column("is_bank_direct", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade():
    op.drop_column("revenue_records", "is_bank_direct")
    op.drop_column("bank_transactions", "direct_posting_type")
