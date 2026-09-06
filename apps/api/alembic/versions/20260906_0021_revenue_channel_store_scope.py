"""add revenue channel store scope and soft delete

Revision ID: 20260906_0021
Revises: 20260904_0020
Create Date: 2026-09-06
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import uuid4

from alembic import op
import sqlalchemy as sa


revision: str = "20260906_0021"
down_revision: str | Sequence[str] | None = "20260904_0020"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "revenue_channels",
        sa.Column("scope_mode", sa.String(length=24), nullable=False, server_default="all_stores"),
    )
    op.add_column("revenue_channels", sa.Column("deleted_at", sa.DateTime(), nullable=True))
    op.add_column("revenue_channels", sa.Column("deleted_by", sa.String(length=80), nullable=True))
    op.create_table(
        "revenue_channel_store_links",
        sa.Column("id", sa.String(length=32), primary_key=True, nullable=False),
        sa.Column("channel_id", sa.String(length=32), sa.ForeignKey("revenue_channels.id", ondelete="CASCADE"), nullable=False),
        sa.Column("store_id", sa.String(length=32), sa.ForeignKey("stores.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("channel_id", "store_id", name="uq_revenue_channel_store_link"),
    )
    op.create_index(
        "ix_revenue_channel_store_links_store_id",
        "revenue_channel_store_links",
        ["store_id"],
    )

    bind = op.get_bind()
    now = datetime.now(UTC).replace(tzinfo=None)
    channels = bind.execute(sa.text("SELECT id, status FROM revenue_channels")).fetchall()
    active_store_ids = [row[0] for row in bind.execute(sa.text("SELECT id FROM stores")).fetchall()]
    for channel_id, status in channels:
        if status == "active":
            bind.execute(
                sa.text(
                    """
                    INSERT INTO revenue_channel_store_links (id, channel_id, store_id, created_at, updated_at)
                    SELECT :id, :channel_id, id, :created_at, :updated_at
                    FROM stores
                    ON CONFLICT DO NOTHING
                    """
                ),
                {
                    "id": uuid4().hex,
                    "channel_id": channel_id,
                    "created_at": now,
                    "updated_at": now,
                },
            )


def downgrade() -> None:
    op.drop_index("ix_revenue_channel_store_links_store_id", table_name="revenue_channel_store_links")
    op.drop_table("revenue_channel_store_links")
    op.drop_column("revenue_channels", "deleted_by")
    op.drop_column("revenue_channels", "deleted_at")
    op.drop_column("revenue_channels", "scope_mode")
