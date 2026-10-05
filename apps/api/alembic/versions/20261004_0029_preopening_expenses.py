"""Add independent store preopening expense scope and categories."""

import sqlalchemy as sa

from alembic import op

revision = "20261004_0029"
down_revision = "20260919_0028"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "preopening_categories",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("name", sa.String(80), nullable=False, unique=True),
        sa.Column("parent_id", sa.String(32), sa.ForeignKey("preopening_categories.id")),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("sort_order", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "preopening_stores",
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id"), primary_key=True),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("closed_at", sa.DateTime()),
        sa.Column("closed_by", sa.String(80)),
    )
    op.add_column(
        "approval_templates",
        sa.Column("is_preopening_expense", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    for table in ["approval_instances", "expense_items", "expense_bank_matches"]:
        op.add_column(
            table,
            sa.Column("expense_scope", sa.String(16), nullable=False, server_default="operating"),
        )
    op.add_column(
        "expense_items",
        sa.Column(
            "preopening_category_id", sa.String(32), sa.ForeignKey("preopening_categories.id")
        ),
    )
    op.add_column("expense_items", sa.Column("preopening_category_l1", sa.String(80)))
    op.add_column("expense_items", sa.Column("preopening_category_l2", sa.String(80)))


def downgrade():
    for column in ["preopening_category_l2", "preopening_category_l1", "preopening_category_id"]:
        op.drop_column("expense_items", column)
    for table in ["expense_bank_matches", "expense_items", "approval_instances"]:
        op.drop_column(table, "expense_scope")
    op.drop_column("approval_templates", "is_preopening_expense")
    op.drop_table("preopening_stores")
    op.drop_table("preopening_categories")
