"""user permissions and store scopes

Revision ID: 20260831_0019
Revises: 20260830_0018
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260831_0019"
down_revision: str | Sequence[str] | None = "20260830_0018"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
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
    op.create_table(
        "user_store_permissions",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("user_id", sa.String(length=32), nullable=False),
        sa.Column("store_id", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["store_id"], ["stores.id"]),
        sa.UniqueConstraint("user_id", "store_id", name="uq_user_store_permission"),
    )
    op.create_index("ix_user_store_permissions_user_id", "user_store_permissions", ["user_id"])
    op.create_index("ix_user_store_permissions_store_id", "user_store_permissions", ["store_id"])


def downgrade() -> None:
    op.drop_index("ix_user_store_permissions_store_id", table_name="user_store_permissions")
    op.drop_index("ix_user_store_permissions_user_id", table_name="user_store_permissions")
    op.drop_table("user_store_permissions")
    op.drop_index("ix_user_permissions_user_id", table_name="user_permissions")
    op.drop_table("user_permissions")
