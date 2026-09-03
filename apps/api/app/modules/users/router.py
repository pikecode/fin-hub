from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.core.security import hash_password
from app.models import (
    Store,
    StoreGroup,
    User,
    UserStoreGroupPermission,
    UserStorePermission,
)
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import (
    effective_permissions,
    effective_store_ids,
    role_exists,
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
        store_group_ids=list(
            session.scalars(
                select(UserStoreGroupPermission.group_id).where(
                    UserStoreGroupPermission.user_id == user.id
                )
            )
        ),
    )


def validate_store_ids(session: Session, store_ids: list[str]) -> None:
    if not store_ids:
        return
    existing = set(session.scalars(select(Store.id).where(Store.id.in_(store_ids))))
    missing = sorted(set(store_ids) - existing)
    if missing:
        raise HTTPException(status_code=422, detail=f"Unknown stores: {', '.join(missing)}")


def validate_store_group_ids(session: Session, store_group_ids: list[str]) -> None:
    if not store_group_ids:
        return
    existing = set(session.scalars(select(StoreGroup.id).where(StoreGroup.id.in_(store_group_ids))))
    missing = sorted(set(store_group_ids) - existing)
    if missing:
        raise HTTPException(status_code=422, detail=f"Unknown store groups: {', '.join(missing)}")


def validate_role(session: Session, role_key: str) -> None:
    if not role_exists(session, role_key):
        raise HTTPException(status_code=422, detail=f"Unknown role: {role_key}")


def replace_user_store_permissions(
    session: Session,
    user: User,
    store_ids: list[str] | None = None,
) -> None:
    if store_ids is not None:
        validate_store_ids(session, store_ids)
        session.query(UserStorePermission).filter(UserStorePermission.user_id == user.id).delete()
        for store_id in sorted(set(store_ids)):
            session.add(UserStorePermission(user_id=user.id, store_id=store_id))


def replace_user_store_group_permissions(
    session: Session,
    user: User,
    store_group_ids: list[str] | None = None,
) -> None:
    if store_group_ids is not None:
        validate_store_group_ids(session, store_group_ids)
        session.query(UserStoreGroupPermission).filter(UserStoreGroupPermission.user_id == user.id).delete()
        for group_id in sorted(set(store_group_ids)):
            session.add(UserStoreGroupPermission(user_id=user.id, group_id=group_id))


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
    validate_role(session, payload.role)
    user = User(
        username=payload.username,
        display_name=payload.display_name,
        password_hash=hash_password(payload.password),
        role=payload.role,
    )
    session.add(user)
    try:
        session.flush()
        replace_user_store_permissions(session, user, payload.store_ids)
        replace_user_store_group_permissions(session, user, payload.store_group_ids)
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="user.create",
            resource_type="user",
            resource_id=user.id,
            summary=f"新增用户：{user.username}",
            metadata={
                "role": user.role,
                "store_ids": payload.store_ids,
                "store_group_ids": payload.store_group_ids,
            },
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
    store_ids = changes.pop("store_ids", None)
    store_group_ids = changes.pop("store_group_ids", None)
    role = changes.get("role")
    if role is not None:
        validate_role(session, role)
    for field, value in changes.items():
        setattr(user, field, value)
    if password:
        user.password_hash = hash_password(password)
    replace_user_store_permissions(session, user, store_ids)
    replace_user_store_group_permissions(session, user, store_group_ids)

    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="user.update",
        resource_type="user",
        resource_id=user.id,
        summary=f"更新用户：{user.username}",
        metadata={
            **{key: value for key, value in changes.items()},
            **({"store_ids": store_ids} if store_ids is not None else {}),
            **({"store_group_ids": store_group_ids} if store_group_ids is not None else {}),
        },
    )
    session.commit()
    session.refresh(user)
    return ApiEnvelope(data=serialize_user(session, user))
