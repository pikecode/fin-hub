from datetime import date, datetime
from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseItem,
    RevenueRecord,
)


def test_financial_analytics_uses_real_report_rows(client: TestClient, session: Session) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说统计店"}).json()["data"]["id"]
    template = ApprovalTemplate(process_code="PROC-ANALYTICS", name="门店支出报销", is_enabled=True)
    session.add(template)
    session.flush()
    approval = ApprovalInstance(
        template_id=template.id,
        dingtalk_instance_id="approval-analytics-1",
        approval_no="202608240001",
        store_id=store_id,
        applicant_name="测试申请人",
        approval_status="COMPLETED",
        submit_at=datetime(2026, 8, 24, 10, 0, 0),
    )
    session.add(approval)
    session.add(
        RevenueRecord(
            store_id=store_id,
            ledger_period="2026-08",
            revenue_date=date(2026, 8, 24),
            channel="美团",
            gross_amount=Decimal("1000.00"),
            net_amount=Decimal("980.00"),
            fee_amount=Decimal("20.00"),
        )
    )
    session.add(
        ExpenseItem(
            store_id=store_id,
            ledger_period="2026-08",
            expense_date=date(2026, 8, 24),
            description="门店零星采购",
            amount=Decimal("120.00"),
            category_l1="物料",
            category_l2="零星采购",
            payment_status="unpaid",
            source="dingtalk",
            source_document_id="approval-analytics-1:row-1",
        )
    )
    session.add(
        BankTransaction(
            store_id=store_id,
            ledger_period="2026-08",
            occurred_at=datetime(2026, 8, 25, 9, 0, 0),
            direction="expense",
            amount=Decimal("120.00"),
            matched_amount=Decimal("0.00"),
            summary="采购付款",
        )
    )
    session.commit()

    response = client.get("/api/reports/analytics?period_start=2026-08&period_end=2026-08")

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["metrics"]["store_count"] == 1
    assert data["metrics"]["total_income_amount"] == "1000.00"
    assert data["metrics"]["total_expense_amount"] == "120.00"
    assert data["metrics"]["unmatched_bank_count"] == 1
    assert data["stores"][0]["store_name"] == "蘑说统计店"
    assert data["categories"][0]["category_l1"] == "物料"
    assert data["templates"][0]["template_name"] == "门店支出报销"
    assert data["templates"][0]["approval_count"] == 1
    assert data["templates"][0]["expense_amount"] == "120.00"


def test_financial_analytics_template_detail_includes_line_item_sources(
    client: TestClient,
    session: Session,
) -> None:
    store_id = client.post("/api/stores", json={"name": "蘑说模板明细店"}).json()["data"]["id"]
    template = ApprovalTemplate(process_code="PROC-TEMPLATE-DETAIL", name="门店支出报销", is_enabled=True)
    session.add(template)
    session.flush()
    session.add(
        ApprovalInstance(
            template_id=template.id,
            dingtalk_instance_id="approval-template-detail-1",
            approval_no="202608240002",
            store_id=store_id,
            applicant_name="测试申请人",
            approval_status="COMPLETED",
            submit_at=datetime(2026, 8, 24, 10, 0, 0),
        )
    )
    session.add(
        ExpenseItem(
            store_id=store_id,
            ledger_period="2026-08",
            expense_date=date(2026, 8, 24),
            description="从表格行同步的费用",
            amount=Decimal("88.00"),
            source="dingtalk",
            source_document_id="approval-template-detail-1:TableField_row_1",
        )
    )
    session.commit()

    response = client.get(
        f"/api/reports/analytics/details?detail_type=template&template_id={template.id}&period_start=2026-08&period_end=2026-08"
    )

    assert response.status_code == 200
    data = response.json()["data"]
    assert data["title"] == "审批模版明细"
    assert len(data["approval_instances"]) == 1
    assert len(data["expense_items"]) == 1
    assert data["expense_items"][0]["description"] == "从表格行同步的费用"


def test_report_expense_details_follow_confirmed_month_and_exclude_pending_rows(client, session):
    from app.models import ExpenseBankMatch

    store_id = client.post('/api/stores', json={'name': '报表导出口径店'}).json()['data']['id']
    matched = ExpenseItem(store_id=store_id, ledger_period='2026-08', description='八月审批九月入账',
                          amount=Decimal('50'), category_l1='食材成本', category_l2='鸡', source='manual')
    pending = ExpenseItem(store_id=store_id, ledger_period='2026-09', description='未对账未分类',
                          amount=Decimal('999'), source='manual')
    fee = ExpenseItem(store_id=store_id, ledger_period='2026-09', description='渠道手续费',
                      amount=Decimal('20'), category_l1='手续费', category_l2='美团手续费', source='revenue_fee')
    purchase = ExpenseItem(store_id=store_id, ledger_period='2026-09', description='快驴采购',
                           amount=Decimal('30'), category_l1='食材成本', category_l2='快驴采购', source='kuailv_purchase')
    bank = BankTransaction(store_id=store_id, ledger_period='2026-09', occurred_at=datetime(2026,9,1), direction='expense', amount=Decimal('50'))
    session.add_all([matched, pending, fee, purchase, bank]);session.flush()
    session.add(ExpenseBankMatch(bank_transaction_id=bank.id, expense_item_id=matched.id, amount=Decimal('50'), accounting_period='2026-09', status='confirmed'))
    session.commit()
    params = {'detail_type':'report_expense', 'store_id':store_id, 'period_start':'2026-09', 'period_end':'2026-09'}
    response = client.get('/api/reports/analytics/details', params=params)
    assert response.status_code == 200
    rows = response.json()['data']['expense_items']
    assert {row['description'] for row in rows} == {'八月审批九月入账', '渠道手续费', '快驴采购'}
    assert sum(Decimal(row['amount']) for row in rows) == Decimal('100')
    params['category_l2'] = '鸡'
    assert [row['id'] for row in client.get('/api/reports/analytics/details', params=params).json()['data']['expense_items']] == [matched.id]
