from test_dividend_opening_balance import opening_payload, setup_store

from app.models import DividendEntry, DividendMonth, DividendShareholder, Ledger


def setup(client, session, **changes):
    store = setup_store(session)
    response = client.put(
        f"/api/dividends/opening/{store.id}",
        json=opening_payload(
            preopening_expense_override="6000", historical_preopening_coverage="200", **changes
        ),
    )
    assert response.status_code == 200, response.text
    return store


def workspace(client, store, period="2026-09"):
    response = client.get(f"/api/dividends/workspace?store_id={store.id}&period={period}")
    assert response.status_code == 200, response.text
    return response.json()["data"]


def save(client, store, amount, period="2026-09"):
    return client.put(
        f"/api/dividends/months/{store.id}/{period}",
        json={"preopening_coverage": amount, "preopening_coverage_remark": "利润补充"},
    )


def test_actual_coverage_and_dividend_are_separate_and_report_agrees(client, session):
    store = setup(client, session)
    shareholder = DividendShareholder(store_id=store.id, name="股东", holding_ratio=100)
    session.add(shareholder)
    session.commit()
    before = workspace(client, store)
    assert before["funding"]["preopening_profit_covered"] == "200.00"
    response = client.put(
        f"/api/dividends/months/{store.id}/2026-09",
        json={
            "distribution": [{"shareholder_id": shareholder.id, "amount": "100"}],
            "preopening_coverage": "600",
        },
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["current"]["remaining_undistributed"] == "300.00"
    assert data["current"]["historical_distribution"] == "2100.00"
    assert data["current"]["cumulative_preopening_coverage"] == "800.00"
    assert data["funding"]["preopening_uncovered"] == "1200.00"
    report = client.get(
        f"/api/reports/financial-supplement?store_id={store.id}&period=2026-09"
    ).json()["data"]
    assert report["remaining_undistributed"] == "300.00"
    assert report["preopening_profit_covered"] == "800.00"
    assert report["cumulative_distribution"] == "2100.00"
    assert report["preopening_coverage_amount"] == "600.00"
    assert save(client, store, "0").status_code == 200
    assert workspace(client, store)["current"]["remaining_undistributed"] == "900.00"


def test_replacing_month_does_not_double_count_and_propagates(client, session):
    store = setup(client, session)
    assert save(client, store, "300").status_code == 200
    assert save(client, store, "400").status_code == 200
    assert save(client, store, "600", "2026-10").status_code == 200
    data = workspace(client, store, "2026-10")
    assert data["current"]["remaining_undistributed"] == "0.00"
    assert data["current"]["cumulative_preopening_coverage"] == "1200.00"
    assert save(client, store, "200").status_code == 200
    assert workspace(client, store, "2026-10")["current"]["remaining_undistributed"] == "200.00"


def test_overrun_limit_and_profit_limit_are_enforced(client, session):
    store = setup(client, session, opening_remaining="10000")
    assert save(client, store, "1800").status_code == 200
    assert save(client, store, "0.01", "2026-10").status_code == 422
    session.rollback()  # Test client shares one session; real requests close it on errors.
    assert workspace(client, store, "2026-10")["current"]["preopening_coverage_amount"] == "0.00"
    assert save(client, store, "1800.01").status_code == 422
    session.rollback()
    assert workspace(client, store)["current"]["preopening_coverage_amount"] == "1800.00"


def test_insufficient_profit_and_malformed_amounts(client, session):
    store = setup(client, session)
    assert save(client, store, "1000.01").status_code == 422
    session.rollback()
    for amount in ("-1", "NaN", "1.001"):
        assert save(client, store, amount).status_code == 422
    assert save(client, store, "1000").status_code == 200


def test_later_allocations_lock_and_seal_protect_history(client, session):
    store = setup(client, session)
    assert save(client, store, "400").status_code == 200
    assert save(client, store, "600", "2026-10").status_code == 200
    assert save(client, store, "500").status_code == 422  # October would overdraw profits.
    session.rollback()
    assert client.post(f"/api/dividends/months/{store.id}/2026-10/lock").status_code == 200
    assert save(client, store, "300").status_code == 409
    session.rollback()
    assert save(client, store, "0", "2026-10").status_code == 409
    session.rollback()
    session.add(Ledger(store_id=store.id, period="2026-09", status="closed"))
    session.commit()
    assert save(client, store, "300").status_code == 409


def test_opening_coverage_validation_and_isolation(client, session):
    store = setup(client, session)
    month = DividendMonth(store_id=store.id, period="2026-08")
    session.add(month)
    session.flush()
    session.add(
        DividendEntry(
            month_id=month.id,
            entry_type="preopening_coverage",
            shareholder_name="补充",
            holding_ratio=0,
            amount=999,
        )
    )
    session.commit()
    assert workspace(client, store)["current"]["cumulative_preopening_coverage"] == "200.00"
    assert (
        workspace(client, store, "2026-08")["current"]["cumulative_preopening_coverage"] == "0.00"
    )
    response = client.put(
        f"/api/dividends/opening/{store.id}",
        json=opening_payload(
            version=1, preopening_expense_override="6000", historical_preopening_coverage="2001"
        ),
    )
    assert response.status_code == 422
    session.rollback()
    assert workspace(client, store)["funding"]["preopening_profit_covered"] == "200.00"


def test_missing_cost_and_unconfigured_store_cannot_allocate(client, session):
    store = setup_store(session)
    assert save(client, store, "1").status_code == 422
    session.rollback()
    response = client.put(f"/api/dividends/opening/{store.id}", json=opening_payload())
    assert response.status_code == 200, response.text
    data = workspace(client, store)
    assert data["funding"]["preopening_expense_source"] == "missing"
    assert data["funding"]["preopening_balance"] is None
    assert data["funding"]["preopening_uncovered"] is None
    assert save(client, store, "1").status_code == 422


def test_sealing_switches_to_report_and_rejects_excess_coverage(client, session):
    store = setup(client, session)
    assert save(client, store, "100").status_code == 200
    response = client.post(f"/api/preopening/stores/{store.id}/close")
    assert response.status_code == 422, (
        response.text
    )  # Empty report cannot cover actual allocations.
    session.rollback()
    assert workspace(client, store)["funding"]["preopening_expense_source"] == "manual"


def test_0040_migration_preserves_old_balances_and_defaults_actual_coverage_to_zero(
    client, session
):
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import text

    store = setup(client, session)
    session.execute(
        text("ALTER TABLE dividend_opening_balances DROP COLUMN historical_preopening_coverage")
    )
    session.commit()
    path = (
        Path(__file__).parents[1] / "alembic/versions/20261103_0040_dividend_preopening_coverage.py"
    )
    spec = importlib.util.spec_from_file_location("coverage_migration", path)
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    migration.op = Operations(MigrationContext.configure(session.connection()))
    migration.upgrade()
    values = session.execute(
        text(
            "SELECT historical_preopening_coverage, opening_remaining, historical_distribution FROM dividend_opening_balances WHERE store_id=:store"
        ),
        {"store": store.id},
    ).one()
    assert tuple(map(str, values)) == ("0.00", "1000.00", "2000.00")
    migration.downgrade()
    migration.upgrade()
    session.commit()
