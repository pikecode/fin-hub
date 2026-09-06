from fastapi import APIRouter, Depends, HTTPException
from datetime import UTC, datetime

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
    RevenueChannelStoreLink,
    RevenueRecord,
    User,
    Store,
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

DEFAULT_REVENUE_CHANNELS: tuple[tuple[str, int, bool], ...] = (
    ("美团团购", 10, True),
    ("美团点评买单", 20, True),
    ("抖音团购", 30, True),
    ("扫码收款", 40, True),
    ("商场代金券", 50, False),
    ("现金收款", 60, False),
    ("淘宝团购", 70, True),
)


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
    ensure_default_revenue_channels(session)
    channel = session.scalar(select(RevenueChannel).where(RevenueChannel.name == channel_name))
    if channel is None:
        raise HTTPException(status_code=404, detail="Revenue channel not found")
    if channel.status != MasterDataStatus.ACTIVE.value or channel.deleted_at is not None:
        raise HTTPException(status_code=409, detail="Revenue channel is inactive")


def ensure_channel_for_store(session: Session, channel_name: str, store_id: str) -> None:
    ensure_active_channel(session, channel_name)
    channel = session.scalar(select(RevenueChannel).where(RevenueChannel.name == channel_name))
    if channel is None:
        raise HTTPException(status_code=404, detail="Revenue channel not found")
    if channel.scope_mode == "all_stores":
        return
    allowed_store_ids = set(
        session.scalars(
            select(RevenueChannelStoreLink.store_id).where(RevenueChannelStoreLink.channel_id == channel.id)
        ).all()
    )
    if store_id not in allowed_store_ids:
        raise HTTPException(status_code=409, detail="Revenue channel is not enabled for the store")


def ensure_channel_store_scope(session: Session, channel: RevenueChannel, store_ids: list[str]) -> None:
    if channel.scope_mode == "all_stores":
        return
    allowed_store_ids = set(
        session.scalars(
            select(RevenueChannelStoreLink.store_id).where(RevenueChannelStoreLink.channel_id == channel.id)
        ).all()
    )
    if not allowed_store_ids:
        raise HTTPException(status_code=409, detail="Revenue channel has no enabled stores")
    requested_store_ids = set(store_ids)
    if not requested_store_ids.issubset(allowed_store_ids):
        raise HTTPException(status_code=409, detail="Revenue channel is not enabled for the selected store")


def revenue_channel_store_ids(session: Session, channel_id: str) -> list[str]:
    return list(
        session.scalars(
            select(RevenueChannelStoreLink.store_id)
            .where(RevenueChannelStoreLink.channel_id == channel_id)
            .order_by(RevenueChannelStoreLink.created_at.asc())
        ).all()
    )


def revenue_channel_read(session: Session, channel: RevenueChannel) -> RevenueChannelRead:
    return RevenueChannelRead(
        id=channel.id,
        name=channel.name,
        sort_order=channel.sort_order,
        requires_bank_match=channel.requires_bank_match,
        scope_mode=channel.scope_mode,
        status=channel.status,
        deleted_at=channel.deleted_at,
        deleted_by=channel.deleted_by,
        created_at=channel.created_at,
        updated_at=channel.updated_at,
        store_ids=[] if channel.scope_mode == "all_stores" else revenue_channel_store_ids(session, channel.id),
    )


def ensure_default_revenue_channels(session: Session) -> bool:
    existing_names = set(session.scalars(select(RevenueChannel.name)).all())
    created = False
    for name, sort_order, requires_bank_match in DEFAULT_REVENUE_CHANNELS:
        if name in existing_names:
            continue
        session.add(
            RevenueChannel(
                name=name,
                sort_order=sort_order,
                requires_bank_match=requires_bank_match,
                scope_mode="all_stores",
            )
        )
        created = True
    if created:
        session.flush()
    return created


def sync_channel_store_links(session: Session, channel: RevenueChannel, store_ids: list[str]) -> None:
    session.query(RevenueChannelStoreLink).filter(RevenueChannelStoreLink.channel_id == channel.id).delete(
        synchronize_session=False
    )
    for store_id in dict.fromkeys(store_ids):
        if session.get(Store, store_id) is None:
            raise HTTPException(status_code=404, detail=f"Store not found: {store_id}")
        session.add(RevenueChannelStoreLink(channel_id=channel.id, store_id=store_id))


