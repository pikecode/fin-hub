from decimal import Decimal


def test_duplicate_details_identify_existing_and_batch_sources(client):
    store = client.post("/api/stores", json={"name": "重复明细测试店"}).json()["data"]["id"]
    body = {
        "store_id": store,
        "ledger_period": "2026-10",
        "occurred_at": "2026-10-27T10:00:00",
        "direction": "expense",
        "amount": "300.00",
        "counterparty_name": "供应商",
        "summary": "原流水备注",
    }
    first = client.post("/api/bank-transactions", json=body).json()["data"]["id"]
    probe = {
        **body,
        "occurred_at": "2026-10-27T15:00:00",
        "counterparty_name": " 供应商 ",
        "summary": "本次备注",
    }
    response = client.post(
        "/api/bank-transactions/duplicates/check",
        json={"items": [probe, probe, {**probe, "amount": "301"}]},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["duplicate_indices"] == [0, 1]
    assert data["duplicate_count"] == 2
    a, b = data["duplicate_details"]
    assert a["index"] == 0 and a["earlier_indices"] == []
    assert b["index"] == 1 and b["earlier_indices"] == [0]
    record = a["existing_records"][0]
    assert record["id"] == first and record["summary"] == "原流水备注"
    assert Decimal(record["amount"]) == 300
    assert set(record) == {
        "id",
        "store_id",
        "occurred_at",
        "direction",
        "amount",
        "counterparty_name",
        "summary",
        "bank_serial_no",
        "is_archived",
    }
    assert (
        client.get("/api/bank-transactions", params={"store_id": store}).json()["data"]["total"]
        == 1
    )


def test_batch_only_and_other_store_do_not_leak_existing_records(client):
    stores = [
        client.post("/api/stores", json={"name": name}).json()["data"]["id"]
        for name in ["明细甲店", "明细乙店"]
    ]
    body = {
        "store_id": stores[0],
        "ledger_period": "2026-10",
        "occurred_at": "2026-10-27T10:00:00",
        "direction": "expense",
        "amount": "300",
        "counterparty_name": "供应商",
    }
    client.post("/api/bank-transactions", json=body)
    other = {**body, "store_id": stores[1]}
    data = client.post(
        "/api/bank-transactions/duplicates/check", json={"items": [other, other, other]}
    ).json()["data"]
    assert data["duplicate_indices"] == [1, 2]
    assert data["duplicate_details"][0]["existing_records"] == []
    assert data["duplicate_details"][1]["earlier_indices"] == [0, 1]


def test_duplicate_detail_permission_checked_before_returning_records(client, session):
    from app.core.security import create_session_token, hash_password
    from app.models import User

    store = client.post("/api/stores", json={"name": "无权明细店"}).json()["data"]["id"]
    body = {
        "store_id": store,
        "ledger_period": "2026-10",
        "occurred_at": "2026-10-27T10:00:00",
        "direction": "expense",
        "amount": "300",
        "counterparty_name": "供应商",
    }
    saved = client.post("/api/bank-transactions", json=body).json()["data"]["id"]
    user = User(
        username="duplicate-no-scope",
        display_name="无权用户",
        role="finance",
        status="active",
        password_hash=hash_password("testpass123"),
    )
    session.add(user)
    session.commit()
    client.cookies.set("fin_hub_session", create_session_token(user.id))
    response = client.post("/api/bank-transactions/duplicates/check", json={"items": [body]})
    assert response.status_code == 403
    assert saved not in response.text
