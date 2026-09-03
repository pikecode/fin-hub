"""add role permissions

Revision ID: 20260903_0004
Revises: 20260903_0003
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa
from uuid import uuid4


revision: str = "20260903_0004"
down_revision: str | Sequence[str] | None = "20260903_0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


ROLE_DEFAULTS: dict[str, list[str]] = {
    "finance": [
        "dashboard.view",
        "reconciliation.view",
        "reconciliation.manage",
        "reports.view",
        "revenue.view",
        "revenue.manage",
        "stores.view",
        "stores.manage",
        "categories.view",
        "categories.manage",
        "dingtalk.view",
        "audit.view",
    ],
    "viewer": [
        "dashboard.view",
        "reconciliation.view",
        "reports.view",
        "revenue.view",
        "stores.view",
        "categories.view",
    ],
}


def upgrade() -> None:
    op.create_table(
        "role_permissions",
        sa.Column("id", sa.String(length=32), nullable=False),
        sa.Column("role", sa.String(length=24), nullable=False),
        sa.Column("permission", sa.String(length=80), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("role", "permission", name="uq_role_permission"),
    )
    op.create_index("ix_role_permissions_role", "role_permissions", ["role"])
    op.create_table(
        "role_permission_settings",
        sa.Column("role", sa.String(length=24), nullable=False),
        sa.Column("permissions_configured", sa.Boolean(), nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.PrimaryKeyConstraint("role"),
    )

    bind = op.get_bind()
    for role, permissions in ROLE_DEFAULTS.items():
        for permission in permissions:
            bind.execute(
                sa.text(
                    "insert into role_permissions (id, role, permission, created_at) "
                    "values (:id, :role, :permission, now()) "
                    "on conflict (role, permission) do nothing"
                ),
                {"id": uuid4().hex, "role": role, "permission": permission},
            )

    existing_role_permissions = bind.execute(
        sa.text(
            """
            select distinct u.role, up.permission
            from user_permissions up
            join users u on u.id = up.user_id
            where u.role in ('finance', 'viewer')
            """
        )
    ).all()
    for row in existing_role_permissions:
        bind.execute(
            sa.text(
                "insert into role_permissions (id, role, permission, created_at) "
                "values (:id, :role, :permission, now()) "
                "on conflict (role, permission) do nothing"
            ),
                {"id": uuid4().hex, "role": row.role, "permission": row.permission},
            )

    for role in ("finance", "viewer"):
        bind.execute(
            sa.text(
                "insert into role_permission_settings (role, permissions_configured, created_at, updated_at) "
                "values (:role, true, now(), now()) "
                "on conflict (role) do update set permissions_configured = excluded.permissions_configured, updated_at = excluded.updated_at"
            ),
            {"role": role},
        )


def downgrade() -> None:
    op.drop_table("role_permission_settings")
    op.drop_index("ix_role_permissions_role", table_name="role_permissions")
    op.drop_table("role_permissions")
