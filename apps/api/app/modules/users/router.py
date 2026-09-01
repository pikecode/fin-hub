from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.core.security import hash_password
from app.models import Store, User, UserPermission, UserRole, UserStorePermission
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import (
    effective_permissions,
    effective_store_ids,
    validate_permissions,
)
from app.modules.auth.router import audit_actor, require_permission
from app.modules.common import paginate
from app.schemas import ApiEnvelope, Page, UserCreate, UserRead, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


def serialize_user(session: Session, user: User) -> UserRead:
    return UserRead(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
        status=user.status,
        last_login_at=user.last_login_at,
        created_at=user.created_at,
        updated_at=user.updated_at,
        permissions=effective_permissions(session, user),
        store_ids=effective_store_ids(session, user),
    )


def validate_store_ids(session: Session, store_ids: list[str]) -> None:
    if not store_ids:
        return
    existing = set(session.scalars(select(Store.id).where(Store.id.in_(store_ids))))
    missing = sorted(set(store_ids) - existing)
    if missing:
        raise HTTPException(status_code=422, detail=f"Unknown stores: {', '.join(missing)}")


def replace_user_permissions(
    session: Session,
    user: User,
    permissions: list[str] | None = None,
    store_ids: list[str] | None = None,
) -> None:
    if permissions is not None:
        validate_permissions(permissions)
        user.permissions_configured = True
        session.query(UserPermission).filter(UserPermission.user_id == user.id).delete()
        for permission in sorted(set(permissions)):
            session.add(UserPermission(user_id=user.id, permission=permission))
    if store_ids is not None:
        validate_store_ids(session, store_ids)
        session.query(UserStorePermission).filter(UserStorePermission.user_id == user.id).delete()
        for store_id in sorted(set(store_ids)):
            session.add(UserStorePermission(user_id=user.id, store_id=store_id))


@router.get("", response_model=ApiEnvelope[Page[UserRead]])
def list_users(
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("users.view")),
) -> ApiEnvelope[Page[UserRead]]:
    query = select(User).order_by(User.created_at.desc())
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(
        data=Page(
            items=[serialize_user(session, user) for user in items],
            total=total,
            page=page,
            page_size=page_size,
        )
    )


@router.post("", response_model=ApiEnvelope[UserRead], status_code=201)
def create_user(
    payload: UserCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("users.manage")),
) -> ApiEnvelope[UserRead]:
    user = User(
        username=payload.username,
        display_name=payload.display_name,
        password_hash=hash_password(payload.password),
        role=payload.role.value,
    )
    session.add(user)
    try:
        session.flush()
        replace_user_permissions(session, user, payload.permissions, payload.store_ids)
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="user.create",
            resource_type="user",
            resource_id=user.id,
            summary=f"新增用户：{user.username}",
            metadata={"role": user.role, "permissions": payload.permissions, "store_ids": payload.store_ids},
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Username already exists") from exc
    session.refresh(user)
    return ApiEnvelope(data=serialize_user(session, user))


@router.patch("/{user_id}", response_model=ApiEnvelope[UserRead])
def update_user(
    user_id: str,
    payload: UserUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("users.manage")),
) -> ApiEnvelope[UserRead]:
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    changes = payload.model_dump(exclude_unset=True)
    password = changes.pop("password", None)
    permissions = changes.pop("permissions", None)
    store_ids = changes.pop("store_ids", None)
    for field, value in changes.items():
        setattr(user, field, value.value if isinstance(value, UserRole) else value)
    if password:
        user.password_hash = hash_password(password)
    replace_user_permissions(session, user, permissions, store_ids)

    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="user.update",
        resource_type="user",
        resource_id=user.id,
        summary=f"更新用户：{user.username}",
        metadata={
            **{key: value for key, value in changes.items()},
            **({"permissions": permissions} if permissions is not None else {}),
            **({"store_ids": store_ids} if store_ids is not None else {}),
        },
    )
    session.commit()
    session.refresh(user)
    return ApiEnvelope(data=serialize_user(session, user))
