import json
from datetime import datetime, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.crypto import decrypt_secret, encrypt_secret
from app.core.database import get_session
from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    Attachment,
    AttachmentStatus,
    DingTalkConfig,
    ExpenseItem,
    Ledger,
    Store,
    SyncJob,
    SyncJobStatus,
    TemplateFieldMapping,
    User,
    UserRole,
    utc_now,
)
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_roles
from app.modules.common import paginate
from app.modules.dingtalk.client import DingTalkClient, DingTalkClientError, DingTalkCredentials
from app.schemas import (
    ApiEnvelope,
    ApprovalInstanceRead,
    ApprovalTemplateCreate,
    ApprovalTemplateRead,
    DingTalkConfigRead,
    DingTalkConfigUpdate,
    Page,
    ResumeApprovalSyncRequest,
    StartApprovalSyncRequest,
    SyncJobRead,
    TemplateFieldCandidate,
    TemplateFieldMappingCreate,
    TemplateFieldMappingRead,
)

router = APIRouter(prefix="/dingtalk", tags=["dingtalk"])


def mask_config(config: DingTalkConfig) -> DingTalkConfigRead:
    has_secret = bool(settings.dingtalk_app_secret or decrypt_secret(config.app_secret_encrypted))
    has_key = bool(settings.dingtalk_app_key or config.app_key)
    return DingTalkConfigRead(
        id=config.id,
        corp_id=config.corp_id,
        app_key=config.app_key,
        app_secret_configured=has_secret,
        admin_user_id=config.admin_user_id,
        drive_union_id=config.drive_union_id,
        status="configured" if has_key and has_secret else "incomplete",
        last_template_sync_at=config.last_template_sync_at,
        last_instance_sync_at=config.last_instance_sync_at,
    )


def get_or_create_config(session: Session) -> DingTalkConfig:
    config = session.scalar(select(DingTalkConfig).order_by(DingTalkConfig.created_at.asc()))
    if config is None:
        config = DingTalkConfig()
        session.add(config)
        session.commit()
        session.refresh(config)
    return config


def dingtalk_credentials(config: DingTalkConfig) -> DingTalkCredentials | None:
    app_key = settings.dingtalk_app_key or config.app_key
    app_secret = settings.dingtalk_app_secret or decrypt_secret(config.app_secret_encrypted)
    if not app_key or not app_secret:
        return None
    return DingTalkCredentials(app_key=app_key, app_secret=app_secret)


def dingtalk_client(config: DingTalkConfig) -> DingTalkClient:
    credentials = dingtalk_credentials(config)
    if credentials is None:
        raise HTTPException(status_code=409, detail="DingTalk app key or secret is not configured")
    return DingTalkClient(credentials)


def should_use_real_dingtalk() -> bool:
    return settings.dingtalk_sync_mode.lower() == "real"


@router.get("/config", response_model=ApiEnvelope[DingTalkConfigRead])
def read_config(session: Session = Depends(get_session)) -> ApiEnvelope[DingTalkConfigRead]:
    return ApiEnvelope(data=mask_config(get_or_create_config(session)))


@router.put("/config", response_model=ApiEnvelope[DingTalkConfigRead])
def update_config(
    payload: DingTalkConfigUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[DingTalkConfigRead]:
    config = get_or_create_config(session)
    values = payload.model_dump(exclude_unset=True)
    app_secret = values.pop("app_secret", None)
    for key, value in values.items():
        setattr(config, key, value)
    if app_secret:
        config.app_secret_encrypted = encrypt_secret(app_secret)
    config.status = "configured" if dingtalk_credentials(config) else "incomplete"
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.config.update",
        resource_type="dingtalk_config",
        resource_id=config.id,
        summary="更新钉钉配置",
        metadata={key: value for key, value in values.items() if key != "app_secret"},
    )
    session.commit()
    session.refresh(config)
    return ApiEnvelope(data=mask_config(config))


