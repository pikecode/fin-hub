from fastapi.testclient import TestClient


def test_create_update_revenue_record_and_report(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    channel_response = client.post(
        "/api/revenue-channels",
        json={"name": "美团", "sort_order": 10, "requires_bank_match": True},
    )
    assert channel_response.status_code == 201

    create_response = client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "美团",
            "gross_amount": "1000.00",
            "net_amount": "970.00",
            "fee_amount": "30.00",
            "remark": "午市",
        },
    )
    assert create_response.status_code == 201
    record_id = create_response.json()["data"]["id"]

    update_response = client.patch(
        f"/api/revenue-records/{record_id}",
        json={"gross_amount": "1100.00", "net_amount": "1060.00", "fee_amount": "40.00"},
    )
    assert update_response.status_code == 200
    assert update_response.json()["data"]["gross_amount"] == "1100.00"

    list_response = client.get(f"/api/revenue-records?store_id={store_id}&ledger_period=2026-08")
    assert list_response.status_code == 200
    assert list_response.json()["data"]["total"] == 1

    report_response = client.get(f"/api/reports/ledger-detail?store_id={store_id}&period=2026-08")
    assert report_response.status_code == 200
    report = report_response.json()["data"]
    assert report["summary"]["income_amount"] == "1100.00"
    assert report["revenue_records"][0]["channel"] == "美团"

    csv_response = client.get(f"/api/reports/ledger-detail.csv?store_id={store_id}&period=2026-08")
    assert csv_response.status_code == 200
    assert "营业收入" in csv_response.text
    assert "美团" in csv_response.text

    logs = client.get("/api/audit-logs?resource_type=revenue_record&page_size=20").json()["data"]["items"]
    assert any(log["action"] == "revenue_record.create" and log["resource_id"] == record_id for log in logs)
    assert any(log["action"] == "revenue_record.update" and log["resource_id"] == record_id for log in logs)


def test_create_revenue_record_auto_creates_open_ledger(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入自动账套店"}).json()["data"]["id"]
    client.post("/api/revenue-channels", json={"name": "扫码收入", "requires_bank_match": False})

    create_response = client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "revenue_date": "2026-09-02",
            "channel": "扫码收入",
            "gross_amount": "1280.00",
            "net_amount": "1280.00",
        },
    )
    assert create_response.status_code == 201
    assert create_response.json()["data"]["ledger_period"] == "2026-09"

    ledgers_response = client.get(f"/api/ledgers?store_id={store_id}&period=2026-09")
    assert ledgers_response.status_code == 200
    ledgers = ledgers_response.json()["data"]["items"]
    assert len(ledgers) == 1
    assert ledgers[0]["status"] == "open"


def test_revenue_record_rejects_ledger_period_that_does_not_match_revenue_date(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入账期校验店"}).json()["data"]["id"]
    client.post("/api/revenue-channels", json={"name": "现金收入", "requires_bank_match": False})

    response = client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-09-02",
            "channel": "现金收入",
            "gross_amount": "100.00",
            "net_amount": "100.00",
        },
    )
    assert response.status_code == 422


def test_update_revenue_record_can_move_to_month_and_create_target_ledger(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入改账期店"}).json()["data"]["id"]
    client.post("/api/revenue-channels", json={"name": "团购收入", "requires_bank_match": False})
    record_id = client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "revenue_date": "2026-08-20",
            "channel": "团购收入",
            "gross_amount": "300.00",
            "net_amount": "300.00",
        },
    ).json()["data"]["id"]

    update_response = client.patch(
        f"/api/revenue-records/{record_id}",
        json={"revenue_date": "2026-09-01"},
    )
    assert update_response.status_code == 200
    assert update_response.json()["data"]["ledger_period"] == "2026-09"
    assert client.get(f"/api/ledgers?store_id={store_id}&period=2026-09").json()["data"]["total"] == 1


def test_revenue_record_requires_open_ledger(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入封账店"}).json()["data"]["id"]
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
    client.post("/api/revenue-channels", json={"name": "现金", "requires_bank_match": False})
    client.post(f"/api/ledgers/{ledger_id}/close", json={"operator": "tester"})

    response = client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "现金",
            "gross_amount": "100.00",
            "net_amount": "100.00",
        },
    )
    assert response.status_code == 409


def test_ledger_close_check_warns_when_revenue_is_missing(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说无收入提示店"}).json()["data"]["id"]
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]

    check_response = client.get(f"/api/ledgers/{ledger_id}/close-check")
    assert check_response.status_code == 200
    check = check_response.json()["data"]
    assert check["can_close"] is True
    assert check["revenue_record_count"] == 0
    assert check["warnings"] == ["当前账期没有营业收入记录"]


def test_revenue_records_respect_user_store_scope(client: TestClient) -> None:
    first_store_id = client.post("/api/stores", json={"name": "蘑说收入权限店 A"}).json()["data"]["id"]
    second_store_id = client.post("/api/stores", json={"name": "蘑说收入权限店 B"}).json()["data"]["id"]
    client.post("/api/revenue-channels", json={"name": "权限渠道", "requires_bank_match": False})
    for store_id, amount in [(first_store_id, "100.00"), (second_store_id, "200.00")]:
        client.post(
            "/api/revenue-records",
            json={
                "store_id": store_id,
                "revenue_date": "2026-08-20",
                "channel": "权限渠道",
                "gross_amount": amount,
                "net_amount": amount,
            },
        )
    client.post(
        "/api/users",
        json={
            "username": "revenue_limited",
            "display_name": "收入受限",
            "password": "secret123",
            "role": "finance",
            "permissions": ["revenue.view", "revenue.manage"],
            "store_ids": [first_store_id],
        },
    )

    login_response = client.post("/api/auth/login", json={"username": "revenue_limited", "password": "secret123"})
    assert login_response.status_code == 200

    list_response = client.get("/api/revenue-records?page_size=20")
    assert list_response.status_code == 200
    records = list_response.json()["data"]["items"]
    assert len(records) == 1
    assert records[0]["store_id"] == first_store_id

    forbidden_response = client.post(
        "/api/revenue-records",
        json={
            "store_id": second_store_id,
            "revenue_date": "2026-08-21",
            "channel": "权限渠道",
            "gross_amount": "300.00",
            "net_amount": "300.00",
        },
    )
    assert forbidden_response.status_code == 403


