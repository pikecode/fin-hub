from pathlib import Path

from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError

from app.core.config import settings

PRODUCTION_ENVS = {"prod", "production"}
WEAK_SECRET_VALUES = {"", "dev-secret", "change-me", "secret", "password"}


def is_production_environment(environment: str | None = None) -> bool:
    return (environment or settings.app_env).lower() in PRODUCTION_ENVS


def parse_cors_origins() -> list[str]:
    return [item.strip() for item in settings.cors_origin_csv.split(",") if item.strip()]


def is_weak_secret() -> bool:
    return settings.secret_key in WEAK_SECRET_VALUES or len(settings.secret_key) < 32


def is_localhost_origin(origin: str) -> bool:
    return "localhost" in origin or "127.0.0.1" in origin


def startup_errors() -> list[str]:
    errors: list[str] = []
    try:
        database_backend = make_url(settings.database_url).get_backend_name()
    except ArgumentError:
        errors.append("DATABASE_URL 格式无效")
        database_backend = ""
    if database_backend and database_backend != "postgresql":
        errors.append("系统仅支持 PostgreSQL 数据库")

    if not is_production_environment():
        return errors

    if is_weak_secret():
        errors.append("生产环境 SECRET_KEY 必须设置为至少 32 位强随机值")

    cors_origins = parse_cors_origins()
    if not cors_origins:
        errors.append("生产环境必须设置 CORS_ORIGINS")
    if any(is_localhost_origin(origin) for origin in cors_origins):
        errors.append("生产环境 CORS_ORIGINS 不能包含 localhost 或 127.0.0.1")

    storage_root = Path(settings.file_storage_root)
    storage_parent = storage_root if storage_root.exists() else storage_root.parent
    if not storage_parent.exists() or not storage_parent.is_dir():
        errors.append(f"文件存储父目录不存在：{storage_parent}")

    return errors


def production_startup_errors() -> list[str]:
    return startup_errors()


def validate_production_startup() -> None:
    errors = startup_errors()
    if errors:
        raise RuntimeError(f"启动配置检查失败：{'; '.join(errors)}")
