"""Add multi-line accrual documents without rewriting legacy entries."""
import sqlalchemy as sa

from alembic import op

revision = "20261109_0044"
down_revision = "20261106_0043"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table("accrual_documents",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("period", sa.String(7), nullable=False),
        sa.Column("remark", sa.Text(), nullable=False),
        sa.Column("request_key", sa.String(64), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.Column("created_by", sa.String(32), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.UniqueConstraint("store_id", "request_key", name="uq_accrual_document_request"))
    op.create_index("ix_accrual_documents_store_id", "accrual_documents", ["store_id"])
    op.add_column("accrual_entries", sa.Column("document_id", sa.String(32), sa.ForeignKey("accrual_documents.id")))
    op.create_index("ix_accrual_entries_document_id", "accrual_entries", ["document_id"])


def downgrade():
    op.drop_index("ix_accrual_entries_document_id", "accrual_entries")
    op.drop_column("accrual_entries", "document_id")
    op.drop_table("accrual_documents")
