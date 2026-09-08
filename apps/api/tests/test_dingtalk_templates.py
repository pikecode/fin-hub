import json
from datetime import datetime, timedelta

from fastapi.testclient import TestClient
from sqlalchemy import select

from app.core.config import settings
from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    ApprovalTemplateNode,
    BankTransaction,
    DingTalkAutoSyncSetting,
    DingTalkConfig,
    DingTalkDepartment,
    ExpenseBankMatch,
    ExpenseItem,
    MatchStatus,
    SyncJob,
    TemplateFieldMapping,
    utc_now,
)
from app.modules.dingtalk.client import DingTalkClient, DingTalkClientError, DingTalkCredentials


def enable_synced_templates(client: TestClient) -> list[dict]:
    templates = client.get("/api/dingtalk/templates?page_size=200").json()["data"]["items"]
    for template in templates:
        client.patch(f"/api/dingtalk/templates/{template['id']}", json={"is_enabled": True})
    return client.get("/api/dingtalk/templates?page_size=200").json()["data"]["items"]


def test_dingtalk_client_list_processes_by_user_paginates(monkeypatch) -> None:
    import httpx

    monkeypatch.setattr("app.modules.dingtalk.client.sleep", lambda _seconds: None)
    requested_offsets: list[int] = []

    def response(url: str, payload: dict) -> httpx.Response:
        return httpx.Response(200, json=payload, request=httpx.Request("POST", url))

    def fake_post(url: str, **kwargs):
        if url.endswith("/v1.0/oauth2/accessToken"):
            return response(url, {"accessToken": "token-1"})

        payload = kwargs["json"]
        offset = payload["offset"]
        requested_offsets.append(offset)
        if offset == 0:
            processes = [
                {"process_code": f"PROC-{index}", "name": f"审批模板 {index}"}
                for index in range(100)
            ]
        elif offset == 100:
            processes = [{"process_code": "PROC-100", "name": "审批模板 100"}]
        else:
            processes = []
        return response(url, {"errcode": 0, "result": {"process_list": processes}})

    monkeypatch.setattr("app.modules.dingtalk.client.httpx.post", fake_post)

    client = DingTalkClient(DingTalkCredentials(app_key="key", app_secret="secret"))
    processes = client.list_processes_by_user("admin-user")

    assert len(processes) == 101
    assert requested_offsets == [0, 100]


def test_dingtalk_client_clamps_process_instance_page_size(monkeypatch) -> None:
    import httpx

    requested_sizes: list[int] = []

    def response(url: str, payload: dict) -> httpx.Response:
        return httpx.Response(200, json=payload, request=httpx.Request("POST", url))

    def fake_post(url: str, **kwargs):
        if url.endswith("/v1.0/oauth2/accessToken"):
            return response(url, {"accessToken": "token-1"})
        requested_sizes.append(kwargs["json"]["size"])
        return response(url, {"errcode": 0, "result": {"list": [], "next_cursor": None}})

    monkeypatch.setattr("app.modules.dingtalk.client.httpx.post", fake_post)

    client = DingTalkClient(DingTalkCredentials(app_key="key", app_secret="secret"))
    ids, next_cursor = client.list_process_instance_ids(
        "PROC-1",
        start_time_ms=1786752000000,
        end_time_ms=1786838400000,
        size=100,
    )

    assert ids == []
    assert next_cursor is None
    assert requested_sizes == [10]


def test_dingtalk_client_forecast_process_nodes(monkeypatch) -> None:
    import httpx

    calls: list[dict] = []

    def response(url: str, payload: dict) -> httpx.Response:
        return httpx.Response(200, json=payload, request=httpx.Request("POST", url))

    def fake_post(url: str, **kwargs):
        calls.append({"url": url, **kwargs})
        if url.endswith("/v1.0/oauth2/accessToken"):
            return response(url, {"accessToken": "token-1"})
        return response(
            url,
            {
                "result": {
                    "nodes": [
                        {
                            "activityId": "finance-approve",
                            "activityName": "财务审批",
                            "activityType": "APPROVAL",
                        }
                    ]
                }
            },
        )

    monkeypatch.setattr("app.modules.dingtalk.client.httpx.post", fake_post)

    client = DingTalkClient(DingTalkCredentials(app_key="key", app_secret="secret"))
    result = client.forecast_process_nodes("PROC-1", "user-1", "dept-1")

    assert result["nodes"][0]["activityId"] == "finance-approve"
    assert calls[1]["url"].endswith("/v1.0/workflow/processes/forecast")
    assert calls[1]["headers"] == {"x-acs-dingtalk-access-token": "token-1"}
    assert calls[1]["json"] == {
        "processCode": "PROC-1",
        "userId": "user-1",
        "deptId": "dept-1",
        "formComponentValues": [],
    }


def test_sync_templates_and_upsert_mapping(client: TestClient) -> None:
    sync_response = client.post("/api/dingtalk/templates/sync")
    assert sync_response.status_code == 200
    assert sync_response.json()["data"]["created"] == 2

    templates_response = client.get("/api/dingtalk/templates")
    assert templates_response.status_code == 200
    templates = templates_response.json()["data"]["items"]
    assert len(templates) == 2
    assert [template["is_enabled"] for template in templates] == [False, False]
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


