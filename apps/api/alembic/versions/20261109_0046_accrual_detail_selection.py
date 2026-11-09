"""Persist explicit approval-detail selections separately from legacy amount coverage."""

from alembic import op
import sqlalchemy as sa

revision = "20261109_0046"
down_revision = "20261109_0045"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "accrual_approval_links", sa.Column("detail_selection_json", sa.Text(), nullable=True)
    )


def downgrade():
    op.drop_column("accrual_approval_links", "detail_selection_json")
