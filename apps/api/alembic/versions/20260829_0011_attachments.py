"""attachments

Revision ID: 20260829_0011
Revises: 20260829_0010
Create Date: 2026-08-29
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260829_0011"
down_revision: str | Sequence[str] | None = "20260829_0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "attachments",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("resource_type", sa.String(length=60), nullable=False),
        sa.Column("resource_id", sa.String(length=32), nullable=False),
        sa.Column("file_name", sa.String(length=240), nullable=False),
        sa.Column("content_type", sa.String(length=120), nullable=True),
        sa.Column("file_size", sa.Integer(), nullable=True),
        sa.Column("file_path", sa.String(length=500), nullable=True),
        sa.Column("file_hash", sa.String(length=128), nullable=True),
        sa.Column("source", sa.String(length=24), nullable=False),
        sa.Column("external_file_id", sa.String(length=240), nullable=True),
        sa.Column("download_status", sa.String(length=24), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("source", "external_file_id", name="uq_attachment_external_file"),
    )
    op.create_index("ix_attachments_resource", "attachments", ["resource_type", "resource_id"])


def downgrade() -> None:
    op.drop_index("ix_attachments_resource", table_name="attachments")
    op.drop_table("attachments")
