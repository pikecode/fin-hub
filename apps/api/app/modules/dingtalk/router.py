import json
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

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
    DingTalkAutoSyncSetting,
    DingTalkConfig,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
    Store,
    SyncJob,
    SyncJobStatus,
    TemplateFieldMapping,
    User,
    utc_now,
)
from app.models import DingTalkDepartment as DingTalkDepartmentModel
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_permission
from app.modules.common import paginate
from app.modules.dingtalk.client import DingTalkClient, DingTalkClientError, DingTalkCredentials
from app.schemas import (
    ApiEnvelope,
    ApprovalInstanceRead,
    ApprovalParsePreview,
    ApprovalReparseRequest,
    ApprovalReparseResult,
    ApprovalTemplateCreate,
    ApprovalTemplateRead,
    ApprovalTemplateUpdate,
    DingTalkAutoSyncRunResult,
    DingTalkAutoSyncSettingRead,
    DingTalkAutoSyncSettingUpdate,
    DingTalkConfigRead,
    DingTalkConfigUpdate,
    DingTalkDepartmentPullResult,
    DingTalkDepartmentRead,
    DingTalkDepartmentSyncPreview,
    DingTalkDepartmentSyncResult,
    Page,
    ResumeApprovalSyncRequest,
    StartApprovalSyncRequest,
    SyncJobRead,
    TemplateFieldCandidate,
    TemplateFieldCandidateSampleRequest,
    TemplateFieldMappingCreate,
    TemplateFieldMappingRead,
    TemplateFieldMappingReorderRequest,
    TemplateSampleApprovalResult,
)

router = APIRouter(
    prefix="/dingtalk",
    tags=["dingtalk"],
    dependencies=[Depends(require_permission("dingtalk.view"))],
)

AUTO_SYNC_TIMEZONE = ZoneInfo("Asia/Shanghai")
AUTO_SYNC_DEPARTMENT_ROOT_ID = "1"
AUTO_SYNC_DEPARTMENT_MAX_DEPTH = 8
AUTO_SYNC_APPROVAL_PAGE_SIZE = 100
AUTO_SYNC_APPROVAL_MAX_PAGES = 500
AUTO_SYNC_INITIAL_APPROVAL_LOOKBACK_DAYS = 3650


def template_mapping_status(session: Session, template_id: str) -> str:
    mapping_exists = session.scalar(
        select(TemplateFieldMapping.id).where(TemplateFieldMapping.template_id == template_id).limit(1)
    )
    return "mapped" if mapping_exists else "unmapped"


def template_read(session: Session, template: ApprovalTemplate) -> ApprovalTemplateRead:
    return ApprovalTemplateRead(
        id=template.id,
        process_code=template.process_code,
        name=template.name,
        is_enabled=template.is_enabled,
        mapping_status=template_mapping_status(session, template.id),
        last_sync_at=template.last_sync_at,
        raw_snapshot=template.raw_snapshot,
        created_at=template.created_at,
        updated_at=template.updated_at,
    )


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


def get_or_create_auto_sync_setting(session: Session) -> DingTalkAutoSyncSetting:
    setting = session.scalar(select(DingTalkAutoSyncSetting).order_by(DingTalkAutoSyncSetting.created_at.asc()))
    if setting is None:
        setting = DingTalkAutoSyncSetting()
        refresh_auto_sync_next_run(setting)
        session.add(setting)
        session.commit()
        session.refresh(setting)
    return setting


def refresh_auto_sync_next_run(setting: DingTalkAutoSyncSetting) -> None:
    hour, minute = map(int, (setting.scheduled_time or "02:00").split(":"))
    now_utc = utc_now().replace(tzinfo=UTC)
    now_local = now_utc.astimezone(AUTO_SYNC_TIMEZONE)
    next_local = datetime.combine(now_local.date(), time(hour=hour, minute=minute), tzinfo=AUTO_SYNC_TIMEZONE)
    if next_local <= now_local:
        next_local += timedelta(days=1)
    setting.next_run_at = next_local.astimezone(UTC).replace(tzinfo=None)


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


def is_seed_process_code(process_code: str) -> bool:
    return process_code.startswith("seed-")


@router.get("/config", response_model=ApiEnvelope[DingTalkConfigRead])
def read_config(session: Session = Depends(get_session)) -> ApiEnvelope[DingTalkConfigRead]:
    return ApiEnvelope(data=mask_config(get_or_create_config(session)))


@router.put("/config", response_model=ApiEnvelope[DingTalkConfigRead])
def update_config(
    payload: DingTalkConfigUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
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
    current_user: User = Depends(require_permission("dingtalk.manage")),
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


@router.get("/departments", response_model=ApiEnvelope[list[DingTalkDepartmentRead]])
def list_departments(
    include_inactive: bool = False,
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("dingtalk.view")),
) -> ApiEnvelope[list[DingTalkDepartmentRead]]:
    return ApiEnvelope(data=load_local_departments(session, include_inactive=include_inactive))


def pull_departments_core(
    session: Session,
    *,
    root_dept_id: str = "1",
    max_depth: int = 6,
) -> DingTalkDepartmentPullResult:
    config = get_or_create_config(session)
    try:
        pulled_departments = build_department_tree(
            dingtalk_client(config),
            root_dept_id=root_dept_id,
            max_depth=min(max(max_depth, 1), 8),
        )
    except DingTalkClientError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    result = upsert_dingtalk_departments(
        session,
        pulled_departments,
        root_dept_id=root_dept_id,
        max_depth=max_depth,
    )
    departments = load_local_departments(session)
    return DingTalkDepartmentPullResult(
        departments=departments,
        pulled_count=result["pulled_count"],
        created_count=result["created_count"],
        updated_count=result["updated_count"],
        deactivated_count=result["deactivated_count"],
        candidate_count=len([department for department in departments if department.is_store_candidate]),
    )


@router.post("/departments/pull", response_model=ApiEnvelope[DingTalkDepartmentPullResult])
def pull_departments(
    root_dept_id: str = "1",
    max_depth: int = 6,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[DingTalkDepartmentPullResult]:
    result = pull_departments_core(
        session,
        root_dept_id=root_dept_id,
        max_depth=max_depth,
    )
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.departments.pull",
        resource_type="dingtalk_department",
        summary=(
            f"拉取钉钉部门：拉取 {result.pulled_count} 个，"
            f"新增 {result.created_count} 个，更新 {result.updated_count} 个"
        ),
        metadata={
            "root_dept_id": root_dept_id,
            "max_depth": max_depth,
            "deactivated_count": result.deactivated_count,
        },
    )
    session.commit()
    return ApiEnvelope(data=result)


@router.get("/departments/sync-preview", response_model=ApiEnvelope[DingTalkDepartmentSyncPreview])
def preview_department_sync(
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("dingtalk.view")),
) -> ApiEnvelope[DingTalkDepartmentSyncPreview]:
    departments = load_local_departments(session)
    return ApiEnvelope(data=build_department_sync_preview(session, departments))


def sync_departments_to_stores_core(session: Session) -> DingTalkDepartmentSyncResult:
    departments = load_local_departments(session)
    created_count = 0
    updated_count = 0
    skipped_count = 0
    synced_stores: list[Store] = []
    for department in departments:
        if not department.is_store_candidate:
            skipped_count += 1
            continue
        department_model = session.scalar(
            select(DingTalkDepartmentModel).where(DingTalkDepartmentModel.dept_id == department.dept_id)
        )
        store = session.scalar(select(Store).where(Store.dingtalk_dept_id == department.dept_id))
        if store is None:
            store = session.scalar(select(Store).where(Store.name == department.name))
        if store is None:
            store = Store(name=department.name, dingtalk_dept_id=department.dept_id)
            session.add(store)
            created_count += 1
        else:
            changed = False
            if store.dingtalk_dept_id != department.dept_id:
                store.dingtalk_dept_id = department.dept_id
                changed = True
            if store.name != department.name:
                store.name = department.name
                changed = True
            if changed:
                updated_count += 1
            else:
                skipped_count += 1
        if department_model is not None and department_model.store_id != store.id:
            department_model.store_id = store.id
        synced_stores.append(store)
    session.flush()
    for store in synced_stores:
        session.refresh(store)
    return DingTalkDepartmentSyncResult(
        created_count=created_count,
        updated_count=updated_count,
        skipped_count=skipped_count,
        stores=synced_stores,
    )


@router.post("/departments/sync", response_model=ApiEnvelope[DingTalkDepartmentSyncResult])
def sync_departments_to_stores(
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[DingTalkDepartmentSyncResult]:
    result = sync_departments_to_stores_core(session)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.departments.sync",
        resource_type="store",
        summary=f"同步钉钉门店部门：新增 {result.created_count} 个，更新 {result.updated_count} 个",
        metadata={"skipped_count": result.skipped_count},
    )
    session.commit()
    return ApiEnvelope(data=result)


