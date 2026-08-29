"""add display options to template mappings

Revision ID: 20260830_0015
Revises: 20260830_0014
Create Date: 2026-08-30
"""

from collections.abc import Sequence

from alembic import op
import sqlalchemy as sa


revision: str = "20260830_0015"
down_revision: str | Sequence[str] | None = "20260830_0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("template_field_mappings", sa.Column("display_label", sa.String(length=120)))
    op.add_column("template_field_mappings", sa.Column("show_in_list", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("template_field_mappings", sa.Column("show_in_detail", sa.Boolean(), nullable=False, server_default=sa.true()))
    op.alter_column("template_field_mappings", "show_in_list", server_default=None)
    op.alter_column("template_field_mappings", "show_in_detail", server_default=None)


def downgrade() -> None:
    op.drop_column("template_field_mappings", "show_in_detail")
    op.drop_column("template_field_mappings", "show_in_list")
    op.drop_column("template_field_mappings", "display_label")
