"""Actual profit allocations to construction overruns, independent of dividends."""

from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import func, select

from app.models import DividendMonth, DividendOpeningBalance


def construction_metrics(funding, covered):
    covered = Decimal(covered)
    balance = Decimal(funding["preopening_investment"]) - Decimal(
        funding["preopening_expense_amount"]
    )
    missing = funding["preopening_expense_source"] == "missing"
    return {
        "preopening_balance": None if missing else f"{balance:.2f}",
        "preopening_profit_covered": f"{covered:.2f}",
        "preopening_uncovered": None if missing else f"{max(-balance - covered, Decimal(0)):.2f}",
    }


def validate_allocations(session, store_id, *, check_profit=True):
    from app.modules.dividend.opening import configured_history
    from app.modules.reports.financial import funding_read

    opening = session.get(DividendOpeningBalance, store_id)
    if opening is None:
        return
    funding = funding_read(session, store_id)
    limit = max(
        Decimal(funding["preopening_expense_amount"]) - Decimal(funding["preopening_investment"]),
        Decimal(0),
    )
    end = session.scalar(
        select(func.max(DividendMonth.period)).where(DividendMonth.store_id == store_id)
    )
    rows = configured_history(
        session, store_id, max(end or opening.start_period, opening.start_period)
    )
    for row in rows:
        if row.excluded_from_calculation:
            continue
        if row.cumulative_preopening_coverage > limit:
            raise HTTPException(
                422, "累计补充金额不能超过筹建超支；请先确认筹建支出和历史已补充金额"
            )
        if row.preopening_coverage_amount > 0 and funding["preopening_expense_source"] == "missing":
            raise HTTPException(422, "筹建报表未封账，请先录入筹建费用总支出")
        # Preserve historical loss months; reject only months with actual allocations.
        if (
            check_profit
            and row.distribution_amount + row.preopening_coverage_amount > 0
            and row.remaining_undistributed < 0
        ):
            raise HTTPException(422, f"{row.period} 分配金额超过可分配利润")
