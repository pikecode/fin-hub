"""Opt-in dual reconciliation entry for approval templates."""

import sqlalchemy as sa

from alembic import op

revision = "20261116_0050"
down_revision = "20261113_0049"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "approval_templates",
        sa.Column(
            "allow_dual_reconciliation", sa.Boolean(), nullable=False, server_default=sa.false()
        ),
    )


def downgrade():
    op.drop_column("approval_templates", "allow_dual_reconciliation")
