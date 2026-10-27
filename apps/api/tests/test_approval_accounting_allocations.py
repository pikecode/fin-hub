from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseCategory,
    ExpenseItem,
    Ledger,
    Store,
)
from app.modules.matching.accounting import allocation_matrix, read_plan
from app.modules.store_ledgers.router import calculate_store_ledger_profits


def setup(session, amounts=("30000", "15000", "15000")):
    store = Store(name="多账期门店")
    template = ApprovalTemplate(name="月度报销", process_code="accounting-periods")
    session.add_all([store, template])
    session.flush()
    approval = ApprovalInstance(
        template_id=template.id,
        store_id=store.id,
        dingtalk_instance_id="accounting-approval",
        approval_status="agree",
        approval_no="MULTI-001",
        submit_at=datetime(2026, 8, 25, tzinfo=UTC),
    )
    root = ExpenseCategory(name="食材成本")
    session.add_all([approval, root])
    session.flush()
    items = []
    for index, amount in enumerate(amounts):
        name = f"项目{index}"
        session.add(ExpenseCategory(name=name, parent_id=root.id))
        item = ExpenseItem(
            store_id=store.id,
            ledger_period="2026-08",
            expense_date=date(2026, 8, 25),
            description=name,
            amount=Decimal(amount),
            category_l1="食材成本",
            category_l2=name,
            source="dingtalk",
            user_edited_fields_json='["category_l1", "category_l2"]',
            source_document_id=f"accounting-approval:{index}",
            approval_instance_id=approval.id,
        )
        items.append(item)
        session.add(item)
    bank = BankTransaction(
        store_id=store.id,
        ledger_period="2026-09",
        occurred_at=datetime(2026, 9, 1, tzinfo=UTC),
        direction="expense",
        amount=sum(map(Decimal, amounts)),
        payment_status="paid",
    )
    session.add(bank)
    session.commit()
    return store, approval, items, bank


def candidate(client, items, bank, allocations=None, version=0):
    body = {
        "expense_item_id": items[0].id,
        "bank_transaction_id": bank.id,
        "amount": str(bank.amount),
        "accounting_period": "2026-09",
    }
    if allocations is not None:
        body.update(accounting_allocations=allocations, accounting_version=version)
    return client.post("/api/matches", json=body)


THREE = [{"period": month, "amount": "20000.00"} for month in ["2026-09", "2026-10", "2026-11"]]


def test_full_approval_split_once_per_month_categories_details_and_profit(client, session):
    store, approval, items, bank = setup(session)
    response = candidate(client, items, bank, THREE)
    assert response.status_code == 201, response.text
    mid = response.json()["data"]["id"]
    assert not read_plan(session, approval.id)["configured"]
    response = client.post(f"/api/matches/{mid}/confirm")
    assert response.status_code == 200, response.text
    assert len(response.json()["data"]["accounting_allocations"]) == 3
    session.expire_all()
    assert sum(item.amount for item in items) == Decimal(60000)
    for period in ["2026-09", "2026-10", "2026-11"]:
        report = client.get(f"/api/store-ledgers/{store.id}/report?period={period}")
        assert report.status_code == 200, report.text
        assert report.json()["data"]["metrics"]["expense_amount"] == "20000.00"
        category = client.get(
            f"/api/reports/analytics/details?detail_type=category&store_id={store.id}&period_start={period}&period_end={period}"
        )
        assert category.status_code == 200, category.text
        assert (
            sum(Decimal(item["amount"]) for item in category.json()["data"]["expense_items"])
            == 20000
        )
        expense_export = client.get(
            f"/api/reports/financial-appendix?store_id={store.id}&period={period}"
        )
        assert expense_export.status_code == 200, expense_export.text
        assert (
            sum(Decimal(item["amount"]) for item in expense_export.json()["data"]["expense_items"])
            == 20000
        )
        assert len(expense_export.json()["data"]["rows"]) == 1
        analytics = client.get(
            f"/api/reports/analytics?store_id={store.id}&period_start={period}&period_end={period}"
        )
        assert analytics.json()["data"]["metrics"]["total_expense_amount"] == "20000.00"
    assert calculate_store_ledger_profits(session, store.id, ["2026-09", "2026-10", "2026-11"]) == {
        p: Decimal(-20000) for p in ["2026-09", "2026-10", "2026-11"]
    }
    original = client.get(f"/api/store-ledgers/{store.id}/report?period=2026-08").json()["data"]
    assert original["metrics"]["expense_amount"] == "0.00"
    records = client.get(
        f"/api/matches/reconciliation/records?store_id={store.id}&accounting_period=2026-10"
    ).json()["data"]["items"]
    assert len(records) == 1
    assert len(records[0]["match"]["accounting_allocations"]) == 3
    assert session.scalar(
        select(Ledger).where(Ledger.store_id == store.id, Ledger.period == "2026-11")
    )