def test_real_sync_templates_auto_upserts_template_nodes(
    client: TestClient,
    session,
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={
            "app_key": "ding-app-key",
            "app_secret": "super-secret",
            "admin_user_id": "admin-user",
        },
    )
    store_id = client.post(
        "/api/stores",
        json={"name": "节点同步门店", "dingtalk_dept_id": "dept-node"},
    ).json()["data"]["id"]
    assert store_id

    class FakeDingTalkClient:
        def list_processes_by_user(self, user_id):
            assert user_id == "admin-user"
            return [{"process_code": "PROC-NODE", "name": "自动节点模板"}]

        def forecast_process_nodes(self, process_code, user_id, dept_id, form_component_values=None):
            assert process_code == "PROC-NODE"
            assert user_id == "admin-user"
            assert dept_id == "dept-node"
            assert form_component_values is None
            return {
                "result": {
                    "forecastNodeVOS": [
                        {
                            "activityId": "finance-approve",
                            "activityName": "财务审批",
                            "activityType": "APPROVAL",
                        },
                        {
                            "activity_id": "cashier-pay",
                            "node_name": "出纳付款",
                            "node_type": "CC",
                        },
                    ]
                }
            }

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())

    response = client.post("/api/dingtalk/templates/sync")
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["created"] == 1
    assert data["node_created"] == 2
    assert data["node_failed"] == 0

    template = client.get("/api/dingtalk/templates").json()["data"]["items"][0]
    nodes = client.get(f"/api/dingtalk/templates/{template['id']}/nodes").json()["data"]
    assert [(node["activity_id"], node["node_name"]) for node in nodes] == [
        ("finance-approve", "财务审批"),
        ("cashier-pay", "出纳付款"),
    ]

    existing = session.scalar(
        select(ApprovalTemplateNode).where(ApprovalTemplateNode.activity_id == "finance-approve")
    )
    assert existing is not None
    existing.node_name = "旧财务审批"
    session.commit()

    second_response = client.post("/api/dingtalk/templates/sync")
    assert second_response.status_code == 200
    assert second_response.json()["data"]["node_updated"] == 1


def test_template_nodes_are_returned_with_approval_instance(client: TestClient, session) -> None:
    client.post("/api/dingtalk/templates/sync")
    template_id = client.get("/api/dingtalk/templates").json()["data"]["items"][0]["id"]
    client.patch(f"/api/dingtalk/templates/{template_id}", json={"is_enabled": True})

    create_response = client.post(
        f"/api/dingtalk/templates/{template_id}/nodes",
        json={
            "activity_id": "be99_0251",
            "node_name": "财务审批",
            "node_type": "approval",
            "sort_order": 1,
            "is_active": True,
        },
    )
    assert create_response.status_code == 201
    node = create_response.json()["data"]
    assert node["node_name"] == "财务审批"

    session.add(
        ApprovalInstance(
            template_id=template_id,
            dingtalk_instance_id="node-name-instance",
            approval_no="202609030001",
            approval_status="agree",
            raw_payload=json.dumps(
                {
                    "business_id": "202609030001",
                    "tasks": [{"activity_id": "be99_0251", "userid": "user-1"}],
                    "form_component_values": [],
                },
                ensure_ascii=False,
            ),
        )
    )
    session.commit()

    instance_response = client.get(f"/api/dingtalk/approval-instances?template_id={template_id}")
    assert instance_response.status_code == 200
    instance = instance_response.json()["data"]["items"][0]
    assert instance["node_name_map"] == {"be99_0251": "财务审批"}

    update_response = client.patch(
        f"/api/dingtalk/templates/{template_id}/nodes/{node['id']}",
        json={"node_name": "出纳复核"},
    )
    assert update_response.status_code == 200
    assert update_response.json()["data"]["node_name"] == "出纳复核"

    delete_response = client.delete(f"/api/dingtalk/templates/{template_id}/nodes/{node['id']}")
    assert delete_response.status_code == 200
    assert delete_response.json()["data"]["ok"] is True


def test_cancel_running_sync_job(client: TestClient, session) -> None:
    running_job = SyncJob(
        job_type="dingtalk_approval_sync",
        status="running",
        started_by="tester",
        started_at=utc_now(),
    )
    finished_job = SyncJob(
        job_type="dingtalk_approval_sync",
        status="succeeded",
        started_by="tester",
        started_at=utc_now(),
        finished_at=utc_now(),
    )
    session.add_all([running_job, finished_job])
    session.commit()

    response = client.post(f"/api/dingtalk/sync-jobs/{running_job.id}/cancel")
    assert response.status_code == 200
    assert response.json()["data"]["status"] == "canceled"
    assert response.json()["data"]["error_message"] == "同步已取消"

    conflict_response = client.post(f"/api/dingtalk/sync-jobs/{finished_job.id}/cancel")
    assert conflict_response.status_code == 409


def test_sync_templates_preserves_existing_enabled_state(client: TestClient) -> None:
    sync_response = client.post("/api/dingtalk/templates/sync")
    assert sync_response.status_code == 200

    templates = client.get("/api/dingtalk/templates").json()["data"]["items"]
    template_id = templates[0]["id"]
    enable_response = client.patch(f"/api/dingtalk/templates/{template_id}", json={"is_enabled": True})
    assert enable_response.status_code == 200
    assert enable_response.json()["data"]["is_enabled"] is True

    sync_again_response = client.post("/api/dingtalk/templates/sync")
    assert sync_again_response.status_code == 200

    enabled_template = client.get(f"/api/dingtalk/templates/{template_id}").json()["data"]
    other_templates = [
        template
        for template in client.get("/api/dingtalk/templates").json()["data"]["items"]
        if template["id"] != template_id
    ]
    assert enabled_template["is_enabled"] is True
    assert all(template["is_enabled"] is False for template in other_templates)


