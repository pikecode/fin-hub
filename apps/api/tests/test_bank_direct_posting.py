from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models import ExpenseItem, Ledger, RevenueRecord


def bank(client, store_id, kind, amount="10", day="2026-10-01", **extra):
    return client.post(
        "/api/bank-transactions",
        json={
            "store_id": store_id,
            "ledger_period": "2026-09",
            "occurred_at": day + "T12:00:00",
            "direction": "income" if kind in {"bank_interest", "other_income"} else "expense",
            "amount": amount,
            "direct_posting_type": kind,
            "allow_duplicates": True,
            **extra,
        },
    )


@pytest.mark.parametrize(
    "kind, label", [("bank_interest", "银行结息"), ("other_income", "其他收入")]
)
def test_interest_aggregates_same_day_moves_month_and_withdraws(client, session, kind, label):
    store = client.post("/api/stores", json={"name": "直接结息门店"}).json()["data"]["id"]
    first = bank(client, store, kind, "10")
    assert first.status_code == 201, first.text
    first_id = first.json()["data"]["id"]
    second = bank(client, store, kind, "20")
    assert second.status_code == 201, second.text
    second_id = second.json()["data"]["id"]

    def entries():
        session.expire_all()
        return list(session.scalars(select(RevenueRecord).where(RevenueRecord.store_id == store)))

    rows = entries()
    assert len(rows) == 1 and rows[0].gross_amount == Decimal(30)
    assert rows[0].net_amount == Decimal(30) and rows[0].fee_amount == 0
    assert rows[0].ledger_period == "2026-10" and rows[0].channel == label
    assert (
        client.patch("/api/revenue-records/" + rows[0].id, json={"gross_amount": "999"}).status_code
        == 409
    )
    assert client.delete("/api/revenue-records/" + rows[0].id).status_code == 409
    assert (
        client.patch(
            "/api/bank-transactions/" + first_id,
            json={"occurred_at": "2026-11-01T12:00:00", "amount": "15"},
        ).status_code
        == 200
    )
    assert {r.ledger_period: r.gross_amount for r in entries()} == {
        "2026-10": Decimal(20),
        "2026-11": Decimal(15),
    }
    assert (
        client.patch(
            "/api/bank-transactions/" + second_id, json={"direct_posting_type": None}
        ).status_code
        == 200
    )
    assert len(entries()) == 1
    assert client.delete("/api/bank-transactions/" + first_id).status_code == 200
    assert not entries()


@pytest.mark.parametrize("kind", ["bank_fee", "bank_sms_fee", "bank_other_expense"])
def test_direct_expense_is_idempotent_and_closed_period_protected(client, session, kind):
    store = client.post("/api/stores", json={"name": "银行费用" + kind}).json()["data"]["id"]
    response = bank(client, store, kind, "8")
    assert response.status_code == 201, response.text
    bank_id = response.json()["data"]["id"]

    def item():
        session.expire_all()
        rows = list(
            session.scalars(
                select(ExpenseItem).where(
                    ExpenseItem.source == "bank_direct", ExpenseItem.source_document_id == bank_id
                )
            )
        )
        assert len(rows) == 1
        return rows[0]

    expense = item()
    assert expense.ledger_period == "2026-10"
    assert (expense.category_l1, expense.category_l2) == ("银行费用", "银行相关支出")
    assert (
        client.patch("/api/bank-transactions/" + bank_id, json={"amount": "9"}).status_code == 200
    )
    assert item().amount == Decimal(9)
    assert (
        client.patch("/api/expense-items/" + expense.id, json={"amount": "99"}).status_code == 409
    )
    excluded = client.get(
        "/api/bank-transactions", params={"store_id": store, "exclude_special": "true"}
    ).json()["data"]
    assert excluded["total"] == 0
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store, Ledger.period == "2026-10")
    )
    ledger.status = "closed"
    session.commit()
    assert (
        client.patch("/api/bank-transactions/" + bank_id, json={"amount": "99"}).status_code == 409
    )
    assert client.delete("/api/bank-transactions/" + bank_id).status_code == 409
    ledger.status = "open"
    session.commit()
    assert client.delete("/api/bank-transactions/" + bank_id).status_code == 200
    session.expire_all()
    assert session.get(ExpenseItem, expense.id) is None


