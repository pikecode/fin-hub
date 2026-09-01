"""track explicit user permission configuration

Revision ID: 20260831_0020
Revises: 20260831_0019
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260831_0020"
down_revision: str | Sequence[str] | None = "20260831_0019"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _column_names(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {column["name"] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    if "permissions_configured" not in _column_names("users"):
        op.add_column(
            "users",
            sa.Column("permissions_configured", sa.Boolean(), nullable=False, server_default=sa.false()),
        )
    if op.get_context().dialect.name != "sqlite":
        op.alter_column("users", "permissions_configured", server_default=None)


def downgrade() -> None:
    op.drop_column("users", "permissions_configured")
