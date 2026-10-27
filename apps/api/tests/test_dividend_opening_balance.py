from datetime import date
from decimal import Decimal

from sqlalchemy import select, func

from app.models import (
    DividendEntry,
    DividendMonth,
    DividendOpeningBalance,
    ExpenseItem,
    Ledger,
    PreopeningStore,
    RevenueRecord,
    Store,
    User,
    UserStorePermission,
)


def setup_store(session, name="期初分红门店"):
    store = Store(name=name)
    session.add(store)
    session.commit()
    return store


def payload(**changes):
    return dict(
        start_period="2026-09",
        opening_remaining="1000",
        historical_profit="5000",
        historical_distribution="2000",
        operating_capital="3000",
        preopening_investment="4000",
        preopening_expense_override=None,
        version=0,
        reason="首次录入",
        **changes,
    )


def opening_payload(**changes):
    result = payload()
    result.update(changes)
    return result


def revenue(session, store, period, amount):
    session.add(
        RevenueRecord(
            store_id=store.id,
            ledger_period=period,
            revenue_date=date.fromisoformat(period + "-01"),
            channel="测试收入",
            gross_amount=amount,
            net_amount=amount,
            fee_amount=0,
        )
    )


def entry(session, store, period, kind, amount):
    month = session.scalar(
        select(DividendMonth).where(
            DividendMonth.store_id == store.id, DividendMonth.period == period
        )
    )
    if month is None:
        month = DividendMonth(store_id=store.id, period=period)
        session.add(month)
        session.flush()
    session.add(
        DividendEntry(
            month_id=month.id,
            entry_type=kind,
            shareholder_name="股东",
            holding_ratio=100,
            amount=amount,
        )
    )
    return month


def test_opening_month_formula_excludes_prior_and_matches_financial_report(client, session):
    store = setup_store(session)
    revenue(session, store, "2026-08", 9000)
    revenue(session, store, "2026-09", 200)
    revenue(session, store, "2026-11", 100)
    session.add(
        ExpenseItem(
            store_id=store.id,
            ledger_period="2026-10",
            expense_date=date(2026, 10, 1),
            description="食材",
            amount=50,
            source="kuailv_purchase",
            category_l1="食材成本",
            category_l2="鸡",
        )
    )
    old = entry(session, store, "2026-08", "distribution", 8000)
    old.manual_net_profit = 8888
    current = entry(session, store, "2026-09", "distribution", 20)
    current.manual_net_profit = 9999
    current.manual_remaining_undistributed = 9999
    entry(session, store, "2026-09", "capital", 500)
    entry(session, store, "2026-10", "distribution", 10)
    session.commit()
    result = client.put(f"/api/dividends/opening/{store.id}", json=payload())
    assert result.status_code == 200, result.text
    rows = client.get(f"/api/dividends/workspace?store_id={store.id}&period=2026-10").json()["data"]
    by_period = {row["period"]: row for row in rows["history"]}
    september = by_period["2026-09"]
    assert september["net_profit"] == "200.00" and september["profit_source"] == "report"
    assert september["available_profit"] == "1200.00"
    assert september["remaining_undistributed"] == "1180.00"
    assert september["historical_profit"] == "5200.00"
    assert september["historical_distribution"] == "2020.00"
    assert september["cumulative_capital"] == "3500.00"
    october = rows["current"]
    assert october["net_profit"] == "-50.00"
    assert october["available_profit"] == "1130.00"
    assert october["remaining_undistributed"] == "1120.00"
    assert october["historical_profit"] == "5150.00"
    assert october["historical_distribution"] == "2030.00"
    assert by_period["2026-08"]["excluded_from_calculation"] is True
    assert by_period["2026-08"]["historical_distribution"] == "0.00"
    report = client.get(
        f"/api/reports/financial-supplement?store_id={store.id}&period=2026-10"
    ).json()["data"]
    assert report["remaining_undistributed"] == october["remaining_undistributed"]
    assert report["cumulative_distribution"] == october["historical_distribution"]
    assert report["total_capital"] == "7500.00"
    before_start = client.get(
        f"/api/reports/financial-supplement?store_id={store.id}&period=2026-08"
    ).json()["data"]
    assert before_start["dividend_excluded"] is True
    assert before_start["remaining_undistributed"] is None
    assert (
        client.put(
            f"/api/dividends/months/{store.id}/2026-09", json={"manual_net_profit": "2"}
        ).status_code
        == 422
    )
    assert (
        client.put(
            f"/api/dividends/months/{store.id}/2026-08", json={"no_capital": True}
        ).status_code
        == 409
    )
    assert client.post(f"/api/dividends/months/{store.id}/2026-08/lock").status_code == 409
    session.refresh(old)
    assert old.manual_net_profit == 8888


