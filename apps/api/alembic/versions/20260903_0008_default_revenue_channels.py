"""default revenue channels

Revision ID: 20260903_0008
Revises: 20260903_0007
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import uuid4

from alembic import op
import sqlalchemy as sa


revision: str = "20260903_0008"
down_revision: str | Sequence[str] | None = "20260903_0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _revenue_channels_table() -> sa.Table:
    return sa.table(
        "revenue_channels",
        sa.column("id", sa.String(length=32)),
        sa.column("name", sa.String(length=80)),
        sa.column("sort_order", sa.Integer()),
        sa.column("requires_bank_match", sa.Boolean()),
        sa.column("status", sa.String(length=24)),
        sa.column("created_at", sa.DateTime()),
        sa.column("updated_at", sa.DateTime()),
    )


def upgrade() -> None:
    bind = op.get_bind()
    revenue_channels = _revenue_channels_table()
    existing_names = {row[0] for row in bind.execute(sa.text("SELECT name FROM revenue_channels"))}
    now = datetime.now(UTC).replace(tzinfo=None)
    defaults = [
        ("美团团购", 10, True),
        ("美团点评买单", 20, True),
        ("抖音团购", 30, True),
        ("扫码收款", 40, True),
        ("商场代金券", 50, False),
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
        sa.text("DELETE FROM revenue_channels WHERE name IN (:a, :b, :c, :d, :e)"),
        {
            "a": "美团团购",
            "b": "美团点评买单",
            "c": "抖音团购",
            "d": "扫码收款",
            "e": "商场代金券",
        },
    )