def test_revenue_channel_update_and_record_validation(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入渠道店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})

    channel_response = client.post(
        "/api/revenue-channels",
        json={"name": "抖音", "sort_order": 20, "requires_bank_match": True},
    )
    assert channel_response.status_code == 201
    channel_id = channel_response.json()["data"]["id"]

    update_response = client.patch(
        f"/api/revenue-channels/{channel_id}",
        json={"status": "inactive"},
    )
    assert update_response.status_code == 200
    assert update_response.json()["data"]["status"] == "inactive"

    record_response = client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "抖音",
            "gross_amount": "100.00",
            "net_amount": "98.00",
        },
    )
    assert record_response.status_code == 409

    logs = client.get("/api/audit-logs?resource_type=revenue_channel&page_size=20").json()["data"]["items"]
    assert any(log["action"] == "revenue_channel.create" and log["resource_id"] == channel_id for log in logs)
    assert any(log["action"] == "revenue_channel.update" and log["resource_id"] == channel_id for log in logs)


def test_revenue_match_confirms_income_bank_transaction(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入匹配店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post("/api/revenue-channels", json={"name": "美团", "sort_order": 10, "requires_bank_match": True})
    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "美团",
            "gross_amount": "1000.00",
            "net_amount": "970.00",
            "fee_amount": "30.00",
        },
    )
    bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-21T10:30:00",
            "direction": "income",
            "amount": "970.00",
            "counterparty_name": "美团",
        },
    ).json()["data"]["id"]

    match_response = client.post(
        "/api/matches/revenue",
        json={
            "bank_transaction_id": bank_id,
            "channel": "美团",
            "revenue_start_date": "2026-08-20",
            "revenue_end_date": "2026-08-20",
            "amount": "970.00",
            "confidence": "98.00",
            "reason": "实收金额一致",
        },
    )
    assert match_response.status_code == 201
    match_id = match_response.json()["data"]["id"]

    confirm_response = client.post(f"/api/matches/revenue/{match_id}/confirm?operator=tester")
    assert confirm_response.status_code == 200
    assert confirm_response.json()["data"]["status"] == "confirmed"

    bank_transaction = client.get(f"/api/bank-transactions?store_id={store_id}&direction=income").json()["data"]["items"][0]
    assert bank_transaction["matched_amount"] == "970.00"

    reject_response = client.post(f"/api/matches/revenue/{match_id}/reject")
    assert reject_response.status_code == 409

    logs = client.get("/api/audit-logs?resource_type=revenue_bank_match&page_size=20").json()["data"]["items"]
    assert any(log["action"] == "revenue_match.create" and log["resource_id"] == match_id for log in logs)
    assert any(log["action"] == "revenue_match.confirm" and log["resource_id"] == match_id for log in logs)


def test_revenue_match_candidate_blocks_ledger_close(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入封账阻断店"}).json()["data"]["id"]
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
    client.post("/api/revenue-channels", json={"name": "门店扫码", "sort_order": 30, "requires_bank_match": True})
    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "门店扫码",
            "gross_amount": "300.00",
            "net_amount": "300.00",
        },
    )
    bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-21T10:30:00",
            "direction": "income",
            "amount": "300.00",
        },
    ).json()["data"]["id"]
    client.post(
        "/api/matches/revenue",
        json={
            "bank_transaction_id": bank_id,
            "channel": "门店扫码",
            "revenue_start_date": "2026-08-20",
            "revenue_end_date": "2026-08-20",
            "amount": "300.00",
        },
    )

    check_response = client.get(f"/api/ledgers/{ledger_id}/close-check")
    assert check_response.status_code == 200
    check = check_response.json()["data"]
    assert check["can_close"] is False
    assert check["candidate_match_count"] == 1

    close_response = client.post(f"/api/ledgers/{ledger_id}/close", json={"operator": "tester"})
    assert close_response.status_code == 409


def test_revenue_match_requires_net_amount_and_income_direction(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入匹配校验店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post("/api/revenue-channels", json={"name": "抖音", "sort_order": 20, "requires_bank_match": True})
    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "抖音",
            "gross_amount": "200.00",
            "net_amount": "190.00",
            "fee_amount": "10.00",
        },
    )
    income_bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-21T10:30:00",
            "direction": "income",
            "amount": "190.00",
        },
    ).json()["data"]["id"]
    expense_bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-21T10:30:00",
            "direction": "expense",
            "amount": "190.00",
        },
    ).json()["data"]["id"]

    wrong_amount_response = client.post(
        "/api/matches/revenue",
        json={
            "bank_transaction_id": income_bank_id,
            "channel": "抖音",
            "revenue_start_date": "2026-08-20",
            "revenue_end_date": "2026-08-20",
            "amount": "200.00",
        },
    )
    assert wrong_amount_response.status_code == 409

    wrong_direction_response = client.post(
        "/api/matches/revenue",
        json={
            "bank_transaction_id": expense_bank_id,
            "channel": "抖音",
            "revenue_start_date": "2026-08-20",
            "revenue_end_date": "2026-08-20",
            "amount": "190.00",
        },
    )
    assert wrong_direction_response.status_code == 409
