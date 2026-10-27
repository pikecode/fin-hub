"""Persist manually corrected approval store across synchronization."""

from alembic import op
import sqlalchemy as sa

revision = "20261026_0033"
down_revision = "20261026_0032"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("approval_instances", sa.Column("manual_store_id", sa.String(32), nullable=True))
    op.create_foreign_key(
        "fk_approval_manual_store", "approval_instances", "stores", ["manual_store_id"], ["id"]
    )
    op.add_column(
        "approval_instances", sa.Column("store_override_reason", sa.Text(), nullable=True)
    )


def downgrade():
    op.drop_column("approval_instances", "store_override_reason")
    op.drop_constraint("fk_approval_manual_store", "approval_instances", type_="foreignkey")
    op.drop_column("approval_instances", "manual_store_id")
