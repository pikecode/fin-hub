import base64
import hashlib
import hmac
import json
import secrets
import time
from typing import Any

from app.core.config import settings

PASSWORD_ALGORITHM = "pbkdf2_sha256"
PASSWORD_ITERATIONS = 210_000
SESSION_TTL_SECONDS = 60 * 60 * 12


def hash_password(password: str, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt.encode("utf-8"),
        PASSWORD_ITERATIONS,
    ).hex()
    return f"{PASSWORD_ALGORITHM}${PASSWORD_ITERATIONS}${salt}${digest}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations_text, salt, expected_digest = stored_hash.split("$", 3)
        if algorithm != PASSWORD_ALGORITHM:
            return False
        digest = hashlib.pbkdf2_hmac(
            "sha256",
            password.encode("utf-8"),
            salt.encode("utf-8"),
            int(iterations_text),
        ).hex()
        return hmac.compare_digest(digest, expected_digest)
    except ValueError:
        return False


def _sign(payload: str) -> str:
    return hmac.new(settings.secret_key.encode("utf-8"), payload.encode("utf-8"), hashlib.sha256).hexdigest()


def create_session_token(user_id: str) -> str:
    payload = {
        "sub": user_id,
        "exp": int(time.time()) + SESSION_TTL_SECONDS,
    }
    payload_text = json.dumps(payload, separators=(",", ":"), sort_keys=True)
    payload_encoded = base64.urlsafe_b64encode(payload_text.encode("utf-8")).decode("utf-8").rstrip("=")
    return f"{payload_encoded}.{_sign(payload_encoded)}"


def decode_session_token(token: str) -> dict[str, Any] | None:
    try:
        payload_encoded, signature = token.split(".", 1)
        if not hmac.compare_digest(signature, _sign(payload_encoded)):
            return None
        padded = payload_encoded + "=" * (-len(payload_encoded) % 4)
        payload = json.loads(base64.urlsafe_b64decode(padded.encode("utf-8")))
        if int(payload.get("exp", 0)) < int(time.time()):
            return None
        return payload
    except (ValueError, json.JSONDecodeError, TypeError):
        return None
