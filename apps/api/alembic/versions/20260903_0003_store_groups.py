"""add virtual store groups

Revision ID: 20260903_0003
Revises: 20260903_0002
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260903_0003"
down_revision: str | Sequence[str] | None = "20260903_0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "store_groups",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("name", sa.String(length=120), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("name", name="uq_store_groups_name"),
    )
    op.add_column("stores", sa.Column("group_id", sa.String(length=32), nullable=True))
    op.create_foreign_key(
        "fk_stores_group_id_store_groups",
        "stores",
        "store_groups",
        ["group_id"],
        ["id"],
        ondelete="SET NULL",
    )
    op.create_index("ix_stores_group_id", "stores", ["group_id"])


def downgrade() -> None:
    op.drop_index("ix_stores_group_id", table_name="stores")
    op.drop_constraint("fk_stores_group_id_store_groups", "stores", type_="foreignkey")
    op.drop_column("stores", "group_id")
    op.drop_table("store_groups")
