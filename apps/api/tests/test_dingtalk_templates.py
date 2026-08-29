from fastapi.testclient import TestClient

from app.core.config import settings
from app.models import ApprovalInstance, ApprovalTemplate, DingTalkConfig


def test_sync_templates_and_upsert_mapping(client: TestClient) -> None:
    sync_response = client.post("/api/dingtalk/templates/sync")
    assert sync_response.status_code == 200
    assert sync_response.json()["data"]["created"] == 2

    templates_response = client.get("/api/dingtalk/templates")
    assert templates_response.status_code == 200
    templates = templates_response.json()["data"]["items"]
    assert len(templates) == 2
    template_id = templates[0]["id"]

    mapping_response = client.post(
        f"/api/dingtalk/templates/{template_id}/mappings",
        json={
            "standard_field": "amount",
            "source_field_id": "field-amount",
            "source_field_name": "金额",
            "source_path": "费用明细[].金额",
            "field_type": "MoneyField",
            "is_required": True,
            "sort_order": 30,
        },
    )
    assert mapping_response.status_code == 201
    assert mapping_response.json()["data"]["standard_field"] == "amount"

    mappings_response = client.get(f"/api/dingtalk/templates/{template_id}/mappings")
    assert mappings_response.status_code == 200
    assert mappings_response.json()["data"][0]["source_field_name"] == "金额"


def test_template_field_candidates_from_snapshot_and_instances(client: TestClient, session) -> None:
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-FIELDS", "name": "字段候选模板", "is_enabled": True},
    ).json()["data"]["id"]
    template = session.get(ApprovalTemplate, template_id)
    assert template is not None
    template.raw_snapshot = (
        '{"form_component_values":[{"id":"field-amount","name":"金额","componentType":"MoneyField"}]}'
    )
    session.add(
        ApprovalInstance(
            template_id=template_id,
            dingtalk_instance_id="instance-fields",
            approval_status="approved",
            raw_payload=(
                '{"form_component_values":['
                '{"id":"field-store","name":"门店","componentType":"TextField"},'
                '{"id":"field-amount","name":"金额","componentType":"MoneyField"}'
                "]}"
            ),
        )
    )
    session.commit()

    response = client.get(f"/api/dingtalk/templates/{template_id}/field-candidates")
    assert response.status_code == 200
    candidates = response.json()["data"]
    labels = {item["source_field_name"]: item for item in candidates}
    assert labels["金额"]["source_field_id"] == "field-amount"
    assert labels["金额"]["field_type"] == "MoneyField"
    assert labels["门店"]["source_field_id"] == "field-store"
    assert [item["source_field_name"] for item in candidates].count("金额") == 1