@router.get("/templates", response_model=ApiEnvelope[Page[ApprovalTemplateRead]])
def list_templates(
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[ApprovalTemplateRead]]:
    query = select(ApprovalTemplate).order_by(
        ApprovalTemplate.is_enabled.desc(),
        ApprovalTemplate.created_at.desc(),
    )
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(
        data=Page(
            items=[template_read(session, item) for item in items],
            total=total,
            page=page,
            page_size=page_size,
        )
    )


@router.get("/templates/{template_id}", response_model=ApiEnvelope[ApprovalTemplateRead])
def get_template(
    template_id: str,
    session: Session = Depends(get_session),
) -> ApiEnvelope[ApprovalTemplateRead]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    return ApiEnvelope(data=template_read(session, template))


@router.post("/templates", response_model=ApiEnvelope[ApprovalTemplateRead], status_code=201)
def create_template(
    payload: ApprovalTemplateCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
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
    return ApiEnvelope(data=template_read(session, template))


@router.patch("/templates/{template_id}", response_model=ApiEnvelope[ApprovalTemplateRead])
def update_template(
    template_id: str,
    payload: ApprovalTemplateUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[ApprovalTemplateRead]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    updates = payload.model_dump(exclude_unset=True)
    for key, value in updates.items():
        setattr(template, key, value)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.template.update",
        resource_type="approval_template",
        resource_id=template.id,
        summary=f"更新审批模板：{template.name}",
        metadata=updates,
    )
    session.commit()
    session.refresh(template)
    return ApiEnvelope(data=template_read(session, template))


def sync_templates_core(session: Session) -> dict[str, int]:
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
    now = utc_now()
    created = 0
    updated = 0
    for process_code, name, raw_snapshot in samples:
        template = session.scalar(
            select(ApprovalTemplate).where(ApprovalTemplate.process_code == process_code)
        )
        if template is None:
            template = ApprovalTemplate(
                process_code=process_code,
                name=name,
                last_sync_at=now,
                raw_snapshot=raw_snapshot,
            )
            session.add(template)
            created += 1
        else:
            if template.name != name or template.raw_snapshot != raw_snapshot:
                updated += 1
            template.name = name
            template.raw_snapshot = raw_snapshot
            template.last_sync_at = now
    config.last_template_sync_at = now
    return {"pulled": len(samples), "created": created, "updated": updated}


@router.post("/templates/sync", response_model=ApiEnvelope[dict[str, int]])
def sync_templates(
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[dict[str, int]]:
    config = get_or_create_config(session)
    result = sync_templates_core(session)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.templates.sync",
        resource_type="dingtalk_config",
        resource_id=config.id,
        summary=f"同步钉钉模板：拉取 {result['pulled']} 个，新增 {result['created']} 个，更新 {result['updated']} 个",
    )
    session.commit()
    return ApiEnvelope(data=result)


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
    for key in ("id", "key", "field_id", "fieldId", "component_id", "componentId"):
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


def candidate_sample_value(value: dict[str, Any]) -> Any:
    for key in ("value", "ext_value", "extValue"):
        if key in value:
            return value.get(key)
    return None


def parsed_json_value(value: Any) -> Any:
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except ValueError:
        return value


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
                    sample_value=candidate_sample_value(value),
                )
            )
        for key, child in value.items():
            child_path = f"{path}.{key}" if path else str(key)
            candidates.extend(collect_field_candidates(child, child_path))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            candidates.extend(collect_field_candidates(child, f"{path}[{index}]"))
    return candidates


def collect_approval_form_field_candidates(raw_instance: dict[str, Any]) -> list[TemplateFieldCandidate]:
    components = raw_instance.get("form_component_values") or raw_instance.get("formComponentValues") or []
    candidates: list[TemplateFieldCandidate] = []
    root_fields = [
        ("business_id", "审批编号", "TextField"),
        ("title", "审批标题", "TextField"),
        ("status", "审批状态", "TextField"),
        ("result", "审批结果", "TextField"),
        ("create_time", "提交时间", "DDDateField"),
        ("finish_time", "完成时间", "DDDateField"),
        ("originator_userid", "发起人 User ID", "TextField"),
        ("originator_dept_id", "发起部门 ID", "TextField"),
        ("originator_dept_name", "发起部门", "TextField"),
        ("biz_action", "业务动作", "TextField"),
        ("cc_userids", "抄送人 User ID", "TextField"),
        ("attached_process_instance_ids", "关联审批实例", "TextField"),
    ]
    for key, label, field_type in root_fields:
        if key not in raw_instance:
            continue
        candidates.append(
            TemplateFieldCandidate(
                source_field_id=key,
                source_field_name=label,
                source_path=f"root:{key}",
                field_type=field_type,
                sample_value=raw_instance.get(key),
            )
        )

    if not isinstance(components, list):
        return candidates

    for component in components:
        if not isinstance(component, dict):
            continue
        field_name = candidate_label(component)
        if not field_name:
            continue
        field_id = candidate_field_id(component)
        field_type = candidate_field_type(component)
        sample_value = candidate_sample_value(component)
        parsed_value = parsed_json_value(sample_value)
        is_table = field_type == "TableField" or (
            isinstance(parsed_value, list)
            and any(isinstance(row, dict) and isinstance(row.get("rowValue") or row.get("row_value"), list) for row in parsed_value)
        )
        if not is_table:
            candidates.append(
                TemplateFieldCandidate(
                    source_field_id=field_id,
                    source_field_name=field_name,
                    source_path=f"field:{field_id or field_name}",
                    field_type=field_type,
                    sample_value=sample_value,
                )
            )
            continue

        if not isinstance(parsed_value, list):
            continue
        seen_table_fields: set[str] = set()
        for row in parsed_value:
            if not isinstance(row, dict):
                continue
            cells = row.get("rowValue") or row.get("row_value") or []
            if not isinstance(cells, list):
                continue
            for cell in cells:
                if not isinstance(cell, dict):
                    continue
                cell_name = candidate_label(cell)
                if not cell_name or cell_name in seen_table_fields:
                    continue
                seen_table_fields.add(cell_name)
                cell_id = candidate_field_id(cell)
                candidates.append(
                    TemplateFieldCandidate(
                        source_field_id=cell_id,
                        source_field_name=f"{field_name}.{cell_name}",
                        source_path=f"table:{field_id or field_name}:{cell_id or cell_name}",
                        field_type=candidate_field_type(cell),
                        sample_value=candidate_sample_value(cell),
                    )
                )
    return candidates


def unique_field_candidates(candidates: list[TemplateFieldCandidate]) -> list[TemplateFieldCandidate]:
    unique: dict[tuple[str | None, str], TemplateFieldCandidate] = {}
    for candidate in candidates:
        key = (candidate.source_field_id, candidate.source_field_name)
        if key not in unique:
            unique[key] = candidate
            continue
        existing = unique[key]
        if existing.sample_value in (None, "") and candidate.sample_value not in (None, ""):
            unique[key] = candidate
    return list(unique.values())


def field_candidates_for_template(session: Session, template: ApprovalTemplate) -> list[TemplateFieldCandidate]:
    instance = session.scalar(
        select(ApprovalInstance)
        .where(ApprovalInstance.template_id == template.id)
        .order_by(ApprovalInstance.updated_at.desc(), ApprovalInstance.created_at.desc())
    )
    if not instance or not instance.raw_payload:
        return []
    try:
        return unique_field_candidates(collect_approval_form_field_candidates(json.loads(instance.raw_payload)))
    except ValueError:
        return []


def applicant_name_from_raw(raw_instance: dict[str, Any]) -> str | None:
    direct = parse_text(raw_instance.get("originator_user_name") or raw_instance.get("originatorUserName"))
    if direct:
        return direct
    title = parse_text(raw_instance.get("title") or raw_instance.get("titleName"))
    if title and "提交" in title:
        name = title.split("提交", 1)[0].strip()
        return name or None
    return None


def department_name_from_raw(
    session: Session,
    raw_instance: dict[str, Any],
    store: Store | None = None,
) -> str | None:
    direct = parse_text(raw_instance.get("originator_dept_name") or raw_instance.get("originatorDeptName"))
    if direct:
        return direct
    parsed = raw_instance.get("_fin_hub_parse")
    if isinstance(parsed, dict):
        parsed_name = parse_text(parsed.get("originator_dept_name"))
        if parsed_name:
            return parsed_name
    dept_id = parse_text(raw_instance.get("originator_dept_id") or raw_instance.get("originatorDeptId"))
    if dept_id:
        department = session.scalar(select(DingTalkDepartmentModel).where(DingTalkDepartmentModel.dept_id == dept_id))
        if department is not None:
            return department.path or department.name
        dept_store = session.scalar(select(Store).where(Store.dingtalk_dept_id == dept_id))
        if dept_store is not None:
            return dept_store.name
    return store.name if store else None


