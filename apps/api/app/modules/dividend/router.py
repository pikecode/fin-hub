from datetime import datetime
from decimal import Decimal, ROUND_HALF_UP

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    DividendEntry,
    DividendMonth,
    DividendShareholder,
    Ledger,
    MasterDataStatus,
    Store,
    StoreStatus,
    User,
    UserRole,
    new_id,
    utc_now,
)
from app.modules.auth.permissions import ensure_permission, ensure_store_access
from app.modules.auth.router import audit_actor, get_current_user, require_roles
from app.modules.audit.service import write_audit_log
from app.modules.store_ledgers.router import calculate_store_ledger_profit
from app.schemas import (
    ApiEnvelope,
    DividendEntryRead,
    DividendMonthRead,
    DividendMonthUpdate,
    DividendShareholderCreate,
    DividendShareholderRead,
    DividendShareholderUpdate,
    DividendWorkspaceRead,
)

router = APIRouter(prefix="/dividends", tags=["dividends"])
MONEY = Decimal("0.01")


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    if current_user.role != UserRole.ADMIN.value:
        raise HTTPException(status_code=403, detail="仅管理员可操作分红管理")
    return current_user


def ensure_store(session: Session, store_id: str, user: User) -> Store:
    ensure_permission(session, user, "stores.view")
    ensure_store_access(session, user, store_id)
    store = session.get(Store, store_id)
    if store is None or store.status != StoreStatus.ACTIVE.value:
        raise HTTPException(status_code=404, detail="Store not found")
    return store


def month_row(session: Session, store: Store, period: str) -> DividendMonth:
    month = session.scalar(select(DividendMonth).where(DividendMonth.store_id == store.id, DividendMonth.period == period))
    if month is None:
        month = DividendMonth(store_id=store.id, period=period)
        session.add(month)
        session.flush()
    return month


def net_profit(session: Session, store: Store, period: str) -> Decimal:
    return calculate_store_ledger_profit(session, store.id, period).quantize(MONEY)


def month_read(session: Session, store: Store, month: DividendMonth, historical_profit: Decimal, historical_distribution: Decimal, cumulative_capital: Decimal) -> DividendMonthRead:
    entries = list(session.scalars(select(DividendEntry).where(DividendEntry.month_id == month.id).order_by(DividendEntry.created_at.asc())))
    distribution = sum((Decimal(item.amount) for item in entries if item.entry_type == "distribution"), Decimal("0.00"))
    capital = sum((Decimal(item.amount) for item in entries if item.entry_type == "capital"), Decimal("0.00"))
    profit = net_profit(session, store, month.period)
    total_profit = historical_profit + profit
    total_distribution = historical_distribution + distribution
    total_capital = cumulative_capital + capital
    return DividendMonthRead(
        id=month.id, store_id=store.id, period=month.period, net_profit=profit,
        distribution_amount=distribution, capital_amount=capital,
        historical_profit=total_profit, historical_distribution=total_distribution,
        remaining_undistributed=total_profit - total_distribution,
        cumulative_capital=total_capital, reference_ratio=month.reference_ratio,
        suggested_distribution=max(Decimal("0.00"), profit) * Decimal(month.reference_ratio) / Decimal("100"),
        no_distribution=month.no_distribution, no_capital=month.no_capital,
        locked=month.locked,
        entries=[DividendEntryRead.model_validate(item) for item in entries],
    )


def history_rows(session: Session, store: Store, selected_period: str) -> list[DividendMonthRead]:
    periods = set(session.scalars(select(Ledger.period).where(Ledger.store_id == store.id)).all())
    periods.update(session.scalars(select(DividendMonth.period).where(DividendMonth.store_id == store.id)).all())
    periods.add(selected_period)
    ordered = sorted(periods)
    months = {month.period: month for month in session.scalars(select(DividendMonth).where(DividendMonth.store_id == store.id)).all()}
    result: list[DividendMonthRead] = []
    total_profit = total_distribution = total_capital = Decimal("0.00")
    for period in ordered:
        month = months.get(period) or month_row(session, store, period)
        row = month_read(session, store, month, total_profit, total_distribution, total_capital)
        total_profit = row.historical_profit
        total_distribution = row.historical_distribution
        total_capital = row.cumulative_capital
        result.append(row)
    selected_index = next((index for index, row in enumerate(result) if row.period == selected_period), len(result) - 1)
    # 展示期初连续 12 个月，再加当前查看月份；累计值仍基于完整历史计算。
    start_index = max(0, selected_index - 12)
    return result[start_index:selected_index + 1][::-1]


