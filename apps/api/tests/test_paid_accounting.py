from decimal import Decimal
from sqlalchemy import select
from test_partial_approvals import salary_fixture, match_bank
from app.models import BankTransaction, Ledger
from app.modules.store_ledgers.router import confirmed_accounting_expense_rows, calculate_store_ledger_profits


def total(session, store, period):
    return sum((r[3] for r in confirmed_accounting_expense_rows(session, store, period)), Decimal(0))


def test_paid_mode_proportions_follow_approval_month_and_unmatch(client, session):
    store, approval, items, banks = salary_fixture(client, session, lines=True)
    # Cash payment happens October/November, expense month remains September.
    for bank in banks:
        bank.payment_status = "paid"
    session.commit()
    first = match_bank(client, items[0], banks[0])
    url = f"/api/matches/reconciliation/approvals/{approval.id}/paid-accounting"
    assert total(session, store, "2026-09") == 60000
    response = client.put(url, json={"enabled": True})
    assert response.status_code == 200, response.text
    assert total(session, store, "2026-09") == 20000
    assert total(session, store, "2026-10") == 0
    rows = confirmed_accounting_expense_rows(session, store, "2026-09")
    assert sorted(r[3] for r in rows) == [Decimal("6666.67"), Decimal("13333.33")]
    second = match_bank(client, items[1], banks[1])
    assert total(session, store, "2026-09") == 45000
    assert calculate_store_ledger_profits(session, store, ["2026-09"])["2026-09"] == -45000
    assert client.post(f"/api/matches/reconciliation/records/{second}/unmatch").status_code == 200
    assert total(session, store, "2026-09") == 20000
    assert client.put(url, json={"enabled": False}).status_code == 200
    assert total(session, store, "2026-09") == 60000


def test_unpaid_not_expensed_and_closed_mode_locked(client, session):
    store, approval, items, banks = salary_fixture(client, session)
    banks[0].payment_status = "unpaid"
    session.commit()
    match_bank(client, items[0], banks[0])
    url = f"/api/matches/reconciliation/approvals/{approval.id}/paid-accounting"
    r = client.put(url, json={"enabled": True})
    assert r.status_code == 200, r.text
    assert total(session, store, "2026-09") == 0
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store, Ledger.period == "2026-09"))
    ledger.status = "closed"
    session.commit()
    assert client.put(url, json={"enabled": False}).status_code == 409
    assert client.patch(f"/api/bank-transactions/{banks[0].id}", json={"payment_status": "paid"}).status_code == 409


def test_whole_accrual_coverage_overrides_paid_mode(client, session):
    from test_accruals import setup_store, matched_approval
    payload = setup_store(client, session)
    root = client.post("/api/accruals", json=payload).json()["data"]["id"]
    approval, item, bank, match = matched_approval(session, payload["store_id"], "60000", suffix="paid-covered")
    bank.payment_status = "paid"
    session.commit()
    response = client.put(f"/api/matches/reconciliation/approvals/{approval.id}/paid-accounting", json={"enabled": True})
    assert response.status_code == 200, response.text
    response = client.post("/api/accruals/links/batch", json={"original_id": root,
        "approval_ids": [approval.id], "remark": "整单计提排除重复费用", "request_key": "paid-covered"})
    assert response.status_code == 200, response.text
    assert total(session, payload["store_id"], "2026-10") == 0


def test_paid_mode_enforces_scope_and_no_match(client, session):
    from app.models import User, UserStorePermission
    from app.core.security import create_session_token, hash_password
    store, approval, items, banks = salary_fixture(client, session)
    url = f"/api/matches/reconciliation/approvals/{approval.id}/paid-accounting"
    assert client.put(url, json={"enabled": True}).status_code == 409
    user = User(username="outside-finance", display_name="无门店财务", role="finance",
        password_hash=hash_password("testpass123"), status="active")
    session.add(user)
    session.commit()
    client.cookies.set("fin_hub_session", create_session_token(user.id))
    assert client.put(url, json={"enabled": True}).status_code == 403
