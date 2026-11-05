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
    confirmed_accounting_expense_rows,
)


@pytest.mark.parametrize("match_owner", ["line", "summary"])
def test_legacy_whole_approval_summary_is_not_counted_with_classified_lines(
    client, session, match_owner
):
    store = Store(name="金海报表去重测试")
    template = ApprovalTemplate(name="报销", process_code="summary-dedup")
    session.add_all([store, template])
    session.flush()
    approval = ApprovalInstance(
        store_id=store.id,
        template_id=template.id,
        dingtalk_instance_id="legacy_approval-id",
        approval_no="RENT-001",
        approval_status="agree",
    )
    session.add(approval)
    session.flush()

    def item(description, amount, source_id, category=None):
        return ExpenseItem(
            store_id=store.id,
            ledger_period="2026-10",
            expense_date=date(2026, 10, 26),
            description=description,
            amount=amount,
            source="dingtalk",
            source_document_id=source_id,
            approval_instance_id=approval.id,
            category_l1=category,
            category_l2="店铺租金管理费" if category else None,
        )

    summary = item("仓库租金费用和电费", "2459.20", approval.dingtalk_instance_id)
    # Old summaries may have no approval foreign key; matching must still discover the approval.
    summary.approval_instance_id = None
    lines = [
        item(
            "10月份仓库租金费用", "1300", approval.dingtalk_instance_id + ":line-1", "门店租管费用"
        ),
        item(
            "10月份仓库电费", "1159.20", approval.dingtalk_instance_id + ":line-2", "门店租管费用"
        ),
    ]
    independent = ExpenseItem(
        store_id=store.id,
        ledger_period="2026-10",
        expense_date=date(2026, 10, 26),
        description="另一笔相同金额的真实费用",
        source="dingtalk", source_document_id="standalone-approval",
        amount="2459.20",
    )
    session.add_all(
        [
            summary,
            *lines,
            independent,
            Ledger(store_id=store.id, period="2026-10"),
            RevenueRecord(
                store_id=store.id,
                ledger_period="2026-10",
                revenue_date=date(2026, 10, 1),
                channel="现金",
                gross_amount=10000,
                net_amount=10000,
                fee_amount=0,
            ),
        ]
    )
    session.flush()
    for owner in (summary if match_owner == "summary" else lines[1], independent):
        bank = BankTransaction(
            store_id=store.id,
            ledger_period="2026-10",
            occurred_at=datetime(2026, 10, 26, tzinfo=UTC),
            direction="expense",
            amount="2459.20",
            matched_amount="2459.20",
        )
        session.add(bank)
        session.flush()
        session.add(
            ExpenseBankMatch(
                expense_item_id=owner.id,
                bank_transaction_id=bank.id,
                amount="2459.20",
                status="confirmed",
                accounting_period="2026-10",
            )
        )
    session.commit()
    expected_ids = {independent.id, *(line.id for line in lines)}
    rows = confirmed_accounting_expense_rows(session, store.id, "2026-10")
    assert {row[0] for row in rows} == expected_ids
    assert sum(row[3] for row in rows) == Decimal("4918.40")
    assert calculate_store_ledger_profit(session, store.id, "2026-10") == Decimal("5081.60")
    assert calculate_store_ledger_profits(session, store.id, ["2026-10"])["2026-10"] == Decimal(
        "5081.60"
    )
    response = client.get(f"/api/store-ledgers/{store.id}/report?period=2026-10")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["metrics"]["expense_amount"] == "4918.40"
    response = client.get(f"/api/reports/financial-appendix?store_id={store.id}&period=2026-10")
    assert {row["id"] for row in response.json()["data"]["expense_items"]} == expected_ids
    response = client.get(
        f"/api/reports/analytics/details?detail_type=report_expense&store_id={store.id}&period_start=2026-10&period_end=2026-10&category_l1=未分类"
    )
    assert response.status_code == 200, response.text
    assert {row["id"] for row in response.json()["data"]["expense_items"]} == {independent.id}
    response = client.get(f"/api/reports/ledger-detail.csv?store_id={store.id}&period=2026-10")
    assert response.status_code == 200, response.text
    assert summary.description not in response.text
    assert all(line.description in response.text for line in lines)
    assert session.get(ExpenseItem, summary.id) is not None
    assert session.scalar(select(func.count()).select_from(ExpenseBankMatch)) == 2
