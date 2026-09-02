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
    assert report["revenue_channel_breakdown"][0] == {
        "channel": "美团",
        "gross_amount": "1100.00",
        "net_amount": "1060.00",
        "fee_amount": "40.00",
        "fee_rate": "3.64",
        "matched_amount": "0.00",
        "unmatched_amount": "1060.00",
        "reconciliation_rate": "0.00",
        "record_count": 1,
    }

    csv_response = client.get(f"/api/reports/ledger-detail.csv?store_id={store_id}&period=2026-08")
    assert csv_response.status_code == 200
    assert "营业收入" in csv_response.text
    assert "收入渠道汇总" in csv_response.text
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


def test_ledger_close_check_blocks_required_revenue_without_bank_match(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入未对账封账店"}).json()["data"]["id"]
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
    client.post(
        "/api/revenue-channels",
        json={"name": "封账扫码收入", "sort_order": 40, "requires_bank_match": True},
    )
    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "封账扫码收入",
            "gross_amount": "1000.00",
            "net_amount": "970.00",
            "fee_amount": "30.00",
        },
    )

    check_response = client.get(f"/api/ledgers/{ledger_id}/close-check")
    assert check_response.status_code == 200
    check = check_response.json()["data"]
    assert check["can_close"] is False
    assert check["unmatched_revenue_record_count"] == 1
    assert check["unmatched_revenue_amount"] == "970.00"
    assert any("营业收入未关联银行流水" in issue for issue in check["issues"])

    close_response = client.post(f"/api/ledgers/{ledger_id}/close", json={"operator": "tester"})
    assert close_response.status_code == 409


def test_ledger_close_check_ignores_revenue_channel_without_bank_match_requirement(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说现金收入封账店"}).json()["data"]["id"]
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
    client.post(
        "/api/revenue-channels",
        json={"name": "封账现金收入", "sort_order": 41, "requires_bank_match": False},
    )
    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "封账现金收入",
            "gross_amount": "100.00",
            "net_amount": "100.00",
        },
    )

    check_response = client.get(f"/api/ledgers/{ledger_id}/close-check")
    assert check_response.status_code == 200
    check = check_response.json()["data"]
    assert check["can_close"] is True
    assert check["unmatched_revenue_record_count"] == 0
    assert check["unmatched_revenue_amount"] == "0.00"


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
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
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

    report = client.get(f"/api/reports/ledger-detail?store_id={store_id}&period=2026-08").json()["data"]
    assert report["revenue_channel_breakdown"][0]["matched_amount"] == "970.00"
    assert report["revenue_channel_breakdown"][0]["unmatched_amount"] == "0.00"
    assert report["revenue_channel_breakdown"][0]["reconciliation_rate"] == "100.00"

    check = client.get(f"/api/ledgers/{ledger_id}/close-check").json()["data"]
    assert check["unmatched_revenue_record_count"] == 0
    assert check["unmatched_revenue_amount"] == "0.00"

    reject_response = client.post(f"/api/matches/revenue/{match_id}/reject")
    assert reject_response.status_code == 409

    logs = client.get("/api/audit-logs?resource_type=revenue_bank_match&page_size=20").json()["data"]["items"]
    assert any(log["action"] == "revenue_match.create" and log["resource_id"] == match_id for log in logs)
    assert any(log["action"] == "revenue_match.confirm" and log["resource_id"] == match_id for log in logs)


def test_one_income_bank_transaction_matches_multiple_revenue_records(
    client: TestClient,
) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入多记录匹配店"}).json()["data"]["id"]
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
    client.post(
        "/api/revenue-channels",
        json={"name": "多记录渠道", "sort_order": 10, "requires_bank_match": True},
    )

    record_ids = []
    for date_value, amount in (("2026-08-01", "60.00"), ("2026-08-03", "20.00"), ("2026-08-05", "40.00")):
        response = client.post(
            "/api/revenue-records",
            json={
                "store_id": store_id,
                "ledger_period": "2026-08",
                "revenue_date": date_value,
                "channel": "多记录渠道",
                "gross_amount": amount,
                "net_amount": amount,
            },
        )
        assert response.status_code == 201
        record_ids.append(response.json()["data"]["id"])

    bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-06T10:30:00",
            "direction": "income",
            "amount": "100.00",
        },
    ).json()["data"]["id"]
    match_response = client.post(
        "/api/matches/revenue",
        json={
            "bank_transaction_id": bank_id,
            "channel": "多记录渠道",
            "revenue_start_date": "2026-08-01",
            "revenue_end_date": "2026-08-05",
            "revenue_record_ids": [record_ids[0], record_ids[2]],
            "amount": "100.00",
        },
    )
    assert match_response.status_code == 201
    match = match_response.json()["data"]
    assert set(match["revenue_record_ids"]) == {record_ids[0], record_ids[2]}

    confirm_response = client.post(f"/api/matches/revenue/{match['id']}/confirm?operator=tester")
    assert confirm_response.status_code == 200
    assert set(confirm_response.json()["data"]["revenue_record_ids"]) == {record_ids[0], record_ids[2]}

    bank = client.get(f"/api/bank-transactions?store_id={store_id}&direction=income").json()["data"]["items"]
    assert bank[0]["matched_amount"] == "100.00"

    matches = client.get(
        f"/api/matches/revenue?store_id={store_id}&ledger_period=2026-08&page_size=20"
    ).json()["data"]["items"]
    assert len(matches) == 1
    assert set(matches[0]["revenue_record_ids"]) == {record_ids[0], record_ids[2]}

    close_check = client.get(f"/api/ledgers/{ledger_id}/close-check").json()["data"]
    assert close_check["unmatched_revenue_record_count"] == 1
    assert close_check["unmatched_revenue_amount"] == "20.00"