def test_direct_posting_direction_special_conflicts_and_report_totals(client, session):
    store = client.post("/api/stores", json={"name": "直接入账报表"}).json()["data"]["id"]
    assert bank(client, store, "bank_interest", direction="expense").status_code == 422
    assert bank(client, store, "bank_fee", special_type="other_income_expense").status_code == 422
    assert bank(client, store, "bank_interest", "100").status_code == 201
    assert bank(client, store, "bank_fee", "3").status_code == 201
    assert bank(client, store, "bank_sms_fee", "2").status_code == 201
    assert bank(client, store, "bank_other_expense", "1").status_code == 201
    response = client.get(
        "/api/reports/analytics",
        params={"store_id": store, "period_start": "2026-10", "period_end": "2026-10"},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["metrics"]["total_income_amount"] == "100.00"
    assert data["metrics"]["total_expense_amount"] == "6.00"
    assert len(data["revenue_channels"]) == 1
    assert data["revenue_channels"][0]["channel"] == "银行结息"


def test_direct_posting_conversion_and_batch_deletion(client, session):
    store = client.post("/api/stores", json={"name": "直接入账转换"}).json()["data"]["id"]
    first = bank(client, store, "bank_fee", "10").json()["data"]["id"]
    converted = client.patch(
        "/api/bank-transactions/" + first,
        json={"direct_posting_type": "bank_interest", "direction": "income"},
    )
    assert converted.status_code == 200, converted.text
    session.expire_all()
    assert not list(
        session.scalars(select(ExpenseItem).where(ExpenseItem.source_document_id == first))
    )
    second = bank(client, store, "bank_interest", "5").json()["data"]["id"]
    response = client.request(
        "DELETE", "/api/bank-transactions/batch", json={"ids": [first, second]}
    )
    assert response.status_code == 200, response.text
    session.expire_all()
    assert not list(session.scalars(select(RevenueRecord).where(RevenueRecord.store_id == store)))


@pytest.mark.parametrize(
    "kind, label", [("bank_interest", "银行结息"), ("other_income", "其他收入")]
)
def test_direct_entries_cannot_be_matched_again(client, session, kind, label):
    store = client.post("/api/stores", json={"name": "直接入账不重复匹配"}).json()["data"]["id"]
    interest_id = bank(client, store, kind, "10").json()["data"]["id"]
    session.expire_all()
    revenue = session.scalar(select(RevenueRecord).where(RevenueRecord.store_id == store))
    response = client.post(
        "/api/matches/revenue/batch",
        json={
            "bank_transaction_id": interest_id,
            "amount": "10",
            "accounting_period": "2026-10",
            "channel": label,
            "revenue_record_ids": [revenue.id],
            "revenue_start_date": "2026-10-01",
            "revenue_end_date": "2026-10-01",
        },
    )
    assert response.status_code == 409, response.text


def test_other_income_report_separation_and_conversion(client, session):
    store = client.post("/api/stores", json={"name": "其他收入统计"}).json()["data"]["id"]
    first = bank(client, store, "other_income", "100")
    assert first.status_code == 201, first.text
    bank_id = first.json()["data"]["id"]
    assert bank(client, store, "other_income", "20").status_code == 201
    assert bank(client, store, "bank_interest", "30").status_code == 201
    response = client.get(
        "/api/reports/analytics",
        params={"store_id": store, "period_start": "2026-10", "period_end": "2026-10"},
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["metrics"]["total_income_amount"] == "150.00"
    assert data["metrics"]["total_expense_amount"] == "0.00"
    session.expire_all()
    rows = list(session.scalars(select(RevenueRecord).where(RevenueRecord.store_id == store)))
    assert {r.channel: r.net_amount for r in rows} == {
        "其他收入": Decimal(120),
        "银行结息": Decimal(30),
    }
    assert all(r.is_bank_direct and r.fee_amount == 0 for r in rows)
    assert bank(client, store, "other_income", direction="expense").status_code == 422
    assert (
        bank(client, store, "other_income", special_type="other_income_expense").status_code == 422
    )
    assert bank(client, store, "other_income", payment_status="unpaid").status_code == 422
    session.rollback()
    converted = client.patch(
        "/api/bank-transactions/" + bank_id,
        json={"direct_posting_type": "bank_fee", "direction": "expense"},
    )
    assert converted.status_code == 200, converted.text
    session.expire_all()
    assert session.scalar(
        select(RevenueRecord).where(
            RevenueRecord.store_id == store, RevenueRecord.channel == "其他收入"
        )
    ).net_amount == Decimal(20)
    expense = session.scalar(select(ExpenseItem).where(ExpenseItem.source_document_id == bank_id))
    assert expense.amount == Decimal(100)
    converted = client.patch(
        "/api/bank-transactions/" + bank_id,
        json={"direct_posting_type": "other_income", "direction": "income"},
    )
    assert converted.status_code == 200, converted.text
    session.expire_all()
    assert not session.scalar(select(ExpenseItem).where(ExpenseItem.source_document_id == bank_id))
    assert session.scalar(
        select(RevenueRecord).where(
            RevenueRecord.store_id == store, RevenueRecord.channel == "其他收入"
        )
    ).net_amount == Decimal(120)


def test_other_income_preserves_manual_channel_and_rejects_same_day_collision(client, session):
    from datetime import date

    from app.models import RevenueChannel

    store = client.post("/api/stores", json={"name": "其他收入手工兼容"}).json()["data"]["id"]
    channel = RevenueChannel(name="其他收入", requires_bank_match=True)
    session.add(channel)
    session.add(
        RevenueRecord(
            store_id=store,
            ledger_period="2026-10",
            revenue_date=date(2026, 10, 1),
            channel="其他收入",
            gross_amount=Decimal(50),
            net_amount=Decimal(50),
            is_bank_direct=False,
        )
    )
    session.commit()
    rejected = bank(client, store, "other_income", "10")
    assert rejected.status_code == 409, rejected.text
    assert "手工其他收入" in rejected.text
    session.rollback()
    assert bank(client, store, "other_income", "10", day="2026-10-02").status_code == 201
    session.expire_all()
    assert session.get(RevenueChannel, channel.id).requires_bank_match is True
    rows = list(session.scalars(select(RevenueRecord).where(RevenueRecord.store_id == store)))
    assert {(r.is_bank_direct, r.net_amount) for r in rows} == {
        (False, Decimal(50)),
        (True, Decimal(10)),
    }
