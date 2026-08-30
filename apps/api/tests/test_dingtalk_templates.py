from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import settings
from app.models import ApprovalInstance, ApprovalTemplate, DingTalkConfig, ExpenseItem, SyncJob
from app.modules.dingtalk.client import DingTalkClientError


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
            "display_label": "报销金额",
            "source_path": "费用明细[].金额",
            "field_type": "MoneyField",
            "show_in_list": True,
            "show_in_detail": True,
            "is_required": True,
            "sort_order": 30,
        },
    )
    assert mapping_response.status_code == 201
    assert mapping_response.json()["data"]["standard_field"] == "amount"
    assert mapping_response.json()["data"]["display_label"] == "报销金额"
    assert mapping_response.json()["data"]["show_in_list"] is True

    mappings_response = client.get(f"/api/dingtalk/templates/{template_id}/mappings")
    assert mappings_response.status_code == 200
    assert mappings_response.json()["data"][0]["source_field_name"] == "金额"
    assert mappings_response.json()["data"][0]["show_in_detail"] is True

    mapping_id = mappings_response.json()["data"][0]["id"]
    update_response = client.patch(
        f"/api/dingtalk/templates/{template_id}/mappings/{mapping_id}",
        json={
            "standard_field": "amount",
            "source_field_id": "field-amount",
            "source_field_name": "金额",
            "display_label": "付款金额",
            "source_path": "费用明细[].金额",
            "field_type": "MoneyField",
            "show_in_list": False,
            "show_in_detail": True,
            "is_required": True,
            "sort_order": 30,
        },
    )
    assert update_response.status_code == 200
    assert update_response.json()["data"]["display_label"] == "付款金额"
    assert update_response.json()["data"]["show_in_list"] is False

    delete_response = client.delete(f"/api/dingtalk/templates/{template_id}/mappings/{mapping_id}")
    assert delete_response.status_code == 200
    assert delete_response.json()["data"]["ok"] is True
    assert client.get(f"/api/dingtalk/templates/{template_id}/mappings").json()["data"] == []


