from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    ExpensePaymentStatus,
    Ledger,
    LedgerStatus,
    MatchStatus,
    RevenueBankMatch,
    RevenueBankMatchRecord,
    RevenueChannel,
    RevenueRecord,
    Store,
    User,
    UserRole,
    utc_now,
)
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_roles
from app.modules.common import paginate
from app.schemas import (
    ApiEnvelope,
    LedgerCloseCheck,
    LedgerCreate,
    LedgerRead,
    LedgerStatusChange,
    Page,
)

router = APIRouter(prefix="/ledgers", tags=["ledgers"])


def ensure_store(session: Session, store_id: str) -> None:
    if session.get(Store, store_id) is None:
        raise HTTPException(status_code=404, detail="Store not found")


def build_close_check(session: Session, ledger: Ledger) -> LedgerCloseCheck:
    unpaid_expense_count = len(
        list(
            session.scalars(
                select(ExpenseItem).where(
                    ExpenseItem.store_id == ledger.store_id,
                    ExpenseItem.ledger_period == ledger.period,
                    ExpenseItem.payment_status.in_(
                        [ExpensePaymentStatus.UNPAID.value, ExpensePaymentStatus.PARTIAL_PAID.value]
                    ),
                )
            )
        )
    )
    unmatched_bank_transaction_count = len(
        [
            transaction
            for transaction in session.scalars(
                select(BankTransaction).where(
                    BankTransaction.store_id == ledger.store_id,
                    BankTransaction.ledger_period == ledger.period,
                )
            )
            if transaction.amount > (transaction.matched_amount or 0)
        ]
    )
    expense_candidate_match_count = len(
        list(
            session.scalars(
                select(ExpenseBankMatch)
                .join(ExpenseItem, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
                .where(
                    ExpenseItem.store_id == ledger.store_id,
                    ExpenseItem.ledger_period == ledger.period,
                    ExpenseBankMatch.status == MatchStatus.CANDIDATE.value,
                )
            )
        )
    )
    revenue_candidate_match_count = len(
        list(
            session.scalars(
                select(RevenueBankMatch)
                .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
                .where(
                    BankTransaction.store_id == ledger.store_id,
                    BankTransaction.ledger_period == ledger.period,
                    RevenueBankMatch.status == MatchStatus.CANDIDATE.value,
                )
            )
        )
    )
    candidate_match_count = expense_candidate_match_count + revenue_candidate_match_count
    revenue_record_count = len(
        list(
            session.scalars(
                select(RevenueRecord).where(
                    RevenueRecord.store_id == ledger.store_id,
                    RevenueRecord.ledger_period == ledger.period,
                )
            )
        )
    )
    required_channel_names = set(
        session.scalars(
            select(RevenueChannel.name).where(RevenueChannel.requires_bank_match.is_(True))
        ).all()
    )
    revenue_records_requiring_match = [
        record
        for record in session.scalars(
            select(RevenueRecord).where(
                RevenueRecord.store_id == ledger.store_id,
                RevenueRecord.ledger_period == ledger.period,
            )
        )
        if record.channel in required_channel_names
    ]
    confirmed_revenue_matches = list(
        session.scalars(
            select(RevenueBankMatch)
            .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
            .where(
                BankTransaction.store_id == ledger.store_id,
                BankTransaction.ledger_period == ledger.period,
                RevenueBankMatch.status == MatchStatus.CONFIRMED.value,
            )
        )
    )
    explicit_match_ids = set(
        session.scalars(
            select(RevenueBankMatchRecord.revenue_bank_match_id)
            .join(
                RevenueBankMatch,
                RevenueBankMatchRecord.revenue_bank_match_id == RevenueBankMatch.id,
            )
            .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
            .where(
                BankTransaction.store_id == ledger.store_id,
                BankTransaction.ledger_period == ledger.period,
                RevenueBankMatch.status == MatchStatus.CONFIRMED.value,
            )
        ).all()
    )
    explicitly_matched_revenue_record_ids = set(
        session.scalars(
            select(RevenueBankMatchRecord.revenue_record_id)
            .join(
                RevenueBankMatch,
                RevenueBankMatchRecord.revenue_bank_match_id == RevenueBankMatch.id,
            )
            .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
            .where(
                BankTransaction.store_id == ledger.store_id,
                BankTransaction.ledger_period == ledger.period,
                RevenueBankMatch.status == MatchStatus.CONFIRMED.value,
            )
        ).all()
    )
    legacy_confirmed_revenue_matches = [
        match for match in confirmed_revenue_matches if match.id not in explicit_match_ids
    ]
    unmatched_revenue_records = [
        record
        for record in revenue_records_requiring_match
        if record.id not in explicitly_matched_revenue_record_ids
        and not any(
            match.channel == record.channel
            and match.revenue_start_date <= record.revenue_date <= match.revenue_end_date
            for match in legacy_confirmed_revenue_matches
        )
    ]
    unmatched_revenue_record_count = len(unmatched_revenue_records)
    unmatched_revenue_amount = sum(
        (record.net_amount for record in unmatched_revenue_records),
        start=Decimal("0.00"),
    )

    issues: list[str] = []
    warnings: list[str] = []
    if unpaid_expense_count:
        issues.append(f"存在 {unpaid_expense_count} 条未付款或部分付款支出")
    if unmatched_bank_transaction_count:
        issues.append(f"存在 {unmatched_bank_transaction_count} 条未完全匹配的银行流水")
    if unmatched_revenue_record_count:
        issues.append(
            f"存在 {unmatched_revenue_record_count} 条需要对账的营业收入未关联银行流水，"
            f"未对账实收金额 {unmatched_revenue_amount:.2f}"
        )
    if candidate_match_count:
        issues.append(f"存在 {candidate_match_count} 条待确认候选匹配")
    if not revenue_record_count:
        warnings.append("当前账期没有营业收入记录")
    return LedgerCloseCheck(
        can_close=not issues,
        unpaid_expense_count=unpaid_expense_count,
        unmatched_bank_transaction_count=unmatched_bank_transaction_count,
        candidate_match_count=candidate_match_count,
        revenue_record_count=revenue_record_count,
        unmatched_revenue_record_count=unmatched_revenue_record_count,
        unmatched_revenue_amount=unmatched_revenue_amount,
        issues=issues,
        warnings=warnings,
    )


@router.get("", response_model=ApiEnvelope[Page[LedgerRead]])
def list_ledgers(
    store_id: str | None = None,
    period: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[LedgerRead]]:
    query = select(Ledger).order_by(Ledger.period.desc(), Ledger.created_at.desc())
    if store_id:
        query = query.where(Ledger.store_id == store_id)
    if period:
        query = query.where(Ledger.period == period)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.post("", response_model=ApiEnvelope[LedgerRead], status_code=201)
def create_ledger(
    payload: LedgerCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[LedgerRead]:
    ensure_store(session, payload.store_id)
    exists = session.scalar(
        select(Ledger).where(Ledger.store_id == payload.store_id, Ledger.period == payload.period)
    )
    if exists:
        raise HTTPException(status_code=409, detail="Ledger already exists")
    ledger = Ledger(**payload.model_dump())
    session.add(ledger)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="ledger.create",
        resource_type="ledger",
        resource_id=ledger.id,
        summary=f"新增账套：{ledger.period}",
        metadata={"store_id": ledger.store_id},
    )
    session.commit()
    session.refresh(ledger)
    return ApiEnvelope(data=ledger)


@router.get("/{ledger_id}/close-check", response_model=ApiEnvelope[LedgerCloseCheck])
def check_ledger_close(
    ledger_id: str,
    session: Session = Depends(get_session),
) -> ApiEnvelope[LedgerCloseCheck]:
    ledger = session.get(Ledger, ledger_id)
    if ledger is None:
        raise HTTPException(status_code=404, detail="Ledger not found")
    return ApiEnvelope(data=build_close_check(session, ledger))


@router.post("/{ledger_id}/close", response_model=ApiEnvelope[LedgerRead])
def close_ledger(
    ledger_id: str,
    payload: LedgerStatusChange,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[LedgerRead]:
    ledger = session.get(Ledger, ledger_id)
    if ledger is None:
        raise HTTPException(status_code=404, detail="Ledger not found")
    if ledger.status == LedgerStatus.CLOSED.value:
        return ApiEnvelope(data=ledger)
    close_check = build_close_check(session, ledger)
    if not close_check.can_close:
        raise HTTPException(
            status_code=409,
            detail={"message": "Ledger cannot be closed", "issues": close_check.issues},
        )
    ledger.status = LedgerStatus.CLOSED.value
    ledger.closed_at = utc_now()
    ledger.closed_by = payload.operator
    ledger.version += 1
    write_audit_log(
        session,
        actor=audit_actor(current_user, payload.operator),
        action="ledger.close",
        resource_type="ledger",
        resource_id=ledger.id,
        summary=f"封账：{ledger.period}",
        metadata={"store_id": ledger.store_id, "version": ledger.version},
    )
    session.commit()
    session.refresh(ledger)
    return ApiEnvelope(data=ledger)


@router.post("/{ledger_id}/reopen", response_model=ApiEnvelope[LedgerRead])
def reopen_ledger(
    ledger_id: str,
    payload: LedgerStatusChange,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[LedgerRead]:
    ledger = session.get(Ledger, ledger_id)
    if ledger is None:
        raise HTTPException(status_code=404, detail="Ledger not found")
    ledger.status = LedgerStatus.OPEN.value
    ledger.reopened_at = utc_now()
    ledger.reopened_by = payload.operator
    ledger.version += 1
    write_audit_log(
        session,
        actor=audit_actor(current_user, payload.operator),
        action="ledger.reopen",
        resource_type="ledger",
        resource_id=ledger.id,
        summary=f"反封账：{ledger.period}",
        metadata={"store_id": ledger.store_id, "version": ledger.version},
    )
    session.commit()
    session.refresh(ledger)
    return ApiEnvelope(data=ledger)
