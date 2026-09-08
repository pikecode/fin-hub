from datetime import datetime
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseCategory,
    ExpenseItem,
    MatchStatus,
)


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
    metrics = workspace["metrics"]
    assert metrics["revenue_record_count"] == 1
    assert metrics["income_amount"] == "100.00"
    assert metrics["expense_amount"] == "2.00"
    assert metrics["food_cost_amount"] == "0.00"
    assert metrics["gross_profit_amount"] == "100.00"
    assert metrics["net_income_amount"] == "98.00"
    assert metrics["fee_amount"] == "2.00"
    assert metrics["bank_transaction_count"] == 1
    assert metrics["unmatched_bank_transaction_count"] == 1
    assert metrics["approval_count"] == 0
    assert metrics["pending_approval_count"] == 0
    assert metrics["revenue_match_count"] == 1
    assert metrics["pending_revenue_match_count"] == 1
    assert len(workspace["bank_transactions"]) == 1
    assert len(workspace["revenue_records"]) == 1
    assert len(workspace["approval_instances"]) == 0
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

    assert workspace["metrics"]["expense_amount"] == "0.00"
    assert workspace["metrics"]["approval_count"] == 1
    assert workspace["metrics"]["pending_approval_count"] == 1
    approval_read = next(
        item for item in workspace["approval_instances"] if item["dingtalk_instance_id"] == "approval-with-lines"
    )
    assert approval_read["expense_item_count"] == 2
    assert approval_read["total_expense_amount"] == "100.00"


def test_store_ledger_workspace_counts_confirmed_approval_match_by_accounting_period(
    client: TestClient,
    session: Session,
) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说历史对账支出店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-09"})
    session.add(ApprovalTemplate(id="template-legacy-match", process_code="PROC-LEGACY", name="历史审批模板"))
    session.flush()
    approval = ApprovalInstance(
        template_id="template-legacy-match",
        dingtalk_instance_id="legacy-approval-001",
        approval_no="LEGACY-001",
        store_id=store_id,
        approval_status="agree",
        submit_at=datetime(2026, 9, 5, 9, 0, 0),
    )
    session.add(approval)
    expense = ExpenseItem(
        store_id=store_id,
        ledger_period="2026-08",
        description="历史导入审批明细",
        amount=Decimal("500.00"),
        category_l1="运营支出",
        category_l2="物料采购",
        source="dingtalk",
        source_document_id="legacy-approval-001",
    )
    bank_transaction = BankTransaction(
        store_id=store_id,
        ledger_period="2026-09",
        occurred_at=datetime(2026, 9, 6, 10, 30, 0),
        direction="expense",
        amount=Decimal("320.00"),
        matched_amount=Decimal("320.00"),
        summary="历史导入审批付款",
    )
    session.add_all([expense, bank_transaction])
    session.flush()
    session.add(
        ExpenseBankMatch(
            expense_item_id=expense.id,
            bank_transaction_id=bank_transaction.id,
            amount=Decimal("320.00"),
            accounting_period="2026-08",
            status=MatchStatus.CONFIRMED.value,
        )
    )
    session.commit()

    august_workspace = client.get(f"/api/store-ledgers/{store_id}/workspace?period=2026-08").json()["data"]
    september_workspace = client.get(f"/api/store-ledgers/{store_id}/workspace?period=2026-09").json()["data"]

    assert august_workspace["metrics"]["expense_amount"] == "320.00"
    assert august_workspace["metrics"]["approval_accounting_amount"] == "320.00"
    assert august_workspace["metrics"]["expense_category_summary"][0]["amount"] == "320.00"
    assert september_workspace["metrics"]["expense_amount"] == "0.00"


