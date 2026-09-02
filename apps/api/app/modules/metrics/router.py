"""
业务指标监控端点
提供关键业务数据的实时统计
"""
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    ExpensePaymentStatus,
    MatchStatus,
    RevenueBankMatch,
    RevenueBankMatchRecord,
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
    pending_expense_matches = db.scalar(
        select(func.count(ExpenseBankMatch.id)).where(ExpenseBankMatch.status == MatchStatus.CANDIDATE.value)
    ) or 0
    pending_revenue_matches = db.scalar(
        select(func.count(RevenueBankMatch.id)).where(RevenueBankMatch.status == MatchStatus.CANDIDATE.value)
    ) or 0
    pending_matches = pending_expense_matches + pending_revenue_matches

    # 未匹配银行流水数量
    unmatched_bank_count = db.scalar(
        select(func.count(BankTransaction.id)).where(
            BankTransaction.matched_amount < BankTransaction.amount
        )
    ) or 0

    # 今日新增匹配
    today_expense_matches = db.scalar(
        select(func.count(ExpenseBankMatch.id)).where(
            ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
            func.date(ExpenseBankMatch.created_at) == today,
        )
    ) or 0
    today_revenue_matches = db.scalar(
        select(func.count(RevenueBankMatch.id)).where(
            RevenueBankMatch.status == MatchStatus.CONFIRMED.value,
            func.date(RevenueBankMatch.created_at) == today,
        )
    ) or 0
    today_matches = today_expense_matches + today_revenue_matches

    # 昨日新增匹配
    yesterday_expense_matches = db.scalar(
        select(func.count(ExpenseBankMatch.id)).where(
            ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
            func.date(ExpenseBankMatch.created_at) == yesterday,
        )
    ) or 0
    yesterday_revenue_matches = db.scalar(
        select(func.count(RevenueBankMatch.id)).where(
            RevenueBankMatch.status == MatchStatus.CONFIRMED.value,
            func.date(RevenueBankMatch.created_at) == yesterday,
        )
    ) or 0
    yesterday_matches = yesterday_expense_matches + yesterday_revenue_matches

    # 未匹配支出笔数
    unmatched_expenses = db.scalar(
        select(func.count(ExpenseItem.id)).where(
            ExpenseItem.payment_status.in_(
                [ExpensePaymentStatus.UNPAID.value, ExpensePaymentStatus.PARTIAL_PAID.value]
            ),
        )
    ) or 0

    # 未匹配收入笔数
    confirmed_exact_revenue_match_exists = (
        select(RevenueBankMatch.id)
        .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
        .join(
            RevenueBankMatchRecord,
            RevenueBankMatchRecord.revenue_bank_match_id == RevenueBankMatch.id,
        )
        .where(
            RevenueBankMatch.status == MatchStatus.CONFIRMED.value,
            RevenueBankMatchRecord.revenue_record_id == RevenueRecord.id,
            BankTransaction.store_id == RevenueRecord.store_id,
            BankTransaction.ledger_period == RevenueRecord.ledger_period,
        )
        .exists()
    )
    confirmed_legacy_revenue_match_exists = (
        select(RevenueBankMatch.id)
        .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
        .where(
            RevenueBankMatch.status == MatchStatus.CONFIRMED.value,
            RevenueBankMatch.channel == RevenueRecord.channel,
            RevenueBankMatch.revenue_start_date <= RevenueRecord.revenue_date,
            RevenueBankMatch.revenue_end_date >= RevenueRecord.revenue_date,
            BankTransaction.store_id == RevenueRecord.store_id,
            BankTransaction.ledger_period == RevenueRecord.ledger_period,
            ~select(RevenueBankMatchRecord.id)
            .where(RevenueBankMatchRecord.revenue_bank_match_id == RevenueBankMatch.id)
            .exists(),
        )
        .exists()
    )
    unmatched_revenues = db.scalar(
        select(func.count(RevenueRecord.id)).where(
            ~or_(confirmed_exact_revenue_match_exists, confirmed_legacy_revenue_match_exists)
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
    daily_expense_matches = db.execute(
        select(
            func.date(ExpenseBankMatch.created_at).label("date"),
            func.count(ExpenseBankMatch.id).label("count"),
        )
        .where(
            ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
            ExpenseBankMatch.created_at >= seven_days_ago,
        )
        .group_by(func.date(ExpenseBankMatch.created_at))
        .order_by(func.date(ExpenseBankMatch.created_at))
    ).all()
    daily_revenue_matches = db.execute(
        select(
            func.date(RevenueBankMatch.created_at).label("date"),
            func.count(RevenueBankMatch.id).label("count"),
        )
        .where(
            RevenueBankMatch.status == MatchStatus.CONFIRMED.value,
            RevenueBankMatch.created_at >= seven_days_ago,
        )
        .group_by(func.date(RevenueBankMatch.created_at))
        .order_by(func.date(RevenueBankMatch.created_at))
    ).all()
    daily_match_counts: dict[str, int] = {}
    for row in [*daily_expense_matches, *daily_revenue_matches]:
        key = str(row.date)
        daily_match_counts[key] = daily_match_counts.get(key, 0) + row.count

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
            ExpenseItem.payment_status.in_(
                [ExpensePaymentStatus.UNPAID.value, ExpensePaymentStatus.PARTIAL_PAID.value]
            ),
        )
        .group_by(ExpenseItem.store_id)
        .order_by(func.count(ExpenseItem.id).desc())
        .limit(10)
    ).all()

    return {
        "daily_matches": [
            {"date": date, "count": count}
            for date, count in sorted(daily_match_counts.items())
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