@router.post("/connection-test", response_model=ApiEnvelope[dict[str, str]])
def test_connection(
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[dict[str, str]]:
    config = get_or_create_config(session)
    try:
        token = dingtalk_client(config).get_access_token()
    except DingTalkClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.connection_test",
        resource_type="dingtalk_config",
        resource_id=config.id,
        summary="测试钉钉连接",
    )
    session.commit()
    return ApiEnvelope(data={"status": "ok", "access_token_prefix": token[:8]})


@router.get("/templates", response_model=ApiEnvelope[Page[ApprovalTemplateRead]])
def list_templates(
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[ApprovalTemplateRead]]:
    query = select(ApprovalTemplate).order_by(ApprovalTemplate.created_at.desc())
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.post("/templates", response_model=ApiEnvelope[ApprovalTemplateRead], status_code=201)
def create_template(
    payload: ApprovalTemplateCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[ApprovalTemplateRead]:
    exists = session.scalar(
        select(ApprovalTemplate).where(ApprovalTemplate.process_code == payload.process_code)
    )
    if exists is not None:
        raise HTTPException(status_code=409, detail="Template already exists")
    template = ApprovalTemplate(**payload.model_dump(), last_sync_at=utc_now())
    session.add(template)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.template.create",
        resource_type="approval_template",
        resource_id=template.id,
        summary=f"新增审批模板：{template.name}",
    )
    session.commit()
    session.refresh(template)
    return ApiEnvelope(data=template)


@router.post("/templates/sync", response_model=ApiEnvelope[dict[str, int]])
def sync_templates(
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[dict[str, int]]:
    config = get_or_create_config(session)
    if should_use_real_dingtalk():
        if not config.admin_user_id:
            raise HTTPException(status_code=409, detail="DingTalk admin user id is not configured")
        try:
            processes = dingtalk_client(config).list_processes_by_user(config.admin_user_id)
        except DingTalkClientError as exc:
            raise HTTPException(status_code=502, detail=str(exc)) from exc
        samples = [
            (
                str(item.get("process_code") or item.get("processCode") or ""),
                str(item.get("name") or item.get("process_name") or item.get("processName") or "未命名审批模板"),
                json.dumps(item, ensure_ascii=False),
            )
            for item in processes
            if item.get("process_code") or item.get("processCode")
        ]
    else:
        samples = [
            ("seed-expense-approval", "门店费用报销", json.dumps({"source": "seed-sync"}, ensure_ascii=False)),
            ("seed-purchase-approval", "采购付款申请", json.dumps({"source": "seed-sync"}, ensure_ascii=False)),
        ]
    created = 0
    for process_code, name, raw_snapshot in samples:
        template = session.scalar(
            select(ApprovalTemplate).where(ApprovalTemplate.process_code == process_code)
        )
        if template is None:
            template = ApprovalTemplate(
                process_code=process_code,
                name=name,
                last_sync_at=utc_now(),
                raw_snapshot=raw_snapshot,
            )
            session.add(template)
            created += 1
        else:
            template.name = name
            template.raw_snapshot = raw_snapshot
            template.last_sync_at = utc_now()
    config.last_template_sync_at = utc_now()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.templates.sync",
        resource_type="dingtalk_config",
        resource_id=config.id,
        summary=f"同步钉钉模板：新增 {created} 个",
    )
    session.commit()
    return ApiEnvelope(data={"created": created})


@router.get(
    "/templates/{template_id}/mappings",
    response_model=ApiEnvelope[list[TemplateFieldMappingRead]],
)
def list_template_mappings(
    template_id: str,
    session: Session = Depends(get_session),
) -> ApiEnvelope[list[TemplateFieldMappingRead]]:
    if session.get(ApprovalTemplate, template_id) is None:
        raise HTTPException(status_code=404, detail="Template not found")
    mappings = session.scalars(
        select(TemplateFieldMapping)
        .where(TemplateFieldMapping.template_id == template_id)
        .order_by(TemplateFieldMapping.sort_order.asc(), TemplateFieldMapping.created_at.asc())
    ).all()
    return ApiEnvelope(data=mappings)


def candidate_label(value: dict[str, Any]) -> str | None:
    for key in ("name", "label", "title", "componentName"):
        candidate = value.get(key)
        if candidate not in (None, ""):
            return str(candidate)
    return None


