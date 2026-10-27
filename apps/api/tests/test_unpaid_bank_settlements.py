from datetime import date, datetime
from decimal import Decimal

import pytest

from sqlalchemy import select, func
from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankBalanceCorrection,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
    Store,
    User,
)


def make_bank(session, store, amount, status="paid", day="2026-10-01", direction="expense"):
    bank = BankTransaction(
        store_id=store.id,
        ledger_period=day[:7],
        occurred_at=datetime.fromisoformat(day + "T12:00:00"),
        direction=direction,
        amount=Decimal(amount),
        payment_status=status,
        counterparty_name="工资代发",
    )
    session.add(bank)
    session.flush()
    return bank


def fixture_group(session):
    store = Store(name="未实付核对测试店")
    session.add(store)
    session.flush()
    session.add_all(
        [Ledger(store_id=store.id, period="2026-09"), Ledger(store_id=store.id, period="2026-10")]
    )
    source = make_bank(session, store, "60000", "unpaid", "2026-09-20")
    payments = [
        make_bank(session, store, amount, day=f"2026-10-0{i}")
        for i, amount in enumerate(["5000", "4000", "50800"], 1)
    ]
    user = session.scalar(select(User).where(User.role == "admin"))
    session.add(
        BankBalanceCorrection(
            store_id=store.id,
            correction_date=date(2026, 9, 1),
            balance_amount=100000,
            remark="测试基准",
            created_by=user.id,
        )
    )
    make_bank(session, store, "10000", "unreceived", direction="income")
    template = ApprovalTemplate(name="发薪审批", process_code="unpaid-salary")
    session.add(template)
    session.flush()
    approval = ApprovalInstance(
        template_id=template.id,
        dingtalk_instance_id="salary-plan",
        approval_no="SALARY-001",
        store_id=store.id,
        approval_status="agree",
    )
    session.add(approval)
    session.flush()
    expense = ExpenseItem(
        store_id=store.id,
        ledger_period="2026-09",
        expense_date=date(2026, 9, 20),
        description="工资",
        amount=60000,
        category_l1="人力成本",
        category_l2="工资",
        approval_instance_id=approval.id,
        source="dingtalk",
        source_document_id="salary-plan",
    )
    session.add(expense)
    session.flush()
    match = ExpenseBankMatch(
        bank_transaction_id=source.id,
        expense_item_id=expense.id,
        amount=60000,
        accounting_period="2026-09",
        status="confirmed",
        bank_occurred=False,
    )
    session.add(match)
    source.matched_amount = 60000
    session.commit()
    return store, source, payments, expense, match