def save_sample_approval_instance(
    session: Session,
    template: ApprovalTemplate,
    raw_instance: dict[str, Any],
) -> ApprovalInstance | None:
    instance_id = str(raw_instance.get("process_instance_id") or raw_instance.get("processInstanceId") or "")
    if not instance_id:
        return None
    instance = session.scalar(select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == instance_id))
    if instance is None:
        instance = ApprovalInstance(template_id=template.id, dingtalk_instance_id=instance_id)
        session.add(instance)
    instance.template_id = template.id
    instance.approval_no = parse_text(raw_instance.get("business_id") or raw_instance.get("businessId"))
    instance.department_name = department_name_from_raw(session, raw_instance)
    instance.applicant_name = applicant_name_from_raw(raw_instance)
    instance.applicant_user_id = parse_text(raw_instance.get("originator_userid") or raw_instance.get("originatorUserId"))
    instance.approval_status = parse_text(raw_instance.get("result") or raw_instance.get("status")) or "unknown"
    instance.submit_at = DingTalkClient.parse_time(raw_instance.get("create_time") or raw_instance.get("createTime"))
    instance.approved_at = DingTalkClient.parse_time(raw_instance.get("finish_time") or raw_instance.get("finishTime"))
    instance.raw_payload = json.dumps(raw_instance, ensure_ascii=False)
    session.flush()
    return instance


def approval_raw_payload(instance: ApprovalInstance) -> dict[str, Any]:
    if not instance.raw_payload:
        return {}
    try:
        parsed = json.loads(instance.raw_payload)
    except ValueError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def approval_originator_dept_id(payload: dict[str, Any]) -> str | None:
    value = payload.get("originator_dept_id") or payload.get("originatorDeptId")
    return parse_text(value)


def approval_originator_dept_name(payload: dict[str, Any]) -> str | None:
    value = payload.get("originator_dept_name") or payload.get("originatorDeptName")
    if parse_text(value):
        return parse_text(value)
    parsed = payload.get("_fin_hub_parse")
    if isinstance(parsed, dict):
        return parse_text(parsed.get("originator_dept_name"))
    return None


def resolve_approval_department_name(session: Session, instance: ApprovalInstance) -> str | None:
    if instance.department_name:
        return instance.department_name
    payload = approval_raw_payload(instance)
    direct_name = approval_originator_dept_name(payload)
    if direct_name:
        return direct_name

    dept_id = approval_originator_dept_id(payload)
    if dept_id:
        department = session.scalar(
            select(DingTalkDepartmentModel).where(DingTalkDepartmentModel.dept_id == dept_id)
        )
        if department is not None:
            return department.path or department.name
        store = session.scalar(select(Store).where(Store.dingtalk_dept_id == dept_id))
        if store is not None:
            return store.name

    if instance.store_id:
        store = session.get(Store, instance.store_id)
        if store is not None:
            return store.name
    return None


def approval_instance_read(session: Session, instance: ApprovalInstance) -> ApprovalInstanceRead:
    return ApprovalInstanceRead(
        id=instance.id,
        template_id=instance.template_id,
        dingtalk_instance_id=instance.dingtalk_instance_id,
        approval_no=instance.approval_no,
        store_id=instance.store_id,
        department_name=resolve_approval_department_name(session, instance),
        applicant_name=instance.applicant_name,
        applicant_user_id=instance.applicant_user_id,
        approval_status=instance.approval_status,
        submit_at=instance.submit_at,
        approved_at=instance.approved_at,
        raw_payload=instance.raw_payload,
        synced_job_id=instance.synced_job_id,
        created_at=instance.created_at,
        updated_at=instance.updated_at,
    )


def last_department_name(value: str | None) -> str | None:
    if not value:
        return None
    parts = [part.strip() for part in value.replace("/", "-").split("-") if part.strip()]
    return parts[-1] if parts else value.strip()


def department_path(value: dict[str, Any], parent_path: str) -> str:
    name = str(value.get("name") or value.get("dept_name") or value.get("deptName") or "")
    return f"{parent_path}-{name}" if parent_path else name


def department_id(value: dict[str, Any]) -> str:
    return str(value.get("dept_id") or value.get("deptId") or value.get("id") or "")


def department_parent_id(value: dict[str, Any]) -> str | None:
    parent = value.get("parent_id") or value.get("parentId")
    return str(parent) if parent not in (None, "") else None


def looks_like_store_department(name: str, path: str, child_names: list[str]) -> bool:
    if "门店运营部" not in path:
        return False
    non_store_words = ("运营部", "门店群", "区", "部门", "前厅", "后厨", "财务", "采购", "人力", "行政", "招商", "市场", "建店")
    if any(word in name for word in non_store_words):
        return False
    has_front_or_kitchen = any("前厅" in child_name or "后厨" in child_name for child_name in child_names)
    return has_front_or_kitchen or "店" in name or "城" in name or "万达" in name


def build_department_tree(
    client: DingTalkClient,
    *,
    root_dept_id: str = "1",
    max_depth: int = 6,
) -> list[DingTalkDepartmentRead]:
    rows: list[DingTalkDepartmentRead] = []
    seen: set[str] = set()

    def walk(dept_id: str, parent_path: str, depth: int) -> None:
        if dept_id in seen or depth > max_depth:
            return
        seen.add(dept_id)
        children = client.list_child_departments(dept_id)
        for child in children:
            child_id = department_id(child)
            name = str(child.get("name") or child.get("dept_name") or child.get("deptName") or "")
            if not child_id or not name:
                continue
            path = department_path(child, parent_path)
            grandchildren = client.list_child_departments(child_id) if depth < max_depth else []
            child_names = [
                str(item.get("name") or item.get("dept_name") or item.get("deptName") or "")
                for item in grandchildren
                if isinstance(item, dict)
            ]
            rows.append(
                DingTalkDepartmentRead(
                    dept_id=child_id,
                    name=name,
                    parent_id=department_parent_id(child),
                    path=path,
                    depth=depth,
                    is_store_candidate=looks_like_store_department(name, path, child_names),
                )
            )
            if child_id and depth < max_depth:
                walk(child_id, path, depth + 1)

    walk(root_dept_id, "", 0)
    return rows


def enrich_departments_with_stores(
    session: Session,
    departments: list[DingTalkDepartmentRead],
) -> list[DingTalkDepartmentRead]:
    stores = list(session.scalars(select(Store)))
    stores_by_dept_id = {str(store.dingtalk_dept_id): store for store in stores if store.dingtalk_dept_id}
    stores_by_name = {store.name: store for store in stores}
    enriched: list[DingTalkDepartmentRead] = []
    for department in departments:
        store = stores_by_dept_id.get(department.dept_id) or stores_by_name.get(department.name)
        enriched.append(
            department.model_copy(
                update={
                    "store_id": store.id if store else None,
                    "store_name": store.name if store else None,
                }
            )
        )
    return enriched


def department_model_to_read(
    department: DingTalkDepartmentModel,
    store: Store | None = None,
) -> DingTalkDepartmentRead:
    return DingTalkDepartmentRead(
        dept_id=department.dept_id,
        name=department.name,
        parent_id=department.parent_id,
        path=department.path,
        depth=department.depth,
        is_store_candidate=department.is_store_candidate,
        store_id=department.store_id or (store.id if store else None),
        store_name=store.name if store else None,
        is_active=department.is_active,
        last_seen_at=department.last_seen_at,
        last_synced_at=department.last_synced_at,
    )


def load_local_departments(
    session: Session,
    *,
    include_inactive: bool = False,
) -> list[DingTalkDepartmentRead]:
    query = select(DingTalkDepartmentModel)
    if not include_inactive:
        query = query.where(DingTalkDepartmentModel.is_active.is_(True))
    departments = list(session.scalars(query.order_by(DingTalkDepartmentModel.path.asc())))
    stores = list(session.scalars(select(Store)))
    stores_by_id = {store.id: store for store in stores}
    stores_by_dept_id = {str(store.dingtalk_dept_id): store for store in stores if store.dingtalk_dept_id}
    stores_by_name = {store.name: store for store in stores}

    rows: list[DingTalkDepartmentRead] = []
    for department in departments:
        store = (
            stores_by_id.get(department.store_id or "")
            or stores_by_dept_id.get(department.dept_id)
            or stores_by_name.get(department.name)
        )
        rows.append(department_model_to_read(department, store))
    return rows