def candidate_field_id(value: dict[str, Any]) -> str | None:
    for key in ("id", "field_id", "fieldId", "component_id", "componentId"):
        candidate = value.get(key)
        if candidate not in (None, ""):
            return str(candidate)
    return None


def candidate_field_type(value: dict[str, Any]) -> str | None:
    for key in ("field_type", "fieldType", "component_type", "componentType", "type"):
        candidate = value.get(key)
        if candidate not in (None, ""):
            return str(candidate)
    return None


def collect_field_candidates(value: Any, path: str = "") -> list[TemplateFieldCandidate]:
    candidates: list[TemplateFieldCandidate] = []
    if isinstance(value, dict):
        label = candidate_label(value)
        if label:
            candidates.append(
                TemplateFieldCandidate(
                    source_field_id=candidate_field_id(value),
                    source_field_name=label,
                    source_path=path or label,
                    field_type=candidate_field_type(value),
                )
            )
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            candidates.extend(collect_field_candidates(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            candidates.extend(collect_field_candidates(child, f"{path}[{index}]"))
    return candidates


def unique_field_candidates(candidates: list[TemplateFieldCandidate]) -> list[TemplateFieldCandidate]:
    unique: dict[tuple[str | None, str], TemplateFieldCandidate] = {}
    for candidate in candidates:
        key = (candidate.source_field_id, candidate.source_field_name)
        if key not in unique:
            unique[key] = candidate
    return sorted(unique.values(), key=lambda item: (item.source_field_name, item.source_field_id or ""))


@router.get(
    "/templates/{template_id}/field-candidates",
    response_model=ApiEnvelope[list[TemplateFieldCandidate]],
)
def list_template_field_candidates(
    template_id: str,
    session: Session = Depends(get_session),
) -> ApiEnvelope[list[TemplateFieldCandidate]]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")

    candidates: list[TemplateFieldCandidate] = []
    if template.raw_snapshot:
        try:
            candidates.extend(collect_field_candidates(json.loads(template.raw_snapshot), "template"))
        except ValueError:
            pass
    instances = session.scalars(
        select(ApprovalInstance)
        .where(ApprovalInstance.template_id == template_id)
        .order_by(ApprovalInstance.created_at.desc())
        .limit(10)
    ).all()
    for instance in instances:
        if not instance.raw_payload:
            continue
        try:
            candidates.extend(collect_field_candidates(json.loads(instance.raw_payload), "instance"))
        except ValueError:
            continue
    return ApiEnvelope(data=unique_field_candidates(candidates))


@router.post(
    "/templates/{template_id}/mappings",
    response_model=ApiEnvelope[TemplateFieldMappingRead],
    status_code=201,
)
def upsert_template_mapping(
    template_id: str,
    payload: TemplateFieldMappingCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[TemplateFieldMappingRead]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    mapping = session.scalar(
        select(TemplateFieldMapping).where(
            TemplateFieldMapping.template_id == template_id,
            TemplateFieldMapping.standard_field == payload.standard_field,
        )
    )
    if mapping is None:
        mapping = TemplateFieldMapping(template_id=template_id, **payload.model_dump())
        session.add(mapping)
    else:
        for key, value in payload.model_dump().items():
            setattr(mapping, key, value)
    template.mapping_status = "mapped"
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.template_mapping.upsert",
        resource_type="template_field_mapping",
        resource_id=mapping.id,
        summary=f"维护审批字段映射：{payload.standard_field}",
        metadata={"template_id": template_id},
    )
    session.commit()
    session.refresh(mapping)
    return ApiEnvelope(data=mapping)


def create_expense_from_instance(
    session: Session,
    template: ApprovalTemplate,
    job: SyncJob,
) -> ApprovalInstance | None:
    store = session.scalar(select(Store).order_by(Store.created_at.asc()))
    if store is None:
        return None
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store.id, Ledger.period == "2026-08")
    )
    if ledger is None:
        ledger = Ledger(store_id=store.id, period="2026-08")
        session.add(ledger)
        session.flush()

    instance_id = f"seed-instance-{template.process_code}-20260829"
    instance = session.scalar(
        select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == instance_id)
    )
    if instance is None:
        instance = ApprovalInstance(
            template_id=template.id,
            dingtalk_instance_id=instance_id,
            approval_no="SEED-APPROVAL-20260829",
            store_id=store.id,
            applicant_name="开发样例",
            applicant_user_id="seed-user",
            approval_status="approved",
            submit_at=datetime(2026, 8, 29, 9, 10),
            approved_at=datetime(2026, 8, 29, 10, 20),
            raw_payload=json.dumps(
                {
                    "store": store.name,
                    "amount": "328.00",
                    "description": f"{template.name} 同步样例",
                },
                ensure_ascii=False,
            ),
            synced_job_id=job.id,
        )
        session.add(instance)
        session.flush()
    exists_item = session.scalar(
        select(ExpenseItem).where(ExpenseItem.source_document_id == instance.dingtalk_instance_id)
    )
    if exists_item is None:
        expense_item = ExpenseItem(
            store_id=store.id,
            ledger_period="2026-08",
            expense_date=datetime(2026, 8, 29),
            description=f"{template.name} 同步样例",
            amount=Decimal("328.00"),
            category_l1="钉钉同步",
            supplier_name="同步样例供应商",
            payee_account="6222 **** 2026",
            source="dingtalk",
            source_document_id=instance.dingtalk_instance_id,
        )
        session.add(expense_item)
        session.flush()
    return instance


