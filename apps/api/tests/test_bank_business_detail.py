from fastapi.testclient import TestClient


def test_bank_business_detail_returns_special_flow_remark(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "流水业务详情店"}).json()["data"]["id"]
    response = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-20T10:00:00",
            "direction": "expense",
            "amount": "300.00",
            "summary": "员工借款",
            "special_type": "current_account",
        },
    )
    transaction_id = response.json()["data"]["id"]

    detail = client.get(f"/api/bank-transactions/{transaction_id}/business-detail")

    assert detail.status_code == 200
    payload = detail.json()["data"]
    assert payload["special_label"] == "往来款"
    assert payload["remark"] == "员工借款"
    assert payload["expenses"] == []
    assert payload["revenues"] == []
