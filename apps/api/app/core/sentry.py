"""
Sentry 集成配置
提供错误追踪和性能监控
"""
import sentry_sdk
from sentry_sdk.integrations.fastapi import FastApiIntegration
from sentry_sdk.integrations.sqlalchemy import SqlalchemyIntegration

from app.core.config import settings


def init_sentry() -> None:
    """
    初始化 Sentry SDK

    功能：
    - 错误自动捕获和上报
    - 性能追踪（10% 采样）
    - FastAPI 和 SQLAlchemy 集成
    - 用户上下文追踪
    """
    if not settings.sentry_dsn:
        return

    sentry_sdk.init(
        dsn=settings.sentry_dsn,
        environment=settings.app_env,
        # 性能追踪采样率（10%）
        traces_sample_rate=0.1,
        # 性能分析采样率（10%）
        profiles_sample_rate=0.1,
        # 集成
        integrations=[
            FastApiIntegration(
                transaction_style="endpoint",  # 按端点分组
                failed_request_status_codes=[500, 599],  # 500+ 视为失败
            ),
            SqlalchemyIntegration(),
        ],
        # 发布版本（用于追踪部署）
        release=f"fin-hub-api@{settings.app_env}",
        # 忽略的错误
        ignore_errors=[
            KeyboardInterrupt,
            "asyncio.CancelledError",
        ],
        # 请求数据采集
        send_default_pii=False,  # 不发送 PII（个人身份信息）
        max_breadcrumbs=50,  # 面包屑最大数量
        # 采样决策
        traces_sampler=traces_sampler,
    )


def traces_sampler(sampling_context: dict) -> float:
    """
    智能采样决策

    - 健康检查：不采样（0%）
    - 静态资源：不采样（0%）
    - 错误请求：全采样（100%）
    - 正常请求：10% 采样
    """
    # 获取路径
    asgi_scope = sampling_context.get("asgi_scope", {})
    path = asgi_scope.get("path", "")

    # 健康检查不采样
    if path.startswith("/api/health"):
        return 0.0

    # 静态资源不采样
    if path.startswith(("/static/", "/favicon.ico", "/robots.txt")):
        return 0.0

    # OpenAPI 文档低采样
    if path.startswith(("/docs", "/redoc", "/openapi.json")):
        return 0.01

    # 父 span 存在错误，全采样
    parent_sampled = sampling_context.get("parent_sampled")
    if parent_sampled is False:
        return 0.0

    # 检查是否有错误标记
    if sampling_context.get("transaction_context", {}).get("op") == "http.server.error":
        return 1.0

    # 默认 10% 采样
    return 0.1


def set_user_context(user_id: str, username: str | None = None, email: str | None = None) -> None:
    """
    设置用户上下文

    在 Sentry 中追踪用户信息，便于问题定位
    """
    sentry_sdk.set_user({
        "id": user_id,
        "username": username,
        "email": email,
    })


def capture_exception(error: Exception, **extra_context) -> None:
    """
    手动捕获异常

    用于捕获已处理的异常，但仍需要追踪
    """
    with sentry_sdk.push_scope() as scope:
        for key, value in extra_context.items():
            scope.set_context(key, value)
        sentry_sdk.capture_exception(error)


def capture_message(message: str, level: str = "info", **extra_context) -> None:
    """
    手动记录消息

    用于记录重要事件或异常情况
    """
    with sentry_sdk.push_scope() as scope:
        for key, value in extra_context.items():
            scope.set_context(key, value)
        sentry_sdk.capture_message(message, level=level)
