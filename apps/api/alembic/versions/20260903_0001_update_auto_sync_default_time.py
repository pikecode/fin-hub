"""update auto sync default time to avoid rate limiting

Revision ID: 20260903_0001
Revises: 20260902_0006
Create Date: 2026-09-03 09:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "20260903_0001"
down_revision = "20260902_0006"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 将现有的 02:00 自动同步时间更新为 02:15，避开整点时刻的钉钉 API 限流高峰
    op.execute(
        """
        UPDATE dingtalk_auto_sync_settings
        SET scheduled_time = '02:15'
        WHERE scheduled_time = '02:00'
        """
    )


def downgrade() -> None:
    # 回滚到原来的 02:00
    op.execute(
        """
        UPDATE dingtalk_auto_sync_settings
        SET scheduled_time = '02:00'
        WHERE scheduled_time = '02:15'
        """
    )
