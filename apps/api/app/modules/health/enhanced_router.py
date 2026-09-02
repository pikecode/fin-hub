"""
增强的健康检查端点
提供详细的系统状态信息
"""
from datetime import datetime
from pathlib import Path

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.config import settings
from app.core.database import get_session

router = APIRouter(prefix="/health", tags=["health"])


def check_database(db: Session) -> dict:
    """检查数据库连接"""
    try:
        # 执行简单查询
        db.execute(text("SELECT 1"))

        # 获取连接池状态
        pool = db.get_bind().pool
        pool_size = pool.size()
        checked_out = pool.checked_out_connections()

        return {
            "status": "healthy",
            "pool_size": pool_size,
            "checked_out": checked_out,
            "available": pool_size - checked_out,
        }
    except Exception as e:
        return {
            "status": "unhealthy",
            "error": str(e),
        }


def check_redis() -> dict:
    """检查 Redis 连接"""
    try:
        import redis
        client = redis.from_url(settings.redis_url, decode_responses=True)
        client.ping()
        return {"status": "healthy"}
    except Exception as e:
        return {
            "status": "unhealthy",
            "error": str(e),
        }


def check_disk_space() -> dict:
    """检查磁盘空间"""
    try:
        import shutil

        # 检查文件存储目录
        storage_path = Path(settings.file_storage_root)
        if storage_path.exists():
            stat = shutil.disk_usage(storage_path)
            used_percent = (stat.used / stat.total) * 100

            status = "healthy"
            if used_percent > 90:
                status = "critical"
            elif used_percent > 80:
                status = "warning"

            return {
                "status": status,
                "total_gb": round(stat.total / (1024**3), 2),
                "used_gb": round(stat.used / (1024**3), 2),
                "free_gb": round(stat.free / (1024**3), 2),
                "used_percent": round(used_percent, 2),
            }
        else:
            return {
                "status": "warning",
                "message": "Storage path does not exist",
            }
    except Exception as e:
        return {
            "status": "unhealthy",
            "error": str(e),
        }


def check_migrations(db: Session) -> dict:
    """检查数据库迁移状态"""
    try:
        # 检查 alembic_version 表
        result = db.execute(text("SELECT version_num FROM alembic_version")).fetchone()
        if result:
            return {
                "status": "healthy",
                "current_version": result[0],
            }
        else:
            return {
                "status": "warning",
                "message": "No migration version found",
            }
    except Exception as e:
        return {
            "status": "unhealthy",
            "error": str(e),
        }


@router.get("")
async def basic_health():
    """
    基础健康检查

    快速检查，用于负载均衡器
    """
    return {
        "status": "ok",
        "timestamp": datetime.utcnow().isoformat(),
    }


@router.get("/detailed")
async def detailed_health(db: Session = Depends(get_session)):
    """
    详细健康检查

    检查所有依赖服务的状态
    """
    checks = {
        "database": check_database(db),
        "redis": check_redis(),
        "disk": check_disk_space(),
        "migrations": check_migrations(db),
    }

    # 判断总体状态
    statuses = [check["status"] for check in checks.values()]
    if any(s == "unhealthy" for s in statuses):
        overall_status = "unhealthy"
    elif any(s == "critical" for s in statuses):
        overall_status = "critical"
    elif any(s == "warning" for s in statuses):
        overall_status = "warning"
    else:
        overall_status = "healthy"

    return {
        "status": overall_status,
        "timestamp": datetime.utcnow().isoformat(),
        "environment": settings.app_env,
        "checks": checks,
    }


@router.get("/ready")
async def readiness_check(db: Session = Depends(get_session)):
    """
    就绪检查

    检查应用是否准备好接收流量
    """
    checks = {
        "database": check_database(db),
        "migrations": check_migrations(db),
    }

    # 任何关键服务不健康则未就绪
    ready = all(check["status"] == "healthy" for check in checks.values())

    if ready:
        return {
            "ready": True,
            "timestamp": datetime.utcnow().isoformat(),
        }
    else:
        return {
            "ready": False,
            "timestamp": datetime.utcnow().isoformat(),
            "checks": checks,
        }, 503
