"""add cash and taobao revenue channels

Revision ID: 20260904_0020
Revises: 20260904_0019
Create Date: 2026-09-04
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import uuid4

from alembic import op
import sqlalchemy as sa


revision: str = "20260904_0020"
down_revision: str | Sequence[str] | None = "20260904_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _revenue_channels_table() -> sa.Table:
    return sa.Table(
        "revenue_channels",
        sa.MetaData(),
        sa.Column("id", sa.String(length=32)),
        sa.Column("name", sa.String(length=80)),
        sa.Column("sort_order", sa.Integer()),
        sa.Column("requires_bank_match", sa.Boolean()),
        sa.Column("status", sa.String(length=24)),
        sa.Column("created_at", sa.DateTime()),
        sa.Column("updated_at", sa.DateTime()),
    )


def upgrade() -> None:
    bind = op.get_bind()
    revenue_channels = _revenue_channels_table()
    existing_names = {row[0] for row in bind.execute(sa.text("SELECT name FROM revenue_channels"))}
    now = datetime.now(UTC).replace(tzinfo=None)
    defaults = [
        ("现金收款", 60, False),
        ("淘宝团购", 70, True),
    ]
    rows = [
        {
            "id": uuid4().hex,
            "name": name,
            "sort_order": sort_order,
            "requires_bank_match": requires_bank_match,
            "status": "active",
            "created_at": now,
            "updated_at": now,
        }
        for name, sort_order, requires_bank_match in defaults
        if name not in existing_names
    ]
    if rows:
        op.bulk_insert(revenue_channels, rows)


def downgrade() -> None:
    bind = op.get_bind()
    bind.execute(
        sa.text("DELETE FROM revenue_channels WHERE name IN (:cash, :taobao)"),
        {"cash": "现金收款", "taobao": "淘宝团购"},
    )