def test_reorder_template_mappings(client: TestClient) -> None:
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-REORDER", "name": "字段排序模板", "is_enabled": True},
    ).json()["data"]["id"]
    first = client.post(
        f"/api/dingtalk/templates/{template_id}/mappings",
        json={
            "standard_field": "display:first",
            "source_field_name": "第一个字段",
            "display_label": "第一个",
            "sort_order": 0,
        },
    ).json()["data"]
    second = client.post(
        f"/api/dingtalk/templates/{template_id}/mappings",
        json={
            "standard_field": "display:second",
            "source_field_name": "第二个字段",
            "display_label": "第二个",
            "sort_order": 1,
        },
    ).json()["data"]

    response = client.post(
        f"/api/dingtalk/templates/{template_id}/mappings/reorder",
        json={"items": [{"id": second["id"], "sort_order": 0}, {"id": first["id"], "sort_order": 1}]},
    )
    assert response.status_code == 200
    assert [item["id"] for item in response.json()["data"]] == [second["id"], first["id"]]

    mappings = client.get(f"/api/dingtalk/templates/{template_id}/mappings").json()["data"]
    assert [item["id"] for item in mappings] == [second["id"], first["id"]]

    incomplete = client.post(
        f"/api/dingtalk/templates/{template_id}/mappings/reorder",
        json={"items": [{"id": second["id"], "sort_order": 0}]},
    )
    assert incomplete.status_code == 404

    duplicate = client.post(
        f"/api/dingtalk/templates/{template_id}/mappings/reorder",
        json={"items": [{"id": second["id"], "sort_order": 0}, {"id": second["id"], "sort_order": 1}]},
    )
    assert duplicate.status_code == 400


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
                '{"business_id":"NO-FIELDS","title":"测试提交的字段候选","status":"COMPLETED",'
                '"create_time":"2026-08-29 10:00:00","originator_dept_name":"门店运营部-测试店",'
                '"form_component_values":['
                '{"id":"field-store","name":"门店","componentType":"TextField","value":"菌山集开平东汇城店"},'
                '{"id":"field-amount","name":"金额","componentType":"MoneyField","value":"350"},'
                '{"id":"table-expense","name":"表格","componentType":"TableField","value":"'
                '[{\\"rowValue\\":['
                '{\\"key\\":\\"field-detail\\",\\"label\\":\\"支出详情\\",\\"componentType\\":\\"TextField\\",\\"value\\":\\"灭火毯\\"},'
                '{\\"key\\":\\"field-line-amount\\",\\"label\\":\\"小项金额\\",\\"componentType\\":\\"NumberField\\",\\"value\\":\\"76\\"}'
                ']}]"}'
                "]}"
            ),
        )
    )
    session.commit()

    response = client.get(f"/api/dingtalk/templates/{template_id}/field-candidates")
    assert response.status_code == 200
    candidates = response.json()["data"]
    labels = {item["source_field_name"]: item for item in candidates}
    assert labels["审批编号"]["source_path"] == "root:business_id"
    assert labels["审批编号"]["sample_value"] == "NO-FIELDS"
    assert labels["审批标题"]["sample_value"] == "测试提交的字段候选"
    assert labels["发起部门"]["sample_value"] == "门店运营部-测试店"
    assert labels["金额"]["source_field_id"] == "field-amount"
    assert labels["金额"]["field_type"] == "MoneyField"
    assert labels["金额"]["sample_value"] == "350"
    assert labels["门店"]["source_field_id"] == "field-store"
    assert labels["门店"]["sample_value"] == "菌山集开平东汇城店"
    assert labels["表格.支出详情"]["source_field_id"] == "field-detail"
    assert labels["表格.支出详情"]["source_path"] == "table:table-expense:field-detail"
    assert labels["表格.支出详情"]["sample_value"] == "灭火毯"
    assert labels["表格.小项金额"]["source_field_id"] == "field-line-amount"
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


def test_real_approval_sync_keeps_resume_cursor_when_max_pages_reached(client: TestClient, monkeypatch) -> None:
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
    assert job["status"] == "succeeded"
    assert job["next_cursor"] == "PROC-LIMIT:1"
    assert job["error_message"] == "DingTalk approval sync paused at max_pages; resume is available"


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
    assert first_job["status"] == "succeeded"
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


def test_department_pull_preview_and_sync_creates_store(client: TestClient, monkeypatch) -> None:
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )

    class FakeDingTalkClient:
        def __init__(self) -> None:
            self.departments = {
                "1": [
                    {"dept_id": 10, "name": "门店运营部", "parent_id": 1},
                    {"dept_id": 20, "name": "财务部", "parent_id": 1},
                ],
                "10": [{"dept_id": 11, "name": "江门区", "parent_id": 10}],
                "11": [{"dept_id": 12, "name": "蘑说测试店", "parent_id": 11}],
                "12": [
                    {"dept_id": 13, "name": "前厅部门", "parent_id": 12},
                    {"dept_id": 14, "name": "后厨部门", "parent_id": 12},
                ],
                "13": [],
                "14": [],
                "20": [],
            }

        def list_child_departments(self, dept_id):
            return self.departments.get(str(dept_id), [])

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())

    empty_preview_response = client.get("/api/dingtalk/departments/sync-preview")
    assert empty_preview_response.status_code == 200
    assert empty_preview_response.json()["data"]["candidate_count"] == 0

    pull_response = client.post("/api/dingtalk/departments/pull?root_dept_id=1&max_depth=4")
    assert pull_response.status_code == 200
    pull_result = pull_response.json()["data"]
    assert pull_result["pulled_count"] == 6
    assert pull_result["created_count"] == 6
    assert pull_result["candidate_count"] == 1

    list_response = client.get("/api/dingtalk/departments")
    assert list_response.status_code == 200
    assert len(list_response.json()["data"]) == 6

    preview_response = client.get("/api/dingtalk/departments/sync-preview")
    assert preview_response.status_code == 200
    preview = preview_response.json()["data"]
    assert preview["candidate_count"] == 1
    assert preview["create_count"] == 1
    candidates = [item for item in preview["departments"] if item["is_store_candidate"]]
    assert candidates[0]["name"] == "蘑说测试店"

    sync_response = client.post("/api/dingtalk/departments/sync")
    assert sync_response.status_code == 200
    result = sync_response.json()["data"]
    assert result["created_count"] == 1
    assert result["stores"][0]["name"] == "蘑说测试店"
    assert result["stores"][0]["dingtalk_dept_id"] == "12"

    preview_after_sync = client.get("/api/dingtalk/departments/sync-preview").json()["data"]
    candidate = next(item for item in preview_after_sync["departments"] if item["is_store_candidate"])
    assert candidate["store_name"] == "蘑说测试店"