def test_another_payment_does_not_duplicate_and_last_unmatch_removes_all_months(client, session):
    store, _approval, items, bank = setup(session)
    first = candidate(client, items, bank, THREE).json()["data"]["id"]
    assert client.post(f"/api/matches/{first}/confirm").status_code == 200
    second = BankTransaction(
        store_id=store.id,
        ledger_period="2026-09",
        occurred_at=datetime(2026, 9, 2, tzinfo=UTC),
        direction="expense",
        amount=100,
        payment_status="paid",
    )
    session.add(second)
    session.commit()
    mid = candidate(client, items, second).json()["data"]["id"]
    assert client.post(f"/api/matches/{mid}/confirm").status_code == 200
    assert (
        client.get(f"/api/store-ledgers/{store.id}/report?period=2026-10").json()["data"][
            "metrics"
        ]["expense_amount"]
        == "20000.00"
    )
    assert client.post(f"/api/matches/reconciliation/records/{first}/unmatch").status_code == 200
    assert (
        client.get(f"/api/store-ledgers/{store.id}/report?period=2026-10").json()["data"][
            "metrics"
        ]["expense_amount"]
        == "20000.00"
    )
    assert client.post(f"/api/matches/reconciliation/records/{mid}/unmatch").status_code == 200
    assert (
        client.get(f"/api/store-ledgers/{store.id}/report?period=2026-10").json()["data"][
            "metrics"
        ]["expense_amount"]
        == "0.00"
    )


@pytest.mark.parametrize(
    "rows",
    [
        [{"period": "2026-09", "amount": "10000"}],
        [{"period": "2026-09", "amount": "30000"}, {"period": "2026-09", "amount": "30000"}],
        [{"period": "2026-13", "amount": "60000"}],
        [{"period": "2026-09", "amount": "-1"}, {"period": "2026-10", "amount": "60001"}],
    ],
)
def test_reject_invalid_allocations(client, session, rows):
    _, _, items, bank = setup(session)
    response = candidate(client, items, bank, rows)
    assert response.status_code == 422, response.text


def test_edit_schedule_single_period_closed_months_and_versions(client, session):
    store, _approval, items, bank = setup(session)
    mid = candidate(client, items, bank, THREE).json()["data"]["id"]
    assert client.post(f"/api/matches/{mid}/confirm").status_code == 200
    base = f"/api/matches/reconciliation/records/{mid}"
    changed = [{"period": "2026-09", "amount": "10000"}, {"period": "2026-10", "amount": "50000"}]
    response = client.patch(base, json={"accounting_allocations": changed, "accounting_version": 1})
    assert response.status_code == 200, response.text
    assert (
        client.patch(
            base, json={"accounting_allocations": THREE, "accounting_version": 1}
        ).status_code
        == 409
    )
    assert (
        client.get(f"/api/store-ledgers/{store.id}/report?period=2026-11").json()["data"][
            "metrics"
        ]["expense_amount"]
        == "0.00"
    )
    october = session.scalar(
        select(Ledger).where(Ledger.store_id == store.id, Ledger.period == "2026-10")
    )
    october.status = "closed"
    session.commit()
    assert (
        client.patch(
            base,
            json={
                "accounting_allocations": [{"period": "2026-09", "amount": "60000"}],
                "accounting_version": 2,
            },
        ).status_code
        == 409
    )
    assert client.post(base + "/unmatch").status_code == 409
    october.status = "open"
    session.commit()
    response = client.patch(
        base,
        json={
            "accounting_allocations": [{"period": "2026-09", "amount": "60000"}],
            "accounting_version": 2,
        },
    )
    assert response.status_code == 200, response.text
    assert (
        client.get(f"/api/store-ledgers/{store.id}/report?period=2026-09").json()["data"][
            "metrics"
        ]["expense_amount"]
        == "60000.00"
    )
    assert (
        client.get(f"/api/store-ledgers/{store.id}/report?period=2026-10").json()["data"][
            "metrics"
        ]["expense_amount"]
        == "0.00"
    )


