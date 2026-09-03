import asyncio
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.database import SessionLocal
from app.core.runtime_checks import validate_production_startup
from app.core.sentry import init_sentry
from app.core.logging import init_logging
from app.middleware.rate_limit import create_rate_limit_middleware
from app.middleware.security_headers import create_security_headers_middleware
from app.modules.attachments.router import router as attachments_router
from app.modules.audit.router import router as audit_router
from app.modules.auth.router import router as auth_router
from app.modules.bank.router import router as bank_router
from app.modules.categories.router import router as categories_router
from app.modules.dingtalk.router import router as dingtalk_router
from app.modules.dingtalk.router import run_due_auto_sync_jobs
from app.modules.expense.router import router as expense_router
from app.modules.health.router import router as health_router
from app.modules.ledgers.router import router as ledgers_router
from app.modules.matching.router import router as matching_router
from app.modules.metrics.router import router as metrics_router
from app.modules.reports.router import router as reports_router
from app.modules.revenue.router import channels_router as revenue_channels_router
from app.modules.revenue.router import router as revenue_router
from app.modules.roles.router import router as roles_router
from app.modules.shareholder_auth.router import router as shareholder_auth_router
from app.modules.store_ledgers.router import router as store_ledgers_router
from app.modules.stores.router import router as stores_router
from app.modules.suppliers.router import router as suppliers_router
from app.modules.system.router import router as system_router
from app.modules.users.router import router as users_router


async def dingtalk_auto_sync_loop() -> None:
    while True:
        await asyncio.sleep(60)
        with SessionLocal() as session:
            run_due_auto_sync_jobs(session)


def should_start_background_jobs() -> bool:
    if "PYTEST_CURRENT_TEST" in os.environ:
        return False
    return settings.app_env in {"local", "production"}


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    task: asyncio.Task[None] | None = None
    if should_start_background_jobs():
        task = asyncio.create_task(dingtalk_auto_sync_loop())
        app.state.dingtalk_auto_sync_task = task
    try:
        yield
    finally:
        if task is not None:
            task.cancel()
            with suppress(asyncio.CancelledError):
                await task


def create_app() -> FastAPI:
    # 初始化可观测性组件
    init_logging()
    init_sentry()

    validate_production_startup()
    app = FastAPI(
        title="fin-hub API",
        version="0.1.0",
        openapi_url="/openapi.json",
        lifespan=lifespan,
    )

    # 安全响应头
    enable_hsts = settings.app_env in {"production", "prod"}
    app.add_middleware(create_security_headers_middleware(enable_hsts=enable_hsts))

    # 限流中间件（敏感路径更严格）
    app.add_middleware(create_rate_limit_middleware(requests_per_minute=120))

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(health_router, prefix="/api")
    app.include_router(auth_router, prefix="/api")
    app.include_router(audit_router, prefix="/api")
    app.include_router(attachments_router, prefix="/api")
    app.include_router(users_router, prefix="/api")
    app.include_router(shareholder_auth_router, prefix="/api")
    app.include_router(system_router, prefix="/api")
    app.include_router(roles_router, prefix="/api")
    app.include_router(stores_router, prefix="/api")
    app.include_router(store_ledgers_router, prefix="/api")
    app.include_router(ledgers_router, prefix="/api")
    app.include_router(categories_router, prefix="/api")
    app.include_router(suppliers_router, prefix="/api")
    app.include_router(expense_router, prefix="/api")
    app.include_router(revenue_channels_router, prefix="/api")
    app.include_router(revenue_router, prefix="/api")
    app.include_router(bank_router, prefix="/api")
    app.include_router(matching_router, prefix="/api")
    app.include_router(dingtalk_router, prefix="/api")
    app.include_router(reports_router, prefix="/api")
    app.include_router(metrics_router, prefix="/api")
    return app


app = create_app()
