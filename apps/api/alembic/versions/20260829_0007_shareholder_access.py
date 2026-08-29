"""shareholder access grants

Revision ID: 20260829_0007
Revises: 20260829_0006
Create Date: 2026-08-29
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260829_0007"
down_revision: str | Sequence[str] | None = "20260829_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "shareholder_access_grants",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("access_code_hash", sa.String(length=240), nullable=False),
        sa.Column("store_ids_json", sa.Text(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("last_login_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("name", name="uq_shareholder_access_grants_name"),
    )


def downgrade() -> None:
    op.drop_table("shareholder_access_grants")
