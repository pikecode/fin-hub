"""sync job window

Revision ID: 20260829_0012
Revises: 20260829_0011
Create Date: 2026-08-29
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260829_0012"
down_revision: str | Sequence[str] | None = "20260829_0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("sync_jobs", sa.Column("request_start_at", sa.DateTime(), nullable=True))
    op.add_column("sync_jobs", sa.Column("request_end_at", sa.DateTime(), nullable=True))
    op.add_column("sync_jobs", sa.Column("next_cursor", sa.String(length=80), nullable=True))
    op.add_column("sync_jobs", sa.Column("raw_summary", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("sync_jobs", "raw_summary")
    op.drop_column("sync_jobs", "next_cursor")
    op.drop_column("sync_jobs", "request_end_at")
    op.drop_column("sync_jobs", "request_start_at")
