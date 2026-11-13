"""Durable, scoped financial report export jobs."""

from alembic import op
import sqlalchemy as sa

revision = "20261113_0049"
down_revision = "20261113_0048"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "financial_report_exports",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("user_id", sa.String(32), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("period", sa.String(7), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("snapshot_json", sa.Text()),
        sa.Column("warnings_json", sa.Text()),
        sa.Column("error", sa.Text()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_financial_report_exports_user_id", "financial_report_exports", ["user_id"])
    op.create_index(
        "ix_financial_report_exports_store_id", "financial_report_exports", ["store_id"]
    )


def downgrade():
    op.drop_table("financial_report_exports")