def test_auto_sync_setting_and_manual_run(client: TestClient, session) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说自动同步店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post("/api/dingtalk/templates/sync")
    enable_synced_templates(client)

    setting_response = client.get("/api/dingtalk/auto-sync/settings")
    assert setting_response.status_code == 200
    assert setting_response.json()["data"]["enabled"] is False

    update_response = client.put(
        "/api/dingtalk/auto-sync/settings",
        json={
            "enabled": True,
            "scheduled_time": "23:00",
            "sync_departments": False,
            "sync_templates": True,
            "sync_approvals": True,
        },
    )
    assert update_response.status_code == 200
    setting = update_response.json()["data"]
    assert setting["enabled"] is True
    assert setting["scheduled_time"] == "23:00"
    assert setting["sync_departments"] is False
    assert setting["paused"] is False

    pause_response = client.put("/api/dingtalk/auto-sync/settings", json={"paused": True})
    assert pause_response.status_code == 200
    assert pause_response.json()["data"]["paused"] is True

    paused_run_response = client.post("/api/dingtalk/auto-sync/run")
    assert paused_run_response.status_code == 409
    assert "已暂停" in paused_run_response.json()["detail"]

    resume_response = client.put("/api/dingtalk/auto-sync/settings", json={"paused": False})
    assert resume_response.status_code == 200
    assert resume_response.json()["data"]["paused"] is False

    run_response = client.post("/api/dingtalk/auto-sync/run")
    assert run_response.status_code == 201
    result = run_response.json()["data"]
    assert result["job"]["job_type"] == "dingtalk_auto_sync"
    assert result["job"]["status"] == "succeeded"
    assert result["template_sync"]["created"] == 0
    assert result["job"]["success_count"] == 2

    saved_setting = session.scalar(select(DingTalkAutoSyncSetting))
    assert saved_setting is not None
    assert saved_setting.last_job_id == result["job"]["id"]
    assert saved_setting.last_status == "succeeded"


def test_template_mapping_status_is_derived_from_existing_mappings(client: TestClient, session) -> None:
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-MAPPING-STATUS", "name": "映射状态模板", "is_enabled": True},
    ).json()["data"]["id"]
    template = session.get(ApprovalTemplate, template_id)
    assert template is not None
    template.mapping_status = "unmapped"
    session.add(
        TemplateFieldMapping(
            template_id=template_id,
            standard_field="amount",
            display_label="单据总金额",
            source_field_name="汇总金额（元）",
        )
    )
    session.commit()

    detail = client.get(f"/api/dingtalk/templates/{template_id}").json()["data"]
    listing = client.get("/api/dingtalk/templates?page_size=200").json()["data"]["items"]
    listed = next(item for item in listing if item["id"] == template_id)

    assert detail["mapping_status"] == "mapped"
    assert listed["mapping_status"] == "mapped"


def test_list_approval_instances_filters_by_store(client: TestClient, session) -> None:
    store_a = client.post("/api/stores", json={"name": "蘑说审批筛选 A 店"}).json()["data"]["id"]
    store_b = client.post("/api/stores", json={"name": "蘑说审批筛选 B 店"}).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-APPROVAL-STORE-FILTER", "name": "审批门店筛选模板", "is_enabled": True},
    ).json()["data"]["id"]
    session.add_all(
        [
            ApprovalInstance(
                template_id=template_id,
                dingtalk_instance_id="approval-store-a",
                approval_status="approved",
                store_id=store_a,
                submit_at=datetime(2026, 9, 1, 10, 0, 0),
            ),
            ApprovalInstance(
                template_id=template_id,
                dingtalk_instance_id="approval-store-b",
                approval_status="approved",
                store_id=store_b,
                submit_at=datetime(2026, 9, 1, 10, 0, 0),
            ),
        ]
    )
    session.commit()

    response = client.get(f"/api/dingtalk/approval-instances?store_id={store_a}&page_size=20")

    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert [item["store_id"] for item in items] == [store_a]


def test_list_approval_instances_orders_by_submit_time_desc(client: TestClient, session) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说审批排序店"}).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-APPROVAL-SORT", "name": "审批排序模板", "is_enabled": True},
    ).json()["data"]["id"]
    session.add_all(
        [
            ApprovalInstance(
                template_id=template_id,
                dingtalk_instance_id="approval-sort-old",
                approval_no="SORT-OLD",
                approval_status="approved",
                store_id=store_id,
                submit_at=datetime(2026, 8, 1, 10, 0, 0),
            ),
            ApprovalInstance(
                template_id=template_id,
                dingtalk_instance_id="approval-sort-new",
                approval_no="SORT-NEW",
                approval_status="approved",
                store_id=store_id,
                submit_at=datetime(2026, 8, 2, 10, 0, 0),
            ),
        ]
    )
    session.commit()

    response = client.get(f"/api/dingtalk/approval-instances?store_id={store_id}&page_size=20")

    assert response.status_code == 200
    items = response.json()["data"]["items"]
    assert [item["approval_no"] for item in items] == ["SORT-NEW", "SORT-OLD"]