def upsert_dingtalk_departments(
    session: Session,
    departments: list[DingTalkDepartmentRead],
    *,
    root_dept_id: str,
    max_depth: int,
) -> dict[str, int]:
    now = utc_now()
    stores = list(session.scalars(select(Store)))
    stores_by_dept_id = {str(store.dingtalk_dept_id): store for store in stores if store.dingtalk_dept_id}
    stores_by_name = {store.name: store for store in stores}
    existing = {
        department.dept_id: department
        for department in session.scalars(select(DingTalkDepartmentModel))
    }
    seen_ids = {department.dept_id for department in departments}
    created_count = 0
    updated_count = 0

    for department in departments:
        store = stores_by_dept_id.get(department.dept_id) or stores_by_name.get(department.name)
        raw_payload = json.dumps(
            {
                "dept_id": department.dept_id,
                "parent_id": department.parent_id,
                "name": department.name,
                "path": department.path,
                "depth": department.depth,
                "root_dept_id": root_dept_id,
                "max_depth": max_depth,
            },
            ensure_ascii=False,
        )
        row = existing.get(department.dept_id)
        if row is None:
            session.add(
                DingTalkDepartmentModel(
                    dept_id=department.dept_id,
                    parent_id=department.parent_id,
                    name=department.name,
                    path=department.path,
                    depth=department.depth,
                    is_store_candidate=department.is_store_candidate,
                    store_id=store.id if store else None,
                    raw_payload=raw_payload,
                    is_active=True,
                    last_seen_at=now,
                    last_synced_at=now,
                )
            )
            created_count += 1
            continue

        changed = False
        updates = {
            "parent_id": department.parent_id,
            "name": department.name,
            "path": department.path,
            "depth": department.depth,
            "is_store_candidate": department.is_store_candidate,
            "store_id": store.id if store else row.store_id,
            "raw_payload": raw_payload,
            "is_active": True,
        }
        for key, value in updates.items():
            if getattr(row, key) != value:
                setattr(row, key, value)
                changed = True
        row.last_seen_at = now
        row.last_synced_at = now
        if changed:
            updated_count += 1

    deactivated_count = 0
    for dept_id, row in existing.items():
        if row.is_active and dept_id not in seen_ids:
            row.is_active = False
            row.last_synced_at = now
            deactivated_count += 1

    session.flush()
    return {
        "pulled_count": len(departments),
        "created_count": created_count,
        "updated_count": updated_count,
        "deactivated_count": deactivated_count,
    }


def build_department_sync_preview(
    session: Session,
    departments: list[DingTalkDepartmentRead],
) -> DingTalkDepartmentSyncPreview:
    enriched = enrich_departments_with_stores(session, departments)
    stores = list(session.scalars(select(Store)))
    stores_by_dept_id = {str(store.dingtalk_dept_id): store for store in stores if store.dingtalk_dept_id}
    stores_by_name = {store.name: store for store in stores}
    candidates = [department for department in enriched if department.is_store_candidate]
    existing_count = 0
    update_count = 0
    create_count = 0
    for department in candidates:
        store_by_dept = stores_by_dept_id.get(department.dept_id)
        store_by_name = stores_by_name.get(department.name)
        if store_by_dept and store_by_dept.name == department.name:
            existing_count += 1
        elif store_by_dept or store_by_name:
            update_count += 1
        else:
            create_count += 1
    return DingTalkDepartmentSyncPreview(
        departments=enriched,
        candidate_count=len(candidates),
        existing_count=existing_count,
        create_count=create_count,
        update_count=update_count,
    )


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

    return ApiEnvelope(data=field_candidates_for_template(session, template))