def test_cent_rounding_conserves_both_dimensions(client, session):
    _, _, items, _ = setup(session, ("0.01", "0.01", "0.01"))
    rows = [{"period": p, "amount": "0.01"} for p in ["2026-09", "2026-10", "2026-11"]]
    matrix = allocation_matrix(items, rows)
    assert all(sum(values.values()) == 1 for values in matrix.values())
    assert all(sum(values.get(item.id, 0) for values in matrix.values()) == 1 for item in items)


def test_default_single_period_unchanged(client, session):
    store, approval, items, bank = setup(session)
    response = candidate(client, items, bank)
    assert response.status_code == 201, response.text
    assert (
        client.post("/api/matches/" + response.json()["data"]["id"] + "/confirm").status_code == 200
    )
    assert not read_plan(session, approval.id)["configured"]
    assert (
        client.get(f"/api/store-ledgers/{store.id}/report?period=2026-09").json()["data"][
            "metrics"
        ]["expense_amount"]
        == "60000.00"
    )
    assert (
        client.get(f"/api/store-ledgers/{store.id}/report?period=2026-10").json()["data"][
            "metrics"
        ]["expense_amount"]
        == "0.00"
    )


def test_nonoperating_categories_are_excluded_after_allocation(client, session):
    store, _, items, bank = setup(session, ("30000", "30000"))
    items[1].category_l1 = "备用金/借款"
    items[1].category_l2 = "备用金"
    session.commit()
    mid = candidate(client, items, bank, THREE).json()["data"]["id"]
    assert client.post(f"/api/matches/{mid}/confirm").status_code == 200
    for month in ["2026-09", "2026-10", "2026-11"]:
        assert (
            client.get(f"/api/store-ledgers/{store.id}/report?period={month}").json()["data"][
                "metrics"
            ]["expense_amount"]
            == "10000.00"
        )
        result = client.get(
            f"/api/reports/financial-appendix?store_id={store.id}&period={month}"
        ).json()["data"]
        assert sum(Decimal(item["amount"]) for item in result["expense_items"]) == 10000


def test_pending_candidate_cannot_overwrite_newer_plan(client, session):
    store, approval, items, bank = setup(session)
    mid = candidate(client, items, bank, THREE).json()["data"]["id"]
    assert client.post(f"/api/matches/{mid}/confirm").status_code == 200
    extra = []
    for day in [2, 3]:
        extra.append(
            BankTransaction(
                store_id=store.id,
                ledger_period="2026-09",
                occurred_at=datetime(2026, 9, day, tzinfo=UTC),
                direction="expense",
                amount=100,
                payment_status="paid",
            )
        )
    session.add_all(extra)
    session.commit()
    proposed = [{"period": "2026-09", "amount": "10000"}, {"period": "2026-10", "amount": "50000"}]
    pending = candidate(client, items, extra[0], proposed, 1)
    assert pending.status_code == 201, pending.text
    changed = client.patch(
        f"/api/matches/reconciliation/records/{mid}",
        json={
            "accounting_allocations": [
                {"period": "2026-09", "amount": "30000"},
                {"period": "2026-10", "amount": "30000"},
            ],
            "accounting_version": 1,
        },
    )
    assert changed.status_code == 200, changed.text
    assert (
        client.post("/api/matches/" + pending.json()["data"]["id"] + "/confirm").status_code == 409
    )
    session.refresh(extra[0])
    assert extra[0].matched_amount == 0
    assert read_plan(session, approval.id)["version"] == 2


def test_original_amount_and_closed_month_categories_cannot_bypass_plan(client, session):
    store, _approval, items, bank = setup(session)
    session.add(Ledger(store_id=store.id, period="2026-08", status="open"))
    session.commit()
    mid = candidate(client, items, bank, THREE).json()["data"]["id"]
    assert client.post(f"/api/matches/{mid}/confirm").status_code == 200
    response = client.patch(f"/api/expense-items/{items[0].id}", json={"amount": "31000"})
    assert response.status_code == 409, response.text
    assert "先解除匹配" in response.json()["detail"]
    october = session.scalar(
        select(Ledger).where(Ledger.store_id == store.id, Ledger.period == "2026-10")
    )
    october.status = "closed"
    session.commit()
    response = client.patch(f"/api/expense-items/{items[0].id}", json={"category_l2": "项目1"})
    assert response.status_code == 409, response.text
    assert "封账" in response.json()["detail"]
