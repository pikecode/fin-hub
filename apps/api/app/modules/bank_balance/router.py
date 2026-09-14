from datetime import datetime, time
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.core.security import verify_password
from app.models import BankBalanceCorrection, BankTransaction, Ledger, LedgerStatus, User
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import ensure_permission, ensure_store_access
from app.modules.auth.router import audit_actor, get_current_user
from app.schemas import (
    ApiEnvelope,
    BankBalanceCorrectionCreate,
    BankBalanceCorrectionRead,
    BankBalanceRead,
)

router = APIRouter(prefix="/bank-balance", tags=["bank-balance"])


def ensure_correction_ledger_open(session: Session, store_id: str, correction_date) -> None:
    period = correction_date.strftime("%Y-%m")
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period))
    if ledger is not None and ledger.status == LedgerStatus.CLOSED.value:
        raise HTTPException(status_code=409, detail="Ledger is closed")


def latest_correction(session: Session, store_id: str) -> BankBalanceCorrection | None:
    return session.scalar(
        select(BankBalanceCorrection)
        .where(BankBalanceCorrection.store_id == store_id)
        .order_by(
            BankBalanceCorrection.correction_date.desc(),
            BankBalanceCorrection.created_at.desc(),
            BankBalanceCorrection.id.desc(),
        )
        .limit(1)
    )


def calculate_bank_balance(session: Session, store_id: str) -> BankBalanceRead:
    correction = latest_correction(session, store_id)
    if correction is None:
        return BankBalanceRead()

    after = datetime.combine(correction.correction_date, time.max)
    transactions = list(
        session.scalars(
            select(BankTransaction).where(
                BankTransaction.store_id == store_id,
                BankTransaction.occurred_at > after,
            )
        )
    )
    income = sum(
        (Decimal(transaction.amount) for transaction in transactions if transaction.direction == "income"),
        Decimal("0.00"),
    )
    expense = sum(
        (Decimal(transaction.amount) for transaction in transactions if transaction.direction == "expense"),
        Decimal("0.00"),
    )
    return BankBalanceRead(
        balance_amount=Decimal(correction.balance_amount) + income - expense,
        base_balance_amount=correction.balance_amount,
        base_correction_date=correction.correction_date,
        income_after_base=income,
        expense_after_base=expense,
        has_correction=True,
    )


def correction_read(correction: BankBalanceCorrection, created_by_name: str) -> BankBalanceCorrectionRead:
    return BankBalanceCorrectionRead(
        id=correction.id,
        store_id=correction.store_id,
        correction_date=correction.correction_date,
        balance_amount=correction.balance_amount,
        remark=correction.remark,
        created_by=created_by_name,
        created_at=correction.created_at,
        updated_at=correction.updated_at,
    )


@router.get("", response_model=ApiEnvelope[BankBalanceRead])
def read_bank_balance(
    store_id: str,
    session: Session = Depends(get_session),  # noqa: B008
    current_user: User = Depends(get_current_user),  # noqa: B008
) -> ApiEnvelope[BankBalanceRead]:
    ensure_permission(session, current_user, "reconciliation.view")
    ensure_store_access(session, current_user, store_id)
    return ApiEnvelope(data=calculate_bank_balance(session, store_id))


@router.get("/corrections", response_model=ApiEnvelope[list[BankBalanceCorrectionRead]])
def list_bank_balance_corrections(
    store_id: str,
    session: Session = Depends(get_session),  # noqa: B008
    current_user: User = Depends(get_current_user),  # noqa: B008
) -> ApiEnvelope[list[BankBalanceCorrectionRead]]:
    ensure_permission(session, current_user, "reconciliation.view")
    ensure_store_access(session, current_user, store_id)
    corrections = list(
        session.scalars(
            select(BankBalanceCorrection)
            .where(BankBalanceCorrection.store_id == store_id)
            .order_by(
                BankBalanceCorrection.correction_date.desc(),
                BankBalanceCorrection.created_at.desc(),
                BankBalanceCorrection.id.desc(),
            )
        )
    )
    users = {
        user.id: user.display_name
        for user in session.scalars(select(User).where(User.id.in_({correction.created_by for correction in corrections})))
    }
    return ApiEnvelope(
        data=[correction_read(correction, users.get(correction.created_by, correction.created_by)) for correction in corrections]
    )


@router.post("/corrections", response_model=ApiEnvelope[BankBalanceCorrectionRead], status_code=201)
def create_bank_balance_correction(
    payload: BankBalanceCorrectionCreate,
    session: Session = Depends(get_session),  # noqa: B008
    current_user: User = Depends(get_current_user),  # noqa: B008
) -> ApiEnvelope[BankBalanceCorrectionRead]:
    ensure_permission(session, current_user, "reconciliation.manage")
    ensure_store_access(session, current_user, payload.store_id)
    if not verify_password(payload.password, current_user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid password")
    ensure_correction_ledger_open(session, payload.store_id, payload.correction_date)

    correction = BankBalanceCorrection(
        store_id=payload.store_id,
        correction_date=payload.correction_date,
        balance_amount=payload.balance_amount,
        remark=payload.remark.strip(),
        created_by=current_user.id,
    )
    if not correction.remark:
        raise HTTPException(status_code=422, detail="Remark is required")
    session.add(correction)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="bank_balance_correction.create",
        resource_type="bank_balance_correction",
        resource_id=correction.id,
        summary=f"新增银行余额校正：{correction.balance_amount}",
        metadata={
            "store_id": correction.store_id,
            "correction_date": correction.correction_date.isoformat(),
            "balance_amount": correction.balance_amount,
        },
    )
    session.commit()
    session.refresh(correction)
    return ApiEnvelope(data=correction_read(correction, current_user.display_name))
