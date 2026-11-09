"""Outgoing loans and principal repayments backed by unique bank transactions."""

from alembic import op
import sqlalchemy as sa

revision = "20261109_0047"
down_revision = "20261109_0046"
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        "store_loans",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("store_id", sa.String(32), sa.ForeignKey("stores.id"), nullable=False),
        sa.Column("borrower", sa.String(120), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
    )
    op.create_index("ix_store_loans_store_id", "store_loans", ["store_id"])
    op.create_table(
        "store_loan_events",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column("loan_id", sa.String(32), sa.ForeignKey("store_loans.id"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("occurred_on", sa.Date(), nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column(
            "bank_transaction_id",
            sa.String(32),
            sa.ForeignKey("bank_transactions.id"),
            nullable=False,
        ),
        sa.Column("active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("generated_bank", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("previous_special_type", sa.String(32)),
        sa.Column("revoked_reason", sa.Text()),
        sa.Column("remark", sa.Text(), nullable=False),
        sa.Column("request_key", sa.String(64), nullable=False),
        sa.Column("payload_json", sa.Text(), nullable=False),
        sa.Column("created_by", sa.String(32), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.CheckConstraint("amount > 0", name="ck_loan_event_amount"),
        sa.UniqueConstraint("request_key", name="uq_loan_event_request"),
    )
    op.create_index(
        "uq_active_loan_event_bank",
        "store_loan_events",
        ["bank_transaction_id"],
        unique=True,
        postgresql_where=sa.text("active"),
    )
    op.create_index("ix_store_loan_events_loan_id", "store_loan_events", ["loan_id"])


def downgrade():
    op.drop_table("store_loan_events")
    op.drop_table("store_loans")
