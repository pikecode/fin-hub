from datetime import date
from decimal import Decimal

from test_accruals import matched_approval

from app.models import ExpenseItem, Store
from app.modules.reports.financial import historical_category_expenses


def test_category_history_uses_accounting_month_and_preserves_historical_categories(client, session):
    store = Store(name="累计支出测试")
    other = Store(name="隔离门店")
    session.add_all([store, other])
    session.commit()
    _, _, _, match = matched_approval(session, store.id, "100", period="2026-08")
    match.accounting_period = "2026-09"
    session.commit()
    for month, amount, l1, source, owner in [
        ("2026-08", "20", "食材成本", "kuailv_purchase", store.id),
        ("2026-09", "30", "食材成本", "kuailv_purchase", store.id),
        ("2026-09", "5", "手续费", "revenue_fee", store.id),
        ("2026-09", "7", "银行费用", "bank_direct", store.id),
        ("2026-09", "900", "异常费用", "kuailv_purchase", store.id),
        ("2026-09", "800", "未分类", "manual", store.id),
        ("2026-10", "1000", "食材成本", "kuailv_purchase", store.id),
        ("2026-09", "2000", "食材成本", "kuailv_purchase", other.id),
    ]:
        session.add(ExpenseItem(store_id=owner, ledger_period=month,
            expense_date=date.fromisoformat(month + "-01"), description="历史费用",
            amount=Decimal(amount), category_l1=l1, source=source))
    session.commit()
    early = {row["name"]: row["amount"] for row in historical_category_expenses(session, store.id, "2026-08")}
    assert early == {"食材成本": "20.00"}
    result = client.get(f"/api/reports/financial-supplement?store_id={store.id}&period=2026-09")
    assert result.status_code == 200, result.text
    amounts = {row["name"]: row["amount"] for row in result.json()["data"]["historical_category_expenses"]}
    assert amounts == {"食材成本": "50.00", "手续费": "5.00", "银行费用": "7.00", "人力成本 / 职工薪酬": "100.00"}
    later = {row["name"]: row["amount"] for row in historical_category_expenses(session, store.id, "2026-11")}
    assert later["食材成本"] == "1050.00"
    assert later["人力成本 / 职工薪酬"] == "100.00"


def test_category_history_accrual_adjustments_follow_cutoff(client, session):
    from test_accruals import setup_store

    payload = setup_store(client, session)
    response = client.post("/api/accruals", json=payload)
    assert response.status_code == 200, response.text
    original = response.json()["data"]["id"]
    for month, kind, amount in [("2026-10", "supplement", "5000"), ("2026-11", "reversal", "10000")]:
        response = client.post("/api/accruals", json={**payload, "original_id": original,
            "period": month, "entry_type": kind, "amount": amount, "request_key": kind})
        assert response.status_code == 200, response.text
    for month, expected in [("2026-09", "65000.00"), ("2026-10", "70000.00"), ("2026-11", "60000.00")]:
        assert historical_category_expenses(session, payload["store_id"], month) == [
            {"name": "人力成本 / 职工薪酬", "amount": expected}]
