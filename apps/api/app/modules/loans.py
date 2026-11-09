"""Outgoing principal is a receivable; only real bank transactions affect cash."""

import json
from datetime import date, datetime, time
from decimal import Decimal
from typing import Annotated
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    BankTransaction,
    ExpenseBankMatch,
    Ledger,
    RevenueBankMatch,
    Store,
    StoreLoan,
    StoreLoanEvent,
    User,
)
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import ensure_permission, ensure_store_access
from app.modules.auth.router import audit_actor, get_current_user
from app.modules.bank.unpaid import mutation_lock
from app.schemas import ApiEnvelope

router = APIRouter(prefix="/store-loans", tags=["store-loans"])
DB = Annotated[Session, Depends(get_session)]
Actor = Annotated[User, Depends(get_current_user)]


def scope(session, user, store_id, write=False):
    ensure_permission(session, user, "reconciliation.manage" if write else "reconciliation.view")
    ensure_store_access(session, user, store_id)
    if not session.get(Store, store_id):
        raise HTTPException(404, "门店不存在")


def loan_rows(session, store_id, cutoff=None):
    result = []
    for loan in session.scalars(
        select(StoreLoan)
        .where(StoreLoan.store_id == store_id)
        .order_by(StoreLoan.created_at.desc())
    ):
        query = select(StoreLoanEvent).where(StoreLoanEvent.loan_id == loan.id)
        if cutoff:
            query = query.where(StoreLoanEvent.occurred_on <= cutoff)
        events = list(
            session.scalars(query.order_by(StoreLoanEvent.occurred_on, StoreLoanEvent.created_at))
        )
        if not events:
            continue
        lent = sum((e.amount for e in events if e.kind == "lend" and e.active), Decimal(0))
        repaid = sum((e.amount for e in events if e.kind == "repay" and e.active), Decimal(0))
        result.append(
            {
                "id": loan.id,
                "borrower": loan.borrower,
                "reason": loan.reason,
                "amount": str(lent),
                "repaid": str(repaid),
                "remaining": str(lent - repaid),
                "status": "已撤销"
                if not lent
                else "已还清"
                if lent == repaid
                else "部分归还"
                if repaid
                else "未还",
                "events": [
                    {
                        "active": e.active,
                        "id": e.id,
                        "kind": e.kind,
                        "date": e.occurred_on.isoformat(),
                        "amount": str(e.amount),
                        "remark": e.remark,
                        "bank_transaction_id": e.bank_transaction_id,
                    }
                    for e in events
                ],
            }
        )
    return result


@router.get("")
def list_loans(store_id: str, session: DB, user: Actor):
    scope(session, user, store_id)
    return ApiEnvelope(data=loan_rows(session, store_id))


class Movement(BaseModel):
    occurred_on: date
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    bank_transaction_id: str | None = None
    remark: str = Field(min_length=1, max_length=2000)
    request_key: str = Field(min_length=1, max_length=64)


class LoanCreate(Movement):
    store_id: str
    borrower: str = Field(min_length=1, max_length=120)


def protect_loan_bank(session, bank_id):
    if session.scalar(
        select(StoreLoanEvent.id)
        .where(StoreLoanEvent.bank_transaction_id == bank_id, StoreLoanEvent.active.is_(True))
        .limit(1)
    ):
        raise HTTPException(409, "该流水已登记借出或还款，不能直接修改或删除")


def apply_movement(session, user, loan, payload, kind):
    if not payload.remark.strip() or not payload.request_key.strip():
        raise HTTPException(422, "原因和请求标识不能为空")
    period = payload.occurred_on.strftime("%Y-%m")
    ledger = session.scalar(
        select(Ledger)
        .where(Ledger.store_id == loan.store_id, Ledger.period >= period, Ledger.status != "open")
        .limit(1)
        .with_for_update()
    )
    if ledger and ledger.status != "open":
        raise HTTPException(409, "该月已封账，不能改变历史外借款")
    if payload.occurred_on > datetime.now(ZoneInfo("Asia/Shanghai")).date():
        raise HTTPException(422, "只能登记已经发生的借出或还款")
    events = list(
        session.scalars(
            select(StoreLoanEvent).where(
                StoreLoanEvent.loan_id == loan.id, StoreLoanEvent.active.is_(True)
            )
        )
    )
    if kind == "repay":
        if not events or payload.occurred_on < min(e.occurred_on for e in events):
            raise HTTPException(409, "还款日期不能早于借款日期")
        remaining = sum((e.amount if e.kind == "lend" else -e.amount for e in events), Decimal(0))
        if payload.amount > remaining:
            raise HTTPException(409, "还款不能超过未还本金")
    direction = "expense" if kind == "lend" else "income"
    if payload.bank_transaction_id:
        bank = session.get(BankTransaction, payload.bank_transaction_id)
        if not bank or bank.store_id != loan.store_id:
            raise HTTPException(409, "请选择本门店流水")
        protect_loan_bank(session, bank.id)
        if (
            bank.is_archived
            or bank.payment_status != "paid"
            or bank.direction != direction
            or bank.amount != payload.amount
            or bank.occurred_at.date() != payload.occurred_on
        ):
            raise HTTPException(409, "流水方向、金额、日期和实付状态必须与登记一致")
        if (
            bank.direct_posting_type
            or bank.special_type not in (None, "loan_repayment")
            or Decimal(bank.matched_amount or 0)
        ):
            raise HTTPException(409, "该流水已有其他业务属性或匹配")
        for model in (ExpenseBankMatch, RevenueBankMatch):
            if session.scalar(
                select(model.id)
                .where(model.bank_transaction_id == bank.id, model.status != "rejected")
                .limit(1)
            ):
                raise HTTPException(409, "该流水已用于其他匹配")
        from app.modules.bank.unpaid import protect_payment_bank

        protect_payment_bank(session, bank.id)
    else:
        bank = BankTransaction(
            store_id=loan.store_id,
            ledger_period=period,
            occurred_at=datetime.combine(payload.occurred_on, time(12)),
            direction=direction,
            amount=payload.amount,
            counterparty_name=loan.borrower,
            summary=payload.remark.strip(),
            payment_status="paid",
        )
        session.add(bank)
        session.flush()
    previous_special_type = bank.special_type
    bank.special_type = "loan_repayment"
    event = StoreLoanEvent(
        loan_id=loan.id,
        kind=kind,
        occurred_on=payload.occurred_on,
        amount=payload.amount,
        bank_transaction_id=bank.id,
        remark=payload.remark.strip(),
        request_key=payload.request_key,
        payload_json=json.dumps(payload.model_dump(mode="json"), sort_keys=True),
        generated_bank=not bool(payload.bank_transaction_id),
        previous_special_type=previous_special_type,
        created_by=user.id,
    )
    session.add(event)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="loan." + kind,
        resource_type="store_loan",
        resource_id=loan.id,
        summary="登记外借款" if kind == "lend" else "登记归还本金",
        metadata={"event_id": event.id, "amount": str(event.amount), "bank_id": bank.id},
    )
    return event


