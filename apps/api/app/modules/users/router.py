from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.core.security import hash_password
from app.models import User, UserRole
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_roles
from app.modules.common import paginate
from app.schemas import ApiEnvelope, Page, UserCreate, UserRead, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=ApiEnvelope[Page[UserRead]])
def list_users(
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
    _: User = Depends(require_roles(UserRole.ADMIN)),
) -> ApiEnvelope[Page[UserRead]]:
    query = select(User).order_by(User.created_at.desc())
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.post("", response_model=ApiEnvelope[UserRead], status_code=201)
def create_user(
    payload: UserCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN)),
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
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="user.create",
            resource_type="user",
            resource_id=user.id,
            summary=f"新增用户：{user.username}",
            metadata={"role": user.role},
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Username already exists") from exc
    session.refresh(user)
    return ApiEnvelope(data=user)


@router.patch("/{user_id}", response_model=ApiEnvelope[UserRead])
def update_user(
    user_id: str,
    payload: UserUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN)),
) -> ApiEnvelope[UserRead]:
    user = session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=404, detail="User not found")

    changes = payload.model_dump(exclude_unset=True)
    password = changes.pop("password", None)
    for field, value in changes.items():
        setattr(user, field, value.value if isinstance(value, UserRole) else value)
    if password:
        user.password_hash = hash_password(password)

    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="user.update",
        resource_type="user",
        resource_id=user.id,
        summary=f"更新用户：{user.username}",
        metadata={key: value for key, value in changes.items()},
    )
    session.commit()
    session.refresh(user)
    return ApiEnvelope(data=user)
