from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    ApprovalInstance,
    BankTransaction,
    ExpenseItem,
    Ledger,
    MatchStatus,
    RevenueBankMatch,
    RevenueRecord,
    Store,
    User,
    utc_now,
)
from app.modules.approvals.status import approval_expense_stats_map, canonical_expense_items
from app.modules.auth.permissions import ensure_permission, ensure_store_access
from app.modules.auth.router import get_current_user
from app.modules.dingtalk.router import approval_instance_read
from app.modules.ledgers.router import build_close_check
from app.modules.matching.router import revenue_match_record_ids_map, revenue_match_response
from app.schemas import ApiEnvelope, StoreLedgerWorkspaceMetrics, StoreLedgerWorkspaceRead

router = APIRouter(prefix="/store-ledgers", tags=["store-ledgers"])


def decimal_sum(value: Decimal | None) -> Decimal:
    return value if value is not None else Decimal("0.00")


def parse_period_start(period: str) -> datetime:
    year, month = (int(part) for part in period.split("-"))
    return datetime(year, month, 1)


def next_period_start(period: str) -> datetime:
    start = parse_period_start(period)
    if start.month == 12:
        return datetime(start.year + 1, 1, 1)
    return datetime(start.year, start.month + 1, 1)


def latest_period(ledgers: list[Ledger], requested_period: str | None) -> str:
    if requested_period:
        return requested_period
    if ledgers:
        return ledgers[0].period
    return utc_now().date().strftime("%Y-%m")