@channels_router.get("", response_model=ApiEnvelope[Page[RevenueChannelRead]])
def list_revenue_channels(
    store_id: str | None = None,
    page: int = 1,
    page_size: int = 100,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[Page[RevenueChannelRead]]:
    ensure_permission(session, current_user, "revenue.view")
    seeded = ensure_default_revenue_channels(session)
    if seeded:
        session.commit()
    query = (
        select(RevenueChannel)
        .where(RevenueChannel.deleted_at.is_(None))
        .order_by(RevenueChannel.sort_order.asc(), RevenueChannel.created_at.asc())
    )
    if store_id:
        ensure_store_access(session, current_user, store_id)
        query = query.where(
            (RevenueChannel.scope_mode == "all_stores")
            | (
                RevenueChannel.id.in_(
                    select(RevenueChannelStoreLink.channel_id).where(RevenueChannelStoreLink.store_id == store_id)
                )
            )
        )
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=[revenue_channel_read(session, item) for item in items], total=total, page=page, page_size=page_size))


@channels_router.post("", response_model=ApiEnvelope[RevenueChannelRead], status_code=201)
def create_revenue_channel(
    payload: RevenueChannelCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[RevenueChannelRead]:
    ensure_permission(session, current_user, "revenue.manage")
    data = payload.model_dump()
    scope_mode = data.pop("scope_mode", "all_stores")
    store_ids = data.pop("store_ids", [])
    if scope_mode == "selected_stores" and not store_ids:
        raise HTTPException(status_code=422, detail="Store ids are required for selected stores scope")
    channel = RevenueChannel(**data, scope_mode=scope_mode)
    session.add(channel)
    try:
        session.flush()
        if scope_mode == "selected_stores":
            sync_channel_store_links(session, channel, store_ids)
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="revenue_channel.create",
            resource_type="revenue_channel",
            resource_id=channel.id,
            summary=f"新增收入渠道：{channel.name}",
            metadata={"scope_mode": scope_mode, "store_ids": store_ids},
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Revenue channel already exists") from exc
    session.refresh(channel)
    return ApiEnvelope(data=revenue_channel_read(session, channel))


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
    if channel.deleted_at is not None:
        raise HTTPException(status_code=409, detail="Revenue channel has been deleted")

    changes = payload.model_dump(exclude_unset=True)
    store_ids = changes.pop("store_ids", None)
    name = changes.get("name", channel.name)
    exists = session.scalar(
        select(RevenueChannel).where(RevenueChannel.id != channel.id, RevenueChannel.name == name)
    )
    if exists is not None:
        raise HTTPException(status_code=409, detail="Revenue channel already exists")
    for field, value in changes.items():
        setattr(channel, field, value.value if hasattr(value, "value") else value)
    if changes.get("scope_mode") == "all_stores":
        store_ids = []
    if store_ids is not None:
        if changes.get("scope_mode", channel.scope_mode) == "selected_stores" and not store_ids:
            raise HTTPException(status_code=422, detail="Store ids are required for selected stores scope")
        sync_channel_store_links(session, channel, store_ids)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="revenue_channel.update",
        resource_type="revenue_channel",
        resource_id=channel.id,
        summary=f"更新收入渠道：{channel.name}",
        metadata={**changes, "store_ids": store_ids},
    )
    session.commit()
    session.refresh(channel)
    return ApiEnvelope(data=revenue_channel_read(session, channel))


@channels_router.delete("/{channel_id}", response_model=ApiEnvelope[dict[str, bool]])
def delete_revenue_channel(
    channel_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[dict[str, bool]]:
    ensure_permission(session, current_user, "revenue.manage")
    channel = session.get(RevenueChannel, channel_id)
    if channel is None:
        raise HTTPException(status_code=404, detail="Revenue channel not found")
    if channel.deleted_at is not None:
        return ApiEnvelope(data={"ok": True})
    channel_name = channel.name
    channel.deleted_at = datetime.now(UTC).replace(tzinfo=None)
    channel.deleted_by = audit_actor(current_user)
    channel.status = MasterDataStatus.INACTIVE.value
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="revenue_channel.delete",
        resource_type="revenue_channel",
        resource_id=channel.id,
        summary=f"删除收入渠道：{channel_name}",
    )
    session.commit()
    return ApiEnvelope(data={"ok": True})


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
    ensure_channel_for_store(session, payload.channel, payload.store_id)
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
        ensure_channel_for_store(session, changes["channel"], target_store_id)
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
