from fastapi.testclient import TestClient


def test_store_ledger_end_to_end_close_and_report_flow(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说主流程验收店"}).json()["data"]["id"]
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
    client.post("/api/revenue-channels", json={"name": "美团验收", "sort_order": 10, "requires_bank_match": True})

    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "美团验收",
            "gross_amount": "1000.00",
            "net_amount": "970.00",
            "fee_amount": "30.00",
            "remark": "主流程收入",
        },
    )
    income_bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-21T10:00:00",
            "direction": "income",
            "amount": "970.00",
            "counterparty_name": "美团",
            "summary": "美团结算",
        },
    ).json()["data"]["id"]
    revenue_match_id = client.post(
        "/api/matches/revenue",
        json={
            "bank_transaction_id": income_bank_id,
            "channel": "美团验收",
            "revenue_start_date": "2026-08-20",
            "revenue_end_date": "2026-08-20",
            "amount": "970.00",
            "confidence": "98.00",
            "reason": "实收金额一致",
        },
    ).json()["data"]["id"]
    assert client.post(f"/api/matches/revenue/{revenue_match_id}/confirm?operator=acceptance").status_code == 200

    expense_id = client.post(
        "/api/expense-items",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "expense_date": "2026-08-20",
            "description": "主流程物料费",
            "amount": "300.00",
        },
    ).json()["data"]["id"]
    expense_bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-22T11:00:00",
            "direction": "expense",
            "amount": "300.00",
            "counterparty_name": "物料供应商",
            "summary": "物料付款",
        },
    ).json()["data"]["id"]
    expense_match_id = client.post(
        "/api/matches",
        json={
            "expense_item_id": expense_id,
            "bank_transaction_id": expense_bank_id,
            "amount": "300.00",
            "accounting_period": "2026-08",
            "bank_occurred": True,
            "confidence": "98.00",
            "reason": "金额一致",
        },
    ).json()["data"]["id"]
    assert client.post(f"/api/matches/{expense_match_id}/confirm?operator=acceptance").status_code == 200

    workspace = client.get(f"/api/store-ledgers/{store_id}/workspace?period=2026-08").json()["data"]
    assert workspace["metrics"]["income_amount"] == "1000.00"
    assert workspace["metrics"]["net_income_amount"] == "970.00"
    assert workspace["metrics"]["unmatched_bank_transaction_count"] == 0
    assert workspace["close_check"]["can_close"] is True
    assert workspace["close_check"]["issues"] == []

    close_response = client.post(f"/api/ledgers/{ledger_id}/close", json={"operator": "acceptance"})
    assert close_response.status_code == 200
    assert close_response.json()["data"]["status"] == "closed"

    report = client.get(f"/api/reports/ledger-detail?store_id={store_id}&period=2026-08").json()["data"]
    assert report["summary"]["income_amount"] == "1000.00"
    assert report["summary"]["expense_amount"] == "300.00"
    assert report["summary"]["profit_amount"] == "700.00"
    assert report["revenue_channel_breakdown"][0]["reconciliation_rate"] == "100.00"

    assert (
        client.post(
            "/api/expense-items",
            json={
                "store_id": store_id,
                "ledger_period": "2026-08",
                "description": "封账后支出",
                "amount": "1.00",
            },
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/revenue-records",
            json={
                "store_id": store_id,
                "ledger_period": "2026-08",
                "revenue_date": "2026-08-23",
                "channel": "美团验收",
                "gross_amount": "1.00",
                "net_amount": "1.00",
            },
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/bank-transactions",
            json={
                "store_id": store_id,
                "ledger_period": "2026-08",
                "occurred_at": "2026-08-23T10:00:00",
                "direction": "income",
                "amount": "1.00",
            },
        ).status_code
        == 409
    )
