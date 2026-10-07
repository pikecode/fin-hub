"""Add manual closing balance for dividend transition months."""
from alembic import op
import sqlalchemy as sa

revision = "20261007_0030"
down_revision = "20261004_0029"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("dividend_months", sa.Column("manual_remaining_undistributed", sa.Numeric(14, 2), nullable=True))


def downgrade():
    op.drop_column("dividend_months", "manual_remaining_undistributed")
