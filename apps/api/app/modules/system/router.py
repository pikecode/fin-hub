from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_session
from app.core.runtime_checks import (
    is_localhost_origin,
    is_production_environment,
    is_weak_secret,
    parse_cors_origins,
)
from app.models import User
from app.modules.auth.router import require_permission
from app.modules.dingtalk.router import dingtalk_credentials, get_or_create_config
from app.schemas import (
    ApiEnvelope,
    DatabaseBackupStatus,
    SystemReadinessCheck,
    SystemReadinessReport,
)

router = APIRouter(prefix="/system", tags=["system"])


def build_database_backup_status(session: Session) -> DatabaseBackupStatus:
    bind = session.get_bind()
    return DatabaseBackupStatus(
        supported=False,
        backend=bind.url.get_backend_name(),
        database_path=None,
        message="PostgreSQL 请使用 pg_dump、托管数据库快照或云厂商备份策略",
    )


def readiness_check(key: str, name: str, status: str, detail: str) -> SystemReadinessCheck:
    return SystemReadinessCheck(key=key, name=name, status=status, detail=detail)


def build_system_readiness_report(session: Session) -> SystemReadinessReport:
    checks: list[SystemReadinessCheck] = []
    environment = settings.app_env
    is_production = is_production_environment(environment)
    database_backend = session.get_bind().url.get_backend_name()

    if database_backend == "postgresql":
        checks.append(readiness_check("database", "数据库", "ok", f"当前数据库类型：{database_backend}"))
    else:
        checks.append(readiness_check("database", "数据库", "error", "系统仅支持 PostgreSQL 数据库"))

    if is_weak_secret():
        checks.append(readiness_check("secret-key", "服务端密钥", "error", "SECRET_KEY 必须设置为至少 32 位强随机值"))
    else:
        checks.append(readiness_check("secret-key", "服务端密钥", "ok", "SECRET_KEY 已配置"))

    cors_origins = parse_cors_origins()
    localhost_origins = [origin for origin in cors_origins if is_localhost_origin(origin)]
    if is_production and localhost_origins:
        checks.append(readiness_check("cors", "跨域来源", "error", "生产环境 CORS_ORIGINS 不能包含 localhost"))
    else:
        checks.append(readiness_check("cors", "跨域来源", "ok", f"已配置 {len(cors_origins)} 个来源"))

    storage_root = Path(settings.file_storage_root)
    storage_parent = storage_root if storage_root.exists() else storage_root.parent
    if storage_parent.exists() and storage_parent.is_dir():
        checks.append(readiness_check("file-storage", "文件存储", "ok", f"文件存储路径：{storage_root}"))
    else:
        checks.append(readiness_check("file-storage", "文件存储", "error", f"文件存储父目录不存在：{storage_parent}"))

    config = get_or_create_config(session)
    credentials = dingtalk_credentials(config)
    if settings.dingtalk_sync_mode.lower() == "real":
        if credentials is None:
            checks.append(readiness_check("dingtalk", "钉钉同步", "error", "real 模式缺少 App Key 或 App Secret"))
        elif not (settings.dingtalk_drive_union_id or config.drive_union_id):
            checks.append(readiness_check("dingtalk", "钉钉同步", "warning", "real 模式建议配置钉盘 Union ID"))
        else:
            checks.append(readiness_check("dingtalk", "钉钉同步", "ok", "real 模式凭证已配置"))
    else:
        checks.append(readiness_check("dingtalk", "钉钉同步", "warning", "当前为 mock 模式，生产同步前需切换 real"))

    ready = all(check.status != "error" for check in checks)
    return SystemReadinessReport(environment=environment, ready=ready, checks=checks)


@router.get("/database-backup/status", response_model=ApiEnvelope[DatabaseBackupStatus])
def read_database_backup_status(
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("settings.manage")),
) -> ApiEnvelope[DatabaseBackupStatus]:
    return ApiEnvelope(data=build_database_backup_status(session))


@router.get("/readiness", response_model=ApiEnvelope[SystemReadinessReport])
def read_system_readiness(
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("settings.manage")),
) -> ApiEnvelope[SystemReadinessReport]:
    return ApiEnvelope(data=build_system_readiness_report(session))


@router.get("/database-backup/download")
def download_database_backup(
    session: Session = Depends(get_session),
    _: User = Depends(require_permission("settings.manage")),
) -> None:
    status = build_database_backup_status(session)
    raise HTTPException(status_code=409, detail=status.message)