def form_value_map(raw_instance: dict[str, Any]) -> dict[str, Any]:
    values: dict[str, Any] = {}
    components = raw_instance.get("form_component_values") or raw_instance.get("formComponentValues") or []
    if not isinstance(components, list):
        return values
    for component in components:
        if not isinstance(component, dict):
            continue
        key = component.get("name") or component.get("label") or component.get("id")
        if key:
            values[str(key)] = component.get("value") or component.get("ext_value") or component.get("extValue")
        component_id = component.get("id")
        if component_id:
            values[str(component_id)] = component.get("value") or component.get("ext_value") or component.get("extValue")
    return values


def mapped_value(mapping: TemplateFieldMapping, values: dict[str, Any]) -> Any:
    if mapping.source_field_id and mapping.source_field_id in values:
        return values[mapping.source_field_id]
    return values.get(mapping.source_field_name)


def parse_decimal(value: Any) -> Decimal | None:
    if value in (None, ""):
        return None
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = value.get("value") or value.get("amount")
    try:
        return Decimal(str(value).replace(",", ""))
    except (InvalidOperation, ValueError):
        return None


def parse_date(value: Any) -> datetime | None:
    if value in (None, ""):
        return None
    if isinstance(value, list):
        value = value[0] if value else None
    if isinstance(value, dict):
        value = value.get("value")
    parsed = DingTalkClient.parse_time(value)
    if parsed is not None:
        return parsed
    try:
        return datetime.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def parse_text(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, list):
        return "、".join(str(item) for item in value)
    if isinstance(value, dict):
        return json.dumps(value, ensure_ascii=False)
    return str(value)


def parse_voucher_items(value: Any) -> list[dict[str, str | None]]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except ValueError:
            return [{"file_name": value.rsplit("/", 1)[-1] or "钉钉凭证", "external_file_id": value}]
        return parse_voucher_items(decoded)
    if isinstance(value, list):
        items: list[dict[str, str | None]] = []
        for item in value:
            items.extend(parse_voucher_items(item))
        return items
    if isinstance(value, dict):
        if value.get("spaceId") or value.get("space_id"):
            external_file_id = json.dumps(value, ensure_ascii=False)
        else:
            external_file_id = value.get("fileId") or value.get("file_id") or value.get("url") or value.get("mediaId")
        file_name = value.get("fileName") or value.get("file_name") or value.get("name") or external_file_id
        return [
            {
                "file_name": str(file_name or "钉钉凭证"),
                "external_file_id": str(external_file_id) if external_file_id else None,
            }
        ]
    return []