@router.get("/workspace", response_model=ApiEnvelope[DividendWorkspaceRead])
def read_workspace(store_id: str, period: str, session: Session = Depends(get_session), current_user: User = Depends(get_current_user)) -> ApiEnvelope[DividendWorkspaceRead]:
    store = ensure_store(session, store_id, current_user)
    shareholders = list(session.scalars(select(DividendShareholder).where(DividendShareholder.store_id == store_id).order_by(DividendShareholder.status.asc(), DividendShareholder.created_at.asc())))
    current = month_row(session, store, period)
    history = history_rows(session, store, period)
    current = next(row for row in history if row.period == period)
    session.commit()
    return ApiEnvelope(data=DividendWorkspaceRead(store=store, period=period, shareholders=[DividendShareholderRead.model_validate(item) for item in shareholders], current=current, history=history))


@router.get("/shareholders", response_model=ApiEnvelope[list[DividendShareholderRead]])
def list_shareholders(store_id: str, session: Session = Depends(get_session), current_user: User = Depends(get_current_user)) -> ApiEnvelope[list[DividendShareholderRead]]:
    ensure_store(session, store_id, current_user)
    items = session.scalars(select(DividendShareholder).where(DividendShareholder.store_id == store_id).order_by(DividendShareholder.status.asc(), DividendShareholder.created_at.asc())).all()
    return ApiEnvelope(data=[DividendShareholderRead.model_validate(item) for item in items])


@router.post("/shareholders", response_model=ApiEnvelope[DividendShareholderRead], status_code=201)
def create_shareholder(payload: DividendShareholderCreate, session: Session = Depends(get_session), current_user: User = Depends(require_admin)) -> ApiEnvelope[DividendShareholderRead]:
    store = ensure_store(session, payload.store_id, current_user)
    existing_ratio = sum((Decimal(item.holding_ratio) for item in session.scalars(select(DividendShareholder).where(DividendShareholder.store_id == store.id, DividendShareholder.status == MasterDataStatus.ACTIVE.value))), Decimal("0"))
    if existing_ratio + payload.holding_ratio > 100:
        raise HTTPException(status_code=422, detail="启用股东持股比例不能超过100%")
    item = DividendShareholder(**payload.model_dump())
    session.add(item)
    write_audit_log(session, actor=audit_actor(current_user), action="dividend_shareholder.create", resource_type="dividend_shareholder", resource_id=item.id, summary=f"新增股东：{item.name}")
    session.commit()
    session.refresh(item)
    return ApiEnvelope(data=DividendShareholderRead.model_validate(item))


