from datetime import datetime
from decimal import Decimal

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    Store,
)


def test_record_filters_combined_inclusive_dates_pagination_and_store_scope(client, session):
    store = Store(name="记录搜索门店")
    other = Store(name="其他门店")
    template = ApprovalTemplate(name="搜索测试报销", process_code="record-search")
    session.add_all([store, other, template])
    session.flush()

    def add_record(target, number, occurred, amount="100.25", status="confirmed"):
        approval = ApprovalInstance(
            template_id=template.id,
            dingtalk_instance_id=number + target.id,
            approval_no=number,
            store_id=target.id,
            approval_status="agree",
            parse_status="parsed",
        )
        session.add(approval)
        session.flush()
        expense = ExpenseItem(
            store_id=target.id,
            ledger_period="2026-09",
            description="搜索费用",
            amount=Decimal("1000"),
            approval_instance_id=approval.id,
            source="manual",
        )
        bank = BankTransaction(
            store_id=target.id,
            ledger_period="2026-09",
            occurred_at=datetime.fromisoformat(occurred),
            direction="expense",
            amount=Decimal("500"),
        )
        session.add_all([expense, bank])
        session.flush()
        match = ExpenseBankMatch(
            expense_item_id=expense.id,
            bank_transaction_id=bank.id,
            amount=Decimal(amount),
            status=status,
            accounting_period="2026-09",
        )
        session.add(match)
        session.flush()
        return match.id

    first = add_record(store, "SEARCH-001", "2026-09-01T00:00:00")
    last = add_record(store, "SEARCH-002", "2026-09-30T23:59:59.999999")
    add_record(store, "SEARCH-003", "2026-10-01T00:00:00")
    add_record(store, "SEARCH-004", "2026-09-20T12:00:00", "101")
    add_record(store, "DIFFERENT", "2026-09-20T12:00:00")
    add_record(store, "SEARCH-005", "2026-09-20T12:00:00", status="rejected")
    add_record(other, "SEARCH-006", "2026-09-20T12:00:00")
    session.commit()
    params = dict(
        store_id=store.id,
        amount="100.25",
        approval_no="SEARCH-",
        occurred_start="2026-09-01",
        occurred_end="2026-09-30",
    )
    response = client.get("/api/matches/reconciliation/records", params=params)
    assert response.status_code == 200
    data = response.json()["data"]
    assert data["total"] == 2
    assert {r["match"]["id"] for r in data["items"]} == {first, last}
    pages = [
        client.get(
            "/api/matches/reconciliation/records", params={**params, "page": p, "page_size": 1}
        ).json()["data"]
        for p in [1, 2]
    ]
    assert all(p["total"] == 2 and len(p["items"]) == 1 for p in pages)
    assert {p["items"][0]["match"]["id"] for p in pages} == {first, last}
    assert (
        client.get(
            "/api/matches/reconciliation/records", params={**params, "occurred_start": "2026-10-01"}
        ).status_code
        == 422
    )
    assert (
        client.get(
            "/api/matches/reconciliation/records", params={**params, "amount": "-1"}
        ).status_code
        == 422
    )
    assert (
        client.get(
            "/api/matches/reconciliation/records", params={**params, "approval_no": "%"}
        ).json()["data"]["total"]
        == 0
    )