def test_list_approval_instances_returns_expense_aggregation(client: TestClient, session) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说审批聚合店"}).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-APPROVAL-AGG", "name": "审批聚合模板", "is_enabled": True},
    ).json()["data"]["id"]
    approval = ApprovalInstance(
        template_id=template_id,
        dingtalk_instance_id="approval-aggregation",
        approval_no="AGG-001",
        approval_status="approved",
        store_id=store_id,
        submit_at=datetime(2026, 9, 1, 10, 0, 0),
    )
    session.add(approval)
    session.flush()
    paid_item = ExpenseItem(
        store_id=store_id,
        ledger_period="2026-09",
        description="已匹配明细",
        amount="120.00",
        category_l1="日常支出",
        category_l2="物料",
        approval_instance_id=approval.id,
        payment_status="paid",
    )
    pending_item = ExpenseItem(
        store_id=store_id,
        ledger_period="2026-09",
        description="待匹配明细",
        amount="80.00",
        category_l1="日常支出",
        approval_instance_id=approval.id,
    )
    confirmed_bank = BankTransaction(
        store_id=store_id,
        ledger_period="2026-09",
        occurred_at=datetime(2026, 9, 2, 10, 0, 0),
        direction="expense",
        amount="120.00",
        matched_amount="120.00",
        summary="已匹配付款",
    )
    candidate_bank = BankTransaction(
        store_id=store_id,
        ledger_period="2026-09",
        occurred_at=datetime(2026, 9, 3, 10, 0, 0),
        direction="expense",
        amount="80.00",
        summary="候选付款",
    )
    session.add_all([paid_item, pending_item, confirmed_bank, candidate_bank])
    session.flush()
    session.add_all(
        [
            ExpenseBankMatch(
                expense_item_id=paid_item.id,
                bank_transaction_id=confirmed_bank.id,
                amount="120.00",
                accounting_period="2026-09",
                status=MatchStatus.CONFIRMED.value,
            ),
            ExpenseBankMatch(
                expense_item_id=pending_item.id,
                bank_transaction_id=candidate_bank.id,
                amount="80.00",
                accounting_period="2026-09",
                status=MatchStatus.CANDIDATE.value,
            ),
        ]
    )
    session.commit()

    response = client.get(f"/api/dingtalk/approval-instances?store_id={store_id}&page_size=20")

    assert response.status_code == 200
    item = response.json()["data"]["items"][0]
    assert item["expense_item_count"] == 2
    assert item["classified_expense_item_count"] == 2
    assert item["matched_expense_item_count"] == 1
    assert item["pending_expense_item_count"] == 1
    assert item["total_expense_amount"] == "200.00"
    assert item["confirmed_match_amount"] == "120.00"
    assert item["candidate_match_count"] == 1
    assert item["processing_status"] == "matched"


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


def test_approval_instances_resolve_department_name_from_originator_dept_id(
    client: TestClient,
    session,
) -> None:
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-DEPT-NAME", "name": "部门名称模板", "is_enabled": True},
    ).json()["data"]["id"]
    session.add(
        DingTalkDepartment(
            dept_id="1083385181",
            parent_id="1",
            name="菌山集阳江新达城店",
            path="门店运营部-江门区-菌山集阳江新达城店",
            depth=3,
            is_store_candidate=True,
        )
    )
    session.add(
        ApprovalInstance(
            template_id=template_id,
            dingtalk_instance_id="dept-id-only-instance",
            approval_no="202608300099",
            approval_status="agree",
            raw_payload=json.dumps(
                {
                    "business_id": "202608300099",
                    "originator_dept_id": "1083385181",
                    "form_component_values": [],
                },
                ensure_ascii=False,
            ),
        )
    )
    session.commit()

    response = client.get(f"/api/dingtalk/approval-instances?template_id={template_id}")

    assert response.status_code == 200
    instance = response.json()["data"]["items"][0]
    assert instance["department_name"] == "门店运营部-江门区-菌山集阳江新达城店"


