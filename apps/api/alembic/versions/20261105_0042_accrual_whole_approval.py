"""Whole approval accrual links; preserve historical partial coverage."""

import sqlalchemy as sa

from alembic import op

revision = "20261105_0042"
down_revision = "20261104_0041"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "accrual_approval_links",
        sa.Column("whole_approval", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade():
    op.drop_column("accrual_approval_links", "whole_approval")
