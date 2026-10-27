"""Approval-level multi-period expense accounting, independent of bank payments."""

from alembic import op
import sqlalchemy as sa

revision = "20261027_0036"
down_revision = "20261026_0035"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("expense_bank_matches", sa.Column("accounting_allocations_json", sa.Text()))
    op.add_column("expense_bank_matches", sa.Column("requested_accounting_version", sa.Integer()))
    op.create_table(
        "approval_accounting_plans",
        sa.Column(
            "approval_id", sa.String(32), sa.ForeignKey("approval_instances.id"), primary_key=True
        ),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("updated_by", sa.String(80), nullable=False),
        sa.Column("updated_at", sa.DateTime(), nullable=False),
    )
    op.create_table(
        "approval_accounting_allocations",
        sa.Column("id", sa.String(32), primary_key=True),
        sa.Column(
            "approval_id",
            sa.String(32),
            sa.ForeignKey("approval_accounting_plans.approval_id"),
            nullable=False,
        ),
        sa.Column("period", sa.String(7), nullable=False),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.UniqueConstraint("approval_id", "period", name="uq_approval_accounting_period"),
    )
    op.create_index(
        "ix_approval_accounting_allocations_period", "approval_accounting_allocations", ["period"]
    )


def downgrade():
    op.drop_table("approval_accounting_allocations")
    op.drop_table("approval_accounting_plans")
    op.drop_column("expense_bank_matches", "requested_accounting_version")
    op.drop_column("expense_bank_matches", "accounting_allocations_json")
