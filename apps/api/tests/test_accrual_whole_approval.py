from decimal import Decimal

from sqlalchemy import select
from test_accruals import matched_approval, setup_store

from app.models import AccrualApprovalLink, ExpenseItem


def test_whole_approval_batch_excludes_all_cost_and_revocation_restores(client, session):
    payload = setup_store(client, session)
    root = client.post("/api/accruals", json=payload).json()["data"]["id"]
    store = payload["store_id"]
    first, item, _, _ = matched_approval(session, store, "70000", suffix="first")
    second, _, _, _ = matched_approval(session, store, "30000", suffix="second")
    data = {
        "original_id": root,
        "approval_ids": [first.id, second.id],
        "remark": "已计提，整单不重复入账",
        "request_key": "whole-batch",
    }
    response = client.post("/api/accruals/links/batch", json=data)
    assert response.status_code == 200, response.text
    links = response.json()["data"]
    assert len(links) == 2 and all(row["whole_approval"] for row in links)
    assert sum(Decimal(row["amount"]) for row in links) == 100000
    assert client.post("/api/accruals/links/batch", json=data).json()["data"] == links

    def expense():
        response = client.get(f"/api/store-ledgers/{store}/report?period=2026-10")
        assert response.status_code == 200, response.text
        return response.json()["data"]["metrics"]["expense_amount"]

    assert expense() == "0.00"
    # Full exclusion follows the approval, rather than the amount at linkage time.
    session.get(ExpenseItem, item.id).amount = Decimal(80000)
    session.commit()
    assert expense() == "0.00"
    duplicate = client.post(
        "/api/accruals/links",
        json={
            "original_id": root,
            "approval_id": first.id,
            "remark": "重复关联",
            "request_key": "duplicate",
        },
    )
    assert duplicate.status_code == 409
    session.rollback()
    first_link = next(row for row in links if row["approval_id"] == first.id)
    response = client.post(
        f"/api/accruals/links/{first_link['id']}/revoke", json={"reason": "恢复正常入账"}
    )
    assert response.status_code == 200, response.text
    assert expense() == "80000.00"


def test_whole_approval_batch_failure_does_not_commit_partial_links(client, session):
    payload = setup_store(client, session)
    root = client.post("/api/accruals", json=payload).json()["data"]["id"]
    approval, _, _, _ = matched_approval(session, payload["store_id"], "70000", suffix="atomic")
    response = client.post(
        "/api/accruals/links/batch",
        json={
            "original_id": root,
            "approval_ids": [approval.id, "zz-missing"],
            "remark": "批量关联",
            "request_key": "atomic",
        },
    )
    assert response.status_code == 409, response.text
    session.rollback()
    assert not list(session.scalars(select(AccrualApprovalLink)))