def test_start_approval_sync_creates_job_instance_and_expense(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说同步店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post("/api/dingtalk/templates/sync")
    enable_synced_templates(client)

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


def test_start_store_approval_sync_scopes_results_to_store_ledger(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "门店账期同步店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post("/api/dingtalk/templates/sync")
    enable_synced_templates(client)

    response = client.post(
        "/api/dingtalk/store-approval-sync",
        json={"store_id": store_id, "ledger_period": "2026-08", "started_by": "tester"},
    )

    assert response.status_code == 201
    result = response.json()["data"]
    assert result["job"]["job_type"] == "dingtalk_store_approval_sync"
    assert result["scanned_count"] == 2
    assert result["matched_count"] == 2
    assert result["outside_scope_count"] == 0
    assert result["unresolved_store_count"] == 0


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


def test_start_approval_sync_uses_early_default_window(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    monkeypatch.setattr("app.modules.dingtalk.router.utc_now", lambda: datetime(2026, 9, 8, 12, 0, 0))
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-DEFAULT-WINDOW", "name": "默认窗口模板", "is_enabled": True},
    ).json()["data"]["id"]

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            return [], None

        def get_process_instance(self, instance_id):
            return {
                "process_instance_id": instance_id,
                "business_id": "NO-DEFAULT",
                "status": "approved",
                "create_time": 1786752000000,
                "form_component_values": [],
            }

    seen: dict[str, int] = {}

    def fake_client(_config):
        return FakeDingTalkClient()

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", fake_client)
    response = client.post(
        "/api/dingtalk/approval-sync",
        json={"template_id": template_id, "started_by": "tester"},
    )
    assert response.status_code == 201
    job = response.json()["data"]
    assert job["request_start_at"].startswith("2026-06-01")


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
    assert job["status"] == "failed"
    assert json.loads(job["next_cursor"]) == {"cursors": {"PROC-LIMIT": 1}}
    assert job["error_message"] == "DingTalk approval sync is incomplete; resume is required before advancing the sync window"


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
    assert json.loads(first_job["next_cursor"]) == {"cursors": {"PROC-RESUME": 1}}

    resume_response = client.post(
        f"/api/dingtalk/sync-jobs/{first_job['id']}/resume",
        json={"started_by": "tester", "page_size": 1, "max_pages": 2},
    )
    assert resume_response.status_code == 201
    resume_job = resume_response.json()["data"]
    assert resume_job["status"] == "succeeded"
    assert resume_job["processed_count"] == 2
    assert resume_job["success_count"] == 2
    assert resume_job["next_cursor"] is None
    assert resume_job["request_start_at"].startswith("2026-08-01")
    assert resume_job["request_end_at"].startswith("2026-08-31")
    assert fake_client.cursors == [0, 1]

    expense_response = client.get(f"/api/expense-items?store_id={store_id}&ledger_period=2026-08&page_size=20")
    descriptions = [item["description"] for item in expense_response.json()["data"]["items"]]
    assert "续跑同步 instance-1" in descriptions
    assert "续跑同步 instance-2" in descriptions


def test_approval_sync_preserves_cursors_for_multiple_templates(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    for process_code in ("PROC-CURSOR-A", "PROC-CURSOR-B"):
        client.post(
            "/api/dingtalk/templates",
            json={"process_code": process_code, "name": process_code, "is_enabled": True},
        )

    class FakeDingTalkClient:
        def __init__(self) -> None:
            self.cursors: list[tuple[str, int]] = []

        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            self.cursors.append((process_code, cursor))
            return ([f"{process_code}-{cursor}"], 1) if cursor == 0 else ([], None)

        def get_process_instance(self, instance_id):
            return {
                "process_instance_id": instance_id,
                "business_id": instance_id,
                "status": "approved",
                "create_time": 1786752000000,
                "form_component_values": [],
            }

    fake_client = FakeDingTalkClient()
    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: fake_client)
    first_response = client.post(
        "/api/dingtalk/approval-sync",
        json={"started_by": "tester", "page_size": 1, "max_pages": 1},
    )
    assert first_response.status_code == 201
    first_job = first_response.json()["data"]
    assert json.loads(first_job["next_cursor"]) == {
        "cursors": {"PROC-CURSOR-A": 1, "PROC-CURSOR-B": 1}
    }

    resume_response = client.post(
        f"/api/dingtalk/sync-jobs/{first_job['id']}/resume",
        json={"started_by": "tester", "page_size": 1, "max_pages": 1},
    )
    assert resume_response.status_code == 201
    assert resume_response.json()["data"]["next_cursor"] is None
    assert fake_client.cursors == [
        ("PROC-CURSOR-A", 0),
        ("PROC-CURSOR-B", 0),
        ("PROC-CURSOR-A", 1),
        ("PROC-CURSOR-B", 1),
    ]


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
    store_id = client.post("/api/stores", json={"name": "跳过已有审批门店"}).json()["data"]["id"]
    session.add(
        ApprovalInstance(
            template_id=template_id,
            dingtalk_instance_id="existing-instance",
            approval_status="agree",
            store_id=store_id,
            parse_status="parsed",
            processing_status="matched",
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
                "finish_time": "2026-08-30 10:00:00",
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
    new_instance = session.scalar(
        select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == "new-instance")
    )
    assert new_instance.dingtalk_modified_at == datetime(2026, 8, 30, 10, 0, 0)


def test_real_approval_sync_resyncs_existing_unparsed_instance(
    client: TestClient,
    session,
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    store_id = client.post(
        "/api/stores",
        json={"name": "蘑说补解析店", "dingtalk_dept_id": "dept-resync"},
    ).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-RESYNC", "name": "补解析审批", "is_enabled": True},
    ).json()["data"]["id"]
    session.add(
        ApprovalInstance(
            template_id=template_id,
            dingtalk_instance_id="existing-unparsed-instance",
            approval_status="running",
            parse_status="skipped",
            processing_status="unparsed",
            parse_error="Missing required fields: store, amount",
        )
    )
    session.commit()
    get_calls = []

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            return ["existing-unparsed-instance"], None

        def get_process_instance(self, instance_id):
            get_calls.append(instance_id)
            return {
                "process_instance_id": instance_id,
                "business_id": "NO-RESYNC",
                "originator_dept_id": "dept-resync",
                "originator_dept_name": "门店运营部-蘑说补解析店",
                "status": "COMPLETED",
                "result": "agree",
                "create_time": "2026-08-29 10:00:00",
                "modify_time": "2026-08-30 12:34:56",
                "form_component_values": [
                    {"name": "报销日期", "value": "2026-08-29"},
                    {"name": "支出门店", "value": "蘑说补解析店"},
                    {"name": "汇总金额（元）", "value": "128.00"},
                    {"name": "支出详情", "value": "补解析支出"},
                    {"name": "支出类型", "value": "门店费用"},
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
            "skip_existing": True,
        },
    )

    assert response.status_code == 201
    assert get_calls == ["existing-unparsed-instance"]
    instance = session.scalar(
        select(ApprovalInstance).where(
            ApprovalInstance.dingtalk_instance_id == "existing-unparsed-instance"
        )
    )
    assert instance.store_id == store_id
    assert instance.approval_status == "agree"
    assert instance.dingtalk_modified_at == datetime(2026, 8, 30, 12, 34, 56)
    assert instance.parse_status == "parsed"
    assert instance.processing_status == "pending_match"
    assert instance.parse_error is None
    expenses = client.get(
        f"/api/expense-items?approval_instance_id={instance.id}&page_size=20"
    ).json()["data"]["items"]
    assert len(expenses) == 1
    assert expenses[0]["amount"] == "128.00"


def test_auto_sync_uses_skip_existing_setting(client: TestClient, session, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    store_id = client.post(
        "/api/stores",
        json={"name": "蘑说自动重拉店", "dingtalk_dept_id": "dept-auto-resync"},
    ).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-AUTO-RESYNC", "name": "自动重拉审批", "is_enabled": True},
    ).json()["data"]["id"]
    session.add(
        ApprovalInstance(
            template_id=template_id,
            dingtalk_instance_id="auto-existing-instance",
            approval_status="agree",
            store_id=store_id,
            parse_status="parsed",
            processing_status="matched",
        )
    )
    session.commit()
    setting_response = client.put(
        "/api/dingtalk/auto-sync/settings",
        json={
            "sync_departments": False,
            "sync_templates": False,
            "sync_approvals": True,
            "skip_existing": False,
        },
    )
    assert setting_response.status_code == 200
    get_calls = []

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            return ["auto-existing-instance"], None

        def get_process_instance(self, instance_id):
            get_calls.append(instance_id)
            return {
                "process_instance_id": instance_id,
                "business_id": "NO-AUTO-RESYNC",
                "originator_dept_id": "dept-auto-resync",
                "status": "COMPLETED",
                "result": "agree",
                "create_time": "2026-08-29 10:00:00",
                "form_component_values": [
                    {"name": "报销日期", "value": "2026-08-29"},
                    {"name": "支出门店", "value": "蘑说自动重拉店"},
                    {"name": "汇总金额（元）", "value": "88.00"},
                    {"name": "支出详情", "value": "自动重拉支出"},
                    {"name": "支出类型", "value": "门店费用"},
                ],
            }

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post("/api/dingtalk/auto-sync/run")

    assert response.status_code == 201
    assert get_calls == ["auto-existing-instance"]


def test_auto_sync_advances_approval_watermark_to_completed_window_with_overlap(
    client: TestClient, session, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-WATERMARK", "name": "水位模板", "is_enabled": True},
    )
    client.put(
        "/api/dingtalk/auto-sync/settings",
        json={"sync_departments": False, "sync_templates": False, "sync_approvals": True},
    )
    windows: list[tuple[int, int]] = []

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            windows.append((start_time_ms, end_time_ms))
            return [], None

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    first_response = client.post("/api/dingtalk/auto-sync/run")
    assert first_response.status_code == 201
    first_job = first_response.json()["data"]["job"]
    first_window_end = datetime.fromisoformat(first_job["request_end_at"])
    setting = session.scalar(select(DingTalkAutoSyncSetting))
    assert setting is not None
    assert setting.approval_watermark_at == first_window_end
    assert setting.last_run_at >= setting.approval_watermark_at
    assert windows[0][1] - windows[0][0] <= 120 * 24 * 60 * 60 * 1000

    first_watermark = setting.approval_watermark_at
    second_response = client.post("/api/dingtalk/auto-sync/run")
    assert second_response.status_code == 201
    assert windows[1][0] == int((first_watermark - timedelta(days=setting.approval_overlap_days)).timestamp() * 1000)


def test_auto_sync_failure_keeps_approval_watermark_and_window_for_retry(
    client: TestClient, session, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-WATERMARK-ERROR", "name": "失败水位模板", "is_enabled": True},
    )
    client.put(
        "/api/dingtalk/auto-sync/settings",
        json={"sync_departments": False, "sync_templates": False, "sync_approvals": True},
    )
    setting = session.scalar(select(DingTalkAutoSyncSetting))
    assert setting is not None
    original_watermark = utc_now() - timedelta(hours=2)
    setting.approval_watermark_at = original_watermark
    session.commit()

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            raise DingTalkClientError("temporary DingTalk error")

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post("/api/dingtalk/auto-sync/run")
    assert response.status_code == 201
    assert response.json()["data"]["job"]["status"] == "failed"
    session.refresh(setting)
    assert setting.approval_watermark_at == original_watermark
    assert setting.approval_resume_state is not None


def test_resync_approvals_by_modified_time_refreshes_existing_instances(
    client: TestClient,
    session,
    monkeypatch,
) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    store_id = client.post(
        "/api/stores",
        json={"name": "修改重刷门店", "dingtalk_dept_id": "dept-modified-resync"},
    ).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-MODIFIED-RESYNC", "name": "修改重刷审批", "is_enabled": True},
    ).json()["data"]["id"]
    session.add(
        ApprovalInstance(
            template_id=template_id,
            dingtalk_instance_id="modified-instance",
            approval_no="MOD-001",
            store_id=store_id,
            approval_status="agree",
            parse_status="parsed",
            processing_status="pending_match",
            dingtalk_modified_at=datetime(2026, 9, 1, 10, 0, 0),
        )
    )
    session.commit()

    get_calls: list[str] = []

    class FakeDingTalkClient:
        def get_process_instance(self, instance_id):
            get_calls.append(instance_id)
            return {
                "process_instance_id": instance_id,
                "business_id": "MOD-001",
                "originator_dept_id": "dept-modified-resync",
                "originator_dept_name": "门店运营部-修改重刷门店",
                "status": "COMPLETED",
                "result": "agree",
                "create_time": "2026-09-01 09:00:00",
                "finish_time": "2026-09-01 10:00:00",
                "modify_time": "2026-09-03 12:00:00",
                "form_component_values": [
                    {"name": "报销日期", "value": "2026-09-01"},
                    {"name": "支出门店", "value": "修改重刷门店"},
                    {"name": "汇总金额（元）", "value": "188.00"},
                    {"name": "支出详情", "value": "修改后重刷"},
                    {"name": "支出类型", "value": "门店费用"},
                ],
            }

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post(
        "/api/dingtalk/approval-resync-by-modified",
        json={
            "start_at": "2026-09-01T00:00:00",
            "end_at": "2026-09-02T00:00:00",
            "store_id": store_id,
            "started_by": "tester",
        },
    )

    assert response.status_code == 201
    assert get_calls == ["modified-instance"]
    data = response.json()["data"]
    assert data["processed_count"] == 1
    assert data["updated_count"] == 1
    instance = session.scalar(
        select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == "modified-instance")
    )
    assert instance is not None
    assert instance.dingtalk_modified_at == datetime(2026, 9, 3, 12, 0, 0)


def test_auto_sync_refreshes_pending_approval_not_returned_by_new_window(
    client: TestClient, session, monkeypatch
) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    store_id = client.post(
        "/api/stores",
        json={"name": "历史待处理审批门店", "dingtalk_dept_id": "dept-pending-refresh"},
    ).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-PENDING-REFRESH", "name": "待处理刷新模板", "is_enabled": True},
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
    session.add(
        ApprovalInstance(
            template_id=template_id,
            dingtalk_instance_id="old-pending-instance",
            approval_status="running",
            parse_status="unparsed",
            processing_status="unparsed",
            submit_at=utc_now() - timedelta(days=30),
        )
    )
    session.commit()
    client.put(
        "/api/dingtalk/auto-sync/settings",
        json={"sync_departments": False, "sync_templates": False, "sync_approvals": True},
    )
    detail_calls: list[str] = []

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            return [], None

        def get_process_instance(self, instance_id):
            detail_calls.append(instance_id)
            return {
                "process_instance_id": instance_id,
                "business_id": "NO-PENDING-REFRESH",
                "originator_dept_id": "dept-pending-refresh",
                "status": "COMPLETED",
                "result": "agree",
                "create_time": "2026-08-01 10:00:00",
                "finish_time": "2026-09-01 10:00:00",
                "form_component_values": [
                    {"name": "门店", "value": "历史待处理审批门店"},
                    {"name": "金额", "value": "66.00"},
                    {"name": "日期", "value": "2026-09-01"},
                    {"name": "说明", "value": "历史审批补拉"},
                ],
            }

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post("/api/dingtalk/auto-sync/run")
    assert response.status_code == 201
    assert detail_calls == ["old-pending-instance"]
    instance = session.scalar(
        select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == "old-pending-instance")
    )
    assert instance is not None
    assert instance.store_id == store_id
    assert instance.parse_status == "parsed"
    assert instance.approved_at is not None


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