def create_dingtalk_attachment_placeholders(
    session: Session,
    resource_type: str,
    resource_id: str,
    values: list[dict[str, str | None]],
) -> None:
    for item in values:
        external_file_id = item.get("external_file_id")
        if not external_file_id:
            continue
        exists = session.scalar(
            select(Attachment).where(
                Attachment.source == "dingtalk",
                Attachment.external_file_id == external_file_id,
            )
        )
        if exists is not None:
            continue
        session.add(
            Attachment(
                resource_type=resource_type,
                resource_id=resource_id,
                file_name=item.get("file_name") or "钉钉凭证",
                source="dingtalk",
                external_file_id=external_file_id,
                download_status=AttachmentStatus.PLACEHOLDER.value,
            )
        )


def resolve_store(session: Session, value: str | None) -> Store | None:
    if value:
        store = session.scalar(select(Store).where(Store.name == value))
        if store is not None:
            return store
        store = session.scalar(select(Store).where(Store.dingtalk_dept_id == value))
        if store is not None:
            return store
    return None


def sync_real_instance(
    session: Session,
    template: ApprovalTemplate,
    job: SyncJob,
    raw_instance: dict[str, Any],
) -> bool:
    instance_id = str(raw_instance.get("process_instance_id") or raw_instance.get("processInstanceId") or "")
    if not instance_id:
        return False
    values = form_value_map(raw_instance)
    mappings = session.scalars(
        select(TemplateFieldMapping).where(TemplateFieldMapping.template_id == template.id)
    ).all()
    mapped: dict[str, Any] = {mapping.standard_field: mapped_value(mapping, values) for mapping in mappings}

    store = resolve_store(session, parse_text(mapped.get("store")) or parse_text(mapped.get("store_name")))
    amount = parse_decimal(mapped.get("amount"))
    description = parse_text(mapped.get("description")) or template.name
    expense_date = parse_date(mapped.get("expense_date")) or DingTalkClient.parse_time(
        raw_instance.get("create_time") or raw_instance.get("createTime")
    )

    instance = session.scalar(select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == instance_id))
    if instance is None:
        instance = ApprovalInstance(template_id=template.id, dingtalk_instance_id=instance_id)
        session.add(instance)
    instance.approval_no = parse_text(raw_instance.get("business_id") or raw_instance.get("businessId"))
    instance.store_id = store.id if store is not None else None
    instance.applicant_name = parse_text(raw_instance.get("originator_user_name") or raw_instance.get("originatorUserName"))
    instance.applicant_user_id = parse_text(raw_instance.get("originator_userid") or raw_instance.get("originatorUserId"))
    instance.approval_status = parse_text(raw_instance.get("status") or raw_instance.get("result")) or "unknown"
    instance.submit_at = DingTalkClient.parse_time(raw_instance.get("create_time") or raw_instance.get("createTime"))
    instance.approved_at = DingTalkClient.parse_time(raw_instance.get("finish_time") or raw_instance.get("finishTime"))
    instance.raw_payload = json.dumps(raw_instance, ensure_ascii=False)
    instance.synced_job_id = job.id
    session.flush()

    if store is None or amount is None or expense_date is None:
        return False
    if instance.approval_status.lower() not in {"agree", "approved", "completed", "finish", "success"}:
        return True
    exists_item = session.scalar(
        select(ExpenseItem).where(ExpenseItem.source_document_id == instance.dingtalk_instance_id)
    )
    if exists_item is None:
        period = expense_date.strftime("%Y-%m")
        if session.scalar(select(Ledger).where(Ledger.store_id == store.id, Ledger.period == period)) is None:
            session.add(Ledger(store_id=store.id, period=period))
            session.flush()
        expense_item = ExpenseItem(
            store_id=store.id,
            ledger_period=period,
            expense_date=expense_date,
            description=description,
            amount=amount,
            category_l1=parse_text(mapped.get("category_l1")),
            category_l2=parse_text(mapped.get("category_l2")),
            supplier_name=parse_text(mapped.get("supplier_name")),
            payee_account=parse_text(mapped.get("payee_account")),
            source="dingtalk",
            source_document_id=instance.dingtalk_instance_id,
        )
        session.add(expense_item)
        session.flush()
        create_dingtalk_attachment_placeholders(
            session,
            "expense_item",
            expense_item.id,
            [
                *parse_voucher_items(mapped.get("voucher_images")),
                *parse_voucher_items(mapped.get("voucher_files")),
            ],
        )
    return True


