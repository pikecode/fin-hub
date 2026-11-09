import hashlib
import json
from pathlib import Path
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.crypto import decrypt_secret
from app.core.database import get_session
from app.models import (
    Attachment,
    AttachmentStatus,
    DingTalkConfig,
    ExpenseItem,
    Ledger,
    LedgerStatus,
    StoreLoan,
    StoreLoanEvent,
    User,
)
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import ensure_store_access, scoped_store_condition
from app.modules.auth.router import audit_actor, require_permission
from app.modules.common import paginate
from app.modules.dingtalk.client import DingTalkClient, DingTalkClientError, DingTalkCredentials
from app.schemas import ApiEnvelope, AttachmentAccessUrl, AttachmentRead, Page

router = APIRouter(prefix="/attachments", tags=["attachments"])
MAX_MANUAL_ATTACHMENT_SIZE = 500 * 1024


def storage_root() -> Path:
    root = Path(settings.file_storage_root) / "attachments"
    root.mkdir(parents=True, exist_ok=True)
    return root


def ensure_resource_for_upload(session: Session, resource_type: str, resource_id: str) -> None:
    if resource_type == "loan_event":
        event = session.get(StoreLoanEvent, resource_id)
        if not event:
            raise HTTPException(404, "借还款记录不存在")
        if not event.active:
            raise HTTPException(409, "已撤销登记不能追加凭证")
        loan = session.get(StoreLoan, event.loan_id)
        closed = session.scalar(select(Ledger.id).where(Ledger.store_id == loan.store_id,
            Ledger.period >= event.occurred_on.strftime("%Y-%m"), Ledger.status == "closed").limit(1))
        if closed:
            raise HTTPException(409, "已封账借还款凭证不能修改")
        return
    if resource_type != "expense_item":
        raise HTTPException(status_code=422, detail="Only expense_item attachments are supported")
    item = session.get(ExpenseItem, resource_id)
    if item is None:
        raise HTTPException(status_code=404, detail="Expense item not found")
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == item.store_id, Ledger.period == item.ledger_period)
    )
    if ledger is not None and ledger.status == LedgerStatus.CLOSED.value:
        raise HTTPException(status_code=409, detail="Ledger is closed")


def resource_access(session, user, resource_type, resource_id):
    if resource_type == "expense_item":
        item = session.get(ExpenseItem, resource_id)
        if not item:
            raise HTTPException(404, "费用不存在")
        ensure_store_access(session, user, item.store_id)
    elif resource_type == "loan_event":
        event = session.get(StoreLoanEvent, resource_id)
        loan = session.get(StoreLoan, event.loan_id) if event else None
        if not loan:
            raise HTTPException(404, "借还款记录不存在")
        ensure_store_access(session, user, loan.store_id)
    else:
        raise HTTPException(422, "不支持的附件资源类型")


def ensure_safe_file_name(file_name: str | None) -> str:
    name = Path(file_name or "attachment.bin").name.strip()
    return name or "attachment.bin"


def store_attachment_content(attachment: Attachment, content: bytes, content_type: str | None = None) -> None:
    digest = hashlib.sha256(content).hexdigest()
    file_name = ensure_safe_file_name(attachment.file_name)
    relative_path = Path(attachment.resource_type) / attachment.resource_id / f"{digest[:16]}-{file_name}"
    target_path = storage_root() / relative_path
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_bytes(content)
    attachment.file_name = file_name
    attachment.content_type = content_type or attachment.content_type
    attachment.file_size = len(content)
    attachment.file_path = str(relative_path)
    attachment.file_hash = digest
    attachment.download_status = AttachmentStatus.STORED.value


def resolve_dingtalk_external_reference(attachment: Attachment) -> tuple[str | None, str | None, str | None]:
    value = attachment.external_file_id or ""
    parsed = urlparse(value)
    if parsed.scheme in {"http", "https"}:
        return value, None, None
    try:
        data = json.loads(value)
    except ValueError:
        return None, None, None
    if not isinstance(data, dict):
        return None, None, None
    direct_url = data.get("url") or data.get("downloadUrl") or data.get("download_url")
    space_id = data.get("spaceId") or data.get("space_id")
    file_id = data.get("fileId") or data.get("file_id")
    return (
        str(direct_url) if direct_url else None,
        str(space_id) if space_id else None,
        str(file_id) if file_id else None,
    )