def existing_event(session, payload, kind, loan_id=None):
    row = session.scalar(
        select(StoreLoanEvent).where(StoreLoanEvent.request_key == payload.request_key)
    )
    if row and (
        row.payload_json != json.dumps(payload.model_dump(mode="json"), sort_keys=True)
        or row.kind != kind
        or (loan_id and row.loan_id != loan_id)
    ):
        raise HTTPException(409, "重复请求参数不一致")
    return row


@router.post("")
def create_loan(payload: LoanCreate, session: DB, user: Actor):
    scope(session, user, payload.store_id, True)
    mutation_lock(session)
    old = existing_event(session, payload, "lend")
    if old:
        return ApiEnvelope(data={"id": old.loan_id, "event_id": old.id})
    if not payload.borrower.strip():
        raise HTTPException(422, "请填写借款人")
    loan = StoreLoan(
        store_id=payload.store_id, borrower=payload.borrower.strip(), reason=payload.remark.strip()
    )
    session.add(loan)
    session.flush()
    event = apply_movement(session, user, loan, payload, "lend")
    session.commit()
    return ApiEnvelope(data={"id": loan.id, "event_id": event.id})


@router.post("/{loan_id}/repayments")
def repay(loan_id: str, payload: Movement, session: DB, user: Actor):
    mutation_lock(session)
    loan = session.get(StoreLoan, loan_id)
    if not loan:
        raise HTTPException(404, "借款不存在")
    scope(session, user, loan.store_id, True)
    old = existing_event(session, payload, "repay", loan_id)
    if old:
        return ApiEnvelope(data={"id": loan.id, "event_id": old.id})
    event = apply_movement(session, user, loan, payload, "repay")
    session.commit()
    return ApiEnvelope(data={"id": loan.id, "event_id": event.id})


class RevokeRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


@router.post("/events/{event_id}/revoke")
def revoke_event(event_id: str, payload: RevokeRequest, session: DB, user: Actor):
    mutation_lock(session)
    event = session.get(StoreLoanEvent, event_id)
    if not event:
        raise HTTPException(404, "登记记录不存在")
    loan = session.get(StoreLoan, event.loan_id)
    scope(session, user, loan.store_id, True)
    if not payload.reason.strip():
        raise HTTPException(422, "请填写撤销原因")
    if not event.active:
        return ApiEnvelope(data={"id": event.id, "active": False})
    if session.scalar(
        select(Ledger.id)
        .where(
            Ledger.store_id == loan.store_id,
            Ledger.period >= event.occurred_on.strftime("%Y-%m"),
            Ledger.status != "open",
        )
        .limit(1)
    ):
        raise HTTPException(409, "已封账期间不能撤销借还款")
    if event.kind == "lend" and session.scalar(
        select(StoreLoanEvent.id)
        .where(
            StoreLoanEvent.loan_id == loan.id,
            StoreLoanEvent.kind == "repay",
            StoreLoanEvent.active.is_(True),
        )
        .limit(1)
    ):
        raise HTTPException(409, "请先撤销该借款的还款登记")
    bank = session.get(BankTransaction, event.bank_transaction_id)
    if event.generated_bank:
        bank.is_archived = True
    else:
        bank.special_type = event.previous_special_type
    event.active = False
    event.revoked_reason = payload.reason.strip()
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="loan.revoke",
        resource_type="store_loan",
        resource_id=loan.id,
        summary="撤销借还款登记",
        metadata={
            "event_id": event.id,
            "reason": event.revoked_reason,
            "bank_id": bank.id,
            "generated_bank": event.generated_bank,
        },
    )
    session.commit()
    return ApiEnvelope(data={"id": event.id, "active": False})
