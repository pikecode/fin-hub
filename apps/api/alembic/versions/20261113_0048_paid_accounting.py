"""Opt-in paid-amount approval accounting."""
from alembic import op
import sqlalchemy as sa
revision = "20261113_0048"
down_revision = "20261109_0047"
branch_labels = None
depends_on = None

def upgrade():
    op.create_table("approval_paid_accounting",
        sa.Column("approval_id", sa.String(32), sa.ForeignKey("approval_instances.id"), primary_key=True),
        sa.Column("period", sa.String(7), nullable=False),
        sa.Column("updated_by", sa.String(80), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False))

def downgrade():
    op.drop_table("approval_paid_accounting")