def test_template_field_candidates_merge_recent_instances(client: TestClient, session) -> None:
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-MERGE-SOURCE", "name": "合并字段模板", "is_enabled": True},
    ).json()["data"]["id"]
    old_instance = ApprovalInstance(
        template_id=template_id,
        dingtalk_instance_id="merge-source-old",
        approval_status="approved",
        raw_payload='{"form_component_values":[{"id":"old-field","name":"旧字段","componentType":"TextField","value":"旧值"}]}',
    )
    new_instance = ApprovalInstance(
        template_id=template_id,
        dingtalk_instance_id="merge-source-new",
        approval_status="approved",
        raw_payload='{"form_component_values":[{"id":"new-field","name":"新字段","componentType":"TextField","value":"新值"}]}',
    )
    session.add_all([old_instance, new_instance])
    session.commit()

    response = client.get(f"/api/dingtalk/templates/{template_id}/field-candidates")

    assert response.status_code == 200
    names = {item["source_field_name"] for item in response.json()["data"]}
    assert {"旧字段", "新字段"}.issubset(names)


def test_dingtalk_sync_rejects_when_any_dingtalk_sync_job_is_running(client: TestClient, session) -> None:
    running_job = SyncJob(
        job_type="dingtalk_auto_sync",
        status="running",
        started_by="tester",
        started_at=utc_now(),
    )
    session.add(running_job)
    session.commit()

    approval_response = client.post("/api/dingtalk/approval-sync", json={})
    auto_response = client.post("/api/dingtalk/auto-sync/run")

    assert approval_response.status_code == 409
    assert auto_response.status_code == 409
    assert running_job.id in approval_response.json()["detail"]
    assert running_job.id in auto_response.json()["detail"]


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


