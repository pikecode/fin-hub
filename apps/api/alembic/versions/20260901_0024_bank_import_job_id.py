"""add bank import job id

Revision ID: 20260901_0024
Revises: 20260831_0023
Create Date: 2026-09-01
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260901_0024"
down_revision: str | Sequence[str] | None = "20260831_0023"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("bank_transactions", sa.Column("import_job_id", sa.String(length=32), nullable=True))


def downgrade() -> None:
    op.drop_column("bank_transactions", "import_job_id")
