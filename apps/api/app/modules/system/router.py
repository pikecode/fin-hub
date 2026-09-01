import sqlite3
from datetime import UTC, datetime
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy.engine import URL
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
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor, require_permission
from app.modules.dingtalk.router import dingtalk_credentials, get_or_create_config
from app.schemas import (
    ApiEnvelope,
    DatabaseBackupStatus,
    SystemReadinessCheck,
    SystemReadinessReport,
)

router = APIRouter(prefix="/system", tags=["system"])


def resolve_sqlite_database_path(url: URL) -> Path | None:
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        return None
    path = Path(url.database)
    if not path.is_absolute():
        path = Path.cwd() / path
    return path.resolve()


def build_database_backup_status(session: Session) -> DatabaseBackupStatus:
    bind = session.get_bind()
    url = bind.url
    backend = url.get_backend_name()
    database_path = resolve_sqlite_database_path(url)
    if database_path is None:
        return DatabaseBackupStatus(
            supported=False,
            backend=backend,
            database_path=None,
            message="当前数据库不支持通过后台直接导出，请使用数据库原生备份工具",
        )
    if not database_path.exists():
        return DatabaseBackupStatus(
            supported=False,
            backend=backend,
            database_path=str(database_path),
            message="SQLite 数据库文件不存在",
        )
    return DatabaseBackupStatus(
        supported=True,
        backend=backend,
        database_path=str(database_path),
        message="支持后台导出 SQLite 备份",
    )


def readiness_check(key: str, name: str, status: str, detail: str) -> SystemReadinessCheck:
    return SystemReadinessCheck(key=key, name=name, status=status, detail=detail)


def build_system_readiness_report(session: Session) -> SystemReadinessReport:
    checks: list[SystemReadinessCheck] = []
    environment = settings.app_env
    is_production = is_production_environment(environment)
    database_backend = session.get_bind().url.get_backend_name()

    if is_production and database_backend == "sqlite":
        checks.append(readiness_check("database", "数据库", "error", "生产环境不应使用 SQLite"))
    else:
        checks.append(readiness_check("database", "数据库", "ok", f"当前数据库类型：{database_backend}"))

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
    current_user: User = Depends(require_permission("settings.manage")),
) -> FileResponse:
    status = build_database_backup_status(session)
    if not status.supported or not status.database_path:
        raise HTTPException(status_code=409, detail=status.message)

    source_path = Path(status.database_path)
    backup_root = Path(settings.file_storage_root) / "database-backups"
    backup_root.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(UTC).strftime("%Y%m%d%H%M%S")
    backup_path = backup_root / f"fin-hub-sqlite-{timestamp}.db"

    source_connection = sqlite3.connect(str(source_path))
    backup_connection = sqlite3.connect(str(backup_path))
    try:
        source_connection.backup(backup_connection)
    finally:
        backup_connection.close()
        source_connection.close()

    write_audit_log(
        session,
        actor=audit_actor(current_user),
        action="system.database_backup.download",
        resource_type="database_backup",
        resource_id=backup_path.name,
        summary="导出数据库备份",
        metadata={"backend": status.backend, "database_path": status.database_path},
    )
    session.commit()
    return FileResponse(
        backup_path,
        media_type="application/octet-stream",
        filename=backup_path.name,
    )