def test_start_approval_sync_creates_job_instance_and_expense(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说同步店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post("/api/dingtalk/templates/sync")

    response = client.post("/api/dingtalk/approval-sync", json={"started_by": "tester"})
    assert response.status_code == 201
    job = response.json()["data"]
    assert job["status"] == "succeeded"
    assert job["success_count"] == 2

    jobs_response = client.get("/api/dingtalk/sync-jobs")
    assert jobs_response.status_code == 200
    assert jobs_response.json()["data"]["total"] == 1

    instances_response = client.get("/api/dingtalk/approval-instances")
    assert instances_response.status_code == 200
    assert instances_response.json()["data"]["total"] == 2

    expense_response = client.get("/api/expense-items")
    assert expense_response.status_code == 200
    descriptions = [item["description"] for item in expense_response.json()["data"]["items"]]
    assert any("同步样例" in description for description in descriptions)


def test_dingtalk_config_encrypts_secret(client: TestClient, session) -> None:
    response = client.put(
        "/api/dingtalk/config",
        json={"corp_id": "ding-corp", "app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["app_secret_configured"] is True

    config = session.query(DingTalkConfig).first()
    assert config is not None
    assert config.app_secret_encrypted != "super-secret"
    assert not config.app_secret_encrypted.startswith("configured:")


def test_dingtalk_connection_test_uses_real_token_endpoint(client: TestClient, monkeypatch) -> None:
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self):
            return {"accessToken": "token-1234567890"}

    calls = []

    def fake_post(url, json, timeout):
        calls.append({"url": url, "json": json, "timeout": timeout})
        return FakeResponse()

    monkeypatch.setattr("app.modules.dingtalk.client.httpx.post", fake_post)
    response = client.post("/api/dingtalk/connection-test")
    assert response.status_code == 200
    assert response.json()["data"]["status"] == "ok"
    assert calls[0]["url"].endswith("/v1.0/oauth2/accessToken")
    assert calls[0]["json"] == {"appKey": "ding-app-key", "appSecret": "super-secret"}


def test_real_approval_sync_paginates_and_records_window(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    store_id = client.post("/api/stores", json={"name": "蘑说真实同步店"}).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-REAL", "name": "真实报销模板", "is_enabled": True},
    ).json()["data"]["id"]
    for standard_field, source_field_name in [
        ("store", "门店"),
        ("amount", "金额"),
        ("expense_date", "日期"),
        ("description", "说明"),
    ]:
        client.post(
            f"/api/dingtalk/templates/{template_id}/mappings",
            json={"standard_field": standard_field, "source_field_name": source_field_name},
        )

    class FakeDingTalkClient:
        def __init__(self) -> None:
            self.cursors: list[int] = []

        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            assert process_code == "PROC-REAL"
            assert size == 1
            self.cursors.append(cursor)
            if cursor == 0:
                return ["instance-1"], 1
            return ["instance-2"], None

        def get_process_instance(self, instance_id):
            return {
                "process_instance_id": instance_id,
                "business_id": f"NO-{instance_id}",
                "originator_user_name": "测试申请人",
                "originator_userid": "user-1",
                "status": "approved",
                "create_time": 1786752000000,
                "finish_time": 1786755600000,
                "form_component_values": [
                    {"name": "门店", "value": "蘑说真实同步店"},
                    {"name": "金额", "value": "66.00"},
                    {"name": "日期", "value": "2026-08-15"},
                    {"name": "说明", "value": f"真实同步 {instance_id}"},
                ],
            }

    fake_client = FakeDingTalkClient()

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: fake_client)
    response = client.post(
        "/api/dingtalk/approval-sync",
        json={
            "template_id": template_id,
            "started_by": "tester",
            "start_at": "2026-08-01T00:00:00",
            "end_at": "2026-08-31T23:59:59",
            "page_size": 1,
            "max_pages": 3,
        },
    )
    assert response.status_code == 201
    job = response.json()["data"]
    assert job["status"] == "succeeded"
    assert job["processed_count"] == 2
    assert job["success_count"] == 2
    assert job["next_cursor"] is None
    assert job["request_start_at"].startswith("2026-08-01")
    assert job["request_end_at"].startswith("2026-08-31")
    assert fake_client.cursors == [0, 1]

    expense_response = client.get(f"/api/expense-items?store_id={store_id}&ledger_period=2026-08&page_size=20")
    descriptions = [item["description"] for item in expense_response.json()["data"]["items"]]
    assert "真实同步 instance-1" in descriptions
    assert "真实同步 instance-2" in descriptions


def test_real_approval_sync_marks_failed_when_max_pages_reached(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-LIMIT", "name": "分页截断模板", "is_enabled": True},
    ).json()["data"]["id"]

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            return ["instance-1"], 1

        def get_process_instance(self, instance_id):
            return {
                "process_instance_id": instance_id,
                "business_id": "NO-LIMIT",
                "status": "approved",
                "create_time": 1786752000000,
                "form_component_values": [],
            }

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post(
        "/api/dingtalk/approval-sync",
        json={
            "template_id": template_id,
            "started_by": "tester",
            "page_size": 1,
            "max_pages": 1,
        },
    )
    assert response.status_code == 201
    job = response.json()["data"]
    assert job["status"] == "failed"
    assert job["next_cursor"] == "PROC-LIMIT:1"
    assert job["error_message"] == "DingTalk approval sync stopped at max_pages"


def test_resume_approval_sync_uses_saved_cursor(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    store_id = client.post("/api/stores", json={"name": "蘑说续跑店"}).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-RESUME", "name": "续跑报销模板", "is_enabled": True},
    ).json()["data"]["id"]
    for standard_field, source_field_name in [
        ("store", "门店"),
        ("amount", "金额"),
        ("expense_date", "日期"),
        ("description", "说明"),
    ]:
        client.post(
            f"/api/dingtalk/templates/{template_id}/mappings",
            json={"standard_field": standard_field, "source_field_name": source_field_name},
        )

    class FakeDingTalkClient:
        def __init__(self) -> None:
            self.cursors: list[int] = []

        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            self.cursors.append(cursor)
            if cursor == 0:
                return ["instance-1"], 1
            return ["instance-2"], None

        def get_process_instance(self, instance_id):
            return {
                "process_instance_id": instance_id,
                "business_id": f"NO-{instance_id}",
                "status": "approved",
                "create_time": 1786752000000,
                "form_component_values": [
                    {"name": "门店", "value": "蘑说续跑店"},
                    {"name": "金额", "value": "88.00"},
                    {"name": "日期", "value": "2026-08-15"},
                    {"name": "说明", "value": f"续跑同步 {instance_id}"},
                ],
            }

    fake_client = FakeDingTalkClient()
    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: fake_client)
    first_response = client.post(
        "/api/dingtalk/approval-sync",
        json={
            "template_id": template_id,
            "started_by": "tester",
            "start_at": "2026-08-01T00:00:00",
            "end_at": "2026-08-31T23:59:59",
            "page_size": 1,
            "max_pages": 1,
        },
    )
    first_job = first_response.json()["data"]
    assert first_job["status"] == "failed"
    assert first_job["next_cursor"] == "PROC-RESUME:1"

    resume_response = client.post(
        f"/api/dingtalk/sync-jobs/{first_job['id']}/resume",
        json={"started_by": "tester", "page_size": 1, "max_pages": 2},
    )
    assert resume_response.status_code == 201
    resume_job = resume_response.json()["data"]
    assert resume_job["status"] == "succeeded"
    assert resume_job["processed_count"] == 1
    assert resume_job["success_count"] == 1
    assert resume_job["next_cursor"] is None
    assert resume_job["request_start_at"].startswith("2026-08-01")
    assert resume_job["request_end_at"].startswith("2026-08-31")
    assert fake_client.cursors == [0, 1]

    expense_response = client.get(f"/api/expense-items?store_id={store_id}&ledger_period=2026-08&page_size=20")
    descriptions = [item["description"] for item in expense_response.json()["data"]["items"]]
    assert "续跑同步 instance-1" in descriptions
    assert "续跑同步 instance-2" in descriptions
