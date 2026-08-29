"""revenue channels

Revision ID: 20260829_0009
Revises: 20260829_0008
Create Date: 2026-08-29
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260829_0009"
down_revision: str | Sequence[str] | None = "20260829_0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "revenue_channels",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("requires_bank_match", sa.Boolean(), nullable=False),
        sa.Column("status", sa.String(length=24), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("name", name="uq_revenue_channels_name"),
    )


def downgrade() -> None:
    op.drop_table("revenue_channels")
