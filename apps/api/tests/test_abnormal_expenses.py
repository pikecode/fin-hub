from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
    RevenueRecord,
    Store,
)
from app.modules.store_ledgers.router import (
    calculate_store_ledger_profit,
    calculate_store_ledger_profits,
)


@pytest.mark.parametrize("paid", [False, True])
def test_abnormal_approved_expense_excluded_with_or_without_bank_match(client, session, paid):
    store = Store(name="异常费用测试门店")
    template = ApprovalTemplate(name="费用报销", process_code="abnormal-expenses")
    session.add_all([store, template])
    session.flush()
    approval = ApprovalInstance(
        template_id=template.id,
        store_id=store.id,
        dingtalk_instance_id="approved-but-not-payable",
        approval_no="ABNORMAL-001",
        approval_status="agree",
        submit_at=datetime(2026, 9, 2, tzinfo=UTC),
    )
    session.add(approval)
    session.flush()
    normal = ExpenseItem(
        store_id=store.id,
        ledger_period="2026-09",
        expense_date=date(2026, 9, 2),
        description="正常食材采购",
        amount=300,
        category_l1="食材成本",
        category_l2="肉类",
    )
    abnormal = ExpenseItem(
        store_id=store.id,
        ledger_period="2026-09",
        expense_date=date(2026, 9, 2),
        description="重复报销无需付款",
        amount=900,
        category_l1="异常费用",
        category_l2="重复报销" if paid else None,
        source="dingtalk",
        source_document_id=approval.dingtalk_instance_id,
        approval_instance_id=approval.id,
    )
    bank = BankTransaction(
        store_id=store.id,
        ledger_period="2026-09",
        occurred_at=datetime(2026, 9, 3, tzinfo=UTC),
        direction="expense",
        amount=300,
        matched_amount=300,
    )
    session.add_all(
        [
            normal,
            abnormal,
            bank,
            Ledger(store_id=store.id, period="2026-09"),
            RevenueRecord(
                store_id=store.id,
                ledger_period="2026-09",
                revenue_date=date(2026, 9, 1),
                channel="现金",
                gross_amount=1000,
                net_amount=1000,
                fee_amount=0,
            ),
        ]
    )
    session.flush()
    session.add(
        ExpenseBankMatch(
            expense_item_id=normal.id,
            bank_transaction_id=bank.id,
            amount=300,
            accounting_period="2026-09",
            status="confirmed",
        )
    )
    if paid:
        historical_bank = BankTransaction(
            store_id=store.id,
            ledger_period="2026-09",
            occurred_at=datetime(2026, 9, 3, tzinfo=UTC),
            direction="expense",
            amount=900,
            matched_amount=900,
        )
        session.add(historical_bank)
        session.flush()
        session.add(
            ExpenseBankMatch(
                expense_item_id=abnormal.id,
                bank_transaction_id=historical_bank.id,
                amount=900,
                accounting_period="2026-09",
                status="confirmed",
            )
        )
    session.commit()
    before_count = session.scalar(select(func.count()).select_from(BankTransaction))

    for endpoint in ("workspace", "report"):
        response = client.get(f"/api/store-ledgers/{store.id}/{endpoint}?period=2026-09")
        assert response.status_code == 200, response.text
        metrics = response.json()["data"]["metrics"]
        assert metrics["expense_amount"] == "300.00"
        assert metrics["gross_profit_amount"] == "700.00"
        assert all("异常费用" not in row["name"] for row in metrics["expense_category_summary"])
    assert calculate_store_ledger_profit(session, store.id, "2026-09") == Decimal(700)
    assert calculate_store_ledger_profits(session, store.id, ["2026-09"])["2026-09"] == Decimal(700)
    response = client.get(
        f"/api/reports/analytics?store_id={store.id}&period_start=2026-09&period_end=2026-09"
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["metrics"]["total_expense_amount"] == "300.00"
    response = client.get(f"/api/reports/financial-appendix?store_id={store.id}&period=2026-09")
    assert response.status_code == 200, response.text
    assert abnormal.id not in {item["id"] for item in response.json()["data"]["expense_items"]}
    response = client.get(f"/api/reports/ledger-detail?store_id={store.id}&period=2026-09")
    assert response.status_code == 200, response.text
    detail = response.json()["data"]
    assert detail["summary"]["expense_amount"] == "300.00"
    assert abnormal.id not in {item["id"] for item in detail["pending_expense_items"]}
    response = client.get(f"/api/reports/ledger-detail.csv?store_id={store.id}&period=2026-09")
    assert response.status_code == 200, response.text
    assert "正常食材采购" in response.text
    assert "重复报销无需付款" not in response.text
    # Excluding a cost must retain the approved record, and must not fabricate payment.
    assert session.get(ExpenseItem, abnormal.id).amount == Decimal(900)
    assert session.get(ApprovalInstance, approval.id).approval_status == "agree"
    assert session.scalar(select(func.count()).select_from(BankTransaction)) == before_count
