"""Add approval template node mappings

Revision ID: 20260903_0013
Revises: 20260903_0012
Create Date: 2026-09-03
"""

from alembic import op
import sqlalchemy as sa


revision = "20260903_0013"
down_revision = "20260903_0012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "approval_template_nodes",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("template_id", sa.String(length=32), nullable=False),
        sa.Column("activity_id", sa.String(length=120), nullable=False),
        sa.Column("node_name", sa.String(length=160), nullable=False),
        sa.Column("node_type", sa.String(length=60), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["template_id"], ["approval_templates.id"]),
        sa.UniqueConstraint("template_id", "activity_id", name="uq_approval_template_node_activity"),
    )
    op.create_index("ix_approval_template_nodes_template", "approval_template_nodes", ["template_id"])


def downgrade() -> None:
    op.drop_index("ix_approval_template_nodes_template", table_name="approval_template_nodes")
    op.drop_table("approval_template_nodes")
