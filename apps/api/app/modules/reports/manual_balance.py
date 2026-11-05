"""Report-only manual bank balance; no changes to bank transactions or profit."""

from decimal import Decimal

from fastapi import HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.models import FinancialReportMonthSetting, Ledger
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor
from app.modules.bank.unpaid import mutation_lock


class ManualBalanceUpdate(BaseModel):
    amount: Decimal | None = Field(max_digits=14, decimal_places=2)
    expected: Decimal | None = Field(max_digits=14, decimal_places=2)
    reason: str = Field(min_length=1, max_length=1000)


def save_manual_balance(session, user, store_id, period, payload):
    if user.role != "admin":
        raise HTTPException(403, "仅管理员可维护报表银行余额")
    if not payload.reason.strip():
        raise HTTPException(422, "请填写录入或修改原因")
    mutation_lock(session)
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period).with_for_update()
    )
    if ledger is None:
        raise HTTPException(409, "请先创建目标账期")
    if ledger.status != "open":
        raise HTTPException(409, "该账期已封账，不能修改报表银行余额")
    setting = session.scalar(
        select(FinancialReportMonthSetting)
        .where(
            FinancialReportMonthSetting.store_id == store_id,
            FinancialReportMonthSetting.period == period,
        )
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    old = setting.bank_balance_manual if setting else None
    if old != payload.expected:
        raise HTTPException(409, "报表余额已被修改，请刷新后重新录入")
    if setting is None:
        setting = FinancialReportMonthSetting(store_id=store_id, period=period)
        session.add(setting)
    setting.bank_balance_manual = payload.amount
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="report.bank_balance.update",
        resource_type="store",
        resource_id=store_id,
        summary=f"维护 {period} 报表展示银行余额",
        metadata={
            "period": period,
            "before": str(old) if old is not None else None,
            "after": str(payload.amount) if payload.amount is not None else None,
            "reason": payload.reason.strip(),
        },
    )
    session.commit()