def test_real_approval_sync_skips_existing_instances(client: TestClient, session, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-SKIP", "name": "跳过已有审批", "is_enabled": True},
    ).json()["data"]["id"]
    session.add(
        ApprovalInstance(
            template_id=template_id,
            dingtalk_instance_id="existing-instance",
            approval_status="agree",
        )
    )
    session.commit()

    get_calls = []

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            return ["existing-instance", "new-instance"], None

        def get_process_instance(self, instance_id):
            get_calls.append(instance_id)
            return {
                "process_instance_id": instance_id,
                "business_id": "NO-SKIP",
                "status": "COMPLETED",
                "result": "agree",
                "create_time": "2026-08-29 23:28:54",
            }

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post(
        "/api/dingtalk/approval-sync",
        json={
            "template_id": template_id,
            "started_by": "tester",
            "start_at": "2026-08-01T00:00:00",
            "end_at": "2026-08-31T23:59:59",
            "skip_existing": True,
        },
    )
    assert response.status_code == 201
    assert get_calls == ["new-instance"]
    assert '"skipped_existing_count": 1' in response.json()["data"]["raw_summary"]


def test_real_approval_sync_returns_failed_job_on_dingtalk_error(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-ERROR", "name": "钉钉错误审批", "is_enabled": True},
    ).json()["data"]["id"]

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            raise DingTalkClientError("时间戳无效")

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post(
        "/api/dingtalk/approval-sync",
        json={
            "template_id": template_id,
            "started_by": "tester",
            "start_at": "2026-08-01T00:00:00",
            "end_at": "2026-08-31T23:59:59",
        },
    )
    assert response.status_code == 201
    job = response.json()["data"]
    assert job["status"] == "failed"
    assert job["failed_count"] == 1
    assert job["error_message"] == "时间戳无效"


def test_pull_template_sample_approval_only_persists_raw_instance(client: TestClient, session, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-SAMPLE", "name": "样例字段模板", "is_enabled": True},
    ).json()["data"]["id"]
    calls = []

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            calls.append((process_code, cursor, size))
            return ["sample-instance"], None

        def get_process_instance(self, instance_id):
            return {
                "process_instance_id": instance_id,
                "business_id": "NO-SAMPLE",
                "originator_user_name": "测试申请人",
                "status": "COMPLETED",
                "result": "agree",
                "create_time": "2026-08-29 23:28:54",
                "form_component_values": [
                    {"id": "field-store", "name": "支出门店", "componentType": "TextField", "value": "测试门店"},
                    {"id": "field-amount", "name": "汇总金额（元）", "componentType": "MoneyField", "value": "350"},
                ],
            }

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post(f"/api/dingtalk/templates/{template_id}/sample-approval")
    assert response.status_code == 200
    result = response.json()["data"]
    assert result["pulled_count"] == 1
    assert result["instance"]["dingtalk_instance_id"] == "sample-instance"
    assert {item["source_field_name"] for item in result["field_candidates"]} >= {"支出门店", "汇总金额（元）"}
    assert calls == [("PROC-SAMPLE", 0, 1)]
    assert session.scalar(select(SyncJob)) is None
    assert session.scalar(select(ExpenseItem)) is None


