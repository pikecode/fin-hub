from datetime import date
from decimal import Decimal

from sqlalchemy import func, select
from test_bank_direct_posting import bank

from app.models import (
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    RevenueBankMatch,
    RevenueRecord,
    User,
    UserStorePermission,
)


def test_cross_period_notice_list_and_exact_source_preserve_report_amounts(client, session):
    store = client.post("/api/stores", json={"name": "跨期直接入账"}).json()["data"]["id"]
    hidden_fee = bank(client, store, "bank_fee", "100", "2026-10-31").json()["data"]
    hidden_interest = bank(client, store, "bank_interest", "100", "2026-10-31").json()["data"]
    bank(
        client, store, "bank_fee", "500", "2026-10-28", ledger_period="2026-10"
    ).json()["data"]
    bank(client, store, "bank_interest", "500", "2026-10-28", ledger_period="2026-10")
    bank(client, store, None, "50", "2026-10-28")
    bank(client, store, "bank_fee", "80", "2026-11-01")
    # The bank page omits ledger_period, even when entered from a dated workspace.
    all_rows = client.get("/api/bank-transactions", params={"store_id": store})
    assert all_rows.status_code == 200, all_rows.text
    assert all_rows.json()["data"]["total"] == 6
    november = client.get("/api/bank-transactions", params={
        "store_id": store, "occurred_from": "2026-11-01T00:00:00",
        "occurred_to": "2026-12-01T00:00:00",
    })
    assert november.status_code == 200, november.text
    assert november.json()["data"]["total"] == 1
    assert november.json()["data"]["items"][0]["ledger_period"] == "2026-09"
    before = {
        model.__tablename__: session.scalar(select(func.count()).select_from(model))
        for model in (ExpenseItem, RevenueRecord, BankTransaction)
    }
    report_url = f"/api/store-ledgers/{store}/report?period=2026-10"
    metrics = client.get(report_url).json()["data"]["metrics"]
    assert metrics["expense_amount"] == metrics["income_amount"] == "600.00"
    response = client.get(f"/api/bank-transactions?store_id={store}&ledger_period=2026-10")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["total"] == 2
    assert response.json()["data"]["items"][0]["accounting_periods"] == ["2026-10"]
    response = client.get(
        f"/api/bank-transactions/cross-period-direct-postings?store_id={store}&period=2026-10"
    )
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["count"] == 2
    assert Decimal(data["expense_amount"]) == Decimal(data["income_amount"]) == 100
    response = client.get(
        f"/api/bank-transactions?store_id={store}&posting_period=2026-10&cross_period_only=true"
    )
    assert {row["id"] for row in response.json()["data"]["items"]} == {
        hidden_fee["id"],
        hidden_interest["id"],
    }
    response = client.get(
        f"/api/bank-transactions?store_id={store}&transaction_id={hidden_fee['id']}"
    )
    assert response.json()["data"]["total"] == 1
    assert response.json()["data"]["items"][0]["ledger_period"] == "2026-09"
    from app.modules.bank.router import list_bank_transactions
    admin = session.scalar(select(User).where(User.username == "admin"))
    # The mobile bank endpoint calls this function directly, without FastAPI defaults.
    direct = list_bank_transactions(store_id=store, session=session, current_user=admin)
    assert direct.data.total == 6
    assert client.get(report_url).json()["data"]["metrics"] == metrics
    assert before == {
        model.__tablename__: session.scalar(select(func.count()).select_from(model))
        for model in (ExpenseItem, RevenueRecord, BankTransaction)
    }


def test_confirmed_periods_ignore_candidates_and_include_revenue_period(client, session):
    store = client.post("/api/stores", json={"name": "实际入账月"}).json()["data"]["id"]
    expense = bank(client, store, None, "100", "2026-10-31").json()["data"]
    revenue = bank(client, store, None, "100", "2026-10-31", direction="income").json()["data"]
    item = ExpenseItem(store_id=store, ledger_period="2026-09", description="真实费用", amount=100)
    session.add(item)
    session.flush()
    session.add_all(
        [
            ExpenseBankMatch(
                bank_transaction_id=expense["id"],
                expense_item_id=item.id,
                amount=100,
                status="confirmed",
                accounting_period="2026-11",
                accounting_allocations_json='[{"period":"2026-10","amount":"40"},{"period":"2026-11","amount":"60"}]',
            ),
            RevenueBankMatch(
                bank_transaction_id=revenue["id"],
                channel="现金",
                revenue_start_date=date(2026, 10, 1),
                revenue_end_date=date(2026, 10, 31),
                amount=100,
                status="confirmed",
                accounting_period="2026-10",
            ),
        ]
    )
    session.commit()
    response = client.get(f"/api/bank-transactions?store_id={store}")
    assert response.status_code == 200, response.text
    rows = {row["id"]: row for row in response.json()["data"]["items"]}
    assert rows[expense["id"]]["accounting_periods"] == ["2026-10", "2026-11"]
    assert rows[revenue["id"]]["accounting_periods"] == ["2026-10"]


def test_visibility_queries_archive_store_scope_and_validation(client, session):
    from app.core.security import hash_password

    store = client.post("/api/stores", json={"name": "范围一"}).json()["data"]["id"]
    other = client.post("/api/stores", json={"name": "范围二"}).json()["data"]["id"]
    item = bank(client, other, "bank_fee", "100", "2026-10-01").json()["data"]
    session.get(BankTransaction, item["id"]).is_archived = True
    session.commit()
    assert (
        client.get(
            f"/api/bank-transactions/cross-period-direct-postings?store_id={other}&period=2026-10"
        ).json()["data"]["count"]
        == 0
    )
    assert (
        client.get(f"/api/bank-transactions?store_id={store}&transaction_id={item['id']}").json()[
            "data"
        ]["total"]
        == 0
    )
    assert (
        client.get(f"/api/bank-transactions?store_id={store}&cross_period_only=true").status_code
        == 422
    )
    assert (
        client.get(f"/api/bank-transactions?store_id={store}&posting_period=2026-13").status_code
        == 422
    )
    assert (
        client.get(
            f"/api/bank-transactions/cross-period-direct-postings?store_id={store}&period=0000-01"
        ).status_code
        == 422
    )
    user = User(
        username="bank-scope",
        display_name="门店查看",
        role="finance",
        status="active",
        password_hash=hash_password("scope-pass"),
    )
    session.add(user)
    session.flush()
    session.add(UserStorePermission(user_id=user.id, store_id=store))
    session.commit()
    assert (
        client.post(
            "/api/auth/login", json={"username": "bank-scope", "password": "scope-pass"}
        ).status_code
        == 200
    )
    assert client.get(f"/api/bank-transactions/cross-period-direct-postings?store_id={store}&period=2026-10").status_code == 200
    assert (
        client.get(
            f"/api/bank-transactions/cross-period-direct-postings?store_id={other}&period=2026-10"
        ).status_code
        == 403
    )
