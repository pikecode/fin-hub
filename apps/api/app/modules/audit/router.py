from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import AuditLog
from app.modules.common import paginate
from app.schemas import ApiEnvelope, AuditLogRead, Page

router = APIRouter(prefix="/audit-logs", tags=["audit"])


@router.get("", response_model=ApiEnvelope[Page[AuditLogRead]])
def list_audit_logs(
    actor: str | None = None,
    action: str | None = None,
    resource_type: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[AuditLogRead]]:
    query = select(AuditLog).order_by(AuditLog.created_at.desc())
    if actor:
        query = query.where(AuditLog.actor == actor)
    if action:
        query = query.where(AuditLog.action == action)
    if resource_type:
        query = query.where(AuditLog.resource_type == resource_type)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))
