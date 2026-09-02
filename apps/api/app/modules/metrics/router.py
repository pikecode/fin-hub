"""
业务指标监控端点
提供关键业务数据的实时统计
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    BankTransaction,
    ExpenseItem,
    Match,
    RevenueRecord,
)

router = APIRouter(prefix="/metrics", tags=["metrics"])


@router.get("/dashboard")
async def dashboard_metrics(db: Session = Depends(get_session)):
    """
    仪表盘指标

    提供管理后台首页展示的关键指标
    """
    today = datetime.utcnow().date()
    yesterday = today - timedelta(days=1)

    # 待处理匹配数量
    pending_matches = db.scalar(
        select(func.count(Match.id)).where(Match.match_status == "candidate")
    ) or 0

    # 未匹配银行流水数量
    unmatched_bank_count = db.scalar(
        select(func.count(BankTransaction.id)).where(
            BankTransaction.matched_amount == None  # noqa: E711
        )
    ) or 0

    # 今日新增匹配
    today_matches = db.scalar(
        select(func.count(Match.id)).where(
            Match.match_status == "confirmed",
            func.date(Match.created_at) == today,
        )
    ) or 0

    # 昨日新增匹配
    yesterday_matches = db.scalar(
        select(func.count(Match.id)).where(
            Match.match_status == "confirmed",
            func.date(Match.created_at) == yesterday,
        )
    ) or 0

    # 未匹配支出笔数
    unmatched_expenses = db.scalar(
        select(func.count(ExpenseItem.id)).where(
            ExpenseItem.payment_status != "no_bank_flow",
            ExpenseItem.matched_amount == None,  # noqa: E711
        )
    ) or 0

    # 未匹配收入笔数
    unmatched_revenues = db.scalar(
        select(func.count(RevenueRecord.id)).where(
            RevenueRecord.matched_amount == None  # noqa: E711
        )
    ) or 0

    return {
        "pending_matches": pending_matches,
        "unmatched_bank_transactions": unmatched_bank_count,
        "unmatched_expenses": unmatched_expenses,
        "unmatched_revenues": unmatched_revenues,
        "today_matches": today_matches,
        "yesterday_matches": yesterday_matches,
        "match_trend": "up" if today_matches > yesterday_matches else "down" if today_matches < yesterday_matches else "stable",
        "timestamp": datetime.utcnow().isoformat(),
    }


@router.get("/operations")
async def operations_metrics(db: Session = Depends(get_session)):
    """
    运营指标

    提供过去 7 天的运营数据
    """
    seven_days_ago = datetime.utcnow() - timedelta(days=7)

    # 过去 7 天的匹配趋势
    daily_matches = db.execute(
        select(
            func.date(Match.created_at).label("date"),
            func.count(Match.id).label("count"),
        )
        .where(
            Match.match_status == "confirmed",
            Match.created_at >= seven_days_ago,
        )
        .group_by(func.date(Match.created_at))
        .order_by(func.date(Match.created_at))
    ).all()

    # 过去 7 天的银行流水录入
    daily_bank_transactions = db.execute(
        select(
            func.date(BankTransaction.created_at).label("date"),
            func.count(BankTransaction.id).label("count"),
        )
        .where(BankTransaction.created_at >= seven_days_ago)
        .group_by(func.date(BankTransaction.created_at))
        .order_by(func.date(BankTransaction.created_at))
    ).all()

    # 按门店统计待处理事项
    pending_by_store = db.execute(
        select(
            ExpenseItem.store_id,
            func.count(ExpenseItem.id).label("unmatched_expenses"),
        )
        .where(
            ExpenseItem.payment_status != "no_bank_flow",
            ExpenseItem.matched_amount == None,  # noqa: E711
        )
        .group_by(ExpenseItem.store_id)
        .order_by(func.count(ExpenseItem.id).desc())
        .limit(10)
    ).all()

    return {
        "daily_matches": [
            {"date": str(row.date), "count": row.count}
            for row in daily_matches
        ],
        "daily_bank_transactions": [
            {"date": str(row.date), "count": row.count}
            for row in daily_bank_transactions
        ],
        "pending_by_store": [
            {"store_id": row.store_id, "unmatched_expenses": row.unmatched_expenses}
            for row in pending_by_store
        ],
        "timestamp": datetime.utcnow().isoformat(),
    }


@router.get("/performance")
async def performance_metrics():
    """
    性能指标

    提供系统性能相关的指标
    注意：这里返回的是模拟数据，实际应从 Prometheus 或内存中获取
    """
    # 实际生产环境中，这些数据应该从性能监控系统获取
    # 这里提供一个基础结构
    return {
        "avg_response_time_ms": 0,  # 需要从中间件收集
        "requests_per_minute": 0,  # 需要从中间件收集
        "error_rate": 0.0,  # 需要从中间件收集
        "database_query_time_ms": 0,  # 需要从 SQLAlchemy 收集
        "message": "Performance metrics collection not yet implemented",
        "timestamp": datetime.utcnow().isoformat(),
    }


@router.get("/sync-status")
async def sync_status_metrics(db: Session = Depends(get_session)):
    """
    同步状态指标

    提供钉钉同步等外部集成的状态
    """
    # 获取最近 24 小时的同步记录
    # 注意：需要根据实际的同步日志表结构调整

    return {
        "dingtalk_last_sync": None,  # 需要从同步日志表获取
        "dingtalk_sync_success_rate": 0.0,  # 需要计算
        "message": "Sync status tracking not yet implemented",
        "timestamp": datetime.utcnow().isoformat(),
    }
