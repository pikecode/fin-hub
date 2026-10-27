"""Read-only monthly report supplements and complete business appendices."""

from datetime import date, datetime, time, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func, or_
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    ApprovalInstance,
    ApprovalAccountingAllocation,
    ApprovalAccountingPlan,
    BankBalanceCorrection,
    BankTransaction,
    DividendEntry,
    DividendMonth,
    DividendOpeningBalance,
    DividendFundingSetting,
    ExpenseBankMatch,
    ExpenseItem,
    FinancialReportMonthSetting,
    Ledger,
    PreopeningStore,
    RevenueBankMatch,
    Store,
    User,
)
from app.modules.auth.router import get_current_user, audit_actor
from app.modules.auth.permissions import ensure_permission, ensure_store_access
from app.modules.audit.service import write_audit_log
from app.modules.store_ledgers.router import (
    calculate_store_ledger_profits,
    confirmed_accounting_expense_rows,
    approval_expense_join_condition,
)
from app.modules.bank.unpaid import completed_payments, mutation_lock
from app.schemas import ApiEnvelope, BankTransactionRead, ExpenseItemRead

router = APIRouter(tags=["financial-report"])
PERIOD = r"^\d{4}-(0[1-9]|1[0-2])$"
MONEY = Decimal("0.01")


def period_date(period):
    try:
        value = date.fromisoformat(period + "-01")
        if not 1900 <= value.year <= 2199:
            raise ValueError("unsupported report year")
        return value
    except ValueError:
        raise HTTPException(422, "月份格式不正确")


def next_month(value):
    return date(value.year + (value.month == 12), value.month % 12 + 1, 1)


def authorize(session, user, store_id):
    ensure_permission(session, user, "reports.view")
    ensure_store_access(session, user, store_id)
    if session.get(Store, store_id) is None:
        raise HTTPException(404, "门店不存在")


def money(value):
    return str(Decimal(value or 0).quantize(MONEY))


def balance_at(session, store_id, cutoff, today=None):
    today = today or datetime.now(ZoneInfo("Asia/Shanghai")).date()
    if cutoff >= today:
        # Snapshot is the END of the 10th, unavailable until the day has finished.
        return {"date": cutoff.isoformat(), "status": "pending", "amount": None}
    correction = session.scalar(
        select(BankBalanceCorrection)
        .where(
            BankBalanceCorrection.store_id == store_id,
            BankBalanceCorrection.correction_date <= cutoff,
        )
        .order_by(
            BankBalanceCorrection.correction_date.desc(),
            BankBalanceCorrection.created_at.desc(),
            BankBalanceCorrection.id.desc(),
        )
        .limit(1)
    )
    if correction is None:
        return {"date": cutoff.isoformat(), "status": "missing_base", "amount": None}
    rows = session.execute(
        select(BankTransaction.direction, func.sum(BankTransaction.amount))
        .where(
            BankTransaction.store_id == store_id,
            BankTransaction.payment_status == "paid",
            BankTransaction.is_archived.is_(False),
            BankTransaction.occurred_at >= datetime.combine(correction.correction_date, time.min),
            BankTransaction.occurred_at < datetime.combine(cutoff + timedelta(days=1), time.min),
        )
        .group_by(BankTransaction.direction)
    ).all()
    delta = sum(
        (Decimal(amount) * (1 if direction == "income" else -1) for direction, amount in rows),
        Decimal(0),
    )
    return {
        "date": cutoff.isoformat(),
        "status": "ready",
        "amount": money(Decimal(correction.balance_amount) + delta),
    }


