from fastapi.testclient import TestClient


def test_manual_dividend_month_can_store_profit_and_appears_in_history(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "历史分红补录店"}).json()["data"]["id"]

    response = client.put(
        f"/api/dividends/months/{store_id}/2025-01",
        json={"manual_net_profit": "-1200.50"},
    )

    assert response.status_code == 200
    workspace = response.json()["data"]
    row = next(item for item in workspace["history"] if item["period"] == "2025-01")
    assert row["net_profit"] == "-1200.50"
    assert row["manual_net_profit"] == "-1200.50"
    assert row["profit_source"] == "manual"
    assert row["historical_profit"] == "-1200.50"


def test_ledger_month_cannot_override_report_profit(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "账期分红来源店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})

    response = client.put(
        f"/api/dividends/months/{store_id}/2026-08",
        json={"manual_net_profit": "100.00"},
    )

    assert response.status_code == 422
    assert "财务报表" in response.json()["detail"]


def test_manual_dividend_month_cannot_be_entered_twice(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "重复月份校验店"}).json()["data"]["id"]
    url = f"/api/dividends/months/{store_id}/2025-01"
    assert client.put(url, json={"manual_net_profit": "100.00"}).status_code == 200

    response = client.put(url, json={"manual_net_profit": "200.00"})

    assert response.status_code == 409
    assert response.json()["detail"] == "该历史月份已存在，不能重复录入"