def create_dingtalk_client(session: Session) -> tuple[DingTalkClient, str]:
    config = session.scalar(select(DingTalkConfig).order_by(DingTalkConfig.created_at.asc()))
    app_key = settings.dingtalk_app_key or (config.app_key if config else None)
    app_secret = settings.dingtalk_app_secret or decrypt_secret(config.app_secret_encrypted if config else None)
    union_id = settings.dingtalk_drive_union_id or (config.drive_union_id if config else None)
    if not app_key or not app_secret or not union_id:
        raise HTTPException(status_code=409, detail="DingTalk app key, secret or drive union id is not configured")
    return DingTalkClient(DingTalkCredentials(app_key=app_key, app_secret=app_secret)), union_id


def download_url_content(url: str) -> tuple[bytes, str | None]:
    try:
        response = httpx.get(url, timeout=30.0)
        response.raise_for_status()
    except httpx.HTTPError as exc:
        raise HTTPException(status_code=502, detail=f"Attachment download failed: {exc}") from exc
    return response.content, response.headers.get("content-type")


@router.get("", response_model=ApiEnvelope[Page[AttachmentRead]])
def list_attachments(
    resource_type: str | None = None,
    resource_id: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("reports.view")),
) -> ApiEnvelope[Page[AttachmentRead]]:
    if resource_type and resource_id:
        resource_access(session, current_user, resource_type, resource_id)
    query = select(Attachment).order_by(Attachment.created_at.desc())
    expense_ids = select(ExpenseItem.id).where(scoped_store_condition(session, current_user, ExpenseItem.store_id))
    loan_ids = select(StoreLoanEvent.id).join(StoreLoan, StoreLoan.id == StoreLoanEvent.loan_id).where(scoped_store_condition(session, current_user, StoreLoan.store_id))
    query = query.where(or_(and_(Attachment.resource_type == "expense_item", Attachment.resource_id.in_(expense_ids)),
                           and_(Attachment.resource_type == "loan_event", Attachment.resource_id.in_(loan_ids))))
    if resource_type:
        query = query.where(Attachment.resource_type == resource_type)
    if resource_id:
        query = query.where(Attachment.resource_id == resource_id)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.post("", response_model=ApiEnvelope[AttachmentRead], status_code=201)
async def upload_attachment(
    resource_type: str,
    resource_id: str,
    file: UploadFile = File(...),
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("reconciliation.manage")),
) -> ApiEnvelope[AttachmentRead]:
    resource_access(session, current_user, resource_type, resource_id)
    ensure_resource_for_upload(session, resource_type, resource_id)
    content = await file.read(MAX_MANUAL_ATTACHMENT_SIZE + 1)
    if not content:
        raise HTTPException(status_code=422, detail="Attachment file is empty")
    if len(content) > MAX_MANUAL_ATTACHMENT_SIZE:
        raise HTTPException(status_code=413, detail="Attachment file must be 500KB or smaller")
    item = session.get(ExpenseItem, resource_id) if resource_type == "expense_item" else None
    if resource_type == "loan_event" or (item and item.source == "accrual"):
        signatures = [(b"\x89PNG\r\n\x1a\n", "image/png"), (b"\xff\xd8\xff", "image/jpeg")]
        detected = next((mime for signature, mime in signatures if content.startswith(signature)), None)
        if not detected:
            raise HTTPException(422, "请上传 PNG 或 JPEG 图片凭证")
    digest = hashlib.sha256(content).hexdigest()
    existing = session.scalar(select(Attachment).where(Attachment.resource_type == resource_type,
        Attachment.resource_id == resource_id, Attachment.file_hash == digest))
    if existing:
        return ApiEnvelope(data=existing)
    file_name = ensure_safe_file_name(file.filename)
    relative_path = Path(resource_type) / resource_id / f"{digest[:16]}-{file_name}"
    target_path = storage_root() / relative_path
    target_path.parent.mkdir(parents=True, exist_ok=True)
    target_path.write_bytes(content)

    attachment = Attachment(
        resource_type=resource_type,
        resource_id=resource_id,
        file_name=file_name,
        content_type=(detected if resource_type == "loan_event" or (resource_type == "expense_item" and session.get(ExpenseItem, resource_id).source == "accrual") else file.content_type),
        file_size=len(content),
        file_path=str(relative_path),
        file_hash=digest,
        source="manual",
        download_status=AttachmentStatus.STORED.value,
    )
    session.add(attachment)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="attachment.upload",
        resource_type="attachment",
        resource_id=attachment.id,
        summary=f"上传附件：{attachment.file_name}",
        metadata={"target_resource_type": resource_type, "target_resource_id": resource_id},
    )
    session.commit()
    session.refresh(attachment)
    return ApiEnvelope(data=attachment)


