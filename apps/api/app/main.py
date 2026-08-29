from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.modules.audit.router import router as audit_router
from app.modules.attachments.router import router as attachments_router
from app.modules.auth.router import router as auth_router
from app.modules.bank.router import router as bank_router
from app.modules.categories.router import router as categories_router
from app.modules.dingtalk.router import router as dingtalk_router
from app.modules.expense.router import router as expense_router
from app.modules.health.router import router as health_router
from app.modules.ledgers.router import router as ledgers_router
from app.modules.matching.router import router as matching_router
from app.modules.reports.router import router as reports_router
from app.modules.revenue.router import channels_router as revenue_channels_router
from app.modules.revenue.router import router as revenue_router
from app.modules.shareholder_auth.router import router as shareholder_auth_router
from app.modules.stores.router import router as stores_router
from app.modules.suppliers.router import router as suppliers_router
from app.modules.system.router import router as system_router
from app.modules.users.router import router as users_router


def create_app() -> FastAPI:
    app = FastAPI(
        title="fin-hub API",
        version="0.1.0",
        openapi_url="/openapi.json",
    )
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
    app.include_router(stores_router, prefix="/api")
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
    return app


app = create_app()
