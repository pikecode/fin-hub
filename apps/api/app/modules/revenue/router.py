from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    BankTransaction,
    Ledger,
    LedgerStatus,
    MasterDataStatus,
    RevenueBankMatch,
    RevenueBankMatchRecord,
    RevenueChannel,
    RevenueRecord,
    User,
)
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import (
    ensure_permission,
    ensure_store_access,
    scoped_store_condition,
)
from app.modules.auth.router import audit_actor, get_current_user
from app.modules.common import paginate
from app.schemas import (
    ApiEnvelope,
    Page,
    RevenueChannelCreate,
    RevenueChannelRead,
    RevenueChannelUpdate,
    RevenueRecordCreate,
    RevenueRecordRead,
    RevenueRecordUpdate,
)

router = APIRouter(prefix="/revenue-records", tags=["revenue"])
channels_router = APIRouter(prefix="/revenue-channels", tags=["revenue"])


def period_from_revenue_date(revenue_date) -> str:
    return revenue_date.strftime("%Y-%m")


def ensure_open_or_create_ledger(session: Session, store_id: str, period: str) -> None:
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period))
    if ledger is None:
        session.add(Ledger(store_id=store_id, period=period))
        session.flush()
        return
    if ledger.status == LedgerStatus.CLOSED.value:
        raise HTTPException(status_code=409, detail="Ledger is closed")


def ensure_open_ledger(session: Session, store_id: str, period: str) -> None:
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period))
    if ledger is None:
        raise HTTPException(status_code=404, detail="Ledger not found")
    if ledger.status == LedgerStatus.CLOSED.value:
        raise HTTPException(status_code=409, detail="Ledger is closed")


def normalize_revenue_assignment(session: Session, data: dict) -> dict:
    period = period_from_revenue_date(data["revenue_date"])
    if data.get("ledger_period") and data["ledger_period"] != period:
        raise HTTPException(status_code=422, detail="Ledger period must match revenue date month")
    data["ledger_period"] = period
    ensure_open_or_create_ledger(session, data["store_id"], period)
    return data


def ensure_active_channel(session: Session, channel_name: str) -> None:
    channel = session.scalar(select(RevenueChannel).where(RevenueChannel.name == channel_name))
    if channel is None:
        raise HTTPException(status_code=404, detail="Revenue channel not found")
    if channel.status != MasterDataStatus.ACTIVE.value:
        raise HTTPException(status_code=409, detail="Revenue channel is inactive")