def test_pull_template_sample_approval_rejects_seed_template_in_real_mode(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "seed-expense-approval", "name": "门店费用报销", "is_enabled": True},
    ).json()["data"]["id"]

    response = client.post(f"/api/dingtalk/templates/{template_id}/sample-approval")
    assert response.status_code == 409
    assert "本地演示模板" in response.json()["detail"]


def test_select_approval_instance_as_field_candidate_sample(client: TestClient, session) -> None:
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-SAMPLE-SOURCE", "name": "样例来源模板", "is_enabled": True},
    ).json()["data"]["id"]
    first = ApprovalInstance(
        template_id=template_id,
        dingtalk_instance_id="first-source",
        approval_status="approved",
        raw_payload='{"form_component_values":[{"id":"first-field","name":"旧字段","componentType":"TextField","value":"旧值"}]}',
    )
    second = ApprovalInstance(
        template_id=template_id,
        dingtalk_instance_id="second-source",
        approval_status="approved",
        raw_payload='{"form_component_values":[{"id":"second-field","name":"新字段","componentType":"TextField","value":"新值"}]}',
    )
    session.add_all([first, second])
    session.commit()

    response = client.post(
        f"/api/dingtalk/templates/{template_id}/field-candidate-sample",
        json={"approval_instance_id": first.id},
    )
    assert response.status_code == 200
    names = {item["source_field_name"] for item in response.json()["data"]["field_candidates"]}
    assert names == {"旧字段"}


def test_real_approval_sync_persists_instance_when_expense_parse_is_incomplete(
    client: TestClient,
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-INCOMPLETE", "name": "缺字段审批", "is_enabled": True},
    ).json()["data"]["id"]

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            return ["incomplete-instance"], None

        def get_process_instance(self, instance_id):
            return {
                "business_id": "NO-INCOMPLETE",
                "originator_user_name": "测试申请人",
                "status": "RUNNING",
                "create_time": "2026-08-29 23:28:54",
                "form_component_values": [{"name": "说明", "value": "缺少门店和金额"}],
            }

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post(
        "/api/dingtalk/approval-sync",
        json={
            "template_id": template_id,
            "started_by": "tester",
            "start_at": "2026-08-01T00:00:00",
            "end_at": "2026-08-31T23:59:59",
        },
    )
    assert response.status_code == 201
    job = response.json()["data"]
    assert job["status"] == "succeeded"
    assert job["success_count"] == 1
    assert job["failed_count"] == 0

    instances = client.get(f"/api/dingtalk/approval-instances?template_id={template_id}").json()["data"]["items"]
    assert len(instances) == 1
    assert instances[0]["dingtalk_instance_id"] == "incomplete-instance"
    assert '"expense_parse_status": "skipped"' in instances[0]["raw_payload"]


