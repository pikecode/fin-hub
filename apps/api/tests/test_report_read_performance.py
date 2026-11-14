from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import event, select, update
from test_partial_approvals import match_bank, salary_fixture

from app.models import (
    ApprovalAccountingAllocation,
    ApprovalAccountingPlan,
    DividendOpeningBalance,
    ExpenseItem,
    Ledger,
    User,
)
from app.modules.matching.accounting import planned_rows_for_periods
from app.modules.miniapp.router import report
from app.modules.report_reads import read_cache, report_read_scope
from app.modules.store_ledgers.router import confirmed_accounting_expense_rows


def measure(session, function):
    queries = []
    engine = session.get_bind()

    def count(*args):
        queries.append(1)

    event.listen(engine, "before_cursor_execute", count)
    try:
        return function(), len(queries)
    finally:
        event.remove(engine, "before_cursor_execute", count)


@pytest.mark.parametrize("mode", ["legacy", "paid", "allocated"])
def test_all_period_plan_reuse_keeps_cent_exact_results(client, session, mode):
    store, approval, items, banks = salary_fixture(client, session, lines=True)
    match_bank(client, items[0], banks[0])
    if mode == "paid":
        assert (
            client.put(
                f"/api/matches/reconciliation/approvals/{approval.id}/paid-accounting",
                json={"enabled": True},
            ).status_code
            == 200
        )
    elif mode == "allocated":
        session.add(ApprovalAccountingPlan(approval_id=approval.id, updated_by="test"))
        session.flush()
        session.add_all(
            [
                ApprovalAccountingAllocation(approval_id=approval.id, period=p, amount=a)
                for p, a in [("2026-09", "12345.67"), ("2026-10", "45654.33"), ("2026-11", "2000")]
            ]
        )
        session.commit()
    periods = ["2026-08", "2026-09", "2026-10", "2026-11"]
    baseline = {period: planned_rows_for_periods(session, store, [period]) for period in periods}
    with report_read_scope(session):
        actual = {
            period: planned_rows_for_periods(session, store, [period])
            for period in reversed(periods)
        }
        assert actual == baseline
        owned, rows = planned_rows_for_periods(session, store, periods)
        owned.clear()
        rows[periods[0]].append(("fake", None, None, Decimal(1)))
        again = planned_rows_for_periods(session, store, [periods[0]])
        assert again == baseline[periods[0]]
    assert read_cache(session) is None


def test_report_reduces_queries_without_changing_any_financial_fields(client, session):
    store, _, items, banks = salary_fixture(client, session, lines=True)
    match_bank(client, items[0], banks[0])
    session.add(
        DividendOpeningBalance(
            store_id=store,
            start_period="2026-06",
            opening_remaining=1000,
            historical_profit=0,
            historical_distribution=0,
            operating_capital=0,
            reason="test",
            updated_by="test",
        )
    )
    for month in ["2026-06", "2026-07", "2026-08"]:
        session.add(Ledger(store_id=store, period=month))
        session.add(
            ExpenseItem(
                store_id=store,
                ledger_period=month,
                source="bank_direct",
                description="测试支出",
                amount=10,
                expense_date=date.fromisoformat(month + "-01"),
            )
        )
    session.commit()
    admin = session.scalar(select(User).where(User.role == "admin"))

    def load():
        data = report(store, "2026-10", session, admin).model_dump(mode="json")["data"]
        data.pop("retrieved_at")
        return data

    with report_read_scope(session, enabled=False):
        baseline, before = measure(session, load)
    optimized, after = measure(session, load)
    assert optimized == baseline
    assert after < before * 0.8, (before, after)
    assert read_cache(session) is None


def test_read_scope_invalidates_after_write_and_never_survives_scope(client, session):
    store, _, items, banks = salary_fixture(client, session, lines=True)
    match_bank(client, items[0], banks[0])

    def amount():
        return sum(
            (r[3] for r in confirmed_accounting_expense_rows(session, store, "2026-09")), Decimal(0)
        )

    with report_read_scope(session):
        assert amount() == 60000
        _, count = measure(session, amount)
        assert count == 0
        items[0].amount = Decimal(21000)
        assert amount() == 61000
        session.flush()
        assert amount() == 61000
        session.execute(
            update(ExpenseItem).where(ExpenseItem.id == items[0].id).values(amount=22000)
        )
        assert amount() == 62000
        session.rollback()
        assert amount() == 60000
        with report_read_scope(session):
            assert amount() == 60000
    assert read_cache(session) is None
    items[0].amount = Decimal(23000)
    session.commit()
    with report_read_scope(session):
        assert amount() == 63000


def test_scope_exception_removes_cached_results(session):
    with pytest.raises(ValueError), report_read_scope(session):
        read_cache(session)[("test",)] = "temporary"
        raise ValueError("test")
    assert read_cache(session) is None
