"""add user store group permissions

Revision ID: 20260903_0005
Revises: 20260903_0004
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260903_0005"
down_revision: str | Sequence[str] | None = "20260903_0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_store_group_permissions",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("group_id", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["group_id"], ["store_groups.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "group_id", name="uq_user_store_group_permission"),
    )
    op.create_index("ix_user_store_group_permissions_user_id", "user_store_group_permissions", ["user_id"])
    op.create_index("ix_user_store_group_permissions_group_id", "user_store_group_permissions", ["group_id"])


def downgrade() -> None:
    op.drop_index("ix_user_store_group_permissions_group_id", table_name="user_store_group_permissions")
    op.drop_index("ix_user_store_group_permissions_user_id", table_name="user_store_group_permissions")
    op.drop_table("user_store_group_permissions")