@channels_router.get("", response_model=ApiEnvelope[Page[RevenueChannelRead]])
def list_revenue_channels(
    page: int = 1,
    page_size: int = 100,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[Page[RevenueChannelRead]]:
    ensure_permission(session, current_user, "revenue.view")
    query = select(RevenueChannel).order_by(RevenueChannel.sort_order.asc(), RevenueChannel.created_at.asc())
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@channels_router.post("", response_model=ApiEnvelope[RevenueChannelRead], status_code=201)
def create_revenue_channel(
    payload: RevenueChannelCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[RevenueChannelRead]:
    ensure_permission(session, current_user, "revenue.manage")
    channel = RevenueChannel(**payload.model_dump())
    session.add(channel)
    try:
        session.flush()
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="revenue_channel.create",
            resource_type="revenue_channel",
            resource_id=channel.id,
            summary=f"新增收入渠道：{channel.name}",
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Revenue channel already exists") from exc
    session.refresh(channel)
    return ApiEnvelope(data=channel)


@channels_router.patch("/{channel_id}", response_model=ApiEnvelope[RevenueChannelRead])
def update_revenue_channel(
    channel_id: str,
    payload: RevenueChannelUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[RevenueChannelRead]:
    ensure_permission(session, current_user, "revenue.manage")
    channel = session.get(RevenueChannel, channel_id)
    if channel is None:
        raise HTTPException(status_code=404, detail="Revenue channel not found")

    changes = payload.model_dump(exclude_unset=True)
    name = changes.get("name", channel.name)
    exists = session.scalar(
        select(RevenueChannel).where(RevenueChannel.id != channel.id, RevenueChannel.name == name)
    )
    if exists is not None:
        raise HTTPException(status_code=409, detail="Revenue channel already exists")
    for field, value in changes.items():
        setattr(channel, field, value.value if hasattr(value, "value") else value)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="revenue_channel.update",
        resource_type="revenue_channel",
        resource_id=channel.id,
        summary=f"更新收入渠道：{channel.name}",
        metadata=changes,
    )
    session.commit()
    session.refresh(channel)
    return ApiEnvelope(data=channel)


@router.get("", response_model=ApiEnvelope[Page[RevenueRecordRead]])
def list_revenue_records(
    store_id: str | None = None,
    ledger_period: str | None = None,
    channel: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[Page[RevenueRecordRead]]:
    ensure_permission(session, current_user, "revenue.view")
    query = select(RevenueRecord).order_by(RevenueRecord.revenue_date.desc(), RevenueRecord.created_at.desc())
    if store_id:
        ensure_store_access(session, current_user, store_id)
        query = query.where(RevenueRecord.store_id == store_id)
    else:
        query = query.where(scoped_store_condition(session, current_user, RevenueRecord.store_id))
    if ledger_period:
        query = query.where(RevenueRecord.ledger_period == ledger_period)
    if channel:
        query = query.where(RevenueRecord.channel == channel)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.post("", response_model=ApiEnvelope[RevenueRecordRead], status_code=201)
def create_revenue_record(
    payload: RevenueRecordCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[RevenueRecordRead]:
    ensure_permission(session, current_user, "revenue.manage")
    ensure_store_access(session, current_user, payload.store_id)
    ensure_active_channel(session, payload.channel)
    record = RevenueRecord(**normalize_revenue_assignment(session, payload.model_dump()))
    session.add(record)
    try:
        session.flush()
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="revenue_record.create",
            resource_type="revenue_record",
            resource_id=record.id,
            summary=f"新增营业收入：{record.channel} {record.gross_amount}",
            metadata={
                "store_id": record.store_id,
                "ledger_period": record.ledger_period,
                "revenue_date": record.revenue_date,
            },
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Revenue record already exists") from exc
    session.refresh(record)
    return ApiEnvelope(data=record)


@router.patch("/{record_id}", response_model=ApiEnvelope[RevenueRecordRead])
def update_revenue_record(
    record_id: str,
    payload: RevenueRecordUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[RevenueRecordRead]:
    ensure_permission(session, current_user, "revenue.manage")
    record = session.get(RevenueRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Revenue record not found")
    ensure_store_access(session, current_user, record.store_id)
    ensure_open_ledger(session, record.store_id, record.ledger_period)

    changes = payload.model_dump(exclude_unset=True)
    target_store_id = changes.get("store_id", record.store_id)
    ensure_store_access(session, current_user, target_store_id)
    target_revenue_date = changes.get("revenue_date", record.revenue_date)
    target_period = period_from_revenue_date(target_revenue_date)
    if changes.get("ledger_period") and changes["ledger_period"] != target_period:
        raise HTTPException(status_code=422, detail="Ledger period must match revenue date month")
    changes["store_id"] = target_store_id
    changes["ledger_period"] = target_period
    ensure_open_or_create_ledger(session, target_store_id, target_period)
    if "channel" in changes and changes["channel"] is not None:
        ensure_active_channel(session, changes["channel"])
    for field, value in changes.items():
        setattr(record, field, value)
    try:
        session.flush()
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="revenue_record.update",
            resource_type="revenue_record",
            resource_id=record.id,
            summary=f"更新营业收入：{record.channel} {record.gross_amount}",
            metadata={"updated_fields": sorted(changes.keys())},
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Revenue record already exists") from exc
    session.refresh(record)
    return ApiEnvelope(data=record)


@router.delete("/{record_id}", response_model=ApiEnvelope[RevenueRecordRead])
def delete_revenue_record(
    record_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[RevenueRecordRead]:
    ensure_permission(session, current_user, "revenue.manage")
    record = session.get(RevenueRecord, record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="Revenue record not found")
    ensure_store_access(session, current_user, record.store_id)
    ensure_open_ledger(session, record.store_id, record.ledger_period)
    existing_exact_match = session.scalar(
        select(RevenueBankMatch)
        .join(
            RevenueBankMatchRecord,
            RevenueBankMatchRecord.revenue_bank_match_id == RevenueBankMatch.id,
        )
        .where(
            RevenueBankMatchRecord.revenue_record_id == record.id,
            RevenueBankMatch.status != "rejected",
        )
        .limit(1)
    )
    existing_legacy_match = session.scalar(
        select(RevenueBankMatch)
        .join(BankTransaction, RevenueBankMatch.bank_transaction_id == BankTransaction.id)
        .where(
            BankTransaction.store_id == record.store_id,
            BankTransaction.ledger_period == record.ledger_period,
            RevenueBankMatch.channel == record.channel,
            RevenueBankMatch.revenue_start_date <= record.revenue_date,
            RevenueBankMatch.revenue_end_date >= record.revenue_date,
            RevenueBankMatch.status != "rejected",
            ~select(RevenueBankMatchRecord.id)
            .where(RevenueBankMatchRecord.revenue_bank_match_id == RevenueBankMatch.id)
            .exists(),
        )
        .limit(1)
    )
    if existing_exact_match is not None or existing_legacy_match is not None:
        raise HTTPException(status_code=409, detail="Revenue record already matched")

    deleted = RevenueRecordRead.model_validate(record)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="revenue_record.delete",
        resource_type="revenue_record",
        resource_id=record.id,
        summary=f"删除营业收入：{record.channel} {record.gross_amount}",
        metadata={
            "store_id": record.store_id,
            "ledger_period": record.ledger_period,
            "revenue_date": record.revenue_date,
        },
    )
    session.delete(record)
    session.commit()
    return ApiEnvelope(data=deleted)