def test_real_approval_sync_creates_one_expense_per_approval_line_and_resolves_store_path(
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
    dingtalk_payload = {"total_amount": "350", "second_line_amount": "230"}

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
                    {"name": "汇总金额（元）", "value": dingtalk_payload["total_amount"]},
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
                            f'{{"label":"小项金额","value":"{dingtalk_payload["second_line_amount"]}"}}'
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
    instances = client.get(f"/api/dingtalk/approval-instances?template_id={template_id}").json()["data"]["items"]
    assert instances[0]["store_id"] == store_id
    assert '"expense_row_count": 2' in instances[0]["raw_payload"]
    items = sorted(expense_response.json()["data"]["items"], key=lambda item: item["approval_line_no"])
    assert len(items) == 2
    assert items[0]["description"] == "消杀"
    assert items[0]["amount"] == "120.00"
    assert items[0]["category_l1"] is None
    assert items[0]["payee_account"] == "安少辉"
    assert items[0]["approval_instance_id"] == instances[0]["id"]
    assert items[0]["approval_line_no"] == 1
    assert items[0]["approval_line_key"] == "line-1"
    assert items[0]["parse_status"] == "parsed"
    assert items[1]["description"] == "维修"
    assert items[1]["amount"] == "230.00"
    assert items[1]["approval_instance_id"] == instances[0]["id"]
    assert items[1]["approval_line_no"] == 2
    assert items[1]["approval_line_key"] == "line-2"
    detail_items = client.get(
        f"/api/expense-items?approval_instance_id={instances[0]['id']}&page_size=20"
    ).json()["data"]["items"]
    assert {item["id"] for item in detail_items} == {item["id"] for item in items}
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
    assert preview["rows"][0]["category_l1"] is None
    assert preview["rows"][1]["description"] == "维修"
    assert preview["rows"][1]["amount"] == "230.00"
    assert preview["voucher_count"] == 2

    edit_response = client.patch(
        f"/api/expense-items/{items[0]['id']}",
        json={"category_l1": "人工分类", "remark": "财务已核对"},
    )
    assert edit_response.status_code == 200

    reparse_response = client.post(
        f"/api/dingtalk/templates/{template_id}/reparse",
        json={"instance_id": instances[0]["id"], "limit": 10, "started_by": "tester"},
    )
    assert reparse_response.status_code == 200
    reparse = reparse_response.json()["data"]
    assert reparse["processed_count"] == 1
    assert reparse["reparsed_count"] == 1
    assert reparse["created_expense_count"] == 0
    reparsed_items = sorted(
        client.get(f"/api/expense-items?store_id={store_id}&ledger_period=2026-08&page_size=20").json()["data"]["items"],
        key=lambda item: item["approval_line_no"],
    )
    assert [item["approval_line_no"] for item in reparsed_items] == [1, 2]
    assert reparsed_items[0]["category_l1"] == "人工分类"
    assert reparsed_items[0]["remark"] == "财务已核对"
    assert json.loads(reparsed_items[0]["user_edited_fields_json"]) == ["category_l1", "remark"]

    dingtalk_payload["total_amount"] = "380"
    dingtalk_payload["second_line_amount"] = "260"
    incremental_response = client.post(
        "/api/dingtalk/approval-sync",
        json={
            "template_id": template_id,
            "started_by": "tester",
            "start_at": "2026-08-01T00:00:00",
            "end_at": "2026-08-31T23:59:59",
            "skip_existing": False,
        },
    )
    assert incremental_response.status_code == 201
    incrementally_synced_items = sorted(
        client.get(f"/api/expense-items?store_id={store_id}&ledger_period=2026-08&page_size=20").json()["data"]["items"],
        key=lambda item: item["approval_line_no"],
    )
    assert incrementally_synced_items[0]["category_l1"] == "人工分类"
    assert incrementally_synced_items[0]["sync_conflict_status"] == "none"
    assert incrementally_synced_items[1]["amount"] == "260.00"
    assert incrementally_synced_items[1]["sync_conflict_status"] == "source_changed"


def test_real_approval_sync_creates_installment_expense_lines(client: TestClient, monkeypatch) -> None:
    monkeypatch.setattr(settings, "dingtalk_sync_mode", "real")
    client.put(
        "/api/dingtalk/config",
        json={"app_key": "ding-app-key", "app_secret": "super-secret"},
    )
    store_id = client.post(
        "/api/stores",
        json={"name": "蘑说旧洲优越城店", "dingtalk_dept_id": "dept-installment"},
    ).json()["data"]["id"]
    template_id = client.post(
        "/api/dingtalk/templates",
        json={"process_code": "PROC-INSTALLMENT", "name": "门店筹建报销", "is_enabled": True},
    ).json()["data"]["id"]

    class FakeDingTalkClient:
        def list_process_instance_ids(self, process_code, start_time_ms, end_time_ms, cursor=0, size=20):
            return ["installment-instance-1"], None

        def get_process_instance(self, instance_id):
            return {
                "process_instance_id": instance_id,
                "business_id": "NO-INSTALLMENT",
                "title": "郭伟裕提交的门店筹建报销",
                "originator_dept_id": "dept-installment",
                "originator_dept_name": "门店运营部-蘑说旧洲优越城店",
                "status": "COMPLETED",
                "result": "agree",
                "create_time": "2026-06-26 09:00:00",
                "finish_time": "2026-06-26 18:00:00",
                "form_component_values": [
                    {"name": "日期", "value": "2026-06-26"},
                    {"name": "报销门店", "value": "蘑说旧洲优越城店"},
                    {"name": "支出类别", "value": "营销费用"},
                    {"name": "金额（元）", "value": "50000"},
                    {"name": "是否分期付款", "value": "是"},
                    {"name": "首期费用", "value": "25000"},
                    {"name": "第二期费用", "value": "25000"},
                    {"name": "第三期费用", "value": "0"},
                    {"name": "支出详情", "value": "抖音宣传"},
                    {"name": "收款账户", "value": "楼秦 招商银行 6214855748609852"},
                ],
            }

    monkeypatch.setattr("app.modules.dingtalk.router.dingtalk_client", lambda config: FakeDingTalkClient())
    response = client.post(
        "/api/dingtalk/approval-sync",
        json={
            "template_id": template_id,
            "started_by": "tester",
            "start_at": "2026-06-01T00:00:00",
            "end_at": "2026-06-30T23:59:59",
        },
    )
    assert response.status_code == 201
    items = sorted(
        client.get(f"/api/expense-items?store_id={store_id}&ledger_period=2026-06&page_size=20").json()["data"]["items"],
        key=lambda item: item["approval_line_key"],
    )
    assert len(items) == 2
    assert [item["approval_line_source_type"] for item in items] == ["installment", "installment"]
    assert [item["approval_line_key"] for item in items] == ["installment-1", "installment-2"]
    assert [item["amount"] for item in items] == ["25000.00", "25000.00"]
    assert items[0]["payee_name"] == "楼秦 招商银行 6214855748609852"


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
