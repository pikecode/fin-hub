"""remove legacy user permissions

Revision ID: 20260903_0007
Revises: 20260903_0006
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260903_0007"
down_revision: str | Sequence[str] | None = "20260903_0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _column_names(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {column["name"] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    if "permissions_configured" in _column_names("users"):
        op.drop_column("users", "permissions_configured")
    if "user_permissions" in sa.inspect(op.get_bind()).get_table_names():
        op.drop_index("ix_user_permissions_user_id", table_name="user_permissions")
        op.drop_table("user_permissions")


def downgrade() -> None:
    op.create_table(
        "user_permissions",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("permission", sa.String(length=80), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.UniqueConstraint("user_id", "permission", name="uq_user_permission"),
    )
    op.create_index("ix_user_permissions_user_id", "user_permissions", ["user_id"])
    op.add_column(
        "users",
        sa.Column("permissions_configured", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.alter_column("users", "permissions_configured", server_default=None)
