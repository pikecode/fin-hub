"""store explicit revenue records on revenue bank matches

Revision ID: 20260902_0006
Revises: 20260902_0005
Create Date: 2026-09-02
"""

from alembic import op
import sqlalchemy as sa


revision = "20260902_0006"
down_revision = "20260902_0005"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "revenue_bank_match_records",
        sa.Column("id", sa.String(length=32), primary_key=True),
        sa.Column("revenue_bank_match_id", sa.String(length=32), nullable=False),
        sa.Column("revenue_record_id", sa.String(length=32), nullable=False),
        sa.Column("created_at", sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(["revenue_bank_match_id"], ["revenue_bank_matches.id"]),
        sa.ForeignKeyConstraint(["revenue_record_id"], ["revenue_records.id"]),
        sa.UniqueConstraint(
            "revenue_bank_match_id",
            "revenue_record_id",
            name="uq_revenue_bank_match_record",
        ),
    )
    op.create_index(
        "ix_revenue_bank_match_records_record",
        "revenue_bank_match_records",
        ["revenue_record_id"],
    )
    op.create_index(
        "ix_revenue_bank_match_records_match",
        "revenue_bank_match_records",
        ["revenue_bank_match_id"],
    )


def downgrade() -> None:
    op.drop_index(
        "ix_revenue_bank_match_records_match",
        table_name="revenue_bank_match_records",
    )
    op.drop_index(
        "ix_revenue_bank_match_records_record",
        table_name="revenue_bank_match_records",
    )
    op.drop_table("revenue_bank_match_records")