def dividend_totals(session, store_id, period):
    from app.modules.dividend.opening import configured_history

    configured = configured_history(session, store_id, period)
    if configured is not None:
        current = next(row for row in configured if row.period == period)
        return {
            "remaining_undistributed": money(current.remaining_undistributed)
            if current.remaining_undistributed is not None
            else None,
            "distribution_amount": money(current.distribution_amount)
            if not current.excluded_from_calculation
            else "0.00",
            "capital_amount": money(current.capital_amount)
            if not current.excluded_from_calculation
            else "0.00",
            "cumulative_capital": money(current.cumulative_capital),
            "cumulative_distribution": money(current.historical_distribution),
        }
    months = {
        m.period: m
        for m in session.scalars(
            select(DividendMonth).where(
                DividendMonth.store_id == store_id, DividendMonth.period <= period
            )
        )
    }
    sums = {
        (p, kind): Decimal(amount)
        for p, kind, amount in session.execute(
            select(DividendMonth.period, DividendEntry.entry_type, func.sum(DividendEntry.amount))
            .join(DividendEntry, DividendEntry.month_id == DividendMonth.id)
            .where(DividendMonth.store_id == store_id, DividendMonth.period <= period)
            .group_by(DividendMonth.period, DividendEntry.entry_type)
        )
    }
    current = months.get(period)
    remaining = current.manual_remaining_undistributed if current else None
    if period > "2026-10":
        anchor = months.get("2026-10")
        remaining = anchor.manual_remaining_undistributed if anchor else None
        if remaining is not None:
            periods = []
            cursor = date(2026, 11, 1)
            while cursor.strftime("%Y-%m") <= period:
                periods.append(cursor.strftime("%Y-%m"))
                cursor = next_month(cursor)
            profits = calculate_store_ledger_profits(session, store_id, periods)
            remaining = (
                Decimal(remaining)
                + sum(profits.values(), Decimal(0))
                - sum(
                    (
                        amount
                        for (p, kind), amount in sums.items()
                        if p > "2026-10" and kind == "distribution"
                    ),
                    Decimal(0),
                )
            )
    return {
        "remaining_undistributed": money(remaining) if remaining is not None else None,
        "distribution_amount": money(sums.get((period, "distribution"))),
        "capital_amount": money(sums.get((period, "capital"))),
        "cumulative_capital": money(
            sum((amount for (_, kind), amount in sums.items() if kind == "capital"), Decimal(0))
        ),
        "cumulative_distribution": money(
            sum(
                (amount for (_, kind), amount in sums.items() if kind == "distribution"), Decimal(0)
            )
        ),
    }


def funding_read(session, store_id):
    setting = session.get(DividendFundingSetting, store_id)
    approval_ids = (
        select(ExpenseItem.approval_instance_id)
        .join(ExpenseBankMatch, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
        .where(
            ExpenseItem.store_id == store_id,
            ExpenseBankMatch.expense_scope == "preopening",
            ExpenseBankMatch.status == "confirmed",
        )
    )
    from app.modules.approvals.status import canonical_expense_items

    items = list(
        session.scalars(
            select(ExpenseItem).where(
                ExpenseItem.store_id == store_id,
                ExpenseItem.expense_scope == "preopening",
                ExpenseItem.approval_instance_id.in_(approval_ids),
            )
        )
    )
    grouped = {}
    for item in items:
        grouped.setdefault(item.approval_instance_id, []).append(item)
    total = sum(
        (
            Decimal(item.amount)
            for group in grouped.values()
            for item in canonical_expense_items(group)
        ),
        Decimal(0),
    )
    override = setting.preopening_expense_override if setting else None
    return {
        "preopening_investment": money(setting.preopening_investment if setting else 0),
        "preopening_expense_override": money(override) if override is not None else None,
        "preopening_expense_amount": money(override if override is not None else total),
        "preopening_expense_source": "manual" if override is not None else "report",
    }


class TargetUpdate(BaseModel):
    revenue_target: Decimal | None = Field(default=None, ge=0, max_digits=14, decimal_places=2)


class FundingUpdate(BaseModel):
    preopening_investment: Decimal = Field(ge=0, max_digits=14, decimal_places=2)
    preopening_expense_override: Decimal | None = Field(
        default=None, ge=0, max_digits=14, decimal_places=2
    )


@router.get("/reports/financial-supplement")
def supplement(
    store_id: str,
    period: str = Query(pattern=PERIOD),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    authorize(session, user, store_id)
    first = period_date(period)
    setting = session.scalar(
        select(FinancialReportMonthSetting).where(
            FinancialReportMonthSetting.store_id == store_id,
            FinancialReportMonthSetting.period == period,
        )
    )
    totals = dividend_totals(session, store_id, period)
    opening = session.get(DividendOpeningBalance, store_id)
    funding = funding_read(session, store_id)
    return ApiEnvelope(
        data={
            "store_id": store_id,
            "period": period,
            "dividend_start_period": opening.start_period if opening else None,
            "dividend_excluded": bool(opening and period < opening.start_period),
            "revenue_target": money(setting.revenue_target)
            if setting and setting.revenue_target is not None
            else None,
            "bank_balance": balance_at(session, store_id, next_month(first).replace(day=10)),
            **totals,
            **funding,
            "total_capital": money(
                Decimal(totals["cumulative_capital"]) + Decimal(funding["preopening_investment"])
            ),
        }
    )


@router.patch("/reports/financial-target")
def update_target(
    payload: TargetUpdate,
    store_id: str,
    period: str = Query(pattern=PERIOD),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    authorize(session, user, store_id)
    period_date(period)
    if user.role != "admin":
        raise HTTPException(403, "仅管理员可设置业绩目标")
    mutation_lock(session)
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period).with_for_update()
    )
    if ledger and ledger.status == "closed":
        raise HTTPException(409, "该账期已封账，不能修改业绩目标")
    setting = session.scalar(
        select(FinancialReportMonthSetting).where(
            FinancialReportMonthSetting.store_id == store_id,
            FinancialReportMonthSetting.period == period,
        )
    )
    if setting is None:
        setting = FinancialReportMonthSetting(store_id=store_id, period=period)
        session.add(setting)
    old = setting.revenue_target
    setting.revenue_target = payload.revenue_target
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="report.target.update",
        resource_type="store",
        resource_id=store_id,
        summary=f"更新 {period} 业绩目标",
        metadata={
            "period": period,
            "before": str(old) if old is not None else None,
            "after": str(payload.revenue_target) if payload.revenue_target is not None else None,
        },
    )
    session.commit()
    return supplement(store_id, period, session, user)