@router.patch("/shareholders/{shareholder_id}", response_model=ApiEnvelope[DividendShareholderRead])
def update_shareholder(shareholder_id: str, payload: DividendShareholderUpdate, session: Session = Depends(get_session), current_user: User = Depends(require_admin)) -> ApiEnvelope[DividendShareholderRead]:
    item = session.get(DividendShareholder, shareholder_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Shareholder not found")
    ensure_store(session, item.store_id, current_user)
    changes = payload.model_dump(exclude_unset=True)
    if "holding_ratio" in changes and item.status == MasterDataStatus.ACTIVE.value:
        other = sum((Decimal(row.holding_ratio) for row in session.scalars(select(DividendShareholder).where(DividendShareholder.store_id == item.store_id, DividendShareholder.id != item.id, DividendShareholder.status == MasterDataStatus.ACTIVE.value))), Decimal("0"))
        if other + changes["holding_ratio"] > 100:
            raise HTTPException(status_code=422, detail="启用股东持股比例不能超过100%")
    for field, value in changes.items():
        setattr(item, field, value)
    write_audit_log(session, actor=audit_actor(current_user), action="dividend_shareholder.update", resource_type="dividend_shareholder", resource_id=item.id, summary=f"更新股东：{item.name}", metadata=changes)
    session.commit()
    session.refresh(item)
    return ApiEnvelope(data=DividendShareholderRead.model_validate(item))


@router.put("/months/{store_id}/{period}", response_model=ApiEnvelope[DividendWorkspaceRead])
def update_month(store_id: str, period: str, payload: DividendMonthUpdate, session: Session = Depends(get_session), current_user: User = Depends(require_admin)) -> ApiEnvelope[DividendWorkspaceRead]:
    store = ensure_store(session, store_id, current_user)
    month = month_row(session, store, period)
    if month.locked:
        raise HTTPException(status_code=409, detail="月份已锁定，请先解锁")
    changes = payload.model_dump(exclude_unset=True)
    for field in ("reference_ratio", "no_distribution", "no_capital"):
        if field in changes:
            setattr(month, field, changes[field])
    if any(field in changes for field in ("reference_ratio", "no_distribution", "no_capital")):
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="dividend_month.update",
            resource_type="dividend_month",
            resource_id=month.id,
            summary=f"更新分红月份：{period}",
            metadata={field: changes[field] for field in ("reference_ratio", "no_distribution", "no_capital") if field in changes},
        )
    shareholders = {item.id: item for item in session.scalars(select(DividendShareholder).where(DividendShareholder.store_id == store_id, DividendShareholder.status == MasterDataStatus.ACTIVE.value))}
    if (payload.distribution is not None or payload.capital is not None) and shareholders and sum((Decimal(item.holding_ratio) for item in shareholders.values()), Decimal("0")) != Decimal("100"):
        raise HTTPException(status_code=422, detail="启用股东持股比例合计必须等于100%")
    for entry_type, rows in (("distribution", payload.distribution), ("capital", payload.capital)):
        if rows is None:
            continue
        total = sum((row.amount for row in rows), Decimal("0.00")).quantize(MONEY, rounding=ROUND_HALF_UP)
        session.query(DividendEntry).filter(DividendEntry.month_id == month.id, DividendEntry.entry_type == entry_type).delete(synchronize_session=False)
        for row in rows:
            shareholder = shareholders.get(row.shareholder_id or "")
            if shareholder is None:
                raise HTTPException(status_code=422, detail="股东不存在或已停用")
            session.add(DividendEntry(month_id=month.id, entry_type=entry_type, shareholder_id=shareholder.id, shareholder_name=shareholder.name, holding_ratio=shareholder.holding_ratio, amount=row.amount, remark=row.remark))
        write_audit_log(session, actor=audit_actor(current_user), action=f"dividend_{entry_type}.save", resource_type="dividend_month", resource_id=month.id, summary=f"保存{period}{entry_type}：{total}")
    session.commit()
    return read_workspace(store_id, period, session, current_user)


@router.post("/months/{store_id}/{period}/lock", response_model=ApiEnvelope[DividendWorkspaceRead])
def lock_month(store_id: str, period: str, session: Session = Depends(get_session), current_user: User = Depends(require_admin)) -> ApiEnvelope[DividendWorkspaceRead]:
    store = ensure_store(session, store_id, current_user)
    month = month_row(session, store, period)
    month.locked = True
    month.locked_at = utc_now()
    month.locked_by = audit_actor(current_user)
    write_audit_log(session, actor=audit_actor(current_user), action="dividend_month.lock", resource_type="dividend_month", resource_id=month.id, summary=f"锁定分红月份：{period}")
    session.commit()
    return read_workspace(store_id, period, session, current_user)


@router.post("/months/{store_id}/{period}/unlock", response_model=ApiEnvelope[DividendWorkspaceRead])
def unlock_month(store_id: str, period: str, reason: str, session: Session = Depends(get_session), current_user: User = Depends(require_admin)) -> ApiEnvelope[DividendWorkspaceRead]:
    if not reason.strip():
        raise HTTPException(status_code=422, detail="解锁原因不能为空")
    store = ensure_store(session, store_id, current_user)
    month = month_row(session, store, period)
    month.locked = False
    write_audit_log(session, actor=audit_actor(current_user), action="dividend_month.unlock", resource_type="dividend_month", resource_id=month.id, summary=f"解锁分红月份：{period}", metadata={"reason": reason})
    session.commit()
    return read_workspace(store_id, period, session, current_user)