def test_missing_months_read_only_negative_balance_and_history(client, session):
    store = setup_store(session)
    revenue(session, store, "2026-10", 30)
    revenue(session, store, "2026-12", 20)
    session.commit()
    result = client.put(
        f"/api/dividends/opening/{store.id}",
        json=opening_payload(
            start_period="2026-09", opening_remaining="-100", historical_profit="-200"
        ),
    )
    assert result.status_code == 200, result.text
    before = session.scalar(select(func.count()).select_from(DividendMonth))
    ledger_count = session.scalar(select(func.count()).select_from(Ledger))
    result = client.get(f"/api/dividends/workspace?store_id={store.id}&period=2026-12")
    assert result.status_code == 200, result.text
    data = result.json()["data"]
    assert data["current"]["remaining_undistributed"] == "-50.00"
    assert "2026-11" in data["available_periods"]
    assert {"2026-09", "2026-10", "2026-11", "2026-12"}.issubset(
        {row["period"] for row in data["history"]}
    )
    assert session.scalar(select(func.count()).select_from(DividendMonth)) == before
    assert session.scalar(select(func.count()).select_from(Ledger)) == ledger_count
    history = client.get(f"/api/dividends/opening/{store.id}/history")
    assert history.status_code == 200
    assert len(history.json()["data"]) == 1
    assert "首次录入" in history.json()["data"][0]["metadata_json"]


def test_opening_updates_version_and_isolation_range_lock(client, session):
    store = setup_store(session)
    base = f"/api/dividends/opening/{store.id}"
    assert client.put(base, json=payload()).status_code == 200
    changed = opening_payload(version=1, opening_remaining="1200", reason="修正历史金额")
    assert client.put(base, json=changed).json()["data"]["version"] == 2
    assert client.put(base, json=changed).status_code == 409
    assert client.post(f"/api/dividends/months/{store.id}/2026-10/lock").status_code == 200
    assert client.put(base, json=opening_payload(version=2)).status_code == 409
    assert (
        client.post(f"/api/dividends/months/{store.id}/2026-10/unlock?reason=更正期初").status_code
        == 200
    )
    old = DividendMonth(store_id=store.id, period="2026-08", locked=True)
    session.add(old)
    session.commit()
    assert (
        client.put(base, json=opening_payload(version=2, start_period="2026-08")).status_code == 409
    )
    # Unlocking a legacy excluded month is allowed to permit an earlier opening boundary.
    assert (
        client.post(f"/api/dividends/months/{store.id}/2026-08/unlock?reason=更正起点").status_code
        == 200
    )
    response = client.put(base, json=opening_payload(version=2, start_period="2026-08"))
    assert response.status_code == 200, response.text
    assert len(client.get(base + "/history").json()["data"]) == 3


def test_opening_ledger_and_preopening_seals_and_old_funding_endpoint(client, session):
    store = setup_store(session)
    session.add(Ledger(store_id=store.id, period="2026-10", status="closed"))
    session.commit()
    base = f"/api/dividends/opening/{store.id}"
    assert client.put(base, json=payload()).status_code == 409
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store.id))
    ledger.status = "open"
    session.add(PreopeningStore(store_id=store.id, status="closed"))
    session.commit()
    assert client.put(base, json=payload()).status_code == 409
    # Existing sealed preopening values can be preserved while setting other opening balances.
    response = client.put(base, json=opening_payload(preopening_investment="0"))
    assert response.status_code == 200, response.text
    assert (
        client.patch(
            f"/api/dividends/stores/{store.id}/funding-settings",
            json={"preopening_investment": "1"},
        ).status_code
        == 409
    )


def test_opening_permissions_validations_and_store_scoped_history(client, session):
    store = setup_store(session)
    other = setup_store(session, "其他门店")
    base = f"/api/dividends/opening/{store.id}"
    for changes in [
        {"start_period": "2026-13"},
        {"historical_distribution": "-1"},
        {"reason": " "},
        {"opening_remaining": "NaN"},
        {"historical_profit": "1.234"},
    ]:
        assert client.put(base, json=opening_payload(**changes)).status_code == 422
    assert client.get(base).json()["data"]["configured"] is False
    assert client.put(base, json=payload()).status_code == 200
    assert client.get(f"/api/dividends/opening/{other.id}/history").json()["data"] == []
    from app.core.security import hash_password

    user = User(
        username="opening-viewer",
        display_name="只读",
        role="viewer",
        status="active",
        password_hash=hash_password("viewerpass"),
    )
    session.add(user)
    session.flush()
    session.add(UserStorePermission(user_id=user.id, store_id=store.id))
    session.commit()
    assert (
        client.post(
            "/api/auth/login", json={"username": "opening-viewer", "password": "viewerpass"}
        ).status_code
        == 200
    )
    assert client.get(base).status_code == 200
    assert client.put(base, json=opening_payload(version=1)).status_code == 403
    assert client.get(f"/api/dividends/opening/{other.id}").status_code == 403
