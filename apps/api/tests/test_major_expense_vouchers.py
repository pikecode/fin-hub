from decimal import Decimal

from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Attachment, ExpenseItem, Ledger


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


def test_update_delete_major_voucher_and_closed_ledger(client: TestClient, session: Session) -> None:
    store_id = client.post("/api/stores", json={"name": "凭证编辑门店"}).json()["data"]["id"]
    payload = {"store_id": store_id, "ledger_period": "2026-08", "expense_name": "房租",
               "display_amount": "1000", "remark": "原备注"}
    voucher = client.post("/api/expense-items/major-expense-vouchers", json=payload).json()["data"]
    item_id = voucher["id"]
    attachment = Attachment(resource_type="expense_item", resource_id=item_id, file_name="凭证.txt",
                            content_type="text/plain", file_path="test/voucher.txt", file_size=1)
    session.add(attachment)
    session.commit()
    attachment_id = attachment.id
    changes = {"ledger_period": "2026-09", "expense_name": "租金凭证", "display_amount": "2000",
               "remark": "新备注"}
    endpoint = f"/api/expense-items/major-expense-vouchers/{item_id}"
    response = client.patch(endpoint, json=changes)
    assert response.status_code == 200
    assert response.json()["data"]["attachment_count"] == 1
    assert response.json()["data"]["display_amount"] == "2000"
    assert response.json()["data"]["expense_name"] == "租金凭证"
    session.expire_all()
    assert session.get(ExpenseItem, item_id).amount == Decimal("0.00")
    assert client.get(f"/api/expense-items/major-expense-vouchers?store_id={store_id}&ledger_period=2026-08").json()["data"] == []
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store_id, Ledger.period == "2026-09"))
    ledger.status = "closed"
    session.commit()
    assert client.patch(endpoint, json=changes).status_code == 409
    assert client.delete(endpoint).status_code == 409
    ledger.status = "open"
    session.commit()
    assert client.delete(endpoint).status_code == 200
    session.expire_all()
    assert session.get(ExpenseItem, item_id) is None
    assert session.get(Attachment, attachment_id) is None
    assert client.delete(endpoint).status_code == 404