def test_store_ledger_workspace_calculates_gross_profit_from_food_cost(
    client: TestClient,
    session: Session,
) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说毛利计算店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": store_id, "period": "2026-08"})
    client.post("/api/revenue-channels", json={"name": "堂食", "sort_order": 10})
    client.post(
        "/api/revenue-records",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "revenue_date": "2026-08-20",
            "channel": "堂食",
            "gross_amount": "1000.00",
            "net_amount": "1000.00",
            "fee_amount": "0.00",
        },
    )
    session.add(ApprovalTemplate(id="template-gross-profit", process_code="PROC-GROSS", name="毛利测试模板"))
    session.flush()
    food_category = ExpenseCategory(name="食材成本", parent_id=None, sort_order=1)
    operation_category = ExpenseCategory(name="运营支出", parent_id=None, sort_order=2)
    session.add_all([food_category, operation_category])
    session.flush()
    session.add_all(
        [
            ExpenseCategory(name="肉类", parent_id=food_category.id, sort_order=1),
            ExpenseCategory(name="物料采购", parent_id=operation_category.id, sort_order=1),
        ]
    )
    session.flush()
    approval = ApprovalInstance(
        template_id="template-gross-profit",
        dingtalk_instance_id="gross-profit-approval",
        approval_no="GROSS-001",
        store_id=store_id,
        approval_status="agree",
        submit_at=datetime(2026, 8, 21, 9, 0, 0),
    )
    session.add(approval)
    food_expense = ExpenseItem(
        store_id=store_id,
        ledger_period="2026-08",
        description="牛肉采购",
        amount=Decimal("300.00"),
        category_l1="食材成本",
        category_l2="肉类",
        source="dingtalk",
        source_document_id="gross-profit-approval:food",
    )
    other_expense = ExpenseItem(
        store_id=store_id,
        ledger_period="2026-08",
        description="清洁用品",
        amount=Decimal("50.00"),
        category_l1="运营支出",
        category_l2="物料采购",
        source="dingtalk",
        source_document_id="gross-profit-approval:other",
    )
    uncategorized_expense = ExpenseItem(
        store_id=store_id,
        ledger_period="2026-08",
        description="待分类支出",
        amount=Decimal("80.00"),
        source="dingtalk",
        source_document_id="gross-profit-approval:uncategorized",
    )
    food_bank = BankTransaction(
        store_id=store_id,
        ledger_period="2026-08",
        occurred_at=datetime(2026, 8, 22, 10, 30, 0),
        direction="expense",
        amount=Decimal("300.00"),
        matched_amount=Decimal("300.00"),
        summary="牛肉采购付款",
    )
    other_bank = BankTransaction(
        store_id=store_id,
        ledger_period="2026-08",
        occurred_at=datetime(2026, 8, 23, 10, 30, 0),
        direction="expense",
        amount=Decimal("50.00"),
        matched_amount=Decimal("50.00"),
        summary="清洁用品付款",
    )
    uncategorized_bank = BankTransaction(
        store_id=store_id,
        ledger_period="2026-08",
        occurred_at=datetime(2026, 8, 24, 10, 30, 0),
        direction="expense",
        amount=Decimal("80.00"),
        matched_amount=Decimal("80.00"),
        summary="待分类付款",
    )
    session.add_all([food_expense, other_expense, uncategorized_expense, food_bank, other_bank, uncategorized_bank])
    session.flush()
    session.add_all(
        [
            ExpenseBankMatch(
                expense_item_id=food_expense.id,
                bank_transaction_id=food_bank.id,
                amount=Decimal("300.00"),
                accounting_period="2026-08",
                status=MatchStatus.CONFIRMED.value,
            ),
            ExpenseBankMatch(
                expense_item_id=other_expense.id,
                bank_transaction_id=other_bank.id,
                amount=Decimal("50.00"),
                accounting_period="2026-08",
                status=MatchStatus.CONFIRMED.value,
            ),
            ExpenseBankMatch(
                expense_item_id=uncategorized_expense.id,
                bank_transaction_id=uncategorized_bank.id,
                amount=Decimal("80.00"),
                accounting_period="2026-08",
                status=MatchStatus.CONFIRMED.value,
            ),
        ]
    )
    session.commit()

    workspace = client.get(f"/api/store-ledgers/{store_id}/workspace?period=2026-08").json()["data"]

    assert workspace["metrics"]["revenue_income_amount"] == "1000.00"
    assert workspace["metrics"]["expense_amount"] == "430.00"
    assert workspace["metrics"]["food_cost_amount"] == "300.00"
    assert workspace["metrics"]["gross_profit_amount"] == "700.00"
    category_names = [item["name"] for item in workspace["metrics"]["expense_category_summary"]]
    assert "食材成本 / 肉类" in category_names
    assert "运营支出 / 物料采购" in category_names
    assert "未分类" not in category_names


def test_bank_transaction_create_auto_creates_ledger(client: TestClient) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说流水自动建账店"}).json()["data"]["id"]

    response = client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "occurred_at": "2026-08-21T10:30:00",
            "direction": "expense",
            "amount": "1280.00",
            "counterparty_name": "供电公司",
        },
    )

    assert response.status_code == 201
    data = response.json()["data"]
    assert data["store_id"] == store_id
    assert data["ledger_period"] == "2026-08"
