from datetime import date
from decimal import Decimal

from sqlalchemy import func, select

from app.core.security import decode_session_token, hash_password
from app.models import (
    BankTransaction,
    DividendMonth,
    Ledger,
    RevenueRecord,
    Store,
    User,
    UserStorePermission,
)
from app.modules.miniapp.router import make_token


def setup(session):
    a, b = Store(name="授权门店"), Store(name="其他门店")
    u = User(
        username="shareholder",
        display_name="股东",
        password_hash=hash_password("pass123456"),
        role="viewer",
        status="active",
    )
    session.add_all([a, b, u])
    session.flush()
    session.add(UserStorePermission(user_id=u.id, store_id=a.id))
    session.add_all(
        [
            Ledger(store_id=a.id, period="2026-09", status="closed"),
            Ledger(store_id=a.id, period="2026-10", status="open"),
        ]
    )
    session.commit()
    return a, b, u


def test_mobile_scope_readonly_and_password_revocation(client, session):
    a, b, u = setup(session)
    client.cookies.clear()
    result = client.post(
        "/api/miniapp/login", json={"username": "shareholder", "password": "pass123456"}
    )
    assert result.status_code == 200, result.text
    token = result.json()["data"]["token"]
    h = {"authorization": "Bearer " + token}
    assert decode_session_token(token) is None
    assert client.get("/api/miniapp/stores", headers=h).json()["data"] == [
        {"id": a.id, "name": a.name}
    ]
    assert (
        client.get("/api/miniapp/periods", params={"store_id": b.id}, headers=h).status_code == 403
    )
    assert (
        client.get(
            "/api/miniapp/report", params={"store_id": a.id, "period": "2026-10"}, headers=h
        ).status_code
        == 403
    )
    assert client.post("/api/bank-transactions", json={}, headers=h).status_code == 401
    for endpoint in ["report", "revenue", "dividend", "expenses"]:
        r = client.get(
            "/api/miniapp/" + endpoint, params={"store_id": a.id, "period": "2026-09"}, headers=h
        )
        assert r.status_code == 200, (endpoint, r.text)
    assert session.scalar(select(func.count()).select_from(DividendMonth)) == 0
    for endpoint in ["bank", "preopening"]:
        r = client.get("/api/miniapp/" + endpoint, params={"store_id": a.id}, headers=h)
        assert r.status_code == 200, (endpoint, r.text)
    r = client.post(
        "/api/miniapp/change-password",
        json={"current_password": "pass123456", "new_password": "newpass12345"},
        headers=h,
    )
    assert r.status_code == 200, r.text
    assert client.get("/api/miniapp/me", headers=h).status_code == 401


def test_mobile_revenue_pagination_and_disabled_account(client, session):
    a, b, u = setup(session)
    for i in range(35):
        session.add(
            RevenueRecord(
                store_id=a.id,
                ledger_period="2026-10",
                revenue_date=date(2026, 9, 1),
                channel=f"扫码{i}",
                gross_amount=Decimal("100"),
                net_amount=Decimal("99"),
                fee_amount=Decimal("1"),
            )
        )
    session.commit()
    h = {"authorization": "Bearer " + make_token(u)}
    for page, count in [(1, 30), (2, 5)]:
        r = client.get(
            "/api/miniapp/revenue",
            params={"store_id": a.id, "period": "2026-09", "page": page},
            headers=h,
        )
        assert r.status_code == 200, r.text
        assert len(r.json()["data"]["items"]) == count
        assert r.json()["data"]["total"] == 35
    u.status = "disabled"
    session.commit()
    assert client.get("/api/miniapp/me", headers=h).status_code == 401


def test_mobile_report_uses_multi_period_cost_and_denies_other_store_bank(client, session):
    from test_approval_accounting_allocations import THREE, candidate
    from test_approval_accounting_allocations import setup as approval_setup
    from app.models import BankTransaction
    from datetime import datetime, UTC

    store, approval, items, bank = approval_setup(session)
    mid = candidate(client, items, bank, THREE).json()["data"]["id"]
    assert client.post(f"/api/matches/{mid}/confirm").status_code == 200
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store.id, Ledger.period == "2026-09")
    )
    ledger.status = "closed"
    a, b, u = setup(session)
    session.add(UserStorePermission(user_id=u.id, store_id=store.id))
    other = BankTransaction(
        store_id=b.id,
        ledger_period="2026-09",
        occurred_at=datetime(2026, 9, 1, tzinfo=UTC),
        direction="expense",
        amount=10,
        payment_status="paid",
    )
    session.add(other)
    session.commit()
    h = {"authorization": "Bearer " + make_token(u)}
    r = client.get(
        "/api/miniapp/report", params={"store_id": store.id, "period": "2026-09"}, headers=h
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["report"]["metrics"]["expense_amount"] == "20000.00"
    r = client.get(
        "/api/miniapp/expenses", params={"store_id": store.id, "period": "2026-09"}, headers=h
    )
    assert r.status_code == 200, r.text
    assert sum(Decimal(x["amount"]) for x in r.json()["data"]["items"]) == Decimal("20000")
    assert client.get("/api/miniapp/bank/" + other.id, headers=h).status_code == 403