def parse_sync_cursor(value: str | None) -> tuple[str, int] | None:
    if not value or ":" not in value:
        return None
    process_code, cursor_text = value.split(":", 1)
    try:
        cursor = int(cursor_text)
    except ValueError:
        return None
    if not process_code or cursor < 0:
        return None
    return process_code, cursor


def run_approval_sync(
    session: Session,
    *,
    job: SyncJob,
    templates: list[ApprovalTemplate],
    page_size: int,
    max_pages: int,
    resume_cursor: tuple[str, int] | None = None,
) -> None:
    template_summaries: list[dict[str, Any]] = []
    incomplete_sync = False
    for template in templates:
        if should_use_real_dingtalk():
            config = get_or_create_config(session)
            client = dingtalk_client(config)
            end_at = job.request_end_at or utc_now()
            start_at = job.request_start_at or end_at - timedelta(days=31)
            job.request_start_at = start_at
            job.request_end_at = end_at
            cursor = resume_cursor[1] if resume_cursor and resume_cursor[0] == template.process_code else 0
            template_processed = 0
            template_next_cursor: str | None = None
            for page_index in range(max_pages):
                ids, next_cursor = client.list_process_instance_ids(
                    template.process_code,
                    int(start_at.timestamp() * 1000),
                    int(end_at.timestamp() * 1000),
                    cursor=cursor,
                    size=page_size,
                )
                template_next_cursor = str(next_cursor) if next_cursor is not None else None
                for instance_id in ids:
                    job.processed_count += 1
                    template_processed += 1
                    raw_instance = client.get_process_instance(instance_id)
                    if sync_real_instance(session, template, job, raw_instance):
                        job.success_count += 1
                    else:
                        job.failed_count += 1
                        job.error_message = "Some approval instances are missing mapped store, amount or date"
                if not next_cursor or not ids:
                    template_next_cursor = None
                    break
                cursor = next_cursor
            else:
                incomplete_sync = True
                if template_next_cursor:
                    job.next_cursor = f"{template.process_code}:{template_next_cursor}"
                job.error_message = "DingTalk approval sync stopped at max_pages"
            template_summaries.append(
                {
                    "template_id": template.id,
                    "process_code": template.process_code,
                    "processed_count": template_processed,
                    "next_cursor": job.next_cursor,
                }
            )
        else:
            job.processed_count += 1
            instance = create_expense_from_instance(session, template, job)
            if instance is None:
                job.failed_count += 1
                job.error_message = "No store available for approval sync"
            else:
                job.success_count += 1
            template_summaries.append(
                {
                    "template_id": template.id,
                    "process_code": template.process_code,
                    "processed_count": 1,
                    "next_cursor": None,
                }
            )
        template.last_sync_at = utc_now()
    if not incomplete_sync:
        job.next_cursor = None
    job.status = (
        SyncJobStatus.SUCCEEDED.value
        if job.failed_count == 0 and not incomplete_sync
        else SyncJobStatus.FAILED.value
    )
    job.finished_at = utc_now()
    job.raw_summary = json.dumps({"templates": template_summaries}, ensure_ascii=False)
    config = get_or_create_config(session)
    config.last_instance_sync_at = utc_now()


