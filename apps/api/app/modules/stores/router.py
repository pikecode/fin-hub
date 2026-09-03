from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import Store, StoreGroup, User
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import (
    ensure_permission,
    ensure_store_access,
    scoped_store_condition,
)
from app.modules.auth.router import audit_actor, get_current_user, require_permission
from app.modules.common import paginate
from app.schemas import (
    ApiEnvelope,
    Page,
    StoreCreate,
    StoreGroupCreate,
    StoreGroupRead,
    StoreGroupUpdate,
    StoreRead,
    StoreUpdate,
)

router = APIRouter(prefix="/stores", tags=["stores"])


def ensure_store_group_exists(session: Session, group_id: str | None) -> None:
    if group_id is not None and session.get(StoreGroup, group_id) is None:
        raise HTTPException(status_code=404, detail="Store group not found")


def store_group_read(session: Session, group: StoreGroup) -> StoreGroupRead:
    return StoreGroupRead(
        **{key: getattr(group, key) for key in ("id", "name", "sort_order", "created_at", "updated_at")},
        store_count=session.scalar(select(func.count(Store.id)).where(Store.group_id == group.id)) or 0,
    )


@router.get("/groups", response_model=ApiEnvelope[list[StoreGroupRead]])
def list_store_groups(
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[list[StoreGroupRead]]:
    ensure_permission(session, current_user, "stores.view")
    groups = session.scalars(
        select(StoreGroup).order_by(StoreGroup.sort_order.asc(), StoreGroup.created_at.asc())
    ).all()
    return ApiEnvelope(data=[store_group_read(session, group) for group in groups])


@router.post("/groups", response_model=ApiEnvelope[StoreGroupRead], status_code=201)
def create_store_group(
    payload: StoreGroupCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("stores.manage")),
) -> ApiEnvelope[StoreGroupRead]:
    group = StoreGroup(**payload.model_dump())
    session.add(group)
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Store group already exists") from exc
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="store_group.create",
        resource_type="store_group",
        resource_id=group.id,
        summary=f"新增门店分组：{group.name}",
    )
    session.commit()
    session.refresh(group)
    return ApiEnvelope(data=store_group_read(session, group))


@router.patch("/groups/{group_id}", response_model=ApiEnvelope[StoreGroupRead])
def update_store_group(
    group_id: str,
    payload: StoreGroupUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("stores.manage")),
) -> ApiEnvelope[StoreGroupRead]:
    group = session.get(StoreGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Store group not found")
    changes = payload.model_dump(exclude_unset=True)
    for field, value in changes.items():
        setattr(group, field, value)
    try:
        session.flush()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Store group already exists") from exc
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="store_group.update",
        resource_type="store_group",
        resource_id=group.id,
        summary=f"更新门店分组：{group.name}",
        metadata=changes,
    )
    session.commit()
    session.refresh(group)
    return ApiEnvelope(data=store_group_read(session, group))


@router.delete("/groups/{group_id}", response_model=ApiEnvelope[dict[str, bool]])
def delete_store_group(
    group_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("stores.manage")),
) -> ApiEnvelope[dict[str, bool]]:
    group = session.get(StoreGroup, group_id)
    if group is None:
        raise HTTPException(status_code=404, detail="Store group not found")
    group_name = group.name
    session.delete(group)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="store_group.delete",
        resource_type="store_group",
        resource_id=group_id,
        summary=f"删除门店分组：{group_name}（门店转为未分组）",
    )
    session.commit()
    return ApiEnvelope(data={"ok": True})


@router.get("", response_model=ApiEnvelope[Page[StoreRead]])
def list_stores(
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[Page[StoreRead]]:
    ensure_permission(session, current_user, "stores.view")
    query = select(Store).order_by(Store.created_at.desc())
    query = query.where(scoped_store_condition(session, current_user, Store.id))
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.post("", response_model=ApiEnvelope[StoreRead], status_code=201)
def create_store(
    payload: StoreCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[StoreRead]:
    ensure_permission(session, current_user, "stores.manage")
    ensure_store_group_exists(session, payload.group_id)
    store = Store(**payload.model_dump())
    session.add(store)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="store.create",
        resource_type="store",
        resource_id=store.id,
        summary=f"新增门店：{store.name}",
    )
    session.commit()
    session.refresh(store)
    return ApiEnvelope(data=store)


@router.patch("/{store_id}", response_model=ApiEnvelope[StoreRead])
def update_store(
    store_id: str,
    payload: StoreUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(get_current_user),
) -> ApiEnvelope[StoreRead]:
    ensure_permission(session, current_user, "stores.manage")
    store = session.get(Store, store_id)
    if store is None:
        raise HTTPException(status_code=404, detail="Store not found")
    ensure_store_access(session, current_user, store.id)

    changes = payload.model_dump(exclude_unset=True)
    if "group_id" in changes:
        ensure_store_group_exists(session, changes["group_id"])
    for field, value in changes.items():
        setattr(store, field, value)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="store.update",
        resource_type="store",
        resource_id=store.id,
        summary=f"更新门店：{store.name}",
        metadata=changes,
    )
    session.commit()
    session.refresh(store)
    return ApiEnvelope(data=store)
