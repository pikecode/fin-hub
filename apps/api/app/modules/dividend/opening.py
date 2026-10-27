"""One authoritative opening-balance calculation for dividends and financial reports."""

from datetime import date
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select, text

from app.models import DividendOpeningBalance, DividendMonth, DividendEntry, Ledger, RevenueRecord
from app.modules.store_ledgers.router import calculate_store_ledger_profits
from app.schemas import DividendMonthRead, DividendEntryRead, DividendOpeningRead

MONEY = Decimal("0.01")


def valid_period(period):
    try:
        value = date.fromisoformat(period + "-01")
        if not 1900 <= value.year <= 2199:
            raise ValueError()
        return value
    except ValueError:
        raise HTTPException(422, "请选择有效的年月份")


def lock_store(session, store_id):
    if session.get_bind().dialect.name == "postgresql":
        session.execute(
            text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
            {"key": "dividend-opening:" + store_id},
        )


def opening_read(session, store_id):
    from app.modules.reports.financial import funding_read

    opening = session.get(DividendOpeningBalance, store_id)
    fields = (
        {
            field: getattr(opening, field)
            for field in [
                "start_period",
                "opening_remaining",
                "historical_profit",
                "historical_distribution",
                "operating_capital",
                "version",
                "reason",
                "updated_by",
                "updated_at",
            ]
        }
        if opening
        else {}
    )
    return DividendOpeningRead(
        configured=opening is not None, **fields, **funding_read(session, store_id)
    )


def ensure_month_mutable(session, store_id, period):
    valid_period(period)
    lock_store(session, store_id)
    opening = session.get(DividendOpeningBalance, store_id, populate_existing=True)
    if opening and period < opening.start_period:
        raise HTTPException(
            409, f"该月份早于数据隔离月份 {opening.start_period}，仅可查看，不参与计算"
        )
    return opening


def configured_history(session, store_id, selected_period):
    """No inserted months, no ledger writes, no fixed transition date."""
    selected = valid_period(selected_period)
    opening = session.get(DividendOpeningBalance, store_id)
    if opening is None:
        return None
    months = {
        month.period: month
        for month in session.scalars(
            select(DividendMonth).where(
                DividendMonth.store_id == store_id, DividendMonth.period <= selected_period
            )
        )
    }
    periods = set(
        session.scalars(
            select(Ledger.period).where(
                Ledger.store_id == store_id, Ledger.period <= selected_period
            )
        )
    )
    periods.update(months)
    periods.update(
        session.scalars(
            select(RevenueRecord.ledger_period).where(
                RevenueRecord.store_id == store_id, RevenueRecord.ledger_period <= selected_period
            )
        )
    )
    cursor = valid_period(opening.start_period)
    while cursor <= selected:
        periods.add(cursor.strftime("%Y-%m"))
        cursor = date(cursor.year + (cursor.month == 12), cursor.month % 12 + 1, 1)
    periods.add(selected_period)
    ordered = sorted(periods)
    profits = calculate_store_ledger_profits(session, store_id, ordered)
    entries_by_period = {}
    for entry, period in session.execute(
        select(DividendEntry, DividendMonth.period)
        .join(DividendMonth, DividendMonth.id == DividendEntry.month_id)
        .where(DividendMonth.store_id == store_id, DividendMonth.period <= selected_period)
        .order_by(DividendEntry.created_at, DividendEntry.id)
    ):
        entries_by_period.setdefault(period, []).append(entry)
    total_profit = Decimal(opening.historical_profit)
    total_distribution = Decimal(opening.historical_distribution)
    total_capital = Decimal(opening.operating_capital)
    remaining = Decimal(opening.opening_remaining)
    rows = []
    for period in ordered:
        month = months.get(period)
        entries = entries_by_period.get(period, [])
        distribution = sum(
            (Decimal(entry.amount) for entry in entries if entry.entry_type == "distribution"),
            Decimal(0),
        )
        capital = sum(
            (Decimal(entry.amount) for entry in entries if entry.entry_type == "capital"),
            Decimal(0),
        )
        excluded = period < opening.start_period
        profit = Decimal(profits.get(period, 0))
        if excluded and month and month.manual_net_profit is not None:
            profit = Decimal(month.manual_net_profit)
        available = None
        if not excluded:
            available = remaining + profit
            remaining = available - distribution
            total_profit += profit
            total_distribution += distribution
            total_capital += capital
        reference = Decimal(month.reference_ratio) if month else Decimal(60)
        rows.append(
            DividendMonthRead(
                id=month.id if month else f"virtual:{store_id}:{period}",
                store_id=store_id,
                period=period,
                net_profit=profit.quantize(MONEY),
                available_profit=available.quantize(MONEY) if available is not None else None,
                excluded_from_calculation=excluded,
                manual_net_profit=month.manual_net_profit if month else None,
                manual_remaining_undistributed=month.manual_remaining_undistributed
                if month
                else None,
                profit_source="manual"
                if excluded and month and month.manual_net_profit is not None
                else "report",
                distribution_amount=distribution.quantize(MONEY),
                capital_amount=capital.quantize(MONEY),
                historical_profit=total_profit.quantize(MONEY) if not excluded else Decimal("0.00"),
                historical_distribution=total_distribution.quantize(MONEY)
                if not excluded
                else Decimal("0.00"),
                cumulative_capital=total_capital.quantize(MONEY)
                if not excluded
                else Decimal("0.00"),
                remaining_undistributed=remaining.quantize(MONEY) if not excluded else None,
                reference_ratio=reference,
                suggested_distribution=(max(Decimal(0), profit) * reference / 100).quantize(MONEY)
                if not excluded
                else Decimal("0.00"),
                no_distribution=month.no_distribution if month else False,
                no_capital=month.no_capital if month else False,
                locked=month.locked if month else False,
                entries=[DividendEntryRead.model_validate(entry) for entry in entries],
            )
        )
    return rows
