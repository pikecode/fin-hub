"""add bank occurred flag to expense bank matches

Revision ID: 20260830_0018
Revises: 20260830_0017
Create Date: 2026-08-30
"""

from alembic import op
import sqlalchemy as sa


revision = "20260830_0018"
down_revision = "20260830_0017"
branch_labels = None
depends_on = None


def _column_names(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {column["name"] for column in inspector.get_columns(table_name)}


def upgrade() -> None:
    if "bank_occurred" not in _column_names("expense_bank_matches"):
        op.add_column(
            "expense_bank_matches",
            sa.Column("bank_occurred", sa.Boolean(), nullable=False, server_default=sa.true()),
        )
    if op.get_context().dialect.name != "sqlite":
        op.alter_column("expense_bank_matches", "bank_occurred", server_default=None)


def downgrade() -> None:
    op.drop_column("expense_bank_matches", "bank_occurred")