@router.get("/{store_id}/workspace", response_model=ApiEnvelope[StoreLedgerWorkspaceRead])
def read_store_ledger_workspace(
    store_id: str,
    period: str | None = Query(default=None, pattern=r"^\d{4}-\d{2}$"),
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[StoreLedgerWorkspaceRead]:
    ensure_permission(session, current_user, "stores.view")
    ensure_store_access(session, current_user, store_id)
    store = session.get(Store, store_id)
    if store is None:
        from fastapi import HTTPException

        raise HTTPException(status_code=404, detail="Store not found")

    ledgers = list(
        session.scalars(
            select(Ledger)
            .where(Ledger.store_id == store_id)
            .order_by(Ledger.period.desc(), Ledger.created_at.desc())
            .limit(200)
        )
    )
    selected_period = latest_period(ledgers, period)
    selected_ledger = next((ledger for ledger in ledgers if ledger.period == selected_period), None)
    period_start = parse_period_start(selected_period)
    next_start = next_period_start(selected_period)

    revenue_record_count = session.scalar(
        select(func.count()).select_from(RevenueRecord).where(
            RevenueRecord.store_id == store_id,
            RevenueRecord.ledger_period == selected_period,
        )
    )
    income_amount = decimal_sum(
        session.scalar(
            select(func.sum(RevenueRecord.gross_amount)).where(
                RevenueRecord.store_id == store_id,
                RevenueRecord.ledger_period == selected_period,
            )
        )
    )
    net_income_amount = decimal_sum(
        session.scalar(
            select(func.sum(RevenueRecord.net_amount)).where(
                RevenueRecord.store_id == store_id,
                RevenueRecord.ledger_period == selected_period,
            )
        )
    )
    expense_items = list(
        session.scalars(
            select(ExpenseItem).where(
                ExpenseItem.store_id == store_id,
                ExpenseItem.ledger_period == selected_period,
            )
        )
    )
    expense_amount = sum(
        (item.amount for item in canonical_expense_items(expense_items)),
        Decimal("0.00"),
    )
    fee_amount = decimal_sum(
        session.scalar(
            select(func.sum(RevenueRecord.fee_amount)).where(
                RevenueRecord.store_id == store_id,
                RevenueRecord.ledger_period == selected_period,
            )
        )
    )
    bank_transaction_count = session.scalar(
        select(func.count()).select_from(BankTransaction).where(
            BankTransaction.store_id == store_id,
            BankTransaction.ledger_period == selected_period,
        )
    )
    unmatched_bank_transaction_count = session.scalar(
        select(func.count()).select_from(BankTransaction).where(
            BankTransaction.store_id == store_id,
            BankTransaction.ledger_period == selected_period,
            BankTransaction.matched_amount < BankTransaction.amount,
        )
    )
    approval_instances = list(
        session.scalars(
            select(ApprovalInstance)
            .where(
                ApprovalInstance.store_id == store_id,
                ApprovalInstance.submit_at >= period_start,
                ApprovalInstance.submit_at < next_start,
            )
            .order_by(ApprovalInstance.submit_at.desc())
        )
    )
    approval_stats_by_id = approval_expense_stats_map(session, [item.id for item in approval_instances])
    pending_approval_count = sum(
        1
        for item in approval_instances
        if approval_stats_by_id.get(item.id, {}).get("processing_status") != "matched"
    )
    revenue_match_count = session.scalar(
        select(func.count()).select_from(RevenueBankMatch).join(
            BankTransaction,
            RevenueBankMatch.bank_transaction_id == BankTransaction.id,
        ).where(
            BankTransaction.store_id == store_id,
            BankTransaction.ledger_period == selected_period,
        )
    )
    pending_revenue_match_count = session.scalar(
        select(func.count()).select_from(RevenueBankMatch).join(
            BankTransaction,
            RevenueBankMatch.bank_transaction_id == BankTransaction.id,
        ).where(
            BankTransaction.store_id == store_id,
            BankTransaction.ledger_period == selected_period,
            RevenueBankMatch.status == MatchStatus.CANDIDATE.value,
        )
    )

    bank_transactions = list(
        session.scalars(
            select(BankTransaction)
            .where(BankTransaction.store_id == store_id, BankTransaction.ledger_period == selected_period)
            .order_by(BankTransaction.occurred_at.desc())
        )
    )
    revenue_records = list(
        session.scalars(
            select(RevenueRecord)
            .where(RevenueRecord.store_id == store_id, RevenueRecord.ledger_period == selected_period)
            .order_by(RevenueRecord.revenue_date.desc(), RevenueRecord.created_at.desc())
        )
    )
    approval_reads = [
        approval_instance_read(session, item, approval_stats_by_id.get(item.id))
        for item in approval_instances
    ]
    revenue_matches = list(
        session.scalars(
            select(RevenueBankMatch)
            .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
            .where(BankTransaction.store_id == store_id, BankTransaction.ledger_period == selected_period)
            .order_by(RevenueBankMatch.created_at.desc())
        )
    )
    revenue_match_record_ids = revenue_match_record_ids_map(
        session,
        [match.id for match in revenue_matches],
    )
    revenue_match_reads = [
        revenue_match_response(session, match, revenue_match_record_ids.get(match.id, []))
        for match in revenue_matches
    ]

    return ApiEnvelope(
        data=StoreLedgerWorkspaceRead(
            store=store,
            period=selected_period,
            ledgers=ledgers,
            selected_ledger=selected_ledger,
            close_check=build_close_check(session, selected_ledger) if selected_ledger else None,
            metrics=StoreLedgerWorkspaceMetrics(
                revenue_record_count=revenue_record_count or 0,
                income_amount=income_amount,
                expense_amount=expense_amount,
                net_income_amount=net_income_amount,
                fee_amount=fee_amount,
                bank_transaction_count=bank_transaction_count or 0,
                unmatched_bank_transaction_count=unmatched_bank_transaction_count or 0,
                approval_count=len(approval_instances),
                pending_approval_count=pending_approval_count,
                revenue_match_count=revenue_match_count or 0,
                pending_revenue_match_count=pending_revenue_match_count or 0,
            ),
            bank_transactions=bank_transactions,
            revenue_records=revenue_records,
            approval_instances=approval_reads,
            revenue_matches=revenue_match_reads,
        )
    )