@router.get("/dividends/stores/{store_id}/funding-settings")
def get_funding(
    store_id: str, session: Session = Depends(get_session), user: User = Depends(get_current_user)
):
    ensure_permission(session, user, "stores.view")
    ensure_store_access(session, user, store_id)
    if session.get(Store, store_id) is None:
        raise HTTPException(404, "门店不存在")
    return ApiEnvelope(data=funding_read(session, store_id))


@router.patch("/dividends/stores/{store_id}/funding-settings")
def update_funding(
    store_id: str,
    payload: FundingUpdate,
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    get_funding(store_id, session, user)
    if user.role != "admin":
        raise HTTPException(403, "仅管理员可维护筹建资金资料")
    from app.modules.dividend.opening import lock_store as lock_dividend_store

    lock_dividend_store(session, store_id)
    if session.get(DividendOpeningBalance, store_id, populate_existing=True):
        raise HTTPException(409, "该门店已配置期初数据，请通过录入历史数据入口维护筹建资料")
    mutation_lock(session)
    state = session.scalar(
        select(PreopeningStore).where(PreopeningStore.store_id == store_id).with_for_update()
    )
    if state and state.status == "closed":
        raise HTTPException(409, "筹建报表已封账，不能更改筹建资金资料")
    setting = session.get(DividendFundingSetting, store_id)
    before = funding_read(session, store_id)
    if setting is None:
        setting = DividendFundingSetting(store_id=store_id)
        session.add(setting)
    setting.preopening_investment = payload.preopening_investment
    setting.preopening_expense_override = payload.preopening_expense_override
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="dividend.funding.update",
        resource_type="store",
        resource_id=store_id,
        summary="更新筹建资金资料（影响历史报表展示）",
        metadata={"before": before, "after": payload.model_dump(mode="json")},
    )
    session.commit()
    return get_funding(store_id, session, user)


