from datetime import timedelta

from fastapi.testclient import TestClient

from app.models import utc_now


def test_shareholder_token_can_read_authorized_reports(client: TestClient, anonymous_client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说股东授权店"}).json()["data"]["id"]
    other_store_id = client.post("/api/stores", json={"name": "蘑说未授权店"}).json()["data"]["id"]
    ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
    client.post(f"/api/ledgers/{ledger_id}/close", json={"operator": "tester"})
    client.post("/api/ledgers", json={"store_id": other_store_id, "period": "2026-08"})

    grant_response = client.post(
        "/api/shareholder-grants",
        json={"name": "测试股东", "access_code": "share123", "store_ids": [store_id]},
    )
    assert grant_response.status_code == 201

    anonymous_response = anonymous_client.get("/api/reports/store-summaries")
    assert anonymous_response.status_code == 401

    login_response = anonymous_client.post(
        "/api/shareholder-auth/login",
        json={"access_code": "share123"},
    )
    assert login_response.status_code == 200
    token = login_response.json()["data"]["token"]

    profile_response = anonymous_client.get(
        "/api/shareholder-auth/me",
        headers={"authorization": f"Bearer {token}"},
    )
    assert profile_response.status_code == 200
    assert profile_response.json()["data"]["name"] == "测试股东"
    assert profile_response.json()["data"]["store_ids"] == [store_id]

    reports_response = anonymous_client.get(
        "/api/reports/store-summaries",
        headers={"authorization": f"Bearer {token}"},
    )
    assert reports_response.status_code == 200
    reports = reports_response.json()["data"]
    assert len(reports) == 1
    assert reports[0]["store_id"] == store_id

    forbidden_response = anonymous_client.get(
        f"/api/reports/ledger-summary?store_id={other_store_id}&period=2026-08",
        headers={"authorization": f"Bearer {token}"},
    )
    assert forbidden_response.status_code == 403


def test_admin_only_can_manage_shareholder_grants(client: TestClient, anonymous_client: TestClient) -> None:
    response = anonymous_client.get("/api/shareholder-grants")
    assert response.status_code == 401

    admin_response = client.get("/api/shareholder-grants")
    assert admin_response.status_code == 200


def test_expired_shareholder_grant_cannot_login(client: TestClient, anonymous_client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说过期授权店"}).json()["data"]["id"]
    expires_at = (utc_now() - timedelta(days=1)).isoformat()

    grant_response = client.post(
        "/api/shareholder-grants",
        json={
            "name": "过期股东",
            "access_code": "expired123",
            "store_ids": [store_id],
            "expires_at": expires_at,
        },
    )
    assert grant_response.status_code == 201
    assert grant_response.json()["data"]["expires_at"] is not None

    login_response = anonymous_client.post(
        "/api/shareholder-auth/login",
        json={"access_code": "expired123"},
    )
    assert login_response.status_code == 401


def test_shareholder_token_is_rejected_after_grant_expires(client: TestClient, anonymous_client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说授权失效店"}).json()["data"]["id"]
    grant_id = client.post(
        "/api/shareholder-grants",
        json={"name": "即将失效股东", "access_code": "expirelater123", "store_ids": [store_id]},
    ).json()["data"]["id"]
    token = anonymous_client.post(
        "/api/shareholder-auth/login",
        json={"access_code": "expirelater123"},
    ).json()["data"]["token"]

    update_response = client.patch(
        f"/api/shareholder-grants/{grant_id}",
        json={"expires_at": (utc_now() - timedelta(minutes=1)).isoformat()},
    )
    assert update_response.status_code == 200

    profile_response = anonymous_client.get(
        "/api/shareholder-auth/me",
        headers={"authorization": f"Bearer {token}"},
    )
    assert profile_response.status_code == 401


def test_shareholder_reports_only_include_closed_ledgers(
    client: TestClient,
    anonymous_client: TestClient,
) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说封账展示店"}).json()["data"]["id"]
    closed_ledger_id = client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"}).json()["data"]["id"]
    client.post(f"/api/ledgers/{closed_ledger_id}/close", json={"operator": "tester"})
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-09"})
    client.post(
        "/api/shareholder-grants",
        json={"name": "封账股东", "access_code": "closed123", "store_ids": [store_id]},
    )
    token = anonymous_client.post(
        "/api/shareholder-auth/login",
        json={"access_code": "closed123"},
    ).json()["data"]["token"]
    headers = {"authorization": f"Bearer {token}"}

    summaries_response = anonymous_client.get("/api/reports/store-summaries", headers=headers)
    assert summaries_response.status_code == 200
    summaries = summaries_response.json()["data"]
    assert len(summaries) == 1
    assert summaries[0]["period"] == "2026-08"
    assert summaries[0]["ledger_status"] == "closed"

    periods_response = anonymous_client.get(
        f"/api/reports/ledger-periods?store_id={store_id}",
        headers=headers,
    )
    assert periods_response.status_code == 200
    assert [item["period"] for item in periods_response.json()["data"]] == ["2026-08"]

    report_periods_response = anonymous_client.get("/api/reports/periods", headers=headers)
    assert report_periods_response.status_code == 200
    assert report_periods_response.json()["data"] == [{"period": "2026-08", "store_count": 1}]

    open_detail_response = anonymous_client.get(
        f"/api/reports/ledger-detail?store_id={store_id}&period=2026-09",
        headers=headers,
    )
    assert open_detail_response.status_code == 403

    admin_periods_response = client.get(f"/api/reports/ledger-periods?store_id={store_id}")
    assert admin_periods_response.status_code == 200
    assert [item["period"] for item in admin_periods_response.json()["data"]] == ["2026-09", "2026-08"]

    admin_report_periods_response = client.get("/api/reports/periods")
    assert admin_report_periods_response.status_code == 200
    assert admin_report_periods_response.json()["data"] == [
        {"period": "2026-09", "store_count": 1},
        {"period": "2026-08", "store_count": 1},
    ]

    trends_response = anonymous_client.get(
        f"/api/reports/ledger-trends?store_id={store_id}",
        headers=headers,
    )
    assert trends_response.status_code == 200
    trends = trends_response.json()["data"]
    assert len(trends) == 1
    assert [item["period"] for item in trends[0]["items"]] == ["2026-08"]

    admin_trends_response = client.get(f"/api/reports/ledger-trends?store_id={store_id}")
    assert admin_trends_response.status_code == 200
    assert [item["period"] for item in admin_trends_response.json()["data"][0]["items"]] == [
        "2026-08",
        "2026-09",
    ]


def test_store_comparison_filters_shareholder_scope(client: TestClient, anonymous_client: TestClient) -> None:
    store_a = client.post("/api/stores", json={"name": "蘑说对比 A 店"}).json()["data"]["id"]
    store_b = client.post("/api/stores", json={"name": "蘑说对比 B 店"}).json()["data"]["id"]
    ledger_a = client.post("/api/ledgers", json={"store_id": store_a, "period": "2026-08"}).json()["data"]["id"]
    ledger_b = client.post("/api/ledgers", json={"store_id": store_b, "period": "2026-08"}).json()["data"]["id"]
    client.post("/api/revenue-channels", json={"name": "对比现金", "requires_bank_match": False})
    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_a,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-01",
            "channel": "对比现金",
            "gross_amount": "1000.00",
            "net_amount": "1000.00",
            "fee_amount": "0.00",
        },
    )
    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_b,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-01",
            "channel": "对比现金",
            "gross_amount": "2000.00",
            "net_amount": "2000.00",
            "fee_amount": "0.00",
        },
    )
    close_a_response = client.post(f"/api/ledgers/{ledger_a}/close", json={"operator": "tester"})
    close_b_response = client.post(f"/api/ledgers/{ledger_b}/close", json={"operator": "tester"})
    assert close_a_response.status_code == 200
    assert close_b_response.status_code == 200
    client.post(
        "/api/shareholder-grants",
        json={"name": "对比股东", "access_code": "compare123", "store_ids": [store_a]},
    )
    token = anonymous_client.post(
        "/api/shareholder-auth/login",
        json={"access_code": "compare123"},
    ).json()["data"]["token"]

    admin_response = client.get("/api/reports/store-comparison?period=2026-08")
    assert admin_response.status_code == 200
    admin_data = admin_response.json()["data"]
    assert admin_data["total_income_amount"] == "3000.00"
    assert [item["store_name"] for item in admin_data["items"]] == ["蘑说对比 B 店", "蘑说对比 A 店"]

    shareholder_response = anonymous_client.get(
        "/api/reports/store-comparison?period=2026-08",
        headers={"authorization": f"Bearer {token}"},
    )
    assert shareholder_response.status_code == 200
    shareholder_data = shareholder_response.json()["data"]
    assert shareholder_data["total_income_amount"] == "1000.00"
    assert [item["store_id"] for item in shareholder_data["items"]] == [store_a]
