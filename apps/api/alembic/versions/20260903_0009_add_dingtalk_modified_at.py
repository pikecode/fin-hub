"""add dingtalk_modified_at to approval_instances

Revision ID: 20260903_0009
Revises: 20260903_0008
Create Date: 2026-09-03 15:30:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260903_0009"
down_revision = "20260903_0008"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 添加钉钉修改时间字段
    op.add_column(
        "approval_instances",
        sa.Column("dingtalk_modified_at", sa.DateTime(), nullable=True),
    )

    # 为现有数据设置默认值（使用 approved_at 或 created_at）
    # 这样可以确保现有审批在下次同步时不会因为 None 而被跳过
    op.execute(
        """
        UPDATE approval_instances
        SET dingtalk_modified_at = COALESCE(approved_at, created_at)
        WHERE dingtalk_modified_at IS NULL
        """
    )


def downgrade() -> None:
    op.drop_column("approval_instances", "dingtalk_modified_at")
