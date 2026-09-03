"""add roles table

Revision ID: 20260903_0006
Revises: 20260903_0005
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from uuid import uuid4


revision: str = "20260903_0006"
down_revision: str | Sequence[str] | None = "20260903_0005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


DEFAULT_ROLES: dict[str, tuple[str, int, bool]] = {
    "admin": ("管理员", 0, True),
    "finance": ("财务", 10, True),
    "viewer": ("查看者", 20, True),
}


def upgrade() -> None:
    op.create_table(
        "roles",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("key", sa.String(length=24), nullable=False),
        sa.Column("name", sa.String(length=80), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
        sa.Column("is_system", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("key", name="uq_roles_key"),
    )

    bind = op.get_bind()
    rows = bind.execute(sa.text("select distinct role from users order by role")).all()
    role_keys = {row.role for row in rows}
    role_keys.update(DEFAULT_ROLES.keys())

    for role_key in sorted(role_keys):
        name, sort_order, is_system = DEFAULT_ROLES.get(role_key, (role_key, 100, False))
        bind.execute(
            sa.text(
                """
                insert into roles (id, key, name, sort_order, is_system, created_at, updated_at)
                values (:id, :key, :name, :sort_order, :is_system, now(), now())
                on conflict (key) do nothing
                """
            ),
            {
                "id": uuid4().hex,
                "key": role_key,
                "name": name,
                "sort_order": sort_order,
                "is_system": is_system,
            },
        )


def downgrade() -> None:
    op.drop_table("roles")
