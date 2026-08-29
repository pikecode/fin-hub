import json
from typing import Any

from sqlalchemy.orm import Session

from app.models import AuditLog


def write_audit_log(
    session: Session,
    *,
    actor: str = "system",
    action: str,
    resource_type: str,
    resource_id: str | None = None,
    summary: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> AuditLog:
    log = AuditLog(
        actor=actor,
        action=action,
        resource_type=resource_type,
        resource_id=resource_id,
        summary=summary,
        metadata_json=json.dumps(metadata, ensure_ascii=False, default=str) if metadata else None,
    )
    session.add(log)
    return log