@router.post("/approval-sync", response_model=ApiEnvelope[SyncJobRead], status_code=201)
def start_approval_sync(
    payload: StartApprovalSyncRequest,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[SyncJobRead]:
    query = select(ApprovalTemplate).where(ApprovalTemplate.is_enabled.is_(True))
    if payload.template_id:
        query = query.where(ApprovalTemplate.id == payload.template_id)
    templates = session.scalars(query.order_by(ApprovalTemplate.created_at.asc())).all()
    if not templates:
        raise HTTPException(status_code=404, detail="No enabled approval templates")

    job = SyncJob(
        job_type="dingtalk_approval_sync",
        status=SyncJobStatus.RUNNING.value,
        started_by=audit_actor(current_user, payload.started_by),
        started_at=utc_now(),
        request_start_at=payload.start_at,
        request_end_at=payload.end_at,
    )
    session.add(job)
    session.flush()

    try:
        run_approval_sync(
            session,
            job=job,
            templates=templates,
            page_size=payload.page_size,
            max_pages=payload.max_pages,
        )
        write_audit_log(
            session,
            actor=audit_actor(current_user, payload.started_by),
            action="dingtalk.approval_sync",
            resource_type="sync_job",
            resource_id=job.id,
            summary=f"同步钉钉审批：成功 {job.success_count} 条，失败 {job.failed_count} 条",
        )
        session.commit()
    except Exception as exc:
        job.status = SyncJobStatus.FAILED.value
        job.error_message = str(exc)
        job.finished_at = utc_now()
        session.commit()
        raise
    session.refresh(job)
    return ApiEnvelope(data=job)


@router.post("/sync-jobs/{job_id}/resume", response_model=ApiEnvelope[SyncJobRead], status_code=201)
def resume_approval_sync(
    job_id: str,
    payload: ResumeApprovalSyncRequest,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_roles(UserRole.ADMIN, UserRole.FINANCE)),
) -> ApiEnvelope[SyncJobRead]:
    previous_job = session.get(SyncJob, job_id)
    if previous_job is None:
        raise HTTPException(status_code=404, detail="Sync job not found")
    resume_cursor = parse_sync_cursor(previous_job.next_cursor)
    if previous_job.job_type != "dingtalk_approval_sync" or resume_cursor is None:
        raise HTTPException(status_code=409, detail="Sync job has no resumable cursor")
    process_code, _cursor = resume_cursor
    template = session.scalar(
        select(ApprovalTemplate).where(
            ApprovalTemplate.process_code == process_code,
            ApprovalTemplate.is_enabled.is_(True),
        )
    )
    if template is None:
        raise HTTPException(status_code=404, detail="Approval template for cursor not found")

    job = SyncJob(
        job_type="dingtalk_approval_sync",
        status=SyncJobStatus.RUNNING.value,
        started_by=audit_actor(current_user, payload.started_by),
        started_at=utc_now(),
        request_start_at=previous_job.request_start_at,
        request_end_at=previous_job.request_end_at,
        next_cursor=previous_job.next_cursor,
    )
    session.add(job)
    session.flush()

    try:
        run_approval_sync(
            session,
            job=job,
            templates=[template],
            page_size=payload.page_size,
            max_pages=payload.max_pages,
            resume_cursor=resume_cursor,
        )
        write_audit_log(
            session,
            actor=audit_actor(current_user, payload.started_by),
            action="dingtalk.approval_sync.resume",
            resource_type="sync_job",
            resource_id=job.id,
            summary=f"续跑钉钉审批同步：成功 {job.success_count} 条，失败 {job.failed_count} 条",
            metadata={"previous_job_id": previous_job.id, "resume_cursor": previous_job.next_cursor},
        )
        session.commit()
    except Exception as exc:
        job.status = SyncJobStatus.FAILED.value
        job.error_message = str(exc)
        job.finished_at = utc_now()
        session.commit()
        raise
    session.refresh(job)
    return ApiEnvelope(data=job)


@router.get("/sync-jobs", response_model=ApiEnvelope[Page[SyncJobRead]])
def list_sync_jobs(
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[SyncJobRead]]:
    query = select(SyncJob).order_by(SyncJob.created_at.desc())
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.get("/approval-instances", response_model=ApiEnvelope[Page[ApprovalInstanceRead]])
def list_approval_instances(
    template_id: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[ApprovalInstanceRead]]:
    query = select(ApprovalInstance).order_by(ApprovalInstance.created_at.desc())
    if template_id:
        query = query.where(ApprovalInstance.template_id == template_id)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))
