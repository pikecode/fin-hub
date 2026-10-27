"""Versioned, audited administrator setup of store opening balances."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    AuditLog,
    DividendOpeningBalance,
    DividendFundingSetting,
    DividendMonth,
    Ledger,
    PreopeningStore,
    User,
    utc_now,
)
from app.modules.auth.router import get_current_user, audit_actor
from app.modules.auth.permissions import ensure_permission
from app.modules.audit.service import write_audit_log
from app.modules.dividend.opening import lock_store, opening_read, valid_period
from app.schemas import ApiEnvelope, DividendOpeningRead, DividendOpeningUpdate, AuditLogRead

router = APIRouter(prefix="/dividends/opening", tags=["dividend-opening"])


def authorize(session, user, store_id):
    from app.modules.dividend.router import ensure_store

    return ensure_store(session, store_id, user)


@router.get("/{store_id}", response_model=ApiEnvelope[DividendOpeningRead])
def read_opening(
    store_id: str, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    authorize(session, user, store_id)
    return ApiEnvelope(data=opening_read(session, store_id))


@router.put("/{store_id}", response_model=ApiEnvelope[DividendOpeningRead])
def save_opening(
    store_id: str,
    payload: DividendOpeningUpdate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    authorize(session, user, store_id)
    if user.role != "admin":
        raise HTTPException(403, "仅管理员可录入门店期初数据")
    valid_period(payload.start_period)
    if not payload.reason.strip():
        raise HTTPException(422, "请填写录入或修改原因")
    lock_store(session, store_id)
    existing = session.get(DividendOpeningBalance, store_id, populate_existing=True)
    if payload.version != (existing.version if existing else 0):
        raise HTTPException(409, "期初数据已被其他操作更新，请重新加载后再保存")
    earliest = (
        min(payload.start_period, existing.start_period) if existing else payload.start_period
    )
    months = list(
        session.scalars(
            select(DividendMonth)
            .where(DividendMonth.store_id == store_id, DividendMonth.period >= earliest)
            .with_for_update()
        )
    )
    locked = next((month for month in months if month.locked), None)
    if locked:
        raise HTTPException(409, f"{locked.period} 分红月份已锁定，修改期初会影响该月，请先解锁")
    ledgers = list(
        session.scalars(
            select(Ledger)
            .where(Ledger.store_id == store_id, Ledger.period >= earliest)
            .with_for_update()
        )
    )
    closed = next((ledger for ledger in ledgers if ledger.status == "closed"), None)
    if closed:
        raise HTTPException(409, f"{closed.period} 账期已封账，不能更改受影响的期初数据")
    before = opening_read(session, store_id).model_dump(mode="json")
    funding = session.get(DividendFundingSetting, store_id)
    state = session.scalar(
        select(PreopeningStore).where(PreopeningStore.store_id == store_id).with_for_update()
    )
    if (
        state
        and state.status == "closed"
        and (
            payload.preopening_investment != (funding.preopening_investment if funding else 0)
            or payload.preopening_expense_override
            != (funding.preopening_expense_override if funding else None)
        )
    ):
        raise HTTPException(409, "筹建报表已封账，不能修改筹建资金和支出覆盖值")
    if funding is None:
        funding = DividendFundingSetting(store_id=store_id)
        session.add(funding)
    funding.preopening_investment = payload.preopening_investment
    funding.preopening_expense_override = payload.preopening_expense_override
    if existing is None:
        existing = DividendOpeningBalance(store_id=store_id, version=0)
        session.add(existing)
    for key in (
        "start_period",
        "opening_remaining",
        "historical_profit",
        "historical_distribution",
        "operating_capital",
    ):
        setattr(existing, key, getattr(payload, key))
    existing.version += 1
    existing.reason = payload.reason.strip()
    existing.updated_by = audit_actor(user)
    existing.updated_at = utc_now()
    session.flush()
    after = opening_read(session, store_id).model_dump(mode="json")
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="dividend.opening.save",
        resource_type="dividend_opening",
        resource_id=store_id,
        summary=f"{'修改' if before['configured'] else '录入'}门店期初数据，自 {payload.start_period} 起计算",
        metadata={"before": before, "after": after, "reason": payload.reason.strip()},
    )
    session.commit()
    return ApiEnvelope(data=opening_read(session, store_id))


@router.get("/{store_id}/history", response_model=ApiEnvelope[list[AuditLogRead]])
def read_history(
    store_id: str, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    authorize(session, user, store_id)
    ensure_permission(session, user, "audit.view")
    items = session.scalars(
        select(AuditLog)
        .where(AuditLog.resource_type == "dividend_opening", AuditLog.resource_id == store_id)
        .order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    ).all()
    return ApiEnvelope(data=[AuditLogRead.model_validate(item) for item in items])
