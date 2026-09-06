import hashlib
import json
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal, InvalidOperation
from time import sleep
from typing import Any
from zoneinfo import ZoneInfo

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.crypto import decrypt_secret, encrypt_secret
from app.core.database import SessionLocal, get_session
from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    ApprovalTemplateNode,
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
from app.modules.approvals.status import (
    approval_expense_stats,
    approval_expense_stats_map,
    refresh_approval_processing_status,
)
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import ensure_permission, ensure_store_access
from app.modules.auth.router import audit_actor, require_permission
from app.modules.common import paginate
from app.modules.dingtalk.client import DingTalkClient, DingTalkClientError, DingTalkCredentials
from app.schemas import (
    ApiEnvelope,
    ApprovalInstanceRead,
    ApprovalParsePreview,
    ApprovalModifiedResyncRequest,
    ApprovalModifiedResyncResult,
    ApprovalReparseRequest,
    ApprovalReparseResult,
    ApprovalTemplateCreate,
    ApprovalTemplateNodeCreate,
    ApprovalTemplateNodeRead,
    ApprovalTemplateNodeUpdate,
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
    DingTalkSyncReadiness,
    Page,
    ResumeApprovalSyncRequest,
    StartApprovalSyncRequest,
    StartStoreApprovalSyncRequest,
    StoreApprovalSyncResult,
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
AUTO_SYNC_APPROVAL_PAGE_SIZE = 10
AUTO_SYNC_APPROVAL_MAX_PAGES = 100
AUTO_SYNC_INITIAL_APPROVAL_LOOKBACK_DAYS = 120
APPROVAL_SYNC_MAX_WINDOW_DAYS = 120
APPROVAL_SYNC_MAX_LOOKBACK_DAYS = 365
APPROVAL_SYNC_OVERLAP = timedelta(minutes=10)
DINGTALK_SYNC_JOB_TYPES = {
    "dingtalk_approval_sync",
    "dingtalk_store_approval_sync",
    "dingtalk_auto_sync",
}
COMPLETED_APPROVAL_STATUSES = {"agree", "approved", "completed", "finish", "success"}
RESYNC_PROCESSING_STATUSES = {"unparsed", "sync_conflict", "pending_classification", "pending_match"}


class ApprovalSyncCanceled(Exception):
    pass


def template_mapping_status(session: Session, template_id: str) -> str:
    mapping_exists = session.scalar(
        select(TemplateFieldMapping.id)
        .where(
            TemplateFieldMapping.template_id == template_id,
            ~TemplateFieldMapping.standard_field.startswith("display:"),
        )
        .limit(1)
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


def build_sync_readiness(session: Session) -> DingTalkSyncReadiness:
    config = get_or_create_config(session)
    sync_mode = settings.dingtalk_sync_mode.lower()
    config_ready = bool(dingtalk_credentials(config))
    department_count = session.scalar(
        select(func.count()).select_from(DingTalkDepartmentModel).where(DingTalkDepartmentModel.is_active.is_(True))
    ) or 0
    store_candidate_count = session.scalar(
        select(func.count())
        .select_from(DingTalkDepartmentModel)
        .where(
            DingTalkDepartmentModel.is_active.is_(True),
            DingTalkDepartmentModel.is_store_candidate.is_(True),
        )
    ) or 0
    mapped_store_count = session.scalar(
        select(func.count())
        .select_from(DingTalkDepartmentModel)
        .where(
            DingTalkDepartmentModel.is_active.is_(True),
            DingTalkDepartmentModel.is_store_candidate.is_(True),
            DingTalkDepartmentModel.store_id.is_not(None),
        )
    ) or 0
    template_count = session.scalar(select(func.count()).select_from(ApprovalTemplate)) or 0
    enabled_templates = list(
        session.scalars(
            select(ApprovalTemplate)
            .where(ApprovalTemplate.is_enabled.is_(True))
            .order_by(ApprovalTemplate.created_at.asc())
        )
    )
    enabled_template_ids = [template.id for template in enabled_templates]
    configured_template_ids: set[str] = set()
    if enabled_template_ids:
        configured_template_ids = set(
            session.scalars(
                select(TemplateFieldMapping.template_id)
                .where(
                    TemplateFieldMapping.template_id.in_(enabled_template_ids),
                    ~TemplateFieldMapping.standard_field.startswith("display:"),
                )
                .distinct()
            )
        )

    unconfigured_enabled_templates = [
        template.name for template in enabled_templates if template.id not in configured_template_ids
    ]
    blockers: list[str] = []
    warnings: list[str] = []
    if not config_ready:
        blockers.append("钉钉应用凭证未配置完整")
    if department_count == 0:
        blockers.append("请先同步钉钉部门快照")
    if mapped_store_count == 0:
        blockers.append("请先把候选门店部门落库或映射到门店")
    if template_count == 0:
        blockers.append("请先同步审批模板")
    if template_count > 0 and not enabled_templates:
        blockers.append("请至少启用一个审批模板")
    if unconfigured_enabled_templates:
        blockers.append("启用的审批模板需要先配置解析规则")
    if store_candidate_count > 0 and mapped_store_count < store_candidate_count:
        warnings.append("还有候选门店部门未完成门店映射")
    if sync_mode != "real":
        warnings.append("当前审批同步模式是 mock，审批模板和审批列表会使用本地演示数据；部门同步仍会读取钉钉部门接口")

    return DingTalkSyncReadiness(
        sync_mode=sync_mode,
        config_ready=config_ready,
        department_ready=department_count > 0,
        store_mapping_ready=mapped_store_count > 0,
        template_ready=bool(enabled_templates) and not unconfigured_enabled_templates,
        approval_sync_ready=not blockers,
        department_count=department_count,
        store_candidate_count=store_candidate_count,
        mapped_store_count=mapped_store_count,
        template_count=template_count,
        enabled_template_count=len(enabled_templates),
        configured_enabled_template_count=len(configured_template_ids),
        unconfigured_enabled_templates=unconfigured_enabled_templates[:8],
        blockers=blockers,
        warnings=warnings,
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
        # 默认时间设置为 02:15，避开整点时刻的钉钉 API 限流高峰
        setting = DingTalkAutoSyncSetting(scheduled_time="02:15")
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


@router.get("/sync-readiness", response_model=ApiEnvelope[DingTalkSyncReadiness])
def read_sync_readiness(
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("dingtalk.view")),
) -> ApiEnvelope[DingTalkSyncReadiness]:
    return ApiEnvelope(data=build_sync_readiness(session))


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
        # ✅ 步骤 1: 按 dept_id 查询 (唯一标识符)
        store = session.scalar(select(Store).where(Store.dingtalk_dept_id == department.dept_id))

        if store is None:
            # ✅ 步骤 2: 未找到，检查是否有同名门店
            existing_by_name = session.scalar(select(Store).where(Store.name == department.name))
            if existing_by_name:
                # ⚠️ 同名门店已存在，为避免关联错误，生成唯一名称
                # 使用 dept_id 后缀避免重复创建
                unique_name = f"{department.name} (钉钉-{department.dept_id})"
                store = Store(name=unique_name, dingtalk_dept_id=department.dept_id)
            else:
                store = Store(name=department.name, dingtalk_dept_id=department.dept_id)
            session.add(store)
            created_count += 1
        else:
            # ✅ 步骤 3: 已存在的门店，只更新 dept_id，不改名称
            # （避免改变用户手动维护的门店名称）
            if store.dingtalk_dept_id != department.dept_id:
                store.dingtalk_dept_id = department.dept_id
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
    dingtalk: DingTalkClient | None = None
    if should_use_real_dingtalk():
        if not config.admin_user_id:
            raise HTTPException(status_code=409, detail="DingTalk admin user id is not configured")
        try:
            dingtalk = dingtalk_client(config)
            processes = dingtalk.list_processes_by_user(config.admin_user_id)
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
    node_created = 0
    node_updated = 0
    node_failed = 0
    for process_code, name, raw_snapshot in samples:
        template = session.scalar(
            select(ApprovalTemplate).where(ApprovalTemplate.process_code == process_code)
        )
        if template is None:
            template = ApprovalTemplate(
                process_code=process_code,
                name=name,
                is_enabled=False,
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
        session.flush()
        if dingtalk is not None and config.admin_user_id:
            dept_id = forecast_dept_id_for_template_sync(session)
            try:
                forecast = dingtalk.forecast_process_nodes(process_code, config.admin_user_id, dept_id)
            except DingTalkClientError:
                node_failed += 1
            else:
                node_result = sync_template_nodes_from_forecast(session, template, forecast)
                node_created += node_result["created"]
                node_updated += node_result["updated"]
    config.last_template_sync_at = now
    return {
        "pulled": len(samples),
        "created": created,
        "updated": updated,
        "node_created": node_created,
        "node_updated": node_updated,
        "node_failed": node_failed,
    }


def forecast_dept_id_for_template_sync(session: Session) -> str:
    store_dept_id = session.scalar(
        select(Store.dingtalk_dept_id)
        .where(Store.dingtalk_dept_id.is_not(None))
        .order_by(Store.created_at.asc())
        .limit(1)
    )
    if store_dept_id:
        return str(store_dept_id)
    department_dept_id = session.scalar(
        select(DingTalkDepartmentModel.dept_id)
        .where(DingTalkDepartmentModel.is_active.is_(True))
        .order_by(DingTalkDepartmentModel.depth.asc(), DingTalkDepartmentModel.created_at.asc())
        .limit(1)
    )
    return str(department_dept_id or "1")


def forecast_node_value(record: dict[str, Any], *keys: str) -> str | None:
    for key in keys:
        value = record.get(key)
        if value not in (None, ""):
            return str(value)
    return None


def extract_forecast_nodes(payload: Any) -> list[dict[str, str | int | None]]:
    nodes: list[dict[str, str | int | None]] = []

    def walk(value: Any) -> None:
        if isinstance(value, list):
            for item in value:
                walk(item)
            return
        if not isinstance(value, dict):
            return

        activity_id = forecast_node_value(
            value,
            "activity_id",
            "activityId",
            "activity_code",
            "activityCode",
            "node_id",
            "nodeId",
        )
        node_name = forecast_node_value(
            value,
            "activity_name",
            "activityName",
            "node_name",
            "nodeName",
            "name",
            "title",
        )
        if activity_id and node_name:
            nodes.append(
                {
                    "activity_id": activity_id,
                    "node_name": node_name,
                    "node_type": forecast_node_value(
                        value,
                        "node_type",
                        "nodeType",
                        "activity_type",
                        "activityType",
                        "type",
                    ),
                }
            )

        for child in value.values():
            if isinstance(child, (dict, list)):
                walk(child)

    walk(payload)

    deduped: list[dict[str, str | int | None]] = []
    seen: set[str] = set()
    for index, node in enumerate(nodes, start=1):
        activity_id = str(node["activity_id"])
        if activity_id in seen:
            continue
        seen.add(activity_id)
        deduped.append({**node, "sort_order": index})
    return deduped


def sync_template_nodes_from_forecast(
    session: Session,
    template: ApprovalTemplate,
    forecast: dict[str, Any],
) -> dict[str, int]:
    nodes = extract_forecast_nodes(forecast)
    created = 0
    updated = 0
    for node_data in nodes:
        activity_id = str(node_data["activity_id"])
        node = session.scalar(
            select(ApprovalTemplateNode).where(
                ApprovalTemplateNode.template_id == template.id,
                ApprovalTemplateNode.activity_id == activity_id,
            )
        )
        if node is None:
            session.add(
                ApprovalTemplateNode(
                    template_id=template.id,
                    activity_id=activity_id,
                    node_name=str(node_data["node_name"]),
                    node_type=node_data["node_type"],
                    sort_order=int(node_data["sort_order"] or 0),
                    is_active=True,
                )
            )
            created += 1
            continue

        next_node_name = str(node_data["node_name"])
        next_node_type = node_data["node_type"]
        next_sort_order = int(node_data["sort_order"] or 0)
        changed = (
            node.node_name != next_node_name
            or node.node_type != next_node_type
            or node.sort_order != next_sort_order
            or not node.is_active
        )
        if changed:
            node.node_name = next_node_name
            node.node_type = next_node_type
            node.sort_order = next_sort_order
            node.is_active = True
            updated += 1
    return {"created": created, "updated": updated}


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


@router.get(
    "/templates/{template_id}/nodes",
    response_model=ApiEnvelope[list[ApprovalTemplateNodeRead]],
)
def list_template_nodes(
    template_id: str,
    session: Session = Depends(get_session),
) -> ApiEnvelope[list[ApprovalTemplateNodeRead]]:
    if session.get(ApprovalTemplate, template_id) is None:
        raise HTTPException(status_code=404, detail="Template not found")
    nodes = session.scalars(
        select(ApprovalTemplateNode)
        .where(ApprovalTemplateNode.template_id == template_id)
        .order_by(ApprovalTemplateNode.sort_order.asc(), ApprovalTemplateNode.created_at.asc())
    ).all()
    return ApiEnvelope(data=nodes)


@router.post(
    "/templates/{template_id}/nodes",
    response_model=ApiEnvelope[ApprovalTemplateNodeRead],
    status_code=201,
)
def upsert_template_node(
    template_id: str,
    payload: ApprovalTemplateNodeCreate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[ApprovalTemplateNodeRead]:
    template = session.get(ApprovalTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="Template not found")
    node = session.scalar(
        select(ApprovalTemplateNode).where(
            ApprovalTemplateNode.template_id == template_id,
            ApprovalTemplateNode.activity_id == payload.activity_id,
        )
    )
    if node is None:
        node = ApprovalTemplateNode(template_id=template_id, **payload.model_dump())
        session.add(node)
    else:
        for key, value in payload.model_dump().items():
            setattr(node, key, value)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.template_node.upsert",
        resource_type="approval_template_node",
        resource_id=node.id,
        summary=f"维护审批节点：{payload.activity_id} -> {payload.node_name}",
        metadata={"template_id": template.id, "template_name": template.name},
    )
    session.commit()
    session.refresh(node)
    return ApiEnvelope(data=node)


@router.patch(
    "/templates/{template_id}/nodes/{node_id}",
    response_model=ApiEnvelope[ApprovalTemplateNodeRead],
)
def update_template_node(
    template_id: str,
    node_id: str,
    payload: ApprovalTemplateNodeUpdate,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[ApprovalTemplateNodeRead]:
    if session.get(ApprovalTemplate, template_id) is None:
        raise HTTPException(status_code=404, detail="Template not found")
    node = session.get(ApprovalTemplateNode, node_id)
    if node is None or node.template_id != template_id:
        raise HTTPException(status_code=404, detail="Template node not found")
    for key, value in payload.model_dump(exclude_unset=True).items():
        setattr(node, key, value)
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.template_node.update",
        resource_type="approval_template_node",
        resource_id=node.id,
        summary=f"更新审批节点：{node.activity_id}",
        metadata={"template_id": template_id},
    )
    session.commit()
    session.refresh(node)
    return ApiEnvelope(data=node)


@router.delete(
    "/templates/{template_id}/nodes/{node_id}",
    response_model=ApiEnvelope[dict[str, bool]],
)
def delete_template_node(
    template_id: str,
    node_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[dict[str, bool]]:
    if session.get(ApprovalTemplate, template_id) is None:
        raise HTTPException(status_code=404, detail="Template not found")
    node = session.get(ApprovalTemplateNode, node_id)
    if node is None or node.template_id != template_id:
        raise HTTPException(status_code=404, detail="Template node not found")
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.template_node.delete",
        resource_type="approval_template_node",
        resource_id=node.id,
        summary=f"删除审批节点：{node.activity_id}",
        metadata={"template_id": template_id},
    )
    session.delete(node)
    session.commit()
    return ApiEnvelope(data={"ok": True})


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
    instances = list(
        session.scalars(
            select(ApprovalInstance)
            .where(ApprovalInstance.template_id == template.id, ApprovalInstance.raw_payload.is_not(None))
            .order_by(ApprovalInstance.updated_at.desc(), ApprovalInstance.created_at.desc())
            .limit(10)
        )
    )
    candidates: list[TemplateFieldCandidate] = []
    for instance in instances:
        if not instance.raw_payload:
            continue
        try:
            candidates.extend(collect_approval_form_field_candidates(json.loads(instance.raw_payload)))
        except ValueError:
            continue
    return unique_field_candidates(candidates)


def field_candidates_for_instance(instance: ApprovalInstance | None) -> list[TemplateFieldCandidate]:
    if instance is None or not instance.raw_payload:
        return []
    try:
        return unique_field_candidates(collect_approval_form_field_candidates(json.loads(instance.raw_payload)))
    except ValueError:
        return []


def running_dingtalk_sync_job(session: Session) -> SyncJob | None:
    return session.scalar(
        select(SyncJob)
        .where(
            SyncJob.status == SyncJobStatus.RUNNING.value,
            SyncJob.job_type.in_(DINGTALK_SYNC_JOB_TYPES),
        )
        .order_by(SyncJob.started_at.desc().nullslast(), SyncJob.created_at.desc())
    )


def ensure_no_running_dingtalk_sync(session: Session) -> None:
    running_job = running_dingtalk_sync_job(session)
    if running_job is not None:
        raise HTTPException(
            status_code=409,
            detail=f"已有钉钉同步任务正在运行，请等待完成后再操作：{running_job.id}",
        )


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
    instance.dingtalk_modified_at = DingTalkClient.parse_time(
        raw_instance.get("modify_time") or raw_instance.get("modifyTime")
    ) or instance.approved_at or instance.submit_at
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


def template_node_name_map(session: Session, template_id: str) -> dict[str, str]:
    nodes = session.scalars(
        select(ApprovalTemplateNode).where(
            ApprovalTemplateNode.template_id == template_id,
            ApprovalTemplateNode.is_active.is_(True),
        )
    ).all()
    return {node.activity_id: node.node_name for node in nodes}


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


def approval_instance_read(
    session: Session,
    instance: ApprovalInstance,
    stats: dict[str, Any] | None = None,
) -> ApprovalInstanceRead:
    stats = stats or approval_expense_stats_map(session, [instance.id]).get(instance.id, approval_expense_stats([], []))

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
        parse_status=instance.parse_status,
        parse_error=instance.parse_error,
        last_parsed_at=instance.last_parsed_at,
        submit_at=instance.submit_at,
        approved_at=instance.approved_at,
        dingtalk_modified_at=instance.dingtalk_modified_at,
        raw_payload=instance.raw_payload,
        synced_job_id=instance.synced_job_id,
        node_name_map=template_node_name_map(session, instance.template_id),
        expense_item_count=stats["expense_item_count"],
        classified_expense_item_count=stats["classified_expense_item_count"],
        matched_expense_item_count=stats["matched_expense_item_count"],
        pending_expense_item_count=stats["pending_expense_item_count"],
        sync_conflict_expense_item_count=stats["sync_conflict_expense_item_count"],
        total_expense_amount=stats["total_expense_amount"],
        confirmed_match_amount=stats["confirmed_match_amount"],
        candidate_match_count=stats["candidate_match_count"],
        processing_status=stats["processing_status"],
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


def looks_like_store_department(name: str, path: str, child_names: list[str], depth: int = 0) -> bool:
    """判断部门是否可能是门店

    使用多层次检查策略 (优先级从高到低):
    1. 黑名单检查 (排除明显不是门店的)
    2. 深度检查 (门店通常在特定深度)
    3. 白名单模式匹配
    4. 子部门结构检查 (强信号)
    5. 综合判断

    Args:
        name: 部门名称
        path: 部门路径 (从根到当前的部门名称，用 / 分隔)
        child_names: 子部门名称列表
        depth: 部门深度（从 0 开始）

    Returns:
        True 表示可能是门店，False 表示不是门店
    """
    # ✅ 步骤 1: 黑名单检查 (排除明显不是门店的词语)
    BLACKLIST_PATTERNS = (
        "集团",
        "总部",
        "大区",
        "区域",
        "运营部",
        "财务",
        "人力",
        "技术",
        "采购",
        "行政",
        "招商",
        "市场",
        "建店",
        "群",
        "讨论",
        "项目组",
        "委员会",
    )
    if any(pattern in name for pattern in BLACKLIST_PATTERNS):
        return False

    # ✅ 步骤 2: 深度检查
    # 门店通常在 3-5 层深度
    # 太浅 (0-2) 可能是大区或区域
    # 太深 (>6) 可能是工作小组
    if depth < 3 or depth > 6:
        return False

    # ✅ 步骤 3: 白名单模式检查 (必须包含这些关键词)
    WHITELIST_PATTERNS = (
        "店",
        "分店",
        "门店",
        "营业部",
        "分公司",
        "站点",
        "校区",
        "网点",
        "城",
    )
    has_whitelist = any(pattern in name for pattern in WHITELIST_PATTERNS)
    if not has_whitelist:
        return False

    # ✅ 步骤 4: 子部门结构检查 (强信号：存在前厅、后厨、收银等)
    # 这是最强的门店标识
    SHOP_STRUCTURE_KEYWORDS = ("前厅", "后厨", "收银", "员工")
    has_shop_structure = any(
        keyword in child
        for child in child_names
        for keyword in SHOP_STRUCTURE_KEYWORDS
    )
    if has_shop_structure:
        return True

    # ✅ 步骤 5: 长度检查
    # 名称太长的通常不是真实门店
    # 门店名称一般 2-10 个汉字
    if len(name) > 15:
        return False

    # ✅ 步骤 6: 路径检查
    # 如果路径中包含明显的非门店部分，排除
    if "门店运营部" not in path and "营业" not in path:
        # 可能在其他部分，但至少要有白名单词语
        pass

    # ✅ 综合判断：必须满足白名单模式和合理深度
    return has_whitelist and 3 <= depth <= 5


def build_department_tree(
    client: DingTalkClient,
    *,
    root_dept_id: str = "1",
    max_depth: int = 6,
) -> list[DingTalkDepartmentRead]:
    rows: list[DingTalkDepartmentRead] = []
    seen: set[str] = set()

    def walk(dept_id: str, parent_path: str, depth: int) -> None:
        if dept_id in seen or depth >= max_depth:
            return
        seen.add(dept_id)
        children = client.list_child_departments(dept_id)
        # 添加延迟避免触发钉钉 QPS 限流（90002 错误）
        sleep(0.15)
        for child in children:
            child_depth = depth + 1
            child_id = department_id(child)
            name = str(child.get("name") or child.get("dept_name") or child.get("deptName") or "")
            if not child_id or not name:
                continue
            path = department_path(child, parent_path)
            grandchildren = client.list_child_departments(child_id) if depth < max_depth else []
            # 添加延迟避免触发钉钉 QPS 限流
            sleep(0.15)
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
                    depth=child_depth,
                    is_store_candidate=looks_like_store_department(name, path, child_names, child_depth),
                )
            )
            if child_id and child_depth < max_depth:
                walk(child_id, path, child_depth)

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
            field_candidates=field_candidates_for_instance(instance),
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
            field_candidates=field_candidates_for_instance(instance),
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


@router.post(
    "/approval-resync-by-modified",
    response_model=ApiEnvelope[ApprovalModifiedResyncResult],
    status_code=201,
)
def resync_approvals_by_modified_time(
    payload: ApprovalModifiedResyncRequest,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[ApprovalModifiedResyncResult]:
    query = select(ApprovalInstance).where(ApprovalInstance.dingtalk_modified_at.is_not(None))
    if payload.start_at:
        query = query.where(ApprovalInstance.dingtalk_modified_at >= payload.start_at)
    if payload.end_at:
        query = query.where(ApprovalInstance.dingtalk_modified_at < payload.end_at)
    if payload.template_id:
        query = query.where(ApprovalInstance.template_id == payload.template_id)
    if payload.store_id:
        query = query.where(ApprovalInstance.store_id == payload.store_id)
    instances = list(
        session.scalars(
            query.order_by(
                ApprovalInstance.dingtalk_modified_at.desc().nullslast(),
                ApprovalInstance.updated_at.desc(),
            ).limit(payload.limit)
        )
    )
    if not instances:
        raise HTTPException(status_code=404, detail="No approvals found in modified-time window")

    job = SyncJob(
        job_type="dingtalk_approval_modified_resync",
        status=SyncJobStatus.RUNNING.value,
        started_by=audit_actor(current_user, payload.started_by),
        started_at=utc_now(),
        request_start_at=payload.start_at,
        request_end_at=payload.end_at,
    )
    session.add(job)
    session.flush()

    processed_count = 0
    updated_count = 0
    skipped_count = 0
    failed_count = 0
    config = get_or_create_config(session)
    client = dingtalk_client(config)
    for instance in instances:
        processed_count += 1
        template = session.get(ApprovalTemplate, instance.template_id)
        if template is None:
            skipped_count += 1
            continue
        try:
            raw_instance = client.get_process_instance(instance.dingtalk_instance_id)
            raw_instance.setdefault("process_instance_id", instance.dingtalk_instance_id)
            if sync_real_instance(session, template, job, raw_instance):
                updated_count += 1
            else:
                skipped_count += 1
        except DingTalkClientError as exc:
            failed_count += 1
            job.error_message = str(exc)
        except Exception as exc:
            failed_count += 1
            job.error_message = str(exc)

    job.status = SyncJobStatus.SUCCEEDED.value if failed_count == 0 else SyncJobStatus.FAILED.value
    job.finished_at = utc_now()
    job.processed_count = processed_count
    job.success_count = updated_count
    job.failed_count = failed_count
    job.raw_summary = json.dumps(
        {
            "template_id": payload.template_id,
            "store_id": payload.store_id,
            "processed_count": processed_count,
            "updated_count": updated_count,
            "skipped_count": skipped_count,
            "failed_count": failed_count,
        },
        ensure_ascii=False,
    )
    write_audit_log(
        session,
        actor=audit_actor(current_user, payload.started_by),
        action="dingtalk.approval_modified_resync",
        resource_type="sync_job",
        resource_id=job.id,
        summary=f"按修改时间重刷审批：{updated_count} 条",
        metadata={"template_id": payload.template_id, "store_id": payload.store_id},
    )
    session.commit()
    session.refresh(job)
    return ApiEnvelope(
        data=ApprovalModifiedResyncResult(
            processed_count=processed_count,
            updated_count=updated_count,
            skipped_count=skipped_count,
            failed_count=failed_count,
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
            approval_instance_id=instance.id,
            approval_line_no=1,
            approval_line_key="seed-line-1",
            parse_status="parsed",
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
    for index, row in enumerate(decode_table_value(value), start=1):
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
                "line_source_type": "table_row",
                "source_row": row,
                "source_row_index": index,
            }
        )
    return rows


def installment_rows_from_form(raw_instance: dict[str, Any], default_description: str, category_l1: str | None) -> list[dict[str, Any]]:
    rows = []
    installment_fields = [
        ("首期费用", "installment-1"),
        ("第一期费用", "installment-1"),
        ("第二期费用", "installment-2"),
        ("第三期费用", "installment-3"),
        ("第四期费用", "installment-4"),
    ]
    seen_keys: set[str] = set()
    for label, line_key in installment_fields:
        if line_key in seen_keys:
            continue
        amount = parse_decimal(find_form_value(raw_instance, label))
        if amount is None or amount <= 0:
            continue
        seen_keys.add(line_key)
        rows.append(
            {
                "description": f"{default_description} {label}",
                "amount": amount,
                "category_l1": category_l1,
                "line_source_type": "installment",
                "source_installment_label": label,
                "source_line_key": line_key,
            }
        )
    return rows


def payee_snapshot_from_raw(raw_instance: dict[str, Any], payee_account: str | None) -> dict[str, Any]:
    payee_name = parse_text(find_form_value(raw_instance, "收款人", "收款账户", "账户名", "户名"))
    bank_name = parse_text(find_form_value(raw_instance, "开户银行", "银行", "收款银行"))
    bank_branch = parse_text(find_form_value(raw_instance, "开户支行", "开户地", "开户行", "支行"))
    account_no = parse_text(find_form_value(raw_instance, "银行卡号", "银行账号", "收款账号", "账号"))
    account_type = parse_text(find_form_value(raw_instance, "账户类型"))
    verify_status = parse_text(find_form_value(raw_instance, "账户校验", "收款账户信息校验", "收款账户校验"))
    raw_value = find_form_value(raw_instance, "收款账户", "收款账号", "账户")
    return {
        "payee_name": payee_name or payee_account,
        "payee_bank_name": bank_name,
        "payee_bank_branch": bank_branch,
        "payee_account_no": account_no,
        "payee_account_type": account_type,
        "payee_account_verify_status": verify_status,
        "raw_value": raw_value,
    }


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


def approval_effective_date(raw_instance: dict[str, Any], fallback: datetime | None = None) -> datetime | None:
    return (
        parse_date(
            mapped_or_form_value(
                {},
                raw_instance,
                "expense_date",
                "报销日期",
                "支出日期",
                "费用日期",
                "日期",
            )
        )
        or DingTalkClient.parse_time(raw_instance.get("finish_time") or raw_instance.get("finishTime"))
        or DingTalkClient.parse_time(raw_instance.get("create_time") or raw_instance.get("createTime"))
        or fallback
    )


def create_dingtalk_attachment_placeholders(
    session: Session,
    resource_type: str,
    resource_id: str,
    values: list[dict[str, str | None]],
) -> None:
    seen_external_ids: set[str] = set()
    for item in values:
        external_file_id = item.get("external_file_id")
        if not external_file_id or external_file_id in seen_external_ids:
            continue
        seen_external_ids.add(external_file_id)
        pending_exists = any(
            isinstance(pending, Attachment)
            and pending.resource_type == resource_type
            and pending.resource_id == resource_id
            and pending.source == "dingtalk"
            and pending.external_file_id == external_file_id
            for pending in session.new
        )
        if pending_exists:
            continue
        with session.no_autoflush:
            exists = session.scalar(
                select(Attachment).where(
                    Attachment.resource_type == resource_type,
                    Attachment.resource_id == resource_id,
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
    expense_date = approval_effective_date(raw_instance)
    table_value = mapped_or_form_value(mapped, raw_instance, "expense_table", "表格", "费用明细", "支出明细")
    expense_rows = expense_rows_from_table(table_value)
    payee_account = parse_text(
        mapped_or_form_value(mapped, raw_instance, "payee_account", "收款账户", "收款账号", "账户")
    )
    category_l1 = parse_text(
        mapped_or_form_value(mapped, raw_instance, "category_l1", "支出类型", "费用类型", "一级分类")
    )
    installment_rows = installment_rows_from_form(raw_instance, description or template.name, category_l1)
    rows = expense_rows or installment_rows or (
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


def stable_json_hash(value: dict[str, Any]) -> str:
    payload = json.dumps(value, ensure_ascii=False, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def edited_fields(item: ExpenseItem) -> set[str]:
    if not item.user_edited_fields_json:
        return set()
    try:
        fields = json.loads(item.user_edited_fields_json)
    except ValueError:
        return set()
    return {str(field) for field in fields} if isinstance(fields, list) else set()


def expense_has_bank_match(session: Session, item: ExpenseItem) -> bool:
    return session.scalar(select(ExpenseBankMatch.id).where(ExpenseBankMatch.expense_item_id == item.id).limit(1)) is not None


def source_document_id_for_line(instance_id: str, total_rows: int, line_key: str) -> str:
    return instance_id if total_rows == 1 else f"{instance_id}:{line_key}"


def expense_source_snapshot(
    *,
    store_id: str,
    ledger_period: str,
    expense_date: datetime,
    row: dict[str, Any],
    payee_account: str | None,
    payee_snapshot: dict[str, Any],
    category_l1: str | None,
    category_l2: str | None,
    supplier_name: str | None,
    line_no: int,
    line_key: str,
    line_source_type: str,
) -> dict[str, Any]:
    return {
        "store_id": store_id,
        "ledger_period": ledger_period,
        "expense_date": expense_date.date().isoformat(),
        "description": str(row["description"]),
        "amount": str(Decimal(row["amount"]).quantize(Decimal("0.01"))),
        "category_l1": category_l1,
        "category_l2": category_l2,
        "supplier_name": supplier_name,
        "payee_account": payee_account,
        "payee_snapshot": payee_snapshot,
        "source_row": row.get("source_row"),
        "source_installment_label": row.get("source_installment_label"),
        "approval_line_no": line_no,
        "approval_line_key": line_key,
        "approval_line_source_type": line_source_type,
    }


def sync_expense_line(
    session: Session,
    *,
    instance: ApprovalInstance,
    source_document_id: str,
    snapshot: dict[str, Any],
    row: dict[str, Any],
    store_id: str,
    ledger_period: str,
    expense_date: datetime,
    category_l1: str | None,
    category_l2: str | None,
    supplier_name: str | None,
    payee_account: str | None,
    payee_snapshot: dict[str, Any],
    line_no: int,
    line_key: str,
    line_source_type: str,
) -> tuple[ExpenseItem, bool]:
    source_hash = stable_json_hash(snapshot)
    snapshot_json = json.dumps(snapshot, ensure_ascii=False, sort_keys=True)
    # ✅ 按 source_document_id 查询，实现幂等性
    item = session.scalar(select(ExpenseItem).where(ExpenseItem.source_document_id == source_document_id))
    if item is None:
        item = ExpenseItem(
            store_id=store_id,
            ledger_period=ledger_period,
            expense_date=expense_date,
            description=str(row["description"]),
            amount=row["amount"],
            category_l1=category_l1,
            category_l2=category_l2,
            supplier_name=supplier_name,
            payee_account=payee_account,
            approval_instance_id=instance.id,
            approval_line_no=line_no,
            approval_line_key=line_key,
            approval_line_source_type=line_source_type,
            parse_status="parsed",
            source_sync_hash=source_hash,
            source_snapshot_json=snapshot_json,
            sync_conflict_status="none",
            payee_name=parse_text(payee_snapshot.get("payee_name")),
            payee_bank_name=parse_text(payee_snapshot.get("payee_bank_name")),
            payee_bank_branch=parse_text(payee_snapshot.get("payee_bank_branch")),
            payee_account_no=parse_text(payee_snapshot.get("payee_account_no")),
            payee_account_type=parse_text(payee_snapshot.get("payee_account_type")),
            payee_account_verify_status=parse_text(payee_snapshot.get("payee_account_verify_status")),
            payee_account_snapshot_json=json.dumps(payee_snapshot, ensure_ascii=False, sort_keys=True),
            source="dingtalk",
            source_document_id=source_document_id,
        )
        session.add(item)
        session.flush()
        return item, True

    # ✅ 已存在的支出行：处理更新或冲突检测
    matched = expense_has_bank_match(session, item)
    if item.source_sync_hash and item.source_sync_hash != source_hash:
        # 源数据变化了
        item.sync_conflict_status = (
            "amount_changed_after_matched"
            if matched and str(item.amount) != snapshot["amount"]
            else "source_changed"
        )
    elif item.sync_conflict_status in {None, "source_removed"}:
        # 恢复正常状态
        item.sync_conflict_status = "none"

    # ✅ 选择性更新：保护用户手动编辑的字段
    protected_fields = edited_fields(item)
    source_updates = {
        "store_id": store_id,
        "ledger_period": ledger_period,
        "expense_date": expense_date,
        "description": str(row["description"]),
        "amount": row["amount"],
        "category_l1": category_l1,
        "category_l2": category_l2,
        "supplier_name": supplier_name,
        "payee_account": payee_account,
        "payee_name": parse_text(payee_snapshot.get("payee_name")),
        "payee_bank_name": parse_text(payee_snapshot.get("payee_bank_name")),
        "payee_bank_branch": parse_text(payee_snapshot.get("payee_bank_branch")),
        "payee_account_no": parse_text(payee_snapshot.get("payee_account_no")),
        "payee_account_type": parse_text(payee_snapshot.get("payee_account_type")),
        "payee_account_verify_status": parse_text(payee_snapshot.get("payee_account_verify_status")),
    }
    for field, value in source_updates.items():
        if field in protected_fields:
            # 用户编辑过，不覆盖
            continue
        if matched and field in {"amount", "store_id", "ledger_period"}:
            # 已匹配的支出，这些字段不能改
            continue
        setattr(item, field, value)

    item.approval_instance_id = instance.id
    item.approval_line_no = line_no
    item.approval_line_key = line_key
    item.approval_line_source_type = line_source_type
    item.parse_status = "parsed"
    item.source_sync_hash = source_hash
    item.source_snapshot_json = snapshot_json
    item.payee_account_snapshot_json = json.dumps(payee_snapshot, ensure_ascii=False, sort_keys=True)
    session.flush()
    return item, False


def mark_removed_expense_lines(session: Session, instance: ApprovalInstance, active_source_document_ids: set[str]) -> None:
    prefix = f"{instance.dingtalk_instance_id}:"
    items = list(
        session.scalars(
            select(ExpenseItem).where(
                ExpenseItem.source == "dingtalk",
                ExpenseItem.approval_instance_id == instance.id,
                ExpenseItem.source_document_id.is_not(None),
            )
        )
    )
    legacy_items = list(
        session.scalars(
            select(ExpenseItem).where(
                ExpenseItem.source == "dingtalk",
                ExpenseItem.approval_instance_id.is_(None),
                ExpenseItem.source_document_id.is_not(None),
                ExpenseItem.source_document_id.in_([instance.dingtalk_instance_id])
                | ExpenseItem.source_document_id.startswith(prefix),
            )
        )
    )
    for item in [*items, *legacy_items]:
        if item.source_document_id in active_source_document_ids:
            continue
        item.approval_instance_id = instance.id
        item.parse_status = "source_removed"
        item.sync_conflict_status = (
            "source_removed_after_matched" if expense_has_bank_match(session, item) else "source_removed"
        )


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
    expense_date = approval_effective_date(raw_instance)
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
    payee_snapshot = payee_snapshot_from_raw(raw_instance, payee_account)
    category_l1 = parse_text(
        mapped_or_form_value(mapped, raw_instance, "category_l1", "支出类型", "费用类型", "一级分类")
    )
    installment_rows = installment_rows_from_form(raw_instance, description or template.name, category_l1)

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
    instance.dingtalk_modified_at = DingTalkClient.parse_time(
        raw_instance.get("modify_time") or raw_instance.get("modifyTime")
    ) or instance.approved_at or instance.submit_at
    instance.raw_payload = json.dumps(raw_instance, ensure_ascii=False)
    instance.synced_job_id = job.id
    session.flush()
    create_dingtalk_attachment_placeholders(session, "approval_instance", instance.id, voucher_items)

    if store is None or expense_date is None:
        missing_fields = []
        if store is None:
            missing_fields.append("store")
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
        instance.parse_status = "skipped"
        instance.processing_status = "unparsed"
        instance.parse_error = f"Missing required fields: {', '.join(missing_fields)}"
        instance.last_parsed_at = utc_now()
        return True
    if instance.approval_status.lower() not in COMPLETED_APPROVAL_STATUSES:
        instance.parse_status = "skipped"
        instance.processing_status = "unparsed"
        instance.parse_error = f"Approval status is not completed: {instance.approval_status}"
        instance.last_parsed_at = utc_now()
        return True
    period = expense_date.strftime("%Y-%m")
    if session.scalar(select(Ledger).where(Ledger.store_id == store.id, Ledger.period == period)) is None:
        session.add(Ledger(store_id=store.id, period=period))
        session.flush()

    approval_total = amount or sum((Decimal(row["amount"]) for row in [*expense_rows, *installment_rows]), Decimal("0.00"))
    if approval_total <= 0:
        instance.parse_status = "skipped"
        instance.processing_status = "unparsed"
        instance.parse_error = "Unable to resolve approval amount"
        instance.last_parsed_at = utc_now()
        return True
    rows_to_create = expense_rows or installment_rows or [
        {
            "description": parse_text(raw_instance.get("title") or raw_instance.get("titleName"))
            or description
            or template.name,
            "amount": approval_total,
            "category_l1": category_l1,
            "category_l2": parse_text(mapped.get("category_l2")),
            "supplier_name": parse_text(mapped.get("supplier_name")),
            "line_source_type": "whole_approval",
        }
    ]
    created_expense_ids: list[str] = []
    active_source_document_ids: set[str] = set()
    for line_no, row in enumerate(rows_to_create, start=1):
        approval_line_key = parse_text(row.get("source_line_key")) or f"line-{line_no}"
        line_source_type = parse_text(row.get("line_source_type")) or "whole_approval"
        source_document_id = source_document_id_for_line(
            instance.dingtalk_instance_id,
            len(rows_to_create),
            approval_line_key,
        )
        active_source_document_ids.add(source_document_id)
        row_category_l1 = parse_text(row.get("category_l1")) or category_l1
        row_category_l2 = parse_text(row.get("category_l2")) or parse_text(mapped.get("category_l2"))
        row_supplier_name = parse_text(row.get("supplier_name")) or parse_text(mapped.get("supplier_name"))
        snapshot = expense_source_snapshot(
            store_id=store.id,
            ledger_period=period,
            expense_date=expense_date,
            row=row,
            category_l1=row_category_l1,
            category_l2=row_category_l2,
            supplier_name=row_supplier_name,
            payee_account=payee_account,
            payee_snapshot=payee_snapshot,
            line_no=line_no,
            line_key=approval_line_key,
            line_source_type=line_source_type,
        )
        expense_item, created = sync_expense_line(
            session,
            instance=instance,
            source_document_id=source_document_id,
            snapshot=snapshot,
            row=row,
            store_id=store.id,
            ledger_period=period,
            expense_date=expense_date,
            category_l1=row_category_l1,
            category_l2=row_category_l2,
            supplier_name=row_supplier_name,
            payee_account=payee_account,
            payee_snapshot=payee_snapshot,
            line_no=line_no,
            line_key=approval_line_key,
            line_source_type=line_source_type,
        )
        if created:
            created_expense_ids.append(expense_item.id)
            create_dingtalk_attachment_placeholders(
                session,
                "expense_item",
                expense_item.id,
                [
                    *voucher_items,
                ],
            )
    mark_removed_expense_lines(session, instance, active_source_document_ids)
    instance.parse_status = "parsed"
    instance.parse_error = None
    instance.last_parsed_at = utc_now()
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
    refresh_approval_processing_status(session, instance.id)
    return True


def parse_sync_cursors(value: str | None) -> dict[str, int]:
    if not value:
        return {}
    try:
        payload = json.loads(value)
    except json.JSONDecodeError:
        payload = None
    if isinstance(payload, dict):
        cursors = payload.get("cursors", payload)
        if isinstance(cursors, dict):
            parsed: dict[str, int] = {}
            for process_code, cursor in cursors.items():
                try:
                    cursor_value = int(cursor)
                except (TypeError, ValueError):
                    continue
                if isinstance(process_code, str) and process_code and cursor_value >= 0:
                    parsed[process_code] = cursor_value
            return parsed
    if ":" not in value:
        return {}
    process_code, cursor_text = value.split(":", 1)
    try:
        cursor = int(cursor_text)
    except ValueError:
        return {}
    return {process_code: cursor} if process_code and cursor >= 0 else {}


def serialize_sync_cursors(cursors: dict[str, int]) -> str | None:
    if not cursors:
        return None
    return json.dumps({"cursors": cursors}, ensure_ascii=False, sort_keys=True)


def normalize_sync_datetime(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value
    return value.astimezone(UTC).replace(tzinfo=None)


def validate_approval_sync_window(start_at: datetime, end_at: datetime) -> tuple[datetime, datetime]:
    """验证并调整审批同步的时间窗口

    检查项:
    1. 时间顺序：start_at 必须 < end_at
    2. 时间跨度：不超过 APPROVAL_SYNC_MAX_WINDOW_DAYS (120 天)
    3. 回溯限制：不超过 APPROVAL_SYNC_MAX_LOOKBACK_DAYS (365 天)
    4. 未来限制：end_at 不能超过当前时间

    Args:
        start_at: 同步开始时间 (UTC)
        end_at: 同步结束时间 (UTC)

    Returns:
        经过验证和调整的 (start_at, end_at) 元组

    Raises:
        HTTPException: 时间窗口无效
    """
    start_at = normalize_sync_datetime(start_at)
    end_at = normalize_sync_datetime(end_at)
    now = utc_now()

    # ✅ 检查 1: 时间顺序
    if end_at <= start_at:
        raise HTTPException(
            status_code=422,
            detail=f"结束时间必须晚于开始时间。开始: {start_at.isoformat()}, 结束: {end_at.isoformat()}"
        )

    # ✅ 检查 2: 时间跨度不超过 120 天
    days_span = (end_at - start_at).days
    if days_span > APPROVAL_SYNC_MAX_WINDOW_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"单次审批同步时间范围不能超过 {APPROVAL_SYNC_MAX_WINDOW_DAYS} 天，您请求的范围为 {days_span} 天"
        )

    # ✅ 检查 3: 回溯限制（不超过 365 天前）
    lookback_limit = now - timedelta(days=APPROVAL_SYNC_MAX_LOOKBACK_DAYS)
    if start_at < lookback_limit:
        raise HTTPException(
            status_code=422,
            detail=f"开始时间不能早于当前时间 {APPROVAL_SYNC_MAX_LOOKBACK_DAYS} 天。最早允许: {lookback_limit.isoformat()}"
        )

    # ✅ 检查 4: end_at 不能超过当前时间（调整而不是报错）
    if end_at > now:
        end_at = now

    return start_at, end_at


def parse_auto_sync_resume_state(
    value: str | None,
) -> tuple[datetime, datetime, dict[str, int]] | None:
    if not value:
        return None
    try:
        payload = json.loads(value)
        start_at = datetime.fromisoformat(str(payload["start_at"]))
        end_at = datetime.fromisoformat(str(payload["end_at"]))
    except (KeyError, TypeError, ValueError, json.JSONDecodeError):
        return None
    try:
        start_at, end_at = validate_approval_sync_window(start_at, end_at)
    except HTTPException:
        return None
    cursors = parse_sync_cursors(json.dumps({"cursors": payload.get("cursors", {})}))
    return start_at, end_at, cursors


def serialize_auto_sync_resume_state(
    start_at: datetime,
    end_at: datetime,
    cursors: dict[str, int],
) -> str:
    return json.dumps(
        {
            "start_at": start_at.isoformat(),
            "end_at": end_at.isoformat(),
            "cursors": cursors,
        },
        ensure_ascii=False,
        sort_keys=True,
    )


def should_skip_stable_approval(instance: ApprovalInstance, sync_window_days: int = 30) -> bool:
    """判断是否可以跳过稳定的审批（完成超过 N 天且状态正常）

    稳定的审批满足：
    1. 已完成状态（不会再变化）
    2. 已成功解析且关联门店
    3. 完成时间或修改时间超过 sync_window_days 天

    Args:
        instance: 审批实例
        sync_window_days: 同步窗口天数，默认 30 天

    Returns:
        True 表示可以跳过（审批稳定），False 表示需要同步
    """
    # 审批未完成 → 不跳过
    if instance.approval_status.lower() not in COMPLETED_APPROVAL_STATUSES:
        return False

    # 解析失败或未关联门店 → 不跳过
    if instance.parse_status != "parsed" or instance.store_id is None:
        return False

    ref_time = instance.dingtalk_modified_at or instance.approved_at or instance.submit_at

    if ref_time is None:
        return True

    days_since_change = (utc_now() - ref_time).days
    return days_since_change > sync_window_days


def approval_needs_detail_resync(instance: ApprovalInstance) -> bool:
    """判断已存在的审批是否需要重新从钉钉拉取详情

    需要重新同步的情况：
    1. 审批状态不是完成状态（可能还在流转）
    2. 没有关联门店（解析不完整）
    3. 解析状态不是已解析
    4. 处理状态需要重新同步
    5. 解析被跳过（缺少必填字段）
    6. ✅ 上次同步超过 N 天（可能有后续修改）
    """
    if instance.approval_status.lower() not in COMPLETED_APPROVAL_STATUSES:
        return True
    if instance.store_id is None:
        return True
    if instance.parse_status != "parsed":
        return True

    if instance.processing_status in RESYNC_PROCESSING_STATUSES:
        return True
    payload = approval_raw_payload(instance)
    parsed = payload.get("_fin_hub_parse")
    return isinstance(parsed, dict) and parsed.get("expense_parse_status") == "skipped"


def ensure_sync_job_not_canceled(session: Session, job: SyncJob) -> None:
    session.flush()
    session.refresh(job)
    if job.status == SyncJobStatus.CANCELED.value:
        job.finished_at = job.finished_at or utc_now()
        job.error_message = job.error_message or "同步已取消"
        session.commit()
        raise ApprovalSyncCanceled


def run_approval_sync(
    session: Session,
    *,
    job: SyncJob,
    templates: list[ApprovalTemplate],
    page_size: int,
    max_pages: int,
    skip_existing: bool = True,
    resume_cursors: dict[str, int] | None = None,
) -> set[str]:
    template_summaries: list[dict[str, Any]] = []
    incomplete_cursors: dict[str, int] = {}
    handled_instance_ids: set[str] = set()
    resume_cursors = resume_cursors or {}
    for template in templates:
        ensure_sync_job_not_canceled(session, job)
        if should_use_real_dingtalk():
            config = get_or_create_config(session)
            client = dingtalk_client(config)
            end_at = job.request_end_at or utc_now()
            start_at = job.request_start_at or end_at - timedelta(days=31)
            job.request_start_at = start_at
            job.request_end_at = end_at
            cursor = resume_cursors.get(template.process_code, 0)
            template_processed = 0
            template_skipped_existing = 0
            template_next_cursor: str | None = None
            for page_index in range(max_pages):
                ensure_sync_job_not_canceled(session, job)
                ids, next_cursor = client.list_process_instance_ids(
                    template.process_code,
                    int(start_at.timestamp() * 1000),
                    int(end_at.timestamp() * 1000),
                    cursor=cursor,
                    size=page_size,
                )
                template_next_cursor = str(next_cursor) if next_cursor is not None else None
                for instance_id in ids:
                    ensure_sync_job_not_canceled(session, job)
                    handled_instance_ids.add(instance_id)
                    job.processed_count += 1
                    template_processed += 1
                    # ✅ 改进：添加行级锁（for_update），防止并发冲突
                    # PostgreSQL 支持 SELECT ... FOR UPDATE
                    existing_instance = session.scalar(
                        select(ApprovalInstance)
                        .where(ApprovalInstance.dingtalk_instance_id == instance_id)
                        .with_for_update()  # ✅ 获取排他锁
                    )
                    if (
                        skip_existing
                        and existing_instance is not None
                        and not approval_needs_detail_resync(existing_instance)
                        and should_skip_stable_approval(existing_instance, sync_window_days=30)
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
                    # ✅ 立即提交，释放锁
                    session.commit()
                if not next_cursor or not ids:
                    template_next_cursor = None
                    break
                cursor = next_cursor
            else:
                if template_next_cursor:
                    incomplete_cursors[template.process_code] = int(template_next_cursor)
            template_summaries.append(
                {
                    "template_id": template.id,
                    "process_code": template.process_code,
                    "processed_count": template_processed,
                    "skipped_existing_count": template_skipped_existing,
                    "next_cursor": template_next_cursor,
                }
            )
        else:
            ensure_sync_job_not_canceled(session, job)
            job.processed_count += 1
            instance = create_expense_from_instance(session, template, job)
            if instance is None:
                job.failed_count += 1
                job.error_message = "No store available for approval sync"
            else:
                handled_instance_ids.add(instance.dingtalk_instance_id)
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

    retry_refreshed_count = 0
    if should_use_real_dingtalk():
        templates_by_id = {template.id: template for template in templates}
        # ✅ 改进：批量加载待重试审批，避免一次性加载所有数据到内存
        BATCH_SIZE = 1000
        offset = 0
        while True:
            retry_instances = list(
                session.scalars(
                    select(ApprovalInstance)
                    .where(ApprovalInstance.template_id.in_(templates_by_id.keys()))
                    .offset(offset)
                    .limit(BATCH_SIZE)
                )
            )
            if not retry_instances:
                break

            config = get_or_create_config(session)
            client = dingtalk_client(config)
            for instance in retry_instances:
                ensure_sync_job_not_canceled(session, job)
                if instance.dingtalk_instance_id in handled_instance_ids or not approval_needs_detail_resync(instance):
                    continue
                # ✅ 再次获取排他锁，防止并发修改
                instance = session.scalar(
                    select(ApprovalInstance)
                    .where(ApprovalInstance.id == instance.id)
                    .with_for_update()
                )
                if instance is None:
                    continue
                handled_instance_ids.add(instance.dingtalk_instance_id)
                job.processed_count += 1
                retry_refreshed_count += 1
                raw_instance = client.get_process_instance(instance.dingtalk_instance_id)
                raw_instance.setdefault("process_instance_id", instance.dingtalk_instance_id)
                if sync_real_instance(session, templates_by_id[instance.template_id], job, raw_instance):
                    job.success_count += 1
                else:
                    job.failed_count += 1
                    job.error_message = "Some approval instances are missing mapped store, amount or date"
                # ✅ 立即提交
                session.commit()

            offset += BATCH_SIZE

    if retry_refreshed_count:
        template_summaries.append({"retry_refreshed_count": retry_refreshed_count})
    ensure_sync_job_not_canceled(session, job)
    job.next_cursor = serialize_sync_cursors(incomplete_cursors)
    if incomplete_cursors:
        job.status = SyncJobStatus.FAILED.value
        job.error_message = "DingTalk approval sync is incomplete; resume is required before advancing the sync window"
    else:
        job.status = SyncJobStatus.SUCCEEDED.value if job.failed_count == 0 else SyncJobStatus.FAILED.value
    job.finished_at = utc_now()
    job.raw_summary = json.dumps({"templates": template_summaries}, ensure_ascii=False)
    if job.status == SyncJobStatus.SUCCEEDED.value:
        config = get_or_create_config(session)
        config.last_instance_sync_at = utc_now()
    session.commit()
    return handled_instance_ids


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
    approval_window: tuple[datetime, datetime] | None = None

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
            resume_state = parse_auto_sync_resume_state(setting.approval_resume_state)
            if resume_state:
                start_at, end_at, resume_cursors = resume_state
            else:
                end_at = utc_now()
                # ✅ 改进：使用配置的 window_days 和 overlap_days
                approval_window_days = setting.window_days
                approval_overlap_days = setting.approval_overlap_days
                start_at = (
                    setting.approval_watermark_at - timedelta(days=approval_overlap_days)
                    if setting.approval_watermark_at
                    else end_at - timedelta(days=approval_window_days)
                )
                start_at, end_at = validate_approval_sync_window(start_at, end_at)
                resume_cursors = {}
            approval_window = (start_at, end_at)
            update_progress(
                "approvals_sync",
                "running",
                page_size=AUTO_SYNC_APPROVAL_PAGE_SIZE,
                max_pages=AUTO_SYNC_APPROVAL_MAX_PAGES,
                incremental_start_at=start_at.isoformat(),
                incremental_end_at=end_at.isoformat(),
                resuming=bool(resume_state),
            )
            job.request_end_at = end_at
            job.request_start_at = start_at
            templates_query = (
                select(ApprovalTemplate)
                .where(ApprovalTemplate.is_enabled.is_(True))
                .order_by(ApprovalTemplate.created_at.asc())
            )
            if resume_cursors:
                templates_query = templates_query.where(
                    ApprovalTemplate.process_code.in_(resume_cursors)
                )
            templates = list(
                session.scalars(
                    templates_query
                )
            )
            if not templates:
                raise HTTPException(status_code=404, detail="No enabled approval templates for approval sync")
            run_approval_sync(
                session,
                job=job,
                templates=templates,
                page_size=AUTO_SYNC_APPROVAL_PAGE_SIZE,
                max_pages=AUTO_SYNC_APPROVAL_MAX_PAGES,
                skip_existing=setting.skip_existing,
                resume_cursors=resume_cursors,
            )
            approval_sync_summary = json.loads(job.raw_summary) if job.raw_summary else None
            if job.status == SyncJobStatus.SUCCEEDED.value and not job.next_cursor:
                setting.approval_watermark_at = end_at
                setting.approval_resume_state = None
            else:
                setting.approval_resume_state = serialize_auto_sync_resume_state(
                    start_at,
                    end_at,
                    parse_sync_cursors(job.next_cursor),
                )
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

        # ✅ 改进：记录失败的详细信息，便于后续诊断和恢复
        failed_summary = {
            "error": job.error_message,
            "progress": progress,
            "failed_templates": {},  # 记录各模板的失败详情
        }

        # ✅ 如果是部分失败，记录可恢复的游标
        if approval_sync_summary:
            for template_summary in approval_sync_summary.get("templates", []):
                if template_summary.get("next_cursor"):
                    failed_summary["failed_templates"][template_summary["process_code"]] = {
                        "processed": template_summary.get("processed_count", 0),
                        "failed": template_summary.get("failed_count", 0),
                        "next_cursor": template_summary["next_cursor"],
                        "reason": "Incomplete - can resume from cursor"
                    }

        job.raw_summary = json.dumps(failed_summary, ensure_ascii=False)
        setting.last_status = job.status
        setting.last_error = job.error_message
        if setting.sync_approvals and approval_window:
            setting.approval_resume_state = serialize_auto_sync_resume_state(
                approval_window[0],
                approval_window[1],
                parse_sync_cursors(job.next_cursor),
            )
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
                DingTalkAutoSyncSetting.paused.is_(False),
                (DingTalkAutoSyncSetting.next_run_at.is_(None))
                | (DingTalkAutoSyncSetting.next_run_at <= now),
            )
        )
    )
    results: list[DingTalkAutoSyncRunResult] = []
    for setting in settings_rows:
        if running_dingtalk_sync_job(session) is not None:
            continue
        results.append(execute_auto_sync(session, setting, started_by="auto-sync"))
    return results


@router.post("/auto-sync/run", response_model=ApiEnvelope[DingTalkAutoSyncRunResult], status_code=201)
def run_auto_sync_now(
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[DingTalkAutoSyncRunResult]:
    setting = get_or_create_auto_sync_setting(session)
    if setting.paused:
        raise HTTPException(status_code=409, detail="自动同步已暂停，请先恢复后再执行自动同步")
    ensure_no_running_dingtalk_sync(session)
    return ApiEnvelope(data=execute_auto_sync(session, setting, started_by=audit_actor(current_user)))


def execute_approval_sync_job(
    job_id: str,
    template_ids: list[str],
    *,
    page_size: int,
    max_pages: int,
    skip_existing: bool,
    actor: str,
    action: str = "dingtalk.approval_sync",
    resume_cursors: dict[str, int] | None = None,
) -> None:
    with SessionLocal() as session:
        job = session.get(SyncJob, job_id)
        if job is None:
            return
        templates = list(
            session.scalars(
                select(ApprovalTemplate)
                .where(
                    ApprovalTemplate.id.in_(template_ids),
                    ApprovalTemplate.is_enabled.is_(True),
                )
                .order_by(ApprovalTemplate.created_at.asc())
            )
        )
        try:
            run_approval_sync(
                session,
                job=job,
                templates=templates,
                page_size=page_size,
                max_pages=max_pages,
                skip_existing=skip_existing,
                resume_cursors=resume_cursors,
            )
            write_audit_log(
                session,
                actor=actor,
                action=action,
                resource_type="sync_job",
                resource_id=job.id,
                summary=f"同步钉钉审批：成功 {job.success_count} 条，失败 {job.failed_count} 条",
            )
            session.commit()
        except ApprovalSyncCanceled:
            write_audit_log(
                session,
                actor=actor,
                action=f"{action}.canceled",
                resource_type="sync_job",
                resource_id=job.id,
                summary="取消钉钉审批同步",
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
                actor=actor,
                action=f"{action}.failed",
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


@router.post("/approval-sync", response_model=ApiEnvelope[SyncJobRead], status_code=201)
def start_approval_sync(
    payload: StartApprovalSyncRequest,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[SyncJobRead]:
    ensure_no_running_dingtalk_sync(session)
    query = select(ApprovalTemplate).where(ApprovalTemplate.is_enabled.is_(True))
    if payload.template_id:
        query = query.where(ApprovalTemplate.id == payload.template_id)
    templates = session.scalars(query.order_by(ApprovalTemplate.created_at.asc())).all()
    if not templates:
        raise HTTPException(status_code=404, detail="No enabled approval templates")

    requested_end_at = normalize_sync_datetime(payload.end_at or utc_now())
    requested_start_at = normalize_sync_datetime(
        payload.start_at or requested_end_at - timedelta(days=31)
    )
    requested_start_at, requested_end_at = validate_approval_sync_window(
        requested_start_at,
        requested_end_at,
    )
    actor = audit_actor(current_user, payload.started_by)
    job = SyncJob(
        job_type="dingtalk_approval_sync",
        status=SyncJobStatus.RUNNING.value,
        started_by=actor,
        started_at=utc_now(),
        request_start_at=requested_start_at,
        request_end_at=requested_end_at,
    )
    session.add(job)
    session.flush()
    if payload.run_async:
        session.commit()
        background_tasks.add_task(
            execute_approval_sync_job,
            job.id,
            [template.id for template in templates],
            page_size=payload.page_size,
            max_pages=payload.max_pages,
            skip_existing=payload.skip_existing,
            actor=actor,
        )
        session.refresh(job)
        return ApiEnvelope(data=job)

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
            actor=actor,
            action="dingtalk.approval_sync",
            resource_type="sync_job",
            resource_id=job.id,
            summary=f"同步钉钉审批：成功 {job.success_count} 条，失败 {job.failed_count} 条",
        )
        session.commit()
    except ApprovalSyncCanceled:
        write_audit_log(
            session,
            actor=actor,
            action="dingtalk.approval_sync.canceled",
            resource_type="sync_job",
            resource_id=job.id,
            summary="取消钉钉审批同步",
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
            actor=actor,
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


@router.post(
    "/store-approval-sync",
    response_model=ApiEnvelope[StoreApprovalSyncResult],
    status_code=201,
)
def start_store_approval_sync(
    payload: StartStoreApprovalSyncRequest,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.view")),
) -> ApiEnvelope[StoreApprovalSyncResult]:
    ensure_permission(session, current_user, "reconciliation.manage")
    ensure_store_access(session, current_user, payload.store_id)
    ensure_no_running_dingtalk_sync(session)

    store = session.get(Store, payload.store_id)
    if store is None:
        raise HTTPException(status_code=404, detail="Store not found")
    period_year, period_month = (int(part) for part in payload.ledger_period.split("-"))
    period_local_start = datetime(period_year, period_month, 1, tzinfo=AUTO_SYNC_TIMEZONE)
    period_local_end = (
        datetime(period_year + 1, 1, 1, tzinfo=AUTO_SYNC_TIMEZONE)
        if period_month == 12
        else datetime(period_year, period_month + 1, 1, tzinfo=AUTO_SYNC_TIMEZONE)
    )
    period_start = normalize_sync_datetime(period_local_start)
    period_end = normalize_sync_datetime(period_local_end)
    if session.scalar(
        select(Ledger.id).where(
            Ledger.store_id == payload.store_id,
            Ledger.period == payload.ledger_period,
        )
    ) is None:
        raise HTTPException(status_code=404, detail="Ledger not found")

    query = select(ApprovalTemplate).where(ApprovalTemplate.is_enabled.is_(True))
    if payload.template_id:
        query = query.where(ApprovalTemplate.id == payload.template_id)
    templates = session.scalars(query.order_by(ApprovalTemplate.created_at.asc())).all()
    if not templates:
        raise HTTPException(status_code=404, detail="No enabled approval templates")

    requested_start_at = normalize_sync_datetime(payload.start_at) if payload.start_at else period_start
    requested_end_at = normalize_sync_datetime(payload.end_at) if payload.end_at else period_end
    request_start_at, request_end_at = validate_approval_sync_window(
        requested_start_at,
        min(requested_end_at, utc_now()),
    )
    job = SyncJob(
        job_type="dingtalk_store_approval_sync",
        status=SyncJobStatus.RUNNING.value,
        started_by=audit_actor(current_user, payload.started_by),
        started_at=utc_now(),
        request_start_at=request_start_at,
        request_end_at=request_end_at,
    )
    session.add(job)
    session.flush()

    try:
        handled_instance_ids = run_approval_sync(
            session,
            job=job,
            templates=templates,
            page_size=AUTO_SYNC_APPROVAL_PAGE_SIZE,
            max_pages=100,
            skip_existing=payload.skip_existing,
        )
        session.flush()
        handled_instances = list(
            session.scalars(
                select(ApprovalInstance).where(
                    ApprovalInstance.dingtalk_instance_id.in_(handled_instance_ids)
                )
            )
        ) if handled_instance_ids else []
        matched_instances = [
            instance
            for instance in handled_instances
            if instance.store_id == payload.store_id
            and instance.submit_at is not None
            and request_start_at <= instance.submit_at < request_end_at
        ]
        unresolved_store_count = sum(instance.store_id is None for instance in handled_instances)
        result = StoreApprovalSyncResult(
            job=SyncJobRead.model_validate(job),
            store_id=payload.store_id,
            ledger_period=payload.ledger_period,
            scanned_count=job.processed_count,
            matched_count=len(matched_instances),
            outside_scope_count=len(handled_instances) - len(matched_instances) - unresolved_store_count,
            unresolved_store_count=unresolved_store_count,
        )
        summary = json.loads(job.raw_summary) if job.raw_summary else {}
        summary["store_scope"] = {
            "store_id": payload.store_id,
            "ledger_period": payload.ledger_period,
            "matched_count": result.matched_count,
            "outside_scope_count": result.outside_scope_count,
            "unresolved_store_count": result.unresolved_store_count,
        }
        job.raw_summary = json.dumps(summary, ensure_ascii=False)
        write_audit_log(
            session,
            actor=audit_actor(current_user, payload.started_by),
            action="dingtalk.store_approval_sync",
            resource_type="sync_job",
            resource_id=job.id,
            summary=f"同步门店账期审批：{store.name} {payload.ledger_period}，归入 {result.matched_count} 条",
            metadata=result.model_dump(mode="json", exclude={"job"}),
        )
        session.commit()
    except DingTalkClientError as exc:
        job.status = SyncJobStatus.FAILED.value
        job.failed_count += 1
        job.error_message = str(exc)
        job.finished_at = utc_now()
        job.raw_summary = json.dumps({"error": str(exc)}, ensure_ascii=False)
        session.commit()
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    except Exception:
        job.status = SyncJobStatus.FAILED.value
        job.finished_at = utc_now()
        session.commit()
        raise
    session.refresh(job)
    result.job = SyncJobRead.model_validate(job)
    return ApiEnvelope(data=result)


@router.post("/sync-jobs/{job_id}/resume", response_model=ApiEnvelope[SyncJobRead], status_code=201)
def resume_approval_sync(
    job_id: str,
    payload: ResumeApprovalSyncRequest,
    background_tasks: BackgroundTasks,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[SyncJobRead]:
    previous_job = session.get(SyncJob, job_id)
    if previous_job is None:
        raise HTTPException(status_code=404, detail="Sync job not found")
    resume_cursors = parse_sync_cursors(previous_job.next_cursor)
    if previous_job.job_type != "dingtalk_approval_sync" or not resume_cursors:
        raise HTTPException(status_code=409, detail="Sync job has no resumable cursor")
    ensure_no_running_dingtalk_sync(session)
    templates = list(
        session.scalars(
            select(ApprovalTemplate).where(
                ApprovalTemplate.process_code.in_(resume_cursors),
                ApprovalTemplate.is_enabled.is_(True),
            )
        )
    )
    if len(templates) != len(resume_cursors):
        raise HTTPException(status_code=404, detail="Approval template for cursor not found")

    actor = audit_actor(current_user, payload.started_by)
    job = SyncJob(
        job_type="dingtalk_approval_sync",
        status=SyncJobStatus.RUNNING.value,
        started_by=actor,
        started_at=utc_now(),
        request_start_at=previous_job.request_start_at,
        request_end_at=previous_job.request_end_at,
        next_cursor=previous_job.next_cursor,
    )
    session.add(job)
    session.flush()
    if payload.run_async:
        session.commit()
        background_tasks.add_task(
            execute_approval_sync_job,
            job.id,
            [template.id for template in templates],
            page_size=payload.page_size,
            max_pages=payload.max_pages,
            skip_existing=payload.skip_existing,
            actor=actor,
            action="dingtalk.approval_sync.resume",
            resume_cursors=resume_cursors,
        )
        session.refresh(job)
        return ApiEnvelope(data=job)

    try:
        run_approval_sync(
            session,
            job=job,
            templates=templates,
            page_size=payload.page_size,
            max_pages=payload.max_pages,
            skip_existing=payload.skip_existing,
            resume_cursors=resume_cursors,
        )
        write_audit_log(
            session,
            actor=actor,
            action="dingtalk.approval_sync.resume",
            resource_type="sync_job",
            resource_id=job.id,
            summary=f"续跑钉钉审批同步：成功 {job.success_count} 条，失败 {job.failed_count} 条",
            metadata={"previous_job_id": previous_job.id, "resume_cursor": previous_job.next_cursor},
        )
        session.commit()
    except ApprovalSyncCanceled:
        write_audit_log(
            session,
            actor=actor,
            action="dingtalk.approval_sync.resume.canceled",
            resource_type="sync_job",
            resource_id=job.id,
            summary="取消钉钉审批续跑",
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
            actor=actor,
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


@router.post("/sync-jobs/{job_id}/cancel", response_model=ApiEnvelope[SyncJobRead])
def cancel_sync_job(
    job_id: str,
    session: Session = Depends(get_session),
    current_user: User = Depends(require_permission("dingtalk.manage")),
) -> ApiEnvelope[SyncJobRead]:
    job = session.get(SyncJob, job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Sync job not found")
    if job.status != SyncJobStatus.RUNNING.value:
        raise HTTPException(status_code=409, detail="Only running sync jobs can be canceled")
    if job.job_type not in {"dingtalk_approval_sync", "dingtalk_store_approval_sync", "dingtalk_auto_sync"}:
        raise HTTPException(status_code=409, detail="This sync job type cannot be canceled")
    job.status = SyncJobStatus.CANCELED.value
    job.error_message = "同步已取消"
    job.finished_at = utc_now()
    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="dingtalk.sync_job.cancel",
        resource_type="sync_job",
        resource_id=job.id,
        summary=f"取消同步任务：{job.job_type}",
    )
    session.commit()
    session.refresh(job)
    return ApiEnvelope(data=job)


@router.get("/sync-jobs", response_model=ApiEnvelope[Page[SyncJobRead]])
def list_sync_jobs(
    job_type: str | None = None,
    status: str | None = None,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[SyncJobRead]]:
    query = select(SyncJob).order_by(SyncJob.created_at.desc())
    if job_type:
        query = query.where(SyncJob.job_type == job_type)
    if status:
        query = query.where(SyncJob.status == status)
    items, total = paginate(session, query, page, page_size)
    return ApiEnvelope(data=Page(items=items, total=total, page=page, page_size=page_size))


@router.get("/approval-instances", response_model=ApiEnvelope[Page[ApprovalInstanceRead]])
def list_approval_instances(
    template_id: str | None = None,
    store_id: str | None = None,
    ledger_period: str | None = None,
    processing_status: str | None = None,
    include_matched: bool = False,
    page: int = 1,
    page_size: int = 50,
    session: Session = Depends(get_session),
) -> ApiEnvelope[Page[ApprovalInstanceRead]]:
    query = select(ApprovalInstance).join(
        ApprovalTemplate,
        ApprovalInstance.template_id == ApprovalTemplate.id,
    ).where(
        ApprovalTemplate.is_enabled.is_(True),
    ).order_by(
        ApprovalInstance.submit_at.desc().nullslast(),
        ApprovalInstance.created_at.desc(),
    )
    if template_id:
        query = query.where(ApprovalInstance.template_id == template_id)
    if store_id:
        query = query.where(ApprovalInstance.store_id == store_id)
    if ledger_period:
        period_start = datetime.strptime(f"{ledger_period}-01", "%Y-%m-%d")
        next_month = period_start.replace(year=period_start.year + 1, month=1) if period_start.month == 12 else period_start.replace(month=period_start.month + 1)
        query = query.where(
            ApprovalInstance.submit_at >= period_start,
            ApprovalInstance.submit_at < next_month,
        )
    if processing_status:
        query = query.where(ApprovalInstance.processing_status == processing_status)
    elif not include_matched:
        query = query.where(ApprovalInstance.processing_status != "matched")
    items, total = paginate(session, query, page, page_size)
    stats_by_approval_id = approval_expense_stats_map(session, [item.id for item in items])
    return ApiEnvelope(
        data=Page(
            items=[approval_instance_read(session, item, stats_by_approval_id.get(item.id)) for item in items],
            total=total,
            page=page,
            page_size=page_size,
        )
    )
