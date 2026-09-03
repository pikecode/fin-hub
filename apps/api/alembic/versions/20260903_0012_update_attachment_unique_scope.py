"""Scope DingTalk attachment uniqueness to the owning resource

Revision ID: 20260903_0012
Revises: 20260903_0011
Create Date: 2026-09-03
"""

from alembic import op


revision = "20260903_0012"
down_revision = "20260903_0011"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("uq_attachment_external_file", "attachments", type_="unique")
    op.create_unique_constraint(
        "uq_attachment_resource_external_file",
        "attachments",
        ["resource_type", "resource_id", "source", "external_file_id"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_attachment_resource_external_file", "attachments", type_="unique")
    op.create_unique_constraint(
        "uq_attachment_external_file",
        "attachments",
        ["source", "external_file_id"],
    )