@router.get("/reports/financial-appendix")
def appendix(
    store_id: str,
    period: str = Query(pattern=PERIOD),
    session: Session = Depends(get_session),
    user: User = Depends(get_current_user),
):
    authorize(session, user, store_id)
    start = period_date(period)
    end = next_month(start)
    expense_matches = list(
        session.execute(
            select(ExpenseBankMatch, ExpenseItem, ApprovalInstance)
            .join(ExpenseItem, ExpenseItem.id == ExpenseBankMatch.expense_item_id)
            .outerjoin(ApprovalInstance, approval_expense_join_condition())
            .where(
                ExpenseItem.store_id == store_id,
                ExpenseBankMatch.expense_scope == "operating",
                ExpenseItem.expense_scope == "operating",
                ExpenseBankMatch.status == "confirmed",
                or_(
                    (
                        func.coalesce(ExpenseBankMatch.accounting_period, ExpenseItem.ledger_period)
                        == period
                    )
                    & ~ApprovalInstance.id.in_(select(ApprovalAccountingPlan.approval_id)),
                    ApprovalInstance.id.in_(
                        select(ApprovalAccountingAllocation.approval_id).where(
                            ApprovalAccountingAllocation.period == period
                        )
                    ),
                    ApprovalInstance.id.is_(None)
                    & (
                        func.coalesce(ExpenseBankMatch.accounting_period, ExpenseItem.ledger_period)
                        == period
                    ),
                ),
            )
        )
    )
    income_matches = list(
        session.scalars(
            select(RevenueBankMatch)
            .join(BankTransaction, BankTransaction.id == RevenueBankMatch.bank_transaction_id)
            .where(
                BankTransaction.store_id == store_id,
                RevenueBankMatch.status == "confirmed",
                func.coalesce(RevenueBankMatch.accounting_period, BankTransaction.ledger_period)
                == period,
            )
        )
    )

    approval_ids = {approval.id for _, _, approval in expense_matches if approval is not None}
    expense_details = {}
    for expense, approval_id in session.execute(
        select(ExpenseItem, ApprovalInstance.id)
        .join(ApprovalInstance, approval_expense_join_condition())
        .where(
            ApprovalInstance.id.in_(approval_ids),
            ExpenseItem.store_id == store_id,
            ExpenseItem.expense_scope == "operating",
        )
    ):
        expense_details.setdefault(approval_id, []).append(expense)
    from app.modules.approvals.status import canonical_expense_items

    source_ids = {match.bank_transaction_id for match, _, _ in expense_matches}
    replacements = completed_payments(session, source_ids)
    ids = source_ids | {match.bank_transaction_id for match in income_matches}
    ids.update(bank.id for banks in replacements.values() for bank in banks)
    banks = list(
        session.scalars(
            select(BankTransaction)
            .where(
                BankTransaction.store_id == store_id,
                BankTransaction.is_archived.is_(False),
                or_(
                    BankTransaction.id.in_(ids),
                    (BankTransaction.occurred_at >= datetime.combine(start, time.min))
                    & (BankTransaction.occurred_at < datetime.combine(end, time.min))
                    & (
                        BankTransaction.special_type.is_not(None)
                        | BankTransaction.direct_posting_type.is_not(None)
                    ),
                ),
            )
            .order_by(BankTransaction.occurred_at, BankTransaction.created_at, BankTransaction.id)
        )
    )
    rows = {
        bank.id: {
            "transaction": BankTransactionRead.model_validate(bank).model_dump(mode="json"),
            "business": [],
        }
        for bank in banks
    }
    month_accounted_amounts = {
        row[0]: row[3] for row in confirmed_accounting_expense_rows(session, store_id, period)
    }
    month_allocations = dict(
        session.execute(
            select(
                ApprovalAccountingAllocation.approval_id, ApprovalAccountingAllocation.amount
            ).where(ApprovalAccountingAllocation.period == period)
        ).all()
    )
    for match, item, approval in expense_matches:
        for bank_id in [b.id for b in replacements.get(match.bank_transaction_id, [])] or [
            match.bank_transaction_id
        ]:
            if bank_id in rows:
                rows[bank_id]["business"].append(
                    {
                        "kind": "expense",
                        "expense_details": [
                            {
                                "description": detail.description,
                                "amount": money(
                                    month_accounted_amounts.get(detail.id, detail.amount)
                                ),
                                "category_l1": detail.category_l1,
                                "category_l2": detail.category_l2,
                            }
                            for detail in canonical_expense_items(
                                expense_details.get(approval.id if approval else None, [item])
                            )
                        ],
                        "description": item.description,
                        "category_l1": item.category_l1,
                        "category_l2": item.category_l2,
                        "application_date": (approval.submit_at or item.expense_date).isoformat()
                        if approval
                        else item.expense_date.isoformat(),
                        "approval_no": approval.approval_no if approval else None,
                        "accounting_amount": money(
                            month_allocations.get(approval.id if approval else None, match.amount)
                        ),
                        "shared_accounting_amount": bool(
                            approval and approval.id in month_allocations
                        ),
                        "settlement_group": match.bank_transaction_id
                        if match.bank_transaction_id in replacements
                        else None,
                    }
                )
    for match in income_matches:
        if match.bank_transaction_id in rows:
            rows[match.bank_transaction_id]["business"].append(
                {
                    "kind": "income",
                    "description": match.channel,
                    "revenue_start": match.revenue_start_date.isoformat(),
                    "revenue_end": match.revenue_end_date.isoformat(),
                    "accounting_amount": money(match.amount),
                }
            )
    direct_expenses = {
        item.source_document_id: item
        for item in session.scalars(
            select(ExpenseItem).where(
                ExpenseItem.store_id == store_id,
                ExpenseItem.source == "bank_direct",
                ExpenseItem.source_document_id.in_(list(rows)),
            )
        )
    }
    for bank in banks:
        if bank.direct_posting_type == "bank_interest":
            rows[bank.id]["business"].append(
                {
                    "kind": "income",
                    "description": "银行结息",
                    "revenue_start": bank.occurred_at.date().isoformat(),
                    "revenue_end": bank.occurred_at.date().isoformat(),
                    "accounting_amount": money(bank.amount),
                }
            )
        elif bank.id in direct_expenses:
            item = direct_expenses[bank.id]
            rows[bank.id]["business"].append(
                {
                    "kind": "expense",
                    "description": item.description,
                    "category_l1": item.category_l1,
                    "category_l2": item.category_l2,
                    "application_date": bank.occurred_at.date().isoformat(),
                    "accounting_amount": money(item.amount),
                    "expense_details": [
                        {
                            "description": item.description,
                            "amount": money(item.amount),
                            "category_l1": item.category_l1,
                            "category_l2": item.category_l2,
                        }
                    ],
                }
            )
    # Full canonical report expenses, not capped by analytics' list page size.
    accounted_rows = confirmed_accounting_expense_rows(session, store_id, period)
    accounted_amounts = {row[0]: row[3] for row in accounted_rows}
    expense_ids = set(accounted_amounts)
    expense_ids.update(
        session.scalars(
            select(ExpenseItem.id).where(
                ExpenseItem.store_id == store_id,
                ExpenseItem.ledger_period == period,
                ExpenseItem.expense_scope == "operating",
                ExpenseItem.source.in_(["revenue_fee", "kuailv_purchase", "bank_direct"]),
            )
        )
    )
    from app.modules.reports.router import export_expense_rows

    expenses = export_expense_rows(
        list(
            session.scalars(
                select(ExpenseItem)
                .where(ExpenseItem.id.in_(expense_ids))
                .order_by(ExpenseItem.expense_date, ExpenseItem.id)
            )
        )
    )
    approval_dates = dict(
        session.execute(
            select(ApprovalInstance.id, ApprovalInstance.submit_at).where(
                ApprovalInstance.id.in_(
                    [item.approval_instance_id for item in expenses if item.approval_instance_id]
                )
            )
        ).all()
    )
    export_items = []
    for item in expenses:
        serialized = ExpenseItemRead.model_validate(item).model_dump(mode="json")
        serialized["amount"] = money(accounted_amounts.get(item.id, item.amount))
        application_date = approval_dates.get(item.approval_instance_id) or item.expense_date
        serialized["application_date"] = application_date.isoformat() if application_date else None
        export_items.append(serialized)
    return ApiEnvelope(
        data={
            "rows": list(rows.values()),
            "expense_items": export_items,
        }
    )
