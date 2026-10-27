"""Preserve unpaid plans and link them to actual bank payments."""

from alembic import op
import sqlalchemy as sa

revision = "20261026_0032"
down_revision = "20261026_0031"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "bank_transactions",
        sa.Column("is_archived", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.create_table(
        "bank_payment_settlements",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column(
            "source_bank_transaction_id",
            sa.String(32),
            sa.ForeignKey("bank_transactions.id"),
            nullable=False,
            unique=True,
        ),
        sa.Column("status", sa.String(24), nullable=False),
        sa.Column("registered_amount", sa.Numeric(14, 2)),
        sa.Column("actual_amount", sa.Numeric(14, 2)),
        sa.Column("remark", sa.Text()),
        sa.Column("source_snapshot_json", sa.Text()),
        sa.Column("completed_by", sa.String(32), sa.ForeignKey("users.id")),
        sa.Column("completed_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "bank_payment_settlement_links",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column(
            "settlement_id",
            sa.String(32),
            sa.ForeignKey("bank_payment_settlements.id"),
            nullable=False,
        ),
        sa.Column(
            "bank_transaction_id",
            sa.String(32),
            sa.ForeignKey("bank_transactions.id"),
            nullable=False,
            unique=True,
        ),
        sa.Column("created_by", sa.String(32), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index(
        "ix_bank_payment_settlement_links_settlement_id",
        "bank_payment_settlement_links",
        ["settlement_id"],
    )


def downgrade():
    op.drop_table("bank_payment_settlement_links")
    op.drop_table("bank_payment_settlements")
    op.drop_column("bank_transactions", "is_archived")
