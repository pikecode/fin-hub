from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.core.security import hash_password
from app.models import User


def test_audit_log_is_written_for_store_create(client: TestClient) -> None:
    response = client.post("/api/stores", json={"name": "蘑说审计店"})
    assert response.status_code == 201
    store_id = response.json()["data"]["id"]

    logs_response = client.get("/api/audit-logs?resource_type=store&page_size=20")
    assert logs_response.status_code == 200
    logs = logs_response.json()["data"]["items"]
    assert logs[0]["action"] == "store.create"
    assert logs[0]["resource_id"] == store_id
    assert logs[0]["summary"] == "新增门店：蘑说审计店"


def test_audit_log_is_written_for_match_confirm(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说匹配审计店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    expense_id = client.post(
        "/api/expense-items",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "description": "审计水电费",
            "amount": "100.00",
        },
    ).json()["data"]["id"]
    bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-13T10:30:00",
            "direction": "expense",
            "amount": "100.00",
        },
    ).json()["data"]["id"]
    match_id = client.post(
        "/api/matches",
        json={"expense_item_id": expense_id, "bank_transaction_id": bank_id, "amount": "100.00"},
    ).json()["data"]["id"]

    response = client.post(f"/api/matches/{match_id}/confirm?operator=auditor")
    assert response.status_code == 200

    logs = client.get("/api/audit-logs?resource_type=expense_bank_match&page_size=20").json()["data"]["items"]
    assert logs[0]["action"] == "match.confirm"
    assert logs[0]["actor"] == "admin"


def test_audit_log_uses_authenticated_user_when_available(client: TestClient, session: Session) -> None:
    session.add(
        User(
            username="finance",
            display_name="财务同事",
            password_hash=hash_password("secret123"),
            role="finance",
            status="active",
        )
    )
    session.commit()

    login_response = client.post("/api/auth/login", json={"username": "finance", "password": "secret123"})
    assert login_response.status_code == 200

    store_response = client.post("/api/stores", json={"name": "蘑说登录审计店"})
    assert store_response.status_code == 201

    logs = client.get("/api/audit-logs?resource_type=store&page_size=20").json()["data"]["items"]
    assert logs[0]["actor"] == "finance"