def test_real_approval_sync_creates_one_expense_per_approval_and_resolves_store_path(
    client: TestClient, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    store_id = client.post(
        "/api/stores",
        json={"name": "菌山集开平东汇城店", "dingtalk_dept_id": "1083312383"},
    ).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-TABLE", "name": "门店支出报销", "is_enabled": True},
    ).json()["data"]["id"]

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            return ["table-instance-1"], None

        def get_process_instance(self, instance_id):
            return {
                "process_instance_id": instance_id,
                "business_id": "NO-TABLE",
                "title": "安少辉提交的门店支出报销",
                "originator_dept_id": "1083312383",
                "originator_dept_name": "门店运营部-江门区-菌山集开平东汇城店",
                "status": "COMPLETED",
                "result": "agree",
                "create_time": "2026-08-29 23:28:54",
                "finish_time": "2026-08-30 10:00:00",
                "form_component_values": [
                    {"name": "报销日期", "value": "2026-08-29"},
                    {"name": "支出门店", "value": "门店运营部-江门区-菌山集开平东汇城店"},
                    {"name": "支出类型", "value": "门店零星报销"},
                    {"name": "汇总金额（元）", "value": "350"},
                    {"name": "收款账户", "value": "安少辉"},
                    {
                        "name": "表格",
                        "value": (
                            '[{"rowValue":['
                            '{"label":"支出详情","value":"消杀"},'
                            '{"label":"小项金额","value":"120"},'
                            '{"label":"报销凭证","value":"[\\"https://example.com/voucher.jpg\\"]"}'
                            ']},{"rowValue":['
                            '{"label":"支出详情","value":"维修"},'
                            '{"label":"小项金额","value":"230"}'
                            "]}]"
                        ),
                    },
                    {
                        "name": "报销凭证文档",
                        "value": '[{"spaceId":"space-1","fileId":"file-1","fileName":"凭证.xlsx"}]',
                    },
                ],
            }

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post(
        "/api/dingtalk/approval-sync",
        json={
            "template_id": template_id,
            "started_by": "tester",
            "start_at": "2026-08-01T00:00:00",
            "end_at": "2026-08-31T23:59:59",
        },
    )
    assert response.status_code == 201
    assert response.json()["data"]["status"] == "succeeded"

    expense_response = client.get(f"/api/expense-items?store_id={store_id}&ledger_period=2026-08&page_size=20")
    items = expense_response.json()["data"]["items"]
    assert len(items) == 1
    assert items[0]["description"] == "安少辉提交的门店支出报销"
    assert items[0]["amount"] == "350.00"
    assert items[0]["category_l1"] == "门店零星报销"
    assert items[0]["payee_account"] == "安少辉"

    instances = client.get(f"/api/dingtalk/approval-instances?template_id={template_id}").json()["data"]["items"]
    assert instances[0]["store_id"] == store_id
    assert '"expense_row_count": 2' in instances[0]["raw_payload"]
    attachments = client.get(
        f"/api/attachments?resource_type=approval_instance&resource_id={instances[0]['id']}&page_size=20"
    ).json()["data"]["items"]
    assert {attachment["file_name"] for attachment in attachments} == {"voucher.jpg", "凭证.xlsx"}

    preview_response = client.get(f"/api/dingtalk/templates/{template_id}/parse-preview")
    assert preview_response.status_code == 200
    preview = preview_response.json()["data"]
    assert preview["can_create_expense"] is True
    assert preview["store_id"] == store_id
    assert preview["expense_row_count"] == 2
    assert preview["rows"][0]["description"] == "消杀"
    assert preview["rows"][0]["amount"] == "120.00"
    assert preview["rows"][1]["description"] == "维修"
    assert preview["rows"][1]["amount"] == "230.00"
    assert preview["voucher_count"] == 2

    reparse_response = client.post(
        f"/api/dingtalk/templates/{template_id}/reparse",
        json={"instance_id": instances[0]["id"], "limit": 10, "started_by": "tester"},
    )
    assert reparse_response.status_code == 200
    reparse = reparse_response.json()["data"]
    assert reparse["processed_count"] == 1
    assert reparse["reparsed_count"] == 1
    assert reparse["created_expense_count"] == 1


def test_disabled_template_cannot_be_selected_for_approval_sync(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "mock")
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-DISABLED", "name": "停用模板", "is_enabled": False},
    ).json()["data"]["id"]

    response = client.post("/api/dingtalk/approval-sync", json={"template_id": template_id})

    assert response.status_code == 404
    assert response.json()["detail"] == "No enabled approval templates"


def test_template_enabled_status_can_be_updated(client: TestClient) -> None:
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-ENABLE-TOGGLE", "name": "启停模板", "is_enabled": True},
    ).json()["data"]["id"]

    response = client.patch(f"/api/dingtalk/templates/{template_id}", json={"is_enabled": False})

    assert response.status_code == 200
    assert response.json()["data"]["is_enabled"] is False