@router.post(
    "/templates/{template_id}/sample-approval",
    response_model=ApiEnvelope[TemplateSampleApprovalResult],
)
def pull_template_sample_approval(
    template_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[TemplateSampleApprovalResult]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    if not template.is_enabled:
        raise HTTPException(status_code=409, detail="Template is disabled")
    if should_use_real_dingtalk() and is_seed_process_code(template.process_code):
        raise HTTPException(
            status_code=409,
            detail="当前模板是本地演示模板，不是钉钉真实审批模板；请先在审批模板页选择 process_code 为 PROC- 开头的模板。",
        )

    if not should_use_real_dingtalk():
        raw_instance = {
            "process_instance_id": f"sample-{template.id}",
            "business_id": f"SAMPLE-{template.name}",
            "status": "COMPLETED",
            "result": "agree",
            "create_time": "2026-08-29 10:00:00",
            "form_component_values": [
                {"id": "sample-store", "name": "支出门店", "componentType": "TextField", "value": "样例门店"},
                {"id": "sample-amount", "name": "汇总金额（元）", "componentType": "MoneyField", "value": "328.00"},
            ],
        }
        instance = save_sample_approval_instance(session, template, raw_instance)
        session.commit()
        return ApiEnvelope(
            data=TemplateSampleApprovalResult(
                instance=instance,
                field_candidates=field_candidates_for_template(session, template),
                pulled_count=1 if instance else 0,
            )
        )

    config = get_or_create_config(session)
    client = dingtalk_client(config)
    end_at = utc_now()
    start_at = end_at - timedelta(days=30)
    try:
        ids, _next_cursor = client.list_process_instance_ids(
            template.process_code,
            int(start_at.timestamp() * 1000),
            int(end_at.timestamp() * 1000),
            cursor=0,
            size=1,
        )
        instance = None
        if ids:
            raw_instance = client.get_process_instance(ids[0])
            raw_instance.setdefault("process_instance_id", ids[0])
            instance = save_sample_approval_instance(session, template, raw_instance)
        write_audit_log(
            session,
            actor=audit_actor(current_user),
            action="dingtalk.template_sample_approval.pull",
            resource_type="approval_template",
            resource_id=template.id,
            summary=f"拉取审批模板样例审批：{template.name}",
            metadata={"process_code": template.process_code, "pulled_count": 1 if instance else 0},
        )
        session.commit()
    except DingTalkClientError as exc:
        session.rollback()
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    return ApiEnvelope(
        data=TemplateSampleApprovalResult(
            instance=instance,
            field_candidates=field_candidates_for_template(session, template),
            pulled_count=1 if instance else 0,
        )
    )


@router.post(
    "/templates/{template_id}/field-candidate-sample",
    response_model=ApiEnvelope[TemplateSampleApprovalResult],
)
def use_approval_instance_as_field_candidate_sample(
    template_id: str,
    payload: TemplateFieldCandidateSampleRequest,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[TemplateSampleApprovalResult]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    instance = session.get(ApprovalInstance, payload.approval_instance_id)
    if instance is None or instance.template_id != template_id:
        raise HTTPException(status_code=404, detail="Approval instance not found for template")
    instance.updated_at = utc_now()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.template_field_sample.select",
        resource_type="approval_instance",
        resource_id=instance.id,
        summary=f"选择审批实例作为字段显示配置样例：{template.name}",
        metadata={"template_id": template_id, "dingtalk_instance_id": instance.dingtalk_instance_id},
    )
    session.commit()
    session.refresh(instance)
    return ApiEnvelope(
        data=TemplateSampleApprovalResult(
            instance=instance,
            field_candidates=field_candidates_for_template(session, template),
            pulled_count=1,
        )
    )


@router.post(
    "/templates/{template_id}/mappings",
    response_model=ApiEnvelope[TemplateFieldMappingRead],
    status_code=201,
)
def upsert_template_mapping(
    template_id: str,
    payload: TemplateFieldMappingCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
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


@router.patch(
    "/templates/{template_id}/mappings/{mapping_id}",
    response_model=ApiEnvelope[TemplateFieldMappingRead],
)
def update_template_mapping(
    template_id: str,
    mapping_id: str,
    payload: TemplateFieldMappingCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[TemplateFieldMappingRead]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    mapping = session.get(TemplateFieldMapping, mapping_id)
    if mapping is None or mapping.template_id != template_id:
        raise HTTPException(status_code=404, detail="Template mapping not found")
    for key, value in payload.model_dump().items():
        setattr(mapping, key, value)
    template.mapping_status = "mapped"
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.template_mapping.update",
        resource_type="template_field_mapping",
        resource_id=mapping.id,
        summary=f"编辑审批字段映射：{payload.source_field_name}",
        metadata={"template_id": template_id},
    )
    session.commit()
    session.refresh(mapping)
    return ApiEnvelope(data=mapping)


@router.post(
    "/templates/{template_id}/mappings/reorder",
    response_model=ApiEnvelope[list[TemplateFieldMappingRead]],
)
def reorder_template_mappings(
    template_id: str,
    payload: TemplateFieldMappingReorderRequest,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[list[TemplateFieldMappingRead]]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    mappings = session.scalars(
        select(TemplateFieldMapping).where(TemplateFieldMapping.template_id == template_id)
    ).all()
    mappings_by_id = {mapping.id: mapping for mapping in mappings}
    requested_ids = [item.id for item in payload.items]
    requested_id_set = set(requested_ids)
    if len(requested_ids) != len(requested_id_set):
        raise HTTPException(status_code=400, detail="Duplicate template mapping ids")
    if requested_id_set != set(mappings_by_id):
        raise HTTPException(status_code=404, detail="Template mapping not found")
    for item in payload.items:
        mappings_by_id[item.id].sort_order = item.sort_order
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.template_mapping.reorder",
        resource_type="approval_template",
        resource_id=template_id,
        summary=f"调整审批字段显示顺序：{template.name}",
        metadata={"mapping_ids": [item.id for item in payload.items]},
    )
    session.commit()
    ordered = session.scalars(
        select(TemplateFieldMapping)
        .where(TemplateFieldMapping.template_id == template_id)
        .order_by(TemplateFieldMapping.sort_order.asc(), TemplateFieldMapping.created_at.asc())
    ).all()
    return ApiEnvelope(data=ordered)


@router.delete(
    "/templates/{template_id}/mappings/{mapping_id}",
    response_model=ApiEnvelope[dict[str, bool]],
)
def delete_template_mapping(
    template_id: str,
    mapping_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[dict[str, bool]]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    mapping = session.get(TemplateFieldMapping, mapping_id)
    if mapping is None or mapping.template_id != template_id:
        raise HTTPException(status_code=404, detail="Template mapping not found")
    session.delete(mapping)
    session.flush()
    remaining = session.scalar(
        select(TemplateFieldMapping).where(TemplateFieldMapping.template_id == template_id).limit(1)
    )
    if remaining is None:
        template.mapping_status = "unmapped"
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.template_mapping.delete",
        resource_type="template_field_mapping",
        resource_id=mapping_id,
        summary=f"删除审批字段映射：{mapping.source_field_name}",
        metadata={"template_id": template_id},
    )
    session.commit()
    return ApiEnvelope(data={"ok": True})


@router.get(
    "/templates/{template_id}/parse-preview",
    response_model=ApiEnvelope[ApprovalParsePreview],
)
def preview_template_parse(
    template_id: str,
    instance_id: str | None = None,
    session: Session = Depends(get_session),
) -> ApiEnvelope[ApprovalParsePreview]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    query = select(ApprovalInstance).where(ApprovalInstance.template_id == template_id)
    if instance_id:
        query = query.where(ApprovalInstance.id == instance_id)
    instance = session.scalar(query.order_by(ApprovalInstance.created_at.desc()))
    if instance is None:
        raise HTTPException(status_code=404, detail="Approval instance not found")
    return ApiEnvelope(data=build_approval_parse_preview(session, template, instance))


@router.post(
    "/templates/{template_id}/reparse",
    response_model=ApiEnvelope[ApprovalReparseResult],
)
def reparse_template_instances(
    template_id: str,
    payload: ApprovalReparseRequest,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[ApprovalReparseResult]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    query = select(ApprovalInstance).where(ApprovalInstance.template_id == template_id)
    if payload.instance_id:
        query = query.where(ApprovalInstance.id == payload.instance_id)
    instances = list(session.scalars(query.order_by(ApprovalInstance.created_at.desc()).limit(payload.limit)))
    job = SyncJob(
        job_type="dingtalk_approval_reparse",
        status=SyncJobStatus.RUNNING.value,
        started_by=payload.started_by,
        started_at=utc_now(),
    )
    session.add(job)
    session.flush()

    reparsed_count = 0
    skipped_count = 0
    before_ids = {
        item.id
        for item in session.scalars(
            select(ExpenseItem).where(ExpenseItem.source == "dingtalk", ExpenseItem.source_document_id.is_not(None))
        )
    }
    for instance in instances:
        if not instance.raw_payload:
            skipped_count += 1
            continue
        try:
            raw_instance = json.loads(instance.raw_payload)
        except ValueError:
            skipped_count += 1
            continue
        delete_unmatched_dingtalk_expenses_for_instance(session, instance)
        if sync_real_instance(session, template, job, raw_instance):
            reparsed_count += 1
        else:
            skipped_count += 1

    after_ids = {
        item.id
        for item in session.scalars(
            select(ExpenseItem).where(ExpenseItem.source == "dingtalk", ExpenseItem.source_document_id.is_not(None))
        )
    }
    created_expense_count = len(after_ids - before_ids)
    job.status = SyncJobStatus.SUCCEEDED.value
    job.finished_at = utc_now()
    job.processed_count = len(instances)
    job.success_count = reparsed_count
    job.failed_count = skipped_count
    job.raw_summary = json.dumps(
        {"template_id": template_id, "created_expense_count": created_expense_count},
        ensure_ascii=False,
    )
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.approval_reparse",
        resource_type="approval_template",
        resource_id=template_id,
        summary=f"重新解析审批实例：{reparsed_count} 条",
        metadata={"template_id": template_id, "instance_id": payload.instance_id},
    )
    session.commit()
    session.refresh(job)
    return ApiEnvelope(
        data=ApprovalReparseResult(
            processed_count=len(instances),
            reparsed_count=reparsed_count,
            skipped_count=skipped_count,
            created_expense_count=created_expense_count,
            job=job,
        )
    )


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


def normalize_label(value: str) -> str:
    return value.replace(" ", "").replace("（", "(").replace("）", ")").lower()


def form_component_values(raw_instance: dict[str, Any]) -> list[dict[str, Any]]:
    components = raw_instance.get("form_component_values") or raw_instance.get("formComponentValues") or []
    return [component for component in components if isinstance(component, dict)] if isinstance(components, list) else []


def find_form_value(raw_instance: dict[str, Any], *names: str) -> Any:
    expected_names = {normalize_label(name) for name in names}
    for component in form_component_values(raw_instance):
        labels = [
            component.get("name"),
            component.get("label"),
            component.get("id"),
            component.get("componentName"),
        ]
        if any(value is not None and normalize_label(str(value)) in expected_names for value in labels):
            return component.get("value") or component.get("ext_value") or component.get("extValue")
    return None


def raw_path_value(raw_instance: dict[str, Any], path: str | None) -> Any:
    if not path:
        return None
    if path.startswith("root:"):
        return raw_instance.get(path.removeprefix("root:"))
    if path.startswith("field:"):
        return field_value_from_raw_instance(raw_instance, path.removeprefix("field:"))
    if path.startswith("table:"):
        parts = path.split(":", 2)
        if len(parts) != 3:
            return None
        _, table_key, cell_key = parts
        return table_value_from_raw_instance(raw_instance, table_key, cell_key)
    return None


def field_value_from_raw_instance(raw_instance: dict[str, Any], field_key: str) -> Any:
    for component in form_component_values(raw_instance):
        if any(str(component.get(key)) == field_key for key in ("id", "name", "label", "key") if component.get(key)):
            return component.get("value") or component.get("ext_value") or component.get("extValue")
    return None


def table_value_from_raw_instance(raw_instance: dict[str, Any], table_key: str, cell_key: str) -> Any:
    components = raw_instance.get("form_component_values") or raw_instance.get("formComponentValues") or []
    if not isinstance(components, list):
        return None
    table = next(
        (
            component
            for component in components
            if isinstance(component, dict)
            and any(str(component.get(key)) == table_key for key in ("id", "name", "label", "key") if component.get(key))
        ),
        None,
    )
    if not isinstance(table, dict):
        return None
    rows = table.get("value")
    if isinstance(rows, str):
        try:
            rows = json.loads(rows)
        except ValueError:
            return None
    if not isinstance(rows, list):
        return None
    values: list[Any] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        cells = row.get("rowValue") or row.get("row_value") or []
        if not isinstance(cells, list):
            continue
        for cell in cells:
            if not isinstance(cell, dict):
                continue
            if any(str(cell.get(key)) == cell_key for key in ("key", "id", "name", "label", "title") if cell.get(key)):
                value = cell.get("value") or cell.get("ext_value") or cell.get("extValue")
                if value not in (None, ""):
                    values.append(value)
    if not values:
        return None
    return values[0] if len(values) == 1 else values


def mapped_value(mapping: TemplateFieldMapping, values: dict[str, Any], raw_instance: dict[str, Any]) -> Any:
    path_value = raw_path_value(raw_instance, mapping.source_path)
    if path_value not in (None, ""):
        return path_value
    if mapping.source_field_id and mapping.source_field_id in values:
        return values[mapping.source_field_id]
    return values.get(mapping.source_field_name)


def mapped_values_for_template(
    session: Session,
    template_id: str,
    raw_instance: dict[str, Any],
) -> dict[str, Any]:
    values = form_value_map(raw_instance)
    mappings = session.scalars(
        select(TemplateFieldMapping).where(TemplateFieldMapping.template_id == template_id)
    ).all()
    return {mapping.standard_field: mapped_value(mapping, values, raw_instance) for mapping in mappings}


def mapped_or_form_value(
    mapped: dict[str, Any],
    raw_instance: dict[str, Any],
    standard_field: str,
    *fallback_names: str,
) -> Any:
    value = mapped.get(standard_field)
    if value not in (None, ""):
        return value
    return find_form_value(raw_instance, *fallback_names)


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


def decode_table_value(value: Any) -> list[dict[str, Any]]:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except ValueError:
            return []
    if isinstance(value, dict):
        value = value.get("rowValue") or value.get("rows") or value.get("value") or []
    if not isinstance(value, list):
        return []

    rows: list[dict[str, Any]] = []
    for row in value:
        row_value = row.get("rowValue") if isinstance(row, dict) else row
        if not isinstance(row_value, list):
            continue
        parsed_row: dict[str, Any] = {}
        for cell in row_value:
            if not isinstance(cell, dict):
                continue
            label = cell.get("label") or cell.get("name") or cell.get("key")
            if label:
                parsed_row[str(label)] = cell.get("value") or cell.get("ext_value") or cell.get("extValue")
        if parsed_row:
            rows.append(parsed_row)
    return rows


def pick_row_value(row: dict[str, Any], *names: str) -> Any:
    expected_names = {normalize_label(name) for name in names}
    for key, value in row.items():
        if normalize_label(key) in expected_names:
            return value
    return None


def expense_rows_from_table(value: Any) -> list[dict[str, Any]]:
    rows = []
    for row in decode_table_value(value):
        description = parse_text(pick_row_value(row, "支出详情", "费用明细", "费用说明", "说明", "摘要"))
        amount = parse_decimal(pick_row_value(row, "小项金额", "金额", "报销金额", "费用金额"))
        category_l1 = parse_text(pick_row_value(row, "支出类型", "费用类型", "一级分类"))
        category_l2 = parse_text(pick_row_value(row, "二级分类", "小类"))
        supplier_name = parse_text(pick_row_value(row, "供应商", "收款方", "收款单位"))
        if amount is None:
            continue
        rows.append(
            {
                "description": description or "钉钉审批支出",
                "amount": amount,
                "category_l1": category_l1,
                "category_l2": category_l2,
                "supplier_name": supplier_name,
            }
        )
    return rows


def voucher_items_from_table(value: Any) -> list[dict[str, str | None]]:
    items: list[dict[str, str | None]] = []
    for row in decode_table_value(value):
        for name in ("报销凭证", "报销凭证图片", "报销凭证文档", "凭证", "凭证图片", "附件"):
            items.extend(parse_voucher_items(pick_row_value(row, name)))
    return items


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
        stripped = value.strip()
        store = session.scalar(select(Store).where(Store.name == value))
        if store is not None:
            return store
        store = session.scalar(select(Store).where(Store.dingtalk_dept_id == stripped))
        if store is not None:
            return store
        last_name = last_department_name(stripped)
        if last_name:
            store = session.scalar(select(Store).where(Store.name == last_name))
            if store is not None:
                return store
    return None


def build_approval_parse_preview(
    session: Session,
    template: ApprovalTemplate,
    instance: ApprovalInstance,
) -> ApprovalParsePreview:
    raw_instance: dict[str, Any] = {}
    if instance.raw_payload:
        try:
            raw_instance = json.loads(instance.raw_payload)
        except ValueError:
            raw_instance = {}
    mapped = mapped_values_for_template(session, template.id, raw_instance)
    store_text = parse_text(
        mapped_or_form_value(mapped, raw_instance, "store", "支出门店", "门店", "费用门店", "所属门店")
    ) or parse_text(mapped.get("store_name"))
    originator_dept_id = parse_text(raw_instance.get("originator_dept_id") or raw_instance.get("originatorDeptId"))
    originator_dept_name = parse_text(raw_instance.get("originator_dept_name") or raw_instance.get("originatorDeptName"))
    store = (
        resolve_store(session, store_text)
        or resolve_store(session, originator_dept_id)
        or resolve_store(session, originator_dept_name)
    )
    amount = parse_decimal(
        mapped_or_form_value(mapped, raw_instance, "amount", "汇总金额（元）", "汇总金额", "金额", "报销金额")
    )
    description = parse_text(
        mapped_or_form_value(mapped, raw_instance, "description", "支出详情", "费用说明", "其他备注信息", "备注")
    ) or template.name
    expense_date = parse_date(
        mapped_or_form_value(mapped, raw_instance, "expense_date", "报销日期", "支出日期", "费用日期", "日期")
    ) or DingTalkClient.parse_time(raw_instance.get("create_time") or raw_instance.get("createTime"))
    table_value = mapped_or_form_value(mapped, raw_instance, "expense_table", "表格", "费用明细", "支出明细")
    expense_rows = expense_rows_from_table(table_value)
    payee_account = parse_text(
        mapped_or_form_value(mapped, raw_instance, "payee_account", "收款账户", "收款账号", "账户")
    )
    category_l1 = parse_text(
        mapped_or_form_value(mapped, raw_instance, "category_l1", "支出类型", "费用类型", "一级分类")
    )
    rows = expense_rows or (
        [
            {
                "description": description,
                "amount": amount,
                "category_l1": category_l1,
                "category_l2": parse_text(mapped.get("category_l2")),
                "supplier_name": parse_text(mapped.get("supplier_name")),
            }
        ]
        if amount is not None
        else []
    )
    voucher_items = [
        *parse_voucher_items(
            mapped_or_form_value(mapped, raw_instance, "voucher_images", "报销凭证图片", "凭证图片", "图片")
        ),
        *parse_voucher_items(
            mapped_or_form_value(mapped, raw_instance, "voucher_files", "报销凭证文档", "报销凭证", "凭证文档", "附件")
        ),
        *voucher_items_from_table(table_value),
    ]
    missing_fields: list[str] = []
    if store is None:
        missing_fields.append("store")
    if not rows:
        missing_fields.append("amount")
    if expense_date is None:
        missing_fields.append("expense_date")
    return ApprovalParsePreview(
        template_id=template.id,
        approval_instance_id=instance.id,
        dingtalk_instance_id=instance.dingtalk_instance_id,
        approval_no=instance.approval_no,
        store_id=store.id if store else None,
        store_name=store.name if store else None,
        store_text=store_text,
        originator_dept_id=originator_dept_id,
        originator_dept_name=originator_dept_name,
        expense_date=expense_date,
        expense_row_count=len(rows),
        rows=[
            {
                "description": str(row["description"]),
                "amount": Decimal(row["amount"]).quantize(Decimal("0.01")),
                "category_l1": parse_text(row.get("category_l1")) or category_l1,
                "category_l2": parse_text(row.get("category_l2")) or parse_text(mapped.get("category_l2")),
                "supplier_name": parse_text(row.get("supplier_name")) or parse_text(mapped.get("supplier_name")),
                "payee_account": payee_account,
            }
            for row in rows
        ],
        voucher_count=len(voucher_items),
        missing_fields=missing_fields,
        can_create_expense=not missing_fields,
    )


def delete_unmatched_dingtalk_expenses_for_instance(session: Session, instance: ApprovalInstance) -> int:
    prefix = f"{instance.dingtalk_instance_id}:"
    items = list(
        session.scalars(
            select(ExpenseItem).where(
                ExpenseItem.source == "dingtalk",
                ExpenseItem.source_document_id.is_not(None),
                ExpenseItem.source_document_id.in_([instance.dingtalk_instance_id])
                | ExpenseItem.source_document_id.startswith(prefix),
            )
        )
    )
    deleted_count = 0
    for item in items:
        has_match = session.scalar(select(ExpenseBankMatch).where(ExpenseBankMatch.expense_item_id == item.id))
        if has_match is not None:
            continue
        for attachment in session.scalars(
            select(Attachment).where(Attachment.resource_type == "expense_item", Attachment.resource_id == item.id)
        ):
            session.delete(attachment)
        session.delete(item)
        deleted_count += 1
    session.flush()
    return deleted_count


def sync_real_instance(
    session: Session,
    template: ApprovalTemplate,
    job: SyncJob,
    raw_instance: dict[str, Any],
) -> bool:
    instance_id = str(raw_instance.get("process_instance_id") or raw_instance.get("processInstanceId") or "")
    if not instance_id:
        return False
    mapped = mapped_values_for_template(session, template.id, raw_instance)

    store_text = parse_text(
        mapped_or_form_value(mapped, raw_instance, "store", "支出门店", "门店", "费用门店", "所属门店")
    ) or parse_text(mapped.get("store_name"))
    originator_dept_id = parse_text(raw_instance.get("originator_dept_id") or raw_instance.get("originatorDeptId"))
    originator_dept_name = parse_text(raw_instance.get("originator_dept_name") or raw_instance.get("originatorDeptName"))
    store = (
        resolve_store(session, store_text)
        or resolve_store(session, originator_dept_id)
        or resolve_store(session, originator_dept_name)
    )
    amount = parse_decimal(
        mapped_or_form_value(mapped, raw_instance, "amount", "汇总金额（元）", "汇总金额", "金额", "报销金额")
    )
    description = parse_text(
        mapped_or_form_value(mapped, raw_instance, "description", "支出详情", "费用说明", "其他备注信息", "备注")
    ) or template.name
    expense_date = parse_date(
        mapped_or_form_value(mapped, raw_instance, "expense_date", "报销日期", "支出日期", "费用日期", "日期")
    ) or DingTalkClient.parse_time(
        raw_instance.get("create_time") or raw_instance.get("createTime")
    )
    table_value = mapped_or_form_value(mapped, raw_instance, "expense_table", "表格", "费用明细", "支出明细")
    expense_rows = expense_rows_from_table(table_value)
    voucher_items = [
        *parse_voucher_items(
            mapped_or_form_value(
                mapped,
                raw_instance,
                "voucher_images",
                "报销凭证图片",
                "凭证图片",
                "图片",
            )
        ),
        *parse_voucher_items(
            mapped_or_form_value(
                mapped,
                raw_instance,
                "voucher_files",
                "报销凭证文档",
                "报销凭证",
                "凭证文档",
                "附件",
            )
        ),
        *voucher_items_from_table(table_value),
    ]
    payee_account = parse_text(
        mapped_or_form_value(mapped, raw_instance, "payee_account", "收款账户", "收款账号", "账户")
    )
    category_l1 = parse_text(
        mapped_or_form_value(mapped, raw_instance, "category_l1", "支出类型", "费用类型", "一级分类")
    )

    instance = session.scalar(select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == instance_id))
    if instance is None:
        instance = ApprovalInstance(template_id=template.id, dingtalk_instance_id=instance_id)
        session.add(instance)
    instance.approval_no = parse_text(raw_instance.get("business_id") or raw_instance.get("businessId"))
    instance.store_id = store.id if store is not None else None
    instance.department_name = department_name_from_raw(session, raw_instance, store)
    instance.applicant_name = applicant_name_from_raw(raw_instance)
    instance.applicant_user_id = parse_text(raw_instance.get("originator_userid") or raw_instance.get("originatorUserId"))
    instance.approval_status = parse_text(raw_instance.get("result") or raw_instance.get("status")) or "unknown"
    instance.submit_at = DingTalkClient.parse_time(raw_instance.get("create_time") or raw_instance.get("createTime"))
    instance.approved_at = DingTalkClient.parse_time(raw_instance.get("finish_time") or raw_instance.get("finishTime"))
    instance.raw_payload = json.dumps(raw_instance, ensure_ascii=False)
    instance.synced_job_id = job.id
    session.flush()
    create_dingtalk_attachment_placeholders(session, "approval_instance", instance.id, voucher_items)

    if store is None or (amount is None and not expense_rows) or expense_date is None:
        missing_fields = []
        if store is None:
            missing_fields.append("store")
        if amount is None and not expense_rows:
            missing_fields.append("amount")
        if expense_date is None:
            missing_fields.append("expense_date")
        instance.raw_payload = json.dumps(
            {
                **raw_instance,
                "_fin_hub_parse": {
                    "store_text": store_text,
                    "originator_dept_id": originator_dept_id,
                    "originator_dept_name": originator_dept_name,
                    "resolved_store_id": None,
                    "expense_row_count": len(expense_rows),
                    "created_expense_ids": [],
                    "expense_parse_status": "skipped",
                    "missing_fields": missing_fields,
                },
            },
            ensure_ascii=False,
        )
        return True
    if instance.approval_status.lower() not in {"agree", "approved", "completed", "finish", "success"}:
        return True
    period = expense_date.strftime("%Y-%m")
    if session.scalar(select(Ledger).where(Ledger.store_id == store.id, Ledger.period == period)) is None:
        session.add(Ledger(store_id=store.id, period=period))
        session.flush()

    approval_total = amount or sum((Decimal(row["amount"]) for row in expense_rows), Decimal("0.00"))
    rows_to_create = [
        {
            "description": parse_text(raw_instance.get("title") or raw_instance.get("titleName"))
            or description
            or template.name,
            "amount": approval_total,
            "category_l1": category_l1,
            "category_l2": parse_text(mapped.get("category_l2")),
            "supplier_name": parse_text(mapped.get("supplier_name")),
        }
    ]
    created_expense_ids: list[str] = []
    for row in rows_to_create:
        source_document_id = instance.dingtalk_instance_id
        exists_item = session.scalar(
            select(ExpenseItem).where(ExpenseItem.source_document_id == source_document_id)
        )
        if exists_item is not None:
            continue
        expense_item = ExpenseItem(
            store_id=store.id,
            ledger_period=period,
            expense_date=expense_date,
            description=str(row["description"]),
            amount=row["amount"],
            category_l1=parse_text(row.get("category_l1")) or category_l1,
            category_l2=parse_text(row.get("category_l2")) or parse_text(mapped.get("category_l2")),
            supplier_name=parse_text(row.get("supplier_name")) or parse_text(mapped.get("supplier_name")),
            payee_account=payee_account,
            source="dingtalk",
            source_document_id=source_document_id,
        )
        session.add(expense_item)
        session.flush()
        created_expense_ids.append(expense_item.id)
        create_dingtalk_attachment_placeholders(
            session,
            "expense_item",
            expense_item.id,
            [
                *voucher_items,
            ],
        )
    instance.raw_payload = json.dumps(
        {
            **raw_instance,
            "_fin_hub_parse": {
                "store_text": store_text,
                "originator_dept_id": originator_dept_id,
                "originator_dept_name": originator_dept_name,
                "resolved_store_id": store.id,
                "expense_row_count": len(expense_rows) if expense_rows else 1,
                "created_expense_ids": created_expense_ids,
            },
        },
        ensure_ascii=False,
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
    skip_existing: bool = True,
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
            template_skipped_existing = 0
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
                    if skip_existing and session.scalar(
                        select(ApprovalInstance.id).where(ApprovalInstance.dingtalk_instance_id == instance_id)
                    ):
                        template_skipped_existing += 1
                        continue
                    raw_instance = client.get_process_instance(instance_id)
                    raw_instance.setdefault("process_instance_id", instance_id)
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
                job.error_message = "DingTalk approval sync paused at max_pages; resume is available"
            template_summaries.append(
                {
                    "template_id": template.id,
                    "process_code": template.process_code,
                    "processed_count": template_processed,
                    "skipped_existing_count": template_skipped_existing,
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
    job.status = SyncJobStatus.SUCCEEDED.value if job.failed_count == 0 else SyncJobStatus.FAILED.value
    job.finished_at = utc_now()
    job.raw_summary = json.dumps({"templates": template_summaries}, ensure_ascii=False)
    config = get_or_create_config(session)
    config.last_instance_sync_at = utc_now()


@router.get("/auto-sync/settings", response_model=ApiEnvelope[DingTalkAutoSyncSettingRead])
def read_auto_sync_setting(
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("dingtalk.view")),
) -> ApiEnvelope[DingTalkAutoSyncSettingRead]:
    return ApiEnvelope(data=get_or_create_auto_sync_setting(session))


@router.put("/auto-sync/settings", response_model=ApiEnvelope[DingTalkAutoSyncSettingRead])
def update_auto_sync_setting(
    payload: DingTalkAutoSyncSettingUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[DingTalkAutoSyncSettingRead]:
    setting = get_or_create_auto_sync_setting(session)
    updates = payload.model_dump(exclude_unset=True)
    for key, value in updates.items():
        setattr(setting, key, value)
    refresh_auto_sync_next_run(setting)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.auto_sync.settings.update",
        resource_type="dingtalk_auto_sync_setting",
        resource_id=setting.id,
        summary="更新钉钉自动同步设置",
        metadata=updates,
    )
    session.commit()
    session.refresh(setting)
    return ApiEnvelope(data=setting)


def execute_auto_sync(
    session: Session,
    setting: DingTalkAutoSyncSetting,
    *,
    started_by: str,
) -> DingTalkAutoSyncRunResult:
    job = SyncJob(
        job_type="dingtalk_auto_sync",
        status=SyncJobStatus.RUNNING.value,
        started_by=started_by,
        started_at=utc_now(),
    )
    session.add(job)
    session.flush()
    progress: dict[str, Any] = {"stages": []}

    def update_progress(stage: str, status: str, **metadata: Any) -> None:
        progress["current_stage"] = stage
        progress["stages"].append(
            {
                "stage": stage,
                "status": status,
                "at": utc_now().isoformat(),
                **metadata,
            }
        )
        job.raw_summary = json.dumps(progress, ensure_ascii=False)
        session.flush()
        session.commit()
        session.refresh(job)
        session.refresh(setting)

    department_pull: DingTalkDepartmentPullResult | None = None
    department_sync: DingTalkDepartmentSyncResult | None = None
    template_sync: dict[str, int] | None = None
    approval_sync_summary: dict[str, Any] | None = None

    def department_pull_summary(result: DingTalkDepartmentPullResult | None) -> dict[str, int] | None:
        if result is None:
            return None
        return {
            "pulled_count": result.pulled_count,
            "created_count": result.created_count,
            "updated_count": result.updated_count,
            "deactivated_count": result.deactivated_count,
            "candidate_count": result.candidate_count,
        }

    try:
        update_progress("start", "running")
        if setting.sync_departments:
            update_progress(
                "departments_pull",
                "running",
                root_dept_id=AUTO_SYNC_DEPARTMENT_ROOT_ID,
                max_depth=AUTO_SYNC_DEPARTMENT_MAX_DEPTH,
            )
            department_pull = pull_departments_core(
                session,
                root_dept_id=AUTO_SYNC_DEPARTMENT_ROOT_ID,
                max_depth=AUTO_SYNC_DEPARTMENT_MAX_DEPTH,
            )
            update_progress("departments_pull", "succeeded", pulled_count=department_pull.pulled_count)
            update_progress("stores_sync", "running")
            department_sync = sync_departments_to_stores_core(session)
            update_progress(
                "stores_sync",
                "succeeded",
                created_count=department_sync.created_count,
                updated_count=department_sync.updated_count,
                skipped_count=department_sync.skipped_count,
            )

        if setting.sync_templates:
            update_progress("templates_sync", "running")
            template_sync = sync_templates_core(session)
            session.flush()
            update_progress("templates_sync", "succeeded", **template_sync)

        if setting.sync_approvals:
            update_progress(
                "approvals_sync",
                "running",
                page_size=AUTO_SYNC_APPROVAL_PAGE_SIZE,
                max_pages=AUTO_SYNC_APPROVAL_MAX_PAGES,
                incremental_start_at=setting.last_run_at.isoformat()
                if setting.last_run_at
                else None,
            )
            end_at = utc_now()
            job.request_end_at = end_at
            job.request_start_at = setting.last_run_at or (
                end_at - timedelta(days=AUTO_SYNC_INITIAL_APPROVAL_LOOKBACK_DAYS)
            )
            templates = list(
                session.scalars(
                    select(ApprovalTemplate)
                    .where(ApprovalTemplate.is_enabled.is_(True))
                    .order_by(ApprovalTemplate.created_at.asc())
                )
            )
            if not templates:
                raise HTTPException(status_code=404, detail="No enabled approval templates")
            run_approval_sync(
                session,
                job=job,
                templates=templates,
                page_size=AUTO_SYNC_APPROVAL_PAGE_SIZE,
                max_pages=AUTO_SYNC_APPROVAL_MAX_PAGES,
                skip_existing=True,
            )
            approval_sync_summary = json.loads(job.raw_summary) if job.raw_summary else None
            update_progress(
                "approvals_sync",
                job.status,
                processed_count=job.processed_count,
                success_count=job.success_count,
                failed_count=job.failed_count,
                next_cursor=job.next_cursor,
                error_message=job.error_message,
            )
        else:
            job.status = SyncJobStatus.SUCCEEDED.value
            job.finished_at = utc_now()

        job.raw_summary = json.dumps(
            {
                "department_pull": department_pull_summary(department_pull),
                "department_sync": {
                    "created_count": department_sync.created_count,
                    "updated_count": department_sync.updated_count,
                    "skipped_count": department_sync.skipped_count,
                }
                if department_sync
                else None,
                "template_sync": template_sync,
                "approval_sync": approval_sync_summary,
                "progress": progress,
            },
            ensure_ascii=False,
        )
        setting.last_status = job.status
        setting.last_error = job.error_message
    except Exception as exc:
        job.status = SyncJobStatus.FAILED.value
        job.error_message = str(getattr(exc, "detail", exc))
        job.finished_at = utc_now()
        progress["error"] = job.error_message
        progress["current_stage"] = progress.get("current_stage") or "unknown"
        job.raw_summary = json.dumps({"error": job.error_message, "progress": progress}, ensure_ascii=False)
        setting.last_status = job.status
        setting.last_error = job.error_message
    setting.last_run_at = utc_now()
    setting.last_job_id = job.id
    refresh_auto_sync_next_run(setting)
    write_audit_log(
        session,
        actor=started_by,
        action="dingtalk.auto_sync.run",
        resource_type="sync_job",
        resource_id=job.id,
        summary=f"执行钉钉自动同步：{job.status}",
    )
    session.commit()
    session.refresh(job)
    session.refresh(setting)
    return DingTalkAutoSyncRunResult(
        job=job,
        setting=setting,
        department_pull=department_pull,
        department_sync=department_sync,
        template_sync=template_sync,
        approval_sync=job,
    )


def run_due_auto_sync_jobs(session: Session) -> list[DingTalkAutoSyncRunResult]:
    now = utc_now()
    settings_rows = list(
        session.scalars(
            select(DingTalkAutoSyncSetting).where(
                DingTalkAutoSyncSetting.enabled.is_(True),
                (DingTalkAutoSyncSetting.next_run_at.is_(None))
                | (DingTalkAutoSyncSetting.next_run_at <= now),
            )
        )
    )
    results: list[DingTalkAutoSyncRunResult] = []
    for setting in settings_rows:
        running_job = session.scalar(
            select(SyncJob).where(
                SyncJob.job_type == "dingtalk_auto_sync",
                SyncJob.status == SyncJobStatus.RUNNING.value,
            )
        )
        if running_job is not None:
            continue
        results.append(execute_auto_sync(session, setting, started_by="auto-sync"))
    return results


@router.post("/auto-sync/run", response_model=ApiEnvelope[DingTalkAutoSyncRunResult], status_code=201)
def run_auto_sync_now(
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[DingTalkAutoSyncRunResult]:
    setting = get_or_create_auto_sync_setting(session)
    return ApiEnvelope(data=execute_auto_sync(session, setting, started_by=audit_actor(current_user)))


@router.post("/approval-sync", response_model=ApiEnvelope[SyncJobRead], status_code=201)
def start_approval_sync(
    payload: StartApprovalSyncRequest,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
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
            skip_existing=payload.skip_existing,
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
    except DingTalkClientError as exc:
        job.status = SyncJobStatus.FAILED.value
        job.failed_count += 1
        job.error_message = str(exc)
        job.finished_at = utc_now()
        job.raw_summary = json.dumps({"error": str(exc)}, ensure_ascii=False)
        write_audit_log(
            session,
            actor=audit_actor(current_user, payload.started_by),
            action="dingtalk.approval_sync.failed",
            resource_type="sync_job",
            resource_id=job.id,
            summary=f"同步钉钉审批失败：{exc}",
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
    current_user: User = Depends(require_permission("dingtalk.manage")),
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
            skip_existing=payload.skip_existing,
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
    except DingTalkClientError as exc:
        job.status = SyncJobStatus.FAILED.value
        job.failed_count += 1
        job.error_message = str(exc)
        job.finished_at = utc_now()
        job.raw_summary = json.dumps({"error": str(exc), "previous_job_id": previous_job.id}, ensure_ascii=False)
        write_audit_log(
            session,
            actor=audit_actor(current_user, payload.started_by),
            action="dingtalk.approval_sync.resume.failed",
            resource_type="sync_job",
            resource_id=job.id,
            summary=f"续跑钉钉审批同步失败：{exc}",
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
    return ApiEnvelope(
        data=Page(
            items=[approval_instance_read(session, item) for item in items],
            total=total,
            page=page,
            page_size=page_size,
        )
    )
