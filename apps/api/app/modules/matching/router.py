from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    ExpensePaymentStatus,
    MasterDataStatus,
    MatchStatus,
    RevenueBankMatch,
    RevenueChannel,
    RevenueRecord,
    User,
    UserRole,
    utc_now,
)
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_roles
from app.modules.common import paginate
from app.schemas import (
    ApiEnvelope,
    AutoMatchResult,
    MatchCreate,
    MatchRead,
    Page,
    RevenueMatchCreate,
    RevenueMatchRead,
)

router = APIRouter(prefix="/matches", tags=["matching"])


def confirmed_expense_match_amount(session: Session, expense_item_id: str, exclude_match_id: str | None = None) -> Decimal:
    query = select(func.coalesce(func.sum(ExpenseBankMatch.amount), Decimal("0.00"))).where(
        ExpenseBankMatch.expense_item_id == expense_item_id,
        ExpenseBankMatch.status == MatchStatus.CONFIRMED.value,
    )
    if exclude_match_id:
        query = query.where(ExpenseBankMatch.id != exclude_match_id)
    return Decimal(session.scalar(query) or 0)


@router.get("", response_model=ApiEnvelope[Page[MatchRead]])
def list_matches(
    status: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[MatchRead]]:
    query = select(ExpenseBankMatch).order_by(ExpenseBankMatch.created_at.desc())
    if status:
        query = query.where(ExpenseBankMatch.status == status)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.get("/revenue", response_model=ApiEnvelope[Page[RevenueMatchRead]])
def list_revenue_matches(
    status: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[RevenueMatchRead]]:
    query = select(RevenueBankMatch).order_by(RevenueBankMatch.created_at.desc())
    if status:
        query = query.where(RevenueBankMatch.status == status)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


def revenue_range_total(session: Session, bank_transaction: BankTransaction, payload: RevenueMatchCreate) -> Decimal:
    if payload.revenue_start_date > payload.revenue_end_date:
        raise HTTPException(status_code=422, detail="Revenue start date cannot be after end date")
    total = session.scalar(
        select(func.coalesce(func.sum(RevenueRecord.net_amount), Decimal("0.00"))).where(
            RevenueRecord.store_id == bank_transaction.store_id,
            RevenueRecord.ledger_period == bank_transaction.ledger_period,
            RevenueRecord.channel == payload.channel,
            RevenueRecord.revenue_date >= payload.revenue_start_date,
            RevenueRecord.revenue_date <= payload.revenue_end_date,
        )
    )
    return Decimal(total or 0)


