from datetime import datetime
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import BankTransaction


def test_bank_balance_uses_latest_correction_and_transactions_after_date(
    client: TestClient, session: Session
) -> None:
    store_id = client.post("/api/stores", json={"name": "余额校正测试店"}).json()["data"]["id"]
    session.add_all(
        [
            BankTransaction(
                store_id=store_id,
                ledger_period="2026-08",
                occurred_at=datetime(2026, 8, 10, 9, 0),  # noqa: DTZ001
                direction="income",
                amount=Decimal("100.00"),
                counterparty_name="当天收入",
            ),
            BankTransaction(
                store_id=store_id,
                ledger_period="2026-08",
                occurred_at=datetime(2026, 8, 11, 9, 0),  # noqa: DTZ001
                direction="income",
                amount=Decimal("30.00"),
                counterparty_name="后续收入",
            ),
            BankTransaction(
                store_id=store_id,
                ledger_period="2026-08",
                occurred_at=datetime(2026, 8, 12, 9, 0),  # noqa: DTZ001
                direction="expense",
                amount=Decimal("10.00"),
                counterparty_name="后续支出",
            ),
        ]
    )
    session.commit()

    response = client.post(
        "/api/bank-balance/corrections",
        json={
            "store_id": store_id,
            "correction_date": "2026-08-10",
            "balance_amount": "1000.00",
            "remark": "月底银行对账",
            "password": "admin123456",
        },
    )
    assert response.status_code == 201
    assert response.json()["data"]["remark"] == "月底银行对账"

    balance = client.get(f"/api/bank-balance?store_id={store_id}")
    assert balance.status_code == 200
    assert balance.json()["data"] == {
        "balance_amount": "1020.00",
        "base_balance_amount": "1000.00",
        "base_correction_date": "2026-08-10",
        "income_after_base": "30.00",
        "expense_after_base": "10.00",
        "has_correction": True,
    }

    second = client.post(
        "/api/bank-balance/corrections",
        json={
            "store_id": store_id,
            "correction_date": "2026-08-12",
            "balance_amount": "2000.00",
            "remark": "再次核对",
            "password": "admin123456",
        },
    )
    assert second.status_code == 201
    latest_balance = client.get(f"/api/bank-balance?store_id={store_id}").json()["data"]
    assert latest_balance["balance_amount"] == "2000.00"
    assert latest_balance["income_after_base"] == "0.00"
    assert latest_balance["expense_after_base"] == "0.00"

    history = client.get(f"/api/bank-balance/corrections?store_id={store_id}")
    assert history.status_code == 200
    assert len(history.json()["data"]) == 2
    assert history.json()["data"][0]["created_by"] == "系统管理员"


def test_bank_balance_correction_requires_password_and_open_ledger(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "余额封账测试店"}).json()["data"]["id"]
    invalid = client.post(
        "/api/bank-balance/corrections",
        json={
            "store_id": store_id,
            "correction_date": "2026-08-10",
            "balance_amount": "100.00",
            "remark": "测试",
            "password": "wrong-password",
        },
    )
    assert invalid.status_code == 401

    ledger_id = client.post(
        "/api/ledgers", json={"store_id": store_id, "period": "2026-08"}
    ).json()["data"]["id"]
    assert client.post(f"/api/ledgers/{ledger_id}/close", json={"operator": "admin"}).status_code == 200
    closed = client.post(
        "/api/bank-balance/corrections",
        json={
            "store_id": store_id,
            "correction_date": "2026-08-10",
            "balance_amount": "100.00",
            "remark": "封账后测试",
            "password": "admin123456",
        },
    )
    assert closed.status_code == 409
