"""Keep deleted bank balance corrections for audit."""
import sqlalchemy as sa
from alembic import op

revision = "20261109_0045"
down_revision = "20261109_0044"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("bank_balance_corrections", sa.Column("is_deleted", sa.Boolean(), server_default=sa.false(), nullable=False))


def downgrade():
    op.drop_column("bank_balance_corrections", "is_deleted")