@router.post("/revenue", response_model=ApiEnvelope[RevenueMatchRead], status_code=201)
def create_revenue_match_candidate(
    payload: RevenueMatchCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[RevenueMatchRead]:
    bank_transaction = session.get(BankTransaction, payload.bank_transaction_id)
    if bank_transaction is None:
        raise HTTPException(status_code=404, detail="Bank transaction not found")
    if bank_transaction.direction != "income":
        raise HTTPException(status_code=409, detail="Bank transaction is not income")
    channel = session.scalar(select(RevenueChannel).where(RevenueChannel.name == payload.channel))
    if channel is None:
        raise HTTPException(status_code=404, detail="Revenue channel not found")
    if channel.status != MasterDataStatus.ACTIVE.value:
        raise HTTPException(status_code=409, detail="Revenue channel is inactive")

    total = revenue_range_total(session, bank_transaction, payload)
    if total <= 0:
        raise HTTPException(status_code=409, detail="Revenue records not found for selected range")
    if payload.amount != total:
        raise HTTPException(status_code=409, detail="Match amount must equal selected revenue net amount")
    remaining_bank_amount = Decimal(bank_transaction.amount) - Decimal(bank_transaction.matched_amount or 0)
    if payload.amount > remaining_bank_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining bank amount")

    match = RevenueBankMatch(**payload.model_dump(), status=MatchStatus.CANDIDATE.value)
    session.add(match)
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Revenue bank match already exists") from exc
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="revenue_match.create",
        resource_type="revenue_bank_match",
        resource_id=match.id,
        summary="创建收入流水匹配候选",
        metadata={
            "bank_transaction_id": match.bank_transaction_id,
            "channel": match.channel,
            "revenue_start_date": match.revenue_start_date,
            "revenue_end_date": match.revenue_end_date,
            "amount": match.amount,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)


@router.post("/revenue/{match_id}/confirm", response_model=ApiEnvelope[RevenueMatchRead])
def confirm_revenue_match(
    match_id: str,
    operator: str = "system",
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[RevenueMatchRead]:
    match = session.get(RevenueBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Revenue match not found")
    bank_transaction = session.get(BankTransaction, match.bank_transaction_id)
    if bank_transaction is None:
        raise HTTPException(status_code=409, detail="Matched bank transaction is missing")
    if match.status == MatchStatus.CONFIRMED.value:
        return ApiEnvelope(data=match)
    if match.status == MatchStatus.REJECTED.value:
        raise HTTPException(status_code=409, detail="Rejected match cannot be confirmed")

    remaining_bank_amount = Decimal(bank_transaction.amount) - Decimal(bank_transaction.matched_amount or 0)
    if match.amount > remaining_bank_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining bank amount")

    match.status = MatchStatus.CONFIRMED.value
    match.confirmed_by = operator
    match.confirmed_at = utc_now()
    bank_transaction.matched_amount = Decimal(bank_transaction.matched_amount or 0) + match.amount
    write_audit_log(
        session,
        actor=audit_actor(current_user, operator),
        action="revenue_match.confirm",
        resource_type="revenue_bank_match",
        resource_id=match.id,
        summary="确认收入流水匹配",
        metadata={
            "bank_transaction_id": match.bank_transaction_id,
            "channel": match.channel,
            "amount": match.amount,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)


@router.post("/revenue/{match_id}/reject", response_model=ApiEnvelope[RevenueMatchRead])
def reject_revenue_match(
    match_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[RevenueMatchRead]:
    match = session.get(RevenueBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Revenue match not found")
    if match.status == MatchStatus.CONFIRMED.value:
        raise HTTPException(status_code=409, detail="Confirmed match cannot be rejected")
    match.status = MatchStatus.REJECTED.value
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="revenue_match.reject",
        resource_type="revenue_bank_match",
        resource_id=match.id,
        summary="驳回收入流水匹配候选",
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)


@router.post("", response_model=ApiEnvelope[MatchRead], status_code=201)
def create_match_candidate(
    payload: MatchCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[MatchRead]:
    expense_item = session.get(ExpenseItem, payload.expense_item_id)
    if expense_item is None:
        raise HTTPException(status_code=404, detail="Expense item not found")
    bank_transaction = session.get(BankTransaction, payload.bank_transaction_id)
    if bank_transaction is None:
        raise HTTPException(status_code=404, detail="Bank transaction not found")
    if bank_transaction.direction != "expense":
        raise HTTPException(status_code=409, detail="Bank transaction is not expense")
    if expense_item.store_id != bank_transaction.store_id:
        raise HTTPException(status_code=409, detail="Store mismatch")
    if expense_item.ledger_period != bank_transaction.ledger_period:
        raise HTTPException(status_code=409, detail="Ledger period mismatch")
    remaining_expense_amount = Decimal(expense_item.amount) - confirmed_expense_match_amount(session, expense_item.id)
    if payload.amount > remaining_expense_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining expense amount")
    remaining_bank_amount = Decimal(bank_transaction.amount) - Decimal(bank_transaction.matched_amount or 0)
    if payload.amount > remaining_bank_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining bank amount")
    match = ExpenseBankMatch(**payload.model_dump(), status=MatchStatus.CANDIDATE.value)
    session.add(match)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="match.create",
        resource_type="expense_bank_match",
        resource_id=match.id,
        summary="创建流水匹配候选",
        metadata={
            "expense_item_id": match.expense_item_id,
            "bank_transaction_id": match.bank_transaction_id,
            "amount": match.amount,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)


@router.post("/auto-suggest", response_model=ApiEnvelope[AutoMatchResult], status_code=201)
def auto_suggest_matches(
    store_id: str | None = None,
    ledger_period: str | None = None,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[AutoMatchResult]:
    expense_query = select(ExpenseItem).where(
        ExpenseItem.payment_status.in_(
            [ExpensePaymentStatus.UNPAID.value, ExpensePaymentStatus.PARTIAL_PAID.value]
        )
    )
    bank_query = select(BankTransaction).where(BankTransaction.direction == "expense")
    if store_id:
        expense_query = expense_query.where(ExpenseItem.store_id == store_id)
        bank_query = bank_query.where(BankTransaction.store_id == store_id)
    if ledger_period:
        expense_query = expense_query.where(ExpenseItem.ledger_period == ledger_period)
        bank_query = bank_query.where(BankTransaction.ledger_period == ledger_period)

    expenses = list(session.scalars(expense_query.order_by(ExpenseItem.created_at.asc())))
    bank_transactions = [
        transaction
        for transaction in session.scalars(bank_query.order_by(BankTransaction.occurred_at.asc()))
        if Decimal(transaction.amount) > Decimal(transaction.matched_amount or 0)
    ]
    existing_pairs = {
        (match.expense_item_id, match.bank_transaction_id)
        for match in session.scalars(select(ExpenseBankMatch))
    }

    created_matches: list[ExpenseBankMatch] = []
    used_expense_ids: set[str] = set()
    used_bank_ids: set[str] = set()
    skipped_count = 0

    for expense in expenses:
        if expense.id in used_expense_ids:
            continue
        for transaction in bank_transactions:
            if transaction.id in used_bank_ids:
                continue
            if (expense.id, transaction.id) in existing_pairs:
                skipped_count += 1
                continue
            if expense.store_id != transaction.store_id or expense.ledger_period != transaction.ledger_period:
                continue
            remaining_expense_amount = Decimal(expense.amount) - confirmed_expense_match_amount(session, expense.id)
            remaining_bank_amount = Decimal(transaction.amount) - Decimal(transaction.matched_amount or 0)
            if remaining_expense_amount <= 0 or remaining_expense_amount != remaining_bank_amount:
                continue

            confidence = Decimal("98.00") if expense.supplier_name and expense.supplier_name == transaction.counterparty_name else Decimal("92.00")
            reason = "金额、门店和账期一致"
            if confidence == Decimal("98.00"):
                reason = "金额、门店、账期和供应商一致"
            match = ExpenseBankMatch(
                expense_item_id=expense.id,
                bank_transaction_id=transaction.id,
                amount=remaining_expense_amount,
                status=MatchStatus.CANDIDATE.value,
                confidence=confidence,
                reason=reason,
            )
            session.add(match)
            created_matches.append(match)
            existing_pairs.add((expense.id, transaction.id))
            used_expense_ids.add(expense.id)
            used_bank_ids.add(transaction.id)
            break

    if created_matches:
        session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="match.auto_suggest",
        resource_type="expense_bank_match",
        summary=f"自动生成匹配候选：{len(created_matches)} 条",
        metadata={"store_id": store_id, "ledger_period": ledger_period, "skipped_count": skipped_count},
    )
    session.commit()
    for match in created_matches:
        session.refresh(match)
    return ApiEnvelope(
        data=AutoMatchResult(
            created_count=len(created_matches),
            skipped_count=skipped_count,
            matches=created_matches,
        )
    )


@router.post("/{match_id}/confirm", response_model=ApiEnvelope[MatchRead])
def confirm_match(
    match_id: str,
    operator: str = "system",
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[MatchRead]:
    match = session.get(ExpenseBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    expense_item = session.get(ExpenseItem, match.expense_item_id)
    bank_transaction = session.get(BankTransaction, match.bank_transaction_id)
    if expense_item is None or bank_transaction is None:
        raise HTTPException(status_code=409, detail="Matched source record is missing")
    if match.status == MatchStatus.CONFIRMED.value:
        return ApiEnvelope(data=match)
    if match.status == MatchStatus.REJECTED.value:
        raise HTTPException(status_code=409, detail="Rejected match cannot be confirmed")
    confirmed_expense_amount = confirmed_expense_match_amount(session, expense_item.id, exclude_match_id=match.id)
    remaining_expense_amount = Decimal(expense_item.amount) - confirmed_expense_amount
    if match.amount > remaining_expense_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining expense amount")
    remaining_bank_amount = Decimal(bank_transaction.amount) - Decimal(bank_transaction.matched_amount or 0)
    if match.amount > remaining_bank_amount:
        raise HTTPException(status_code=409, detail="Match amount exceeds remaining bank amount")

    match.status = MatchStatus.CONFIRMED.value
    match.confirmed_by = operator
    match.confirmed_at = utc_now()
    bank_transaction.matched_amount = Decimal(bank_transaction.matched_amount or 0) + match.amount
    if confirmed_expense_amount + match.amount >= Decimal(expense_item.amount):
        expense_item.payment_status = ExpensePaymentStatus.PAID.value
    else:
        expense_item.payment_status = ExpensePaymentStatus.PARTIAL_PAID.value
    write_audit_log(
        session,
        actor=audit_actor(current_user, operator),
        action="match.confirm",
        resource_type="expense_bank_match",
        resource_id=match.id,
        summary="确认流水匹配",
        metadata={
            "expense_item_id": match.expense_item_id,
            "bank_transaction_id": match.bank_transaction_id,
            "amount": match.amount,
        },
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)


@router.post("/{match_id}/reject", response_model=ApiEnvelope[MatchRead])
def reject_match(
    match_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[MatchRead]:
    match = session.get(ExpenseBankMatch, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status == MatchStatus.CONFIRMED.value:
        raise HTTPException(status_code=409, detail="Confirmed match cannot be rejected")
    match.status = MatchStatus.REJECTED.value
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="match.reject",
        resource_type="expense_bank_match",
        resource_id=match.id,
        summary="驳回流水匹配候选",
    )
    session.commit()
    session.refresh(match)
    return ApiEnvelope(data=match)
