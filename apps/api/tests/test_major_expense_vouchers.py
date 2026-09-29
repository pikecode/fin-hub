from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import ExpenseItem


def test_major_expense_voucher_keeps_display_amount_but_records_zero_expense(
    client: TestClient,
    session: Session,
) -> None:
    store_id = client.post("/api/stores", json={"name": "主要支出凭证门店"}).json()["data"]["id"]

    response = client.post(
        "/api/expense-items/major-expense-vouchers",
        json={
            "store_id": store_id,
            "ledger_period": "2026-08",
            "expense_name": "主要支出凭证",
            "display_amount": "12345.67",
            "remark": "仅展示，不计入报表",
        },
    )

    assert response.status_code == 201
    voucher = response.json()["data"]
    assert voucher["expense_name"] == "主要支出凭证"
    assert voucher["display_amount"] == "12345.67"
    assert voucher["attachment_count"] == 0

    item = session.scalar(select(ExpenseItem).where(ExpenseItem.id == voucher["id"]))
    assert item is not None
    assert item.source == "major_expense_voucher"
    assert item.amount == Decimal("0.00")

    list_response = client.get(
        f"/api/expense-items/major-expense-vouchers?store_id={store_id}&ledger_period=2026-08"
    )

    assert list_response.status_code == 200
    items = list_response.json()["data"]
    assert len(items) == 1
    assert items[0]["id"] == voucher["id"]
    assert items[0]["display_amount"] == "12345.67"