def test_unpaid_balance_multiple_payments_final_difference_and_business_links(client, session):
    store, source, payments, expense, match = fixture_group(session)
    base = "/api/bank-payment-settlements/" + source.id
    balance = client.get("/api/bank-balance", params={"store_id": store.id}).json()["data"]
    assert balance["balance_amount"] == "40200.00"
    assert balance["income_after_base"] == "0.00" and balance["expense_after_base"] == "59800.00"
    ids = [b.id for b in payments]
    response = client.post(base + "/links", json={"bank_transaction_ids": ids})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["difference"] == "-200.00"
    assert client.post(base + "/complete", json={}).status_code == 422
    assert (
        client.post(
            base + "/complete", json={"confirm_difference": True, "remark": " "}
        ).status_code
        == 422
    )
    response = client.post(
        base + "/complete", json={"confirm_difference": True, "remark": "工资扣款差异已核实"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["status"] == "completed"
    session.expire_all()
    assert session.get(BankTransaction, source.id).is_archived
    assert session.get(ExpenseItem, expense.id).amount == Decimal("60000")
    assert session.get(ExpenseBankMatch, match.id).accounting_period == "2026-09"
    assert session.scalar(select(func.count()).select_from(ExpenseItem)) == 1
    listing = client.get("/api/bank-transactions", params={"store_id": store.id}).json()["data"][
        "items"
    ]
    assert source.id not in {b["id"] for b in listing}
    assert (
        next(b for b in listing if b["payment_status"] == "unreceived")["running_balance"] is None
    )
    assert (
        client.get("/api/bank-balance", params={"store_id": store.id}).json()["data"][
            "balance_amount"
        ]
        == "40200.00"
    )
    for payment in payments:
        detail = client.get("/api/bank-transactions/" + payment.id + "/business-detail").json()[
            "data"
        ]
        assert len(detail["expenses"]) == 1 and detail["expenses"][0]["approval_no"] == "SALARY-001"
        assert (
            client.patch("/api/bank-transactions/" + payment.id, json={"amount": "99"}).status_code
            == 409
        )
        assert client.delete("/api/bank-transactions/" + payment.id).status_code == 409
    records = client.get(
        "/api/matches/reconciliation/records",
        params={"store_id": store.id, "occurred_start": "2026-10-01", "occurred_end": "2026-10-31"},
    ).json()["data"]
    assert records["total"] == 1
    assert {b["id"] for b in records["items"][0]["settled_bank_transactions"]} == set(ids)
    assert (
        client.post("/api/matches/reconciliation/records/" + match.id + "/unmatch").status_code
        == 409
    )
    assert (
        client.post(
            base + "/complete", json={"confirm_difference": True, "remark": "重复"}
        ).status_code
        == 409
    )
    assert (
        client.get("/api/bank-payment-settlements", params={"store_id": store.id}).json()["data"][
            "total"
        ]
        == 0
    )
    assert (
        client.get(
            "/api/bank-payment-settlements", params={"store_id": store.id, "status": "completed"}
        ).json()["data"]["total"]
        == 1
    )
    report = client.get(
        "/api/reports/analytics",
        params={"store_id": store.id, "period_start": "2026-09", "period_end": "2026-10"},
    ).json()["data"]
    assert report["metrics"]["total_expense_amount"] == "60000.00"


def test_reservations_candidates_unlink_and_closed_period(client, session):
    store, source, payments, expense, match = fixture_group(session)
    other = Store(name="其他门店")
    session.add(other)
    session.flush()
    cross = make_bank(session, other, "60000")
    unpaid = make_bank(session, store, "60000", "unpaid")
    second = make_bank(session, store, "100", "unpaid")
    session.commit()
    base = "/api/bank-payment-settlements/" + source.id
    choices = client.get(base + "/candidates").json()["data"]
    assert {x["transaction"]["id"] for x in choices} == {p.id for p in payments}
    assert (
        client.post(base + "/links", json={"bank_transaction_ids": [cross.id]}).status_code == 409
    )
    assert (
        client.post(base + "/links", json={"bank_transaction_ids": [unpaid.id]}).status_code == 409
    )
    added = client.post(base + "/links", json={"bank_transaction_ids": [payments[0].id]})
    assert added.status_code == 200, added.text
    link_id = added.json()["data"]["links"][0]["id"]
    states = {
        b["id"]: b["payment_settlement_status"]
        for b in client.get("/api/bank-transactions", params={"store_id": store.id}).json()["data"][
            "items"
        ]
    }
    assert states[source.id] == states[payments[0].id] == "open"
    eligible_ids = {
        b["id"]
        for b in client.get(
            "/api/bank-transactions", params={"store_id": store.id, "exclude_special": "true"}
        ).json()["data"]["items"]
    }
    assert source.id not in eligible_ids and payments[0].id not in eligible_ids

    assert (
        client.post(
            "/api/bank-payment-settlements/" + second.id + "/links",
            json={"bank_transaction_ids": [payments[0].id]},
        ).status_code
        == 409
    )
    assert (
        client.patch(
            "/api/bank-transactions/" + payments[0].id, json={"summary": "占用中"}
        ).status_code
        == 409
    )
    assert client.delete(base + "/links/" + link_id).status_code == 200
    assert (
        client.patch(
            "/api/bank-transactions/" + payments[0].id, json={"summary": "已释放"}
        ).status_code
        == 200
    )
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store.id, Ledger.period == "2026-09")
    )
    ledger.status = "closed"
    session.commit()
    assert (
        client.post(base + "/links", json={"bank_transaction_ids": [payments[0].id]}).status_code
        == 409
    )


@pytest.mark.parametrize("paid_amount", ["90", "100", "110"])
def test_equal_amount_requires_explicit_final_action_and_does_not_generate_expense(
    client, session, paid_amount
):
    store = Store(name="无审批登记")
    session.add(store)
    session.flush()
    source = make_bank(session, store, "100", "unpaid")
    actual = make_bank(session, store, paid_amount)
    session.commit()
    base = "/api/bank-payment-settlements/" + source.id
    assert (
        client.post(base + "/links", json={"bank_transaction_ids": [actual.id]}).status_code == 200
    )
    session.expire_all()
    assert not session.get(BankTransaction, source.id).is_archived
    if paid_amount != "100":
        assert client.post(base + "/complete", json={}).status_code == 422
    payload = {} if paid_amount == "100" else {"confirm_difference": True, "remark": "差额已核实"}
    assert client.post(base + "/complete", json=payload).status_code == 200
    assert session.scalar(select(func.count()).select_from(ExpenseItem)) == 0


def test_remove_last_link_fully_releases_the_source_for_deletion(client, session):
    store = Store(name="移除草稿测试店")
    session.add(store)
    session.flush()
    source = make_bank(session, store, "100", "unpaid")
    real = make_bank(session, store, "100")
    session.commit()
    base = "/api/bank-payment-settlements/" + source.id
    response = client.post(base + "/links", json={"bank_transaction_ids": [real.id]})
    link_id = response.json()["data"]["links"][0]["id"]
    assert client.delete(base + "/links/" + link_id).status_code == 200
    assert client.delete("/api/bank-transactions/" + source.id).status_code == 200
    assert client.delete("/api/bank-transactions/" + real.id).status_code == 200
