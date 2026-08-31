"""add approval instance department name

Revision ID: 20260831_0022
Revises: 20260831_0021
Create Date: 2026-08-31
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260831_0022"
down_revision: str | Sequence[str] | None = "20260831_0021"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("approval_instances", sa.Column("department_name", sa.String(length=240), nullable=True))


def downgrade() -> None:
    op.drop_column("approval_instances", "department_name")
