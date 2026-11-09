from decimal import Decimal
from sqlalchemy import select, func
from test_accruals import setup_store
from app.models import BankTransaction, StoreLoanEvent, Ledger


def test_loan_cash_receivable_profit_and_idempotency(client, session):
    base = setup_store(client, session)
    store = base["store_id"]
    payload = dict(
        store_id=store,
        borrower="借款人",
        occurred_on="2026-09-15",
        amount="1000",
        remark="周转",
        request_key="lend",
    )
    response = client.post("/api/store-loans", json=payload)
    assert response.status_code == 200, response.text
    loan = response.json()["data"]
    assert client.post("/api/store-loans", json=payload).json()["data"] == loan
    repayment = dict(occurred_on="2026-10-15", amount="300", remark="部分还款", request_key="repay")
    response = client.post(f"/api/store-loans/{loan['id']}/repayments", json=repayment)
    assert response.status_code == 200, response.text
    assert (
        client.post(f"/api/store-loans/{loan['id']}/repayments", json=repayment).status_code == 200
    )
    assert session.scalar(select(func.count()).select_from(StoreLoanEvent)) == 2
    banks = list(session.scalars(select(BankTransaction)))
    assert (
        sum((b.amount if b.direction == "income" else -b.amount for b in banks), Decimal(0)) == -700
    )
    for month, remaining in [("2026-09", "1000.00"), ("2026-10", "700.00")]:
        result = client.get(f"/api/reports/financial-supplement?store_id={store}&period={month}")
        assert result.status_code == 200, result.text
        assert result.json()["data"]["loan_receivable_amount"] == remaining
        report = client.get(f"/api/store-ledgers/{store}/report?period={month}")
        assert report.json()["data"]["metrics"]["expense_amount"] == "0.00"
    assert (
        client.post(
            f"/api/store-loans/{loan['id']}/repayments",
            json={**repayment, "amount": "701", "request_key": "overpay"},
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/store-loans",
            json={**payload, "request_key": "duplicate-bank", "bank_transaction_id": banks[0].id},
        ).status_code
        == 409
    )
    assert client.delete(f"/api/bank-transactions/{banks[0].id}").status_code in (409, 422)


def test_existing_bank_and_closed_future_period(client, session):
    from datetime import datetime

    base = setup_store(client, session)
    store = base["store_id"]
    bank = BankTransaction(
        store_id=store,
        ledger_period="2026-09",
        occurred_at=datetime(2026, 9, 15, 12),
        direction="expense",
        amount=Decimal(1000),
        payment_status="paid",
    )
    session.add(bank)
    session.commit()
    payload = dict(
        store_id=store,
        borrower="已有流水",
        occurred_on="2026-09-15",
        amount="1000",
        remark="关联流水",
        request_key="existing",
        bank_transaction_id=bank.id,
    )
    response = client.post("/api/store-loans", json=payload)
    assert response.status_code == 200, response.text
    assert session.scalar(select(func.count()).select_from(BankTransaction)) == 1
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store, Ledger.period == "2026-10")
    )
    ledger.status = "closed"
    session.commit()
    assert (
        client.post(
            "/api/store-loans",
            json={**payload, "bank_transaction_id": None, "request_key": "closed"},
        ).status_code
        == 409
    )


def test_revoke_preserves_audit_and_restores_cash(client, session):
    base = setup_store(client, session)
    store = base["store_id"]
    payload = dict(
        store_id=store,
        borrower="借款人",
        occurred_on="2026-09-15",
        amount="1000",
        remark="周转",
        request_key="lend",
    )
    loan = client.post("/api/store-loans", json=payload).json()["data"]
    repayment = dict(occurred_on="2026-10-15", amount="300", remark="部分还款", request_key="repay")
    repaid = client.post(f"/api/store-loans/{loan['id']}/repayments", json=repayment).json()["data"]
    revoke = lambda id: client.post(
        f"/api/store-loans/events/{id}/revoke", json={"reason": "录入错误"}
    )
    assert revoke(loan["event_id"]).status_code == 409
    assert revoke(repaid["event_id"]).status_code == 200
    assert revoke(repaid["event_id"]).status_code == 200
    assert (
        client.get("/api/store-loans", params={"store_id": store}).json()["data"][0]["remaining"]
        == "1000.00"
    )
    assert revoke(loan["event_id"]).status_code == 200
    assert session.scalar(select(func.count()).select_from(StoreLoanEvent)) == 2
    assert all(b.is_archived for b in session.scalars(select(BankTransaction)))
    assert (
        client.get("/api/store-loans", params={"store_id": store}).json()["data"][0]["remaining"]
        == "0"
    )
    # An idempotent retry cannot resurrect a cancelled transaction.
    assert client.post("/api/store-loans", json=payload).json()["data"] == loan
    assert (
        client.post(
            f"/api/store-loans/{loan['id']}/repayments",
            json={**repayment, "request_key": "cancelled-loan"},
        ).status_code
        == 409
    )


def test_receipts_scope_types_and_closed_guard(client, session, monkeypatch, tmp_path):
    from app.core.config import settings
    from app.core.security import hash_password
    from app.models import User, UserStorePermission, Store

    monkeypatch.setattr(settings, "file_storage_root", str(tmp_path))
    base = setup_store(client, session)
    store = base["store_id"]
    loan = client.post(
        "/api/store-loans",
        json=dict(
            store_id=store,
            borrower="借款人",
            occurred_on="2026-09-15",
            amount="1000",
            remark="周转",
            request_key="lend",
        ),
    ).json()["data"]
    url = f"/api/attachments?resource_type=loan_event&resource_id={loan['event_id']}"
    assert (
        client.post(url, files={"file": ("fake.png", b"<html>bad</html>", "image/png")}).status_code
        == 422
    )
    # A real one-pixel PNG.
    import base64

    png = base64.b64decode(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1cAAAAASUVORK5CYII="
    )
    uploaded = client.post(url, files={"file": ("receipt.png", png, "text/html")})
    assert uploaded.status_code == 201, uploaded.text
    att = uploaded.json()["data"]
    assert att["content_type"] == "image/png"
    assert client.get(f"/api/attachments/{att['id']}/download").content == png
    viewer = User(
        username="loanviewer",
        display_name="查看者",
        password_hash=hash_password("pass123456"),
        role="viewer",
        status="active",
    )
    other = Store(name="其他门店")
    session.add_all([viewer, other])
    session.flush()
    session.add(UserStorePermission(user_id=viewer.id, store_id=other.id))
    session.commit()
    client.cookies.clear()
    assert (
        client.post(
            "/api/auth/login", json={"username": "loanviewer", "password": "pass123456"}
        ).status_code
        == 200
    )
    assert client.get(url).status_code == 403
    assert client.get(f"/api/attachments/{att['id']}/download").status_code == 403
    assert client.get("/api/store-loans", params={"store_id": store}).status_code == 403
    client.cookies.clear()
    client.post("/api/auth/login", json={"username": "admin", "password": "admin123456"})
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store, Ledger.period == "2026-10")
    )
    ledger.status = "closed"
    session.commit()
    assert client.post(url, files={"file": ("receipt.png", png, "image/png")}).status_code == 409
    assert (
        client.post(
            f"/api/store-loans/events/{loan['event_id']}/revoke", json={"reason": "撤销"}
        ).status_code
        == 409
    )
