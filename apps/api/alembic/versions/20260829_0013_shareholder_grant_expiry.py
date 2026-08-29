"""shareholder grant expiry

Revision ID: 20260829_0013
Revises: 20260829_0012
Create Date: 2026-08-29 15:20:00.000000
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "20260829_0013"
down_revision: str | None = "20260829_0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("shareholder_access_grants", sa.Column("expires_at", sa.DateTime(), nullable=True))


def downgrade() -> None:
    op.drop_column("shareholder_access_grants", "expires_at")
