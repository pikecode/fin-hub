import json

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.core.security import hash_password, verify_password
from app.models import ShareholderAccessGrant, Store, User, UserRole, utc_now
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_roles
from app.modules.common import paginate
from app.modules.shareholder_auth.service import (
    create_shareholder_token,
    get_bearer_token,
    is_grant_expired,
    require_shareholder_grant,
    serialize_grant,
)
from app.schemas import (
    ApiEnvelope,
    Page,
    ShareholderAccessGrantCreate,
    ShareholderAccessGrantRead,
    ShareholderAccessGrantUpdate,
    ShareholderLoginRequest,
    ShareholderLoginResponse,
)

router = APIRouter(tags=["shareholder-auth"])


def validate_store_ids(session: Session, store_ids: list[str]) -> None:
    if not store_ids:
        raise HTTPException(status_code=422, detail="At least one store is required")
    existing_ids = set(session.scalars(select(Store.id).where(Store.id.in_(store_ids))).all())
    missing = sorted(set(store_ids) - existing_ids)
    if missing:
        raise HTTPException(status_code=404, detail=f"Stores not found: {', '.join(missing)}")


@router.post(
    "/shareholder-auth/login",
    response_model=ApiEnvelope[ShareholderLoginResponse],
)
def shareholder_login(
    payload: ShareholderLoginRequest,
    session: Session = Depends(get_session),
) -> ApiEnvelope[ShareholderLoginResponse]:
    grants = session.scalars(select(ShareholderAccessGrant)).all()
    grant = next(
        (
            item
            for item in grants
            if item.status == "active"
            and not is_grant_expired(item)
            and verify_password(payload.access_code, item.access_code_hash)
        ),
        None,
    )
    if grant is None:
        raise HTTPException(status_code=401, detail="Invalid access code")
    grant.last_login_at = utc_now()
    session.commit()
    session.refresh(grant)
    return ApiEnvelope(
        data=ShareholderLoginResponse(
            token=create_shareholder_token(grant.id),
            grant=ShareholderAccessGrantRead(**serialize_grant(grant)),
        )
    )


@router.get(
    "/shareholder-auth/me",
    response_model=ApiEnvelope[ShareholderAccessGrantRead],
)
def read_shareholder_profile(
    token: str | None = Depends(get_bearer_token),
    session: Session = Depends(get_session),
) -> ApiEnvelope[ShareholderAccessGrantRead]:
    grant = require_shareholder_grant(session, token)
    return ApiEnvelope(data=ShareholderAccessGrantRead(**serialize_grant(grant)))


@router.get(
    "/shareholder-grants",
    response_model=ApiEnvelope[Page[ShareholderAccessGrantRead]],
)
def list_shareholder_grants(
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
    _: User = Depends(require_roles(UserRole.ADMIN)),
) -> ApiEnvelope[Page[ShareholderAccessGrantRead]]:
    query = select(ShareholderAccessGrant).order_by(ShareholderAccessGrant.created_at.desc())
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(
        data=Page(
            items=[ShareholderAccessGrantRead(**serialize_grant(item)) for item in items],
            total=total,
            page=page,
            page_size=page_size,
        )
    )


@router.post(
    "/shareholder-grants",
    response_model=ApiEnvelope[ShareholderAccessGrantRead],
    status_code=201,
)
def create_shareholder_grant(
    payload: ShareholderAccessGrantCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN)),
) -> ApiEnvelope[ShareholderAccessGrantRead]:
    validate_store_ids(session, payload.store_ids)
    grant = ShareholderAccessGrant(
        name=payload.name,
        access_code_hash=hash_password(payload.access_code),
        store_ids_json=json.dumps(payload.store_ids, ensure_ascii=False),
        expires_at=payload.expires_at,
    )
    session.add(grant)
    try:
        session.flush()
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="shareholder_grant.create",
            resource_type="shareholder_access_grant",
            resource_id=grant.id,
            summary=f"新增股东授权：{grant.name}",
            metadata={"store_ids": payload.store_ids},
        )
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="Shareholder grant already exists") from exc
    session.refresh(grant)
    return ApiEnvelope(data=ShareholderAccessGrantRead(**serialize_grant(grant)))


@router.patch(
    "/shareholder-grants/{grant_id}",
    response_model=ApiEnvelope[ShareholderAccessGrantRead],
)
def update_shareholder_grant(
    grant_id: str,
    payload: ShareholderAccessGrantUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN)),
) -> ApiEnvelope[ShareholderAccessGrantRead]:
    grant = session.get(ShareholderAccessGrant, grant_id)
    if grant is None:
        raise HTTPException(status_code=404, detail="Shareholder grant not found")

    changes = payload.model_dump(exclude_unset=True)
    if "store_ids" in changes and changes["store_ids"] is not None:
        validate_store_ids(session, changes["store_ids"])
        grant.store_ids_json = json.dumps(changes.pop("store_ids"), ensure_ascii=False)
    access_code = changes.pop("access_code", None)
    if access_code:
        grant.access_code_hash = hash_password(access_code)
    for field, value in changes.items():
        setattr(grant, field, value.value if hasattr(value, "value") else value)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="shareholder_grant.update",
        resource_type="shareholder_access_grant",
        resource_id=grant.id,
        summary=f"更新股东授权：{grant.name}",
        metadata={key: value for key, value in changes.items()},
    )
    session.commit()
    session.refresh(grant)
    return ApiEnvelope(data=ShareholderAccessGrantRead(**serialize_grant(grant)))