def test_one_income_bank_transaction_matches_revenue_records_across_channels(
    client: TestClient,
) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入跨渠道匹配店"}).json()["data"]["id"]
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
    for channel in ("跨渠道美团", "跨渠道抖音"):
        client.post(
            "/api/revenue-channels",
            json={"name": channel, "sort_order": 10, "requires_bank_match": True},
        )

    record_ids = []
    for date_value, channel, amount in (
        ("2026-08-01", "跨渠道美团", "60.00"),
        ("2026-08-02", "跨渠道抖音", "40.00"),
    ):
        response = client.post(
            "/api/revenue-records",
            json={
                "store_id": store_id,
                "ledger_period": "2026-08",
                "revenue_date": date_value,
                "channel": channel,
                "gross_amount": amount,
                "net_amount": amount,
            },
        )
        assert response.status_code == 201
        record_ids.append(response.json()["data"]["id"])

    bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-03T10:30:00",
            "direction": "income",
            "amount": "100.00",
        },
    ).json()["data"]["id"]

    match_response = client.post(
        "/api/matches/revenue/batch?operator=tester",
        json={
            "bank_transaction_id": bank_id,
            "revenue_record_ids": record_ids,
            "amount": "100.00",
        },
    )
    assert match_response.status_code == 201
    matches = match_response.json()["data"]
    assert len(matches) == 2
    assert {match["channel"] for match in matches} == {"跨渠道美团", "跨渠道抖音"}
    assert all(match["status"] == "confirmed" for match in matches)
    assert {record_id for match in matches for record_id in match["revenue_record_ids"]} == set(record_ids)

    bank = client.get(f"/api/bank-transactions?store_id={store_id}&direction=income").json()["data"]["items"]
    assert bank[0]["matched_amount"] == "100.00"

    listed_matches = client.get(
        f"/api/matches/revenue?store_id={store_id}&ledger_period=2026-08&page_size=20"
    ).json()["data"]["items"]
    assert len(listed_matches) == 2
    assert {record_id for match in listed_matches for record_id in match["revenue_record_ids"]} == set(record_ids)

    close_check = client.get(f"/api/ledgers/{ledger_id}/close-check").json()["data"]
    assert close_check["unmatched_revenue_record_count"] == 0
    assert close_check["unmatched_revenue_amount"] == "0.00"


def test_list_revenue_matches_filters_by_store_and_period(client: TestClient) -> None:
    store_a = client.post("/api/stores", json={"name": "蘑说收入匹配筛选店 A"}).json()["data"]["id"]
    store_b = client.post("/api/stores", json={"name": "蘑说收入匹配筛选店 B"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_a, "period": "2026-08"})
    client.post("/api/ledgers", json={"store_id": store_b, "period": "2026-08"})
    client.post("/api/revenue-channels", json={"name": "筛选渠道", "sort_order": 10, "requires_bank_match": True})
    for store_id, amount in ((store_a, "88.00"), (store_b, "99.00")):
        client.post(
            "/api/revenue-records",
            json={
                "store_id": store_id,
                "ledger_period": "2026-08",
                "revenue_date": "2026-08-20",
                "channel": "筛选渠道",
                "gross_amount": amount,
                "net_amount": amount,
            },
        )
        bank_id = client.post(
            "/api/bank-transactions",
            json={
                "store_id": store_id,
                "ledger_period": "2026-08",
                "occurred_at": "2026-08-21T10:30:00",
                "direction": "income",
                "amount": amount,
            },
        ).json()["data"]["id"]
        client.post(
            "/api/matches/revenue",
            json={
                "bank_transaction_id": bank_id,
                "channel": "筛选渠道",
                "revenue_start_date": "2026-08-20",
                "revenue_end_date": "2026-08-20",
                "amount": amount,
            },
        )

    response = client.get(f"/api/matches/revenue?store_id={store_a}&ledger_period=2026-08&page_size=20")
    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert len(items) == 1
    assert items[0]["amount"] == "88.00"


def test_revenue_match_rejects_overlapping_revenue_range(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说收入重复匹配店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post("/api/revenue-channels", json={"name": "重复渠道", "sort_order": 10, "requires_bank_match": True})
    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "重复渠道",
            "gross_amount": "100.00",
            "net_amount": "100.00",
        },
    )
    first_bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-21T10:30:00",
            "direction": "income",
            "amount": "100.00",
        },
    ).json()["data"]["id"]
    second_bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-22T10:30:00",
            "direction": "income",
            "amount": "100.00",
        },
    ).json()["data"]["id"]
    payload = {
        "channel": "重复渠道",
        "revenue_start_date": "2026-08-20",
        "revenue_end_date": "2026-08-20",
        "amount": "100.00",
    }
    assert client.post("/api/matches/revenue", json={**payload, "bank_transaction_id": first_bank_id}).status_code == 201

    duplicate_response = client.post("/api/matches/revenue", json={**payload, "bank_transaction_id": second_bank_id})
    assert duplicate_response.status_code == 409
    assert duplicate_response.json()["detail"] == "Revenue records already matched for selected range"


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
