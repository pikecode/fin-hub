"""
结构化日志配置
使用 structlog 提供 JSON 格式的结构化日志
"""
import logging
import sys
from typing import Any

import structlog
from structlog.types import EventDict

from app.core.config import settings


def add_app_context(logger: Any, method_name: str, event_dict: EventDict) -> EventDict:
    """添加应用上下文"""
    event_dict["app"] = "fin-hub-api"
    event_dict["environment"] = settings.app_env
    return event_dict


def censor_sensitive_data(logger: Any, method_name: str, event_dict: EventDict) -> EventDict:
    """
    脱敏敏感信息

    自动检测并脱敏常见的敏感字段
    """
    sensitive_keys = {
        "password", "secret", "token", "api_key",
        "authorization", "cookie", "session",
        "bank_account", "id_card", "phone"
    }

    def censor_dict(d: dict) -> dict:
        result = {}
        for key, value in d.items():
            key_lower = key.lower()
            if any(sensitive in key_lower for sensitive in sensitive_keys):
                result[key] = "***CENSORED***"
            elif isinstance(value, dict):
                result[key] = censor_dict(value)
            elif isinstance(value, list):
                result[key] = [censor_dict(item) if isinstance(item, dict) else item for item in value]
            else:
                result[key] = value
        return result

    return censor_dict(event_dict)


def init_logging() -> None:
    """
    初始化结构化日志

    配置：
    - JSON 格式输出（生产环境）
    - 控制台友好格式（开发环境）
    - 自动添加时间戳、日志级别
    - 敏感信息脱敏
    """
    # 根据环境选择输出格式
    is_production = settings.app_env in {"production", "prod"}

    # 共享处理器
    shared_processors = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.stdlib.PositionalArgumentsFormatter(),
        add_app_context,
        censor_sensitive_data,
        structlog.processors.TimeStamper(fmt="iso"),
        structlog.processors.StackInfoRenderer(),
    ]

    if is_production:
        # 生产环境：JSON 格式
        processors = shared_processors + [
            structlog.processors.format_exc_info,
            structlog.processors.JSONRenderer(),
        ]
    else:
        # 开发环境：彩色控制台
        processors = shared_processors + [
            structlog.processors.ExceptionRenderer(),
            structlog.dev.ConsoleRenderer(colors=True),
        ]

    # 配置 structlog
    structlog.configure(
        processors=processors,
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # 配置标准库 logging
    logging.basicConfig(
        format="%(message)s",
        stream=sys.stdout,
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
    )

    # 降低第三方库日志级别
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)


def get_logger(name: str | None = None) -> structlog.stdlib.BoundLogger:
    """
    获取日志记录器

    使用：
        logger = get_logger(__name__)
        logger.info("user_created", user_id=user.id, username=user.username)
    """
    return structlog.get_logger(name)