@router.get("/{attachment_id}/download")
def download_attachment(
    attachment_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("reports.view")),
) -> FileResponse:
    attachment = session.get(Attachment, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    resource_access(session, current_user, attachment.resource_type, attachment.resource_id)
    if attachment.download_status != AttachmentStatus.STORED.value or not attachment.file_path:
        raise HTTPException(status_code=409, detail="Attachment file is not available")
    root = storage_root().resolve()
    path = (root / attachment.file_path).resolve()
    if not path.exists() or root not in path.parents:
        raise HTTPException(status_code=404, detail="Attachment file not found")
    return FileResponse(
        path,
        media_type=attachment.content_type or "application/octet-stream",
        filename=attachment.file_name,
    )


@router.get("/{attachment_id}/access-url", response_model=ApiEnvelope[AttachmentAccessUrl])
def get_attachment_access_url(
    attachment_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("reports.view")),
) -> ApiEnvelope[AttachmentAccessUrl]:
    attachment = session.get(Attachment, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    resource_access(session, current_user, attachment.resource_type, attachment.resource_id)
    if attachment.source != "dingtalk":
        raise HTTPException(status_code=409, detail="Only DingTalk attachments support access URLs")

    direct_url, space_id, file_id = resolve_dingtalk_external_reference(attachment)
    try:
        if not direct_url:
            if not space_id or not file_id:
                raise HTTPException(status_code=422, detail="DingTalk attachment reference is incomplete")
            client, union_id = create_dingtalk_client(session)
            direct_url = client.get_drive_download_url(space_id, file_id, union_id)
    except DingTalkClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return ApiEnvelope(data=AttachmentAccessUrl(url=direct_url, file_name=attachment.file_name, expires_in=None))


@router.post("/{attachment_id}/download-dingtalk", response_model=ApiEnvelope[AttachmentRead])
def download_dingtalk_attachment(
    attachment_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("reconciliation.manage")),
) -> ApiEnvelope[AttachmentRead]:
    attachment = session.get(Attachment, attachment_id)
    if attachment is None:
        raise HTTPException(status_code=404, detail="Attachment not found")
    resource_access(session, current_user, attachment.resource_type, attachment.resource_id)
    if attachment.source != "dingtalk":
        raise HTTPException(status_code=409, detail="Attachment is not from DingTalk")
    if attachment.download_status == AttachmentStatus.STORED.value:
        return ApiEnvelope(data=attachment)

    direct_url, space_id, file_id = resolve_dingtalk_external_reference(attachment)
    try:
        if not direct_url:
            if not space_id or not file_id:
                raise HTTPException(status_code=422, detail="DingTalk attachment reference is incomplete")
            client, union_id = create_dingtalk_client(session)
            direct_url = client.get_drive_download_url(space_id, file_id, union_id)
        content, content_type = download_url_content(direct_url)
        if not content:
            raise HTTPException(status_code=502, detail="Attachment download returned empty content")
        store_attachment_content(attachment, content, content_type)
    except (DingTalkClientError, HTTPException) as exc:
        attachment.download_status = AttachmentStatus.FAILED.value
        session.commit()
        if isinstance(exc, HTTPException):
            raise
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="attachment.dingtalk_download",
        resource_type="attachment",
        resource_id=attachment.id,
        summary=f"下载钉钉附件：{attachment.file_name}",
        metadata={"target_resource_type": attachment.resource_type, "target_resource_id": attachment.resource_id},
    )
    session.commit()
    session.refresh(attachment)
    return ApiEnvelope(data=attachment)
