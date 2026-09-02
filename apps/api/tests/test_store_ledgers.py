from datetime import datetime

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ApprovalInstance, ApprovalTemplate, ExpenseItem


def test_store_ledger_workspace_returns_period_metrics(client: TestClient, session: Session) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说套帐聚合店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post("/api/revenue-channels", json={"name": "聚合渠道", "sort_order": 10, "requires_bank_match": True})
    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "聚合渠道",
            "gross_amount": "100.00",
            "net_amount": "98.00",
            "fee_amount": "2.00",
        },
    )
    bank_id = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-21T10:30:00",
            "direction": "income",
            "amount": "98.00",
        },
    ).json()["data"]["id"]
    client.post(
        "/api/matches/revenue",
        json={
            "bank_transaction_id": bank_id,
            "channel": "聚合渠道",
            "revenue_start_date": "2026-08-20",
            "revenue_end_date": "2026-08-20",
            "amount": "98.00",
        },
    )
    session.add(
        ApprovalTemplate(
            id="template-workspace",
            process_code="PROC-WORKSPACE",
            name="套帐聚合测试模板",
        )
    )
    session.commit()
    session.add(
        ApprovalInstance(
            template_id="template-workspace",
            dingtalk_instance_id="workspace-approval",
            approval_no="WORKSPACE-001",
            store_id=store_id,
            department_name="聚合门店",
            applicant_name="张三",
            applicant_user_id="user-1",
            approval_status="running",
            submit_at=datetime(2026, 8, 22, 9, 0, 0),
        )
    )
    session.commit()

    response = client.get(f"/api/store-ledgers/{store_id}/workspace?period=2026-08")

    assert response.status_code == 200
    workspace = response.json()["data"]
    assert workspace["store"]["id"] == store_id
    assert workspace["period"] == "2026-08"
    assert workspace["selected_ledger"]["period"] == "2026-08"
    assert workspace["close_check"]["can_close"] is False
    assert workspace["close_check"]["unmatched_revenue_record_count"] == 1
    assert workspace["close_check"]["unmatched_revenue_amount"] == "98.00"
    assert workspace["metrics"] == {
        "revenue_record_count": 1,
        "income_amount": "100.00",
        "expense_amount": "0.00",
        "net_income_amount": "98.00",
        "fee_amount": "2.00",
        "bank_transaction_count": 1,
        "unmatched_bank_transaction_count": 1,
        "approval_count": 1,
        "pending_approval_count": 0,
        "revenue_match_count": 1,
        "pending_revenue_match_count": 1,
    }
    assert len(workspace["bank_transactions"]) == 1
    assert len(workspace["revenue_records"]) == 1
    assert len(workspace["approval_instances"]) == 1
    assert len(workspace["revenue_matches"]) == 1


def test_store_ledger_workspace_defaults_to_latest_period(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说套帐默认账期店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-07"})
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})

    response = client.get(f"/api/store-ledgers/{store_id}/workspace")

    assert response.status_code == 200
    assert response.json()["data"]["period"] == "2026-08"


def test_store_ledger_workspace_has_no_close_check_without_selected_ledger(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说套帐无账期店"}).json()["data"]["id"]

    response = client.get(f"/api/store-ledgers/{store_id}/workspace?period=2026-08")

    assert response.status_code == 200
    workspace = response.json()["data"]
    assert workspace["period"] == "2026-08"
    assert workspace["selected_ledger"] is None
    assert workspace["close_check"] is None


def test_store_ledger_workspace_excludes_whole_approval_summary_when_line_items_exist(
    client: TestClient,
    session: Session,
) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说套帐明细聚合店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    session.add(ApprovalTemplate(id="template-summary", process_code="PROC-SUMMARY", name="明细聚合模板"))
    session.flush()
    session.add_all(
        [
            ApprovalInstance(
                template_id="template-summary",
                dingtalk_instance_id="approval-with-lines",
                approval_no="SUMMARY-001",
                store_id=store_id,
                approval_status="agree",
                submit_at=datetime(2026, 8, 20, 9, 0, 0),
            ),
            ApprovalInstance(
                template_id="template-summary",
                dingtalk_instance_id="approval-terminated",
                approval_no="SUMMARY-002",
                store_id=store_id,
                approval_status="TERMINATED",
                submit_at=datetime(2026, 8, 21, 9, 0, 0),
            ),
            ApprovalInstance(
                template_id="template-summary",
                dingtalk_instance_id="approval-running",
                approval_no="SUMMARY-003",
                store_id=store_id,
                approval_status="RUNNING",
                submit_at=datetime(2026, 8, 22, 9, 0, 0),
            ),
        ]
    )
    session.flush()
    approval = session.scalar(
        select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == "approval-with-lines")
    )
    session.add_all(
        [
            ExpenseItem(
                store_id=store_id,
                ledger_period="2026-08",
                description="整单汇总",
                amount="100.00",
                approval_instance_id=approval.id,
                source="dingtalk",
                source_document_id="approval-with-lines",
            ),
            ExpenseItem(
                store_id=store_id,
                ledger_period="2026-08",
                description="明细一",
                amount="60.00",
                approval_instance_id=approval.id,
                source="dingtalk",
                source_document_id="approval-with-lines:line-1",
            ),
            ExpenseItem(
                store_id=store_id,
                ledger_period="2026-08",
                description="明细二",
                amount="40.00",
                approval_instance_id=approval.id,
                source="dingtalk",
                source_document_id="approval-with-lines:line-2",
            ),
            ExpenseItem(
                store_id=store_id,
                ledger_period="2026-08",
                description="已匹配活动审批",
                amount="1.00",
                approval_instance_id=session.scalar(
                    select(ApprovalInstance).where(
                        ApprovalInstance.dingtalk_instance_id == "approval-running"
                    )
                ).id,
                payment_status="paid",
                source="dingtalk",
                source_document_id="approval-running",
            ),
        ]
    )
    session.commit()

    workspace = client.get(f"/api/store-ledgers/{store_id}/workspace?period=2026-08").json()["data"]

    assert workspace["metrics"]["expense_amount"] == "101.00"
    assert workspace["metrics"]["approval_count"] == 3
    assert workspace["metrics"]["pending_approval_count"] == 2
    approval_read = next(
        item for item in workspace["approval_instances"] if item["dingtalk_instance_id"] == "approval-with-lines"
    )
    assert approval_read["expense_item_count"] == 2
    assert approval_read["total_expense_amount"] == "100.00"
