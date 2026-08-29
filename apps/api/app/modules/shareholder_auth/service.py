import base64
import hmac
import json
import time
from datetime import UTC
from typing import Any

from fastapi import Header, HTTPException
from sqlalchemy.orm import Session

from app.core.security import _sign
from app.models import ShareholderAccessGrant, ShareholderGrantStatus, utc_now

SHAREHOLDER_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30


def grant_store_ids(grant: ShareholderAccessGrant) -> list[str]:
    try:
        value = json.loads(grant.store_ids_json)
    except json.JSONDecodeError:
        return []
    return value if isinstance(value, list) else []


def serialize_grant(grant: ShareholderAccessGrant) -> dict[str, Any]:
    return {
        "id": grant.id,
        "name": grant.name,
        "store_ids": grant_store_ids(grant),
        "status": grant.status,
        "expires_at": grant.expires_at,
        "last_login_at": grant.last_login_at,
        "created_at": grant.created_at,
        "updated_at": grant.updated_at,
    }


def is_grant_expired(grant: ShareholderAccessGrant) -> bool:
    if grant.expires_at is None:
        return False
    expires_at = grant.expires_at
    if expires_at.tzinfo is not None:
        expires_at = expires_at.astimezone(UTC).replace(tzinfo=None)
    return expires_at <= utc_now()


def create_shareholder_token(grant_id: str) -> str:
    payload = {
        "typ": "shareholder",
        "sub": grant_id,
        "exp": int(time.time()) + SHAREHOLDER_TOKEN_TTL_SECONDS,
    }
    payload_text = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    encoded = base64.urlsafe_b64encode(payload_text.encode("utf-8")).decode("utf-8").rstrip("=")
    return f"{encoded}.{_sign(encoded)}"


def decode_shareholder_token(token: str) -> dict[str, Any] | None:
    try:
        encoded, signature = token.split(".", 1)
        if not hmac.compare_digest(signature, _sign(encoded)):
            return None
        padded = encoded + "=" * (-len(encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")))
        if payload.get("typ") != "shareholder":
            return None
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except (ValueError, TypeError, json.JSONDecodeError):
        return None


def get_bearer_token(authorization: str | None = Header(default=None)) -> str | None:
    if not authorization:
        return None
    prefix = "Bearer "
    if not authorization.startswith(prefix):
        raise HTTPException(status_code=401, detail="Invalid authorization header")
    return authorization.removeprefix(prefix)


def require_shareholder_grant(session: Session, token: str | None) -> ShareholderAccessGrant:
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    payload = decode_shareholder_token(token)
    if payload is None:
        raise HTTPException(status_code=401, detail="Invalid shareholder token")
    grant = session.get(ShareholderAccessGrant, payload.get("sub"))
    if grant is None or grant.status != ShareholderGrantStatus.ACTIVE.value or is_grant_expired(grant):
        raise HTTPException(status_code=401, detail="Invalid shareholder grant")
    return grant
