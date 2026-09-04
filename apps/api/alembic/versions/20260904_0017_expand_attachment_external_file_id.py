"""expand attachment external file id

Revision ID: 20260904_0017
Revises: 20260904_0016
Create Date: 2026-09-04
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260904_0017"
down_revision: str | Sequence[str] | None = "20260904_0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column(
        "attachments",
        "external_file_id",
        existing_type=sa.String(length=240),
        type_=sa.Text(),
        existing_nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "attachments",
        "external_file_id",
        existing_type=sa.Text(),
        type_=sa.String(length=240),
        existing_nullable=True,
    )
