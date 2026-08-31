from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import Store, User
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import ensure_permission, ensure_store_access, scoped_store_condition
from app.modules.auth.router import audit_actor, get_current_user
from app.modules.common import paginate
from app.schemas import ApiEnvelope, Page, StoreCreate, StoreRead, StoreUpdate

router = APIRouter(prefix="/stores", tags=["stores"])


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
