"""seed food cost expense category

Revision ID: 20260908_0022
Revises: 20260906_0021
Create Date: 2026-09-08
"""

from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import uuid4

from alembic import op
import sqlalchemy as sa


revision: str = "20260908_0022"
down_revision: str | Sequence[str] | None = "20260906_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    bind = op.get_bind()
    now = datetime.now(UTC).replace(tzinfo=None)
    existing = bind.execute(
        sa.text(
            """
            SELECT id, status
            FROM expense_categories
            WHERE parent_id IS NULL AND name = :name
            LIMIT 1
            """
        ),
        {"name": "食材成本"},
    ).fetchone()
    if existing is None:
        bind.execute(
            sa.text(
                """
                INSERT INTO expense_categories
                    (id, name, parent_id, sort_order, status, created_at, updated_at)
                VALUES
                    (:id, :name, NULL, :sort_order, :status, :created_at, :updated_at)
                """
            ),
            {
                "id": uuid4().hex,
                "name": "食材成本",
                "sort_order": 5,
                "status": "active",
                "created_at": now,
                "updated_at": now,
            },
        )
        return

    if existing[1] != "active":
        bind.execute(
            sa.text(
                """
                UPDATE expense_categories
                SET status = :status, updated_at = :updated_at
                WHERE id = :id
                """
            ),
            {"id": existing[0], "status": "active", "updated_at": now},
        )


def downgrade() -> None:
    pass
