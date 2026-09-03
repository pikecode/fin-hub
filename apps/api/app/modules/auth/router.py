from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.core.security import (
    create_session_token,
    decode_session_token,
    hash_password,
    verify_password,
)
from app.models import Store, User, UserRole, UserStatus, UserStoreGroupPermission, utc_now
from app.modules.auth.permissions import (
    effective_permissions,
    effective_store_ids,
    ensure_permission,
    scoped_store_condition,
)
from app.schemas import ApiEnvelope, ChangePasswordRequest, CurrentUser, LoginRequest, StoreRead

SESSION_COOKIE_NAME = "fin_hub_session"

router = APIRouter(prefix="/auth", tags=["auth"])


def to_current_user(session: Session, user: User) -> CurrentUser:
    return CurrentUser(
        id=user.id,
        username=user.username,
        display_name=user.display_name,
        role=user.role,
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


def get_current_user(
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    session: Session = Depends(get_session),
) -> User:
    if not session_token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_session_token(session_token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid session")
    user = session.get(User, payload.get("sub"))
    if user is None or user.status != UserStatus.ACTIVE.value:
        raise HTTPException(status_code=401, detail="Invalid user")
    return user


def get_optional_current_user(
    session_token: str | None = Cookie(default=None, alias=SESSION_COOKIE_NAME),
    session: Session = Depends(get_session),
) -> User | None:
    if not session_token:
        return None
    payload = decode_session_token(session_token)
    if payload is None:
        return None
    user = session.get(User, payload.get("sub"))
    if user is None or user.status != UserStatus.ACTIVE.value:
        return None
    return user


def audit_actor(user: User | None, fallback: str = "admin") -> str:
    return user.username if user is not None else fallback


def require_roles(*roles: UserRole):
    def dependency(current_user: User = Depends(get_current_user)) -> User:
        if roles and current_user.role not in {role.value for role in roles}:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return current_user

    return dependency


def require_permission(permission: str):
    def dependency(
        current_user: User = Depends(get_current_user),
        session: Session = Depends(get_session),
    ) -> User:
        ensure_permission(session, current_user, permission)
        return current_user

    return dependency


@router.post("/login", response_model=ApiEnvelope[CurrentUser])
def login(
    payload: LoginRequest,
    response: Response,
    session: Session = Depends(get_session),
) -> ApiEnvelope[CurrentUser]:
    user = session.scalar(select(User).where(User.username == payload.username))
    if user is None or user.status != UserStatus.ACTIVE.value:
        raise HTTPException(status_code=401, detail="Invalid username or password")
    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid username or password")

    user.last_login_at = utc_now()
    session.commit()
    session.refresh(user)
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=create_session_token(user.id),
        httponly=True,
        secure=False,
        samesite="lax",
        max_age=60 * 60 * 12,
        path="/",
    )
    return ApiEnvelope(data=to_current_user(session, user))


@router.post("/logout", response_model=ApiEnvelope[dict[str, bool]])
def logout(response: Response) -> ApiEnvelope[dict[str, bool]]:
    response.delete_cookie(key=SESSION_COOKIE_NAME, path="/")
    return ApiEnvelope(data={"ok": True})


@router.post("/change-password", response_model=ApiEnvelope[dict[str, bool]])
def change_password(
    payload: ChangePasswordRequest,
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> ApiEnvelope[dict[str, bool]]:
    if not verify_password(payload.current_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="Current password is incorrect")
    if verify_password(payload.new_password, current_user.password_hash):
        raise HTTPException(status_code=400, detail="New password must be different from current password")
    current_user.password_hash = hash_password(payload.new_password)
    session.commit()
    return ApiEnvelope(data={"ok": True})


@router.get("/me", response_model=ApiEnvelope[CurrentUser])
def me(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> ApiEnvelope[CurrentUser]:
    return ApiEnvelope(data=to_current_user(session, current_user))


@router.get("/me/stores", response_model=ApiEnvelope[list[StoreRead]])
def my_stores(
    current_user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> ApiEnvelope[list[StoreRead]]:
    ensure_permission(session, current_user, "stores.view")
    stores = list(
        session.scalars(
            select(Store)
            .where(scoped_store_condition(session, current_user, Store.id))
            .order_by(Store.created_at.desc())
        )
    )
    return ApiEnvelope(data=stores)
