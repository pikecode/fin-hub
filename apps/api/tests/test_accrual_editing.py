from decimal import Decimal

import pytest
from sqlalchemy import select
from test_accruals import matched_approval, setup_store

from app.models import (
    AccrualApprovalLink,
    AccrualEntry,
    AuditLog,
    ExpenseCategory,
    ExpenseItem,
    Ledger,
    User,
)
from app.modules.store_ledgers.router import calculate_store_ledger_profit


def setup(client, session):
    payload = setup_store(client, session)
    response = client.post("/api/accruals", json=payload)
    assert response.status_code == 200, response.text
    root = response.json()["data"]
    response = client.post(
        "/api/accruals",
        json={
            **payload,
            "entry_type": "supplement",
            "period": "2026-10",
            "original_id": root["id"],
            "amount": "5000",
            "request_key": "extra",
        },
    )
    assert response.status_code == 200, response.text
    return root, response.json()["data"]


def update(client, row, **changes):
    expected = {
        key: row[key] for key in ("period", "category_l1", "category_l2", "amount", "remark")
    }
    return client.patch(
        f"/api/accruals/{row['id']}",
        json={**expected, "expected": expected, "reason": "纠正录入错误", **changes},
    )


def new_category(session):
    root = ExpenseCategory(name="运营费用")
    session.add(root)
    session.flush()
    session.add(ExpenseCategory(name="测试费用", parent_id=root.id))
    session.commit()


def test_edit_month_amount_remark_category_and_expense_mirrors(client, session):
    root, extra = setup(client, session)
    new_category(session)
    response = update(
        client,
        root,
        period="2026-10",
        amount="60000",
        remark="修正工资",
        category_l1="运营费用",
        category_l2="测试费用",
    )
    assert response.status_code == 200, response.text
    session.expire_all()
    for entry_id in (root["id"], extra["id"]):
        entry = session.get(AccrualEntry, entry_id)
        item = session.get(ExpenseItem, entry_id)
        assert item.category_l1 == entry.category_l1 == "运营费用"
        assert item.category_l2 == entry.category_l2 == "测试费用"
    assert session.get(ExpenseItem, root["id"]).description == "[计提] 修正工资"
    assert calculate_store_ledger_profit(session, root["store_id"], "2026-09") == 0
    assert calculate_store_ledger_profit(session, root["store_id"], "2026-10") == Decimal(-65000)
    log = session.scalar(select(AuditLog).where(AuditLog.action == "accrual.update"))
    assert "纠正录入错误" in log.metadata_json
    assert root["id"] in log.metadata_json and extra["id"] in log.metadata_json


@pytest.mark.parametrize("closed_period", ["2026-09", "2026-11"])
def test_closed_source_or_destination_rejects_edit(client, session, closed_period):
    root, _ = setup(client, session)
    session.scalar(
        select(Ledger).where(Ledger.store_id == root["store_id"], Ledger.period == closed_period)
    ).status = "closed"
    session.commit()
    response = update(client, root, period="2026-11")
    assert response.status_code == 409
    session.rollback()
    assert session.get(AccrualEntry, root["id"]).period == "2026-09"


def test_open_adjustment_edit_does_not_change_closed_original(client, session):
    root, extra = setup(client, session)
    session.scalar(
        select(Ledger).where(Ledger.store_id == root["store_id"], Ledger.period == root["period"])
    ).status = "closed"
    session.commit()
    response = update(client, extra, period="2026-11", amount="3000", remark="实际差额")
    assert response.status_code == 200, response.text
    assert calculate_store_ledger_profit(session, root["store_id"], "2026-09") == Decimal(-65000)
    assert calculate_store_ledger_profit(session, root["store_id"], "2026-10") == 0
    assert calculate_store_ledger_profit(session, root["store_id"], "2026-11") == Decimal(-3000)


def test_cannot_move_original_after_adjustment_or_over_reverse(client, session):
    root, extra = setup(client, session)
    assert update(client, root, period="2026-11").status_code == 409
    session.rollback()
    payload = {key: root[key] for key in ("store_id", "category_l1", "category_l2")}
    response = client.post(
        "/api/accruals",
        json={
            **payload,
            "period": "2026-11",
            "original_id": root["id"],
            "entry_type": "reversal",
            "amount": "69000",
            "remark": "冲销",
            "request_key": "reverse",
        },
    )
    assert response.status_code == 200, response.text
    assert update(client, extra, amount="1000").status_code == 409
    session.rollback()
    assert session.get(ExpenseItem, extra["id"]).amount == Decimal(5000)


def test_edit_conflict_and_input_validation(client, session):
    root, _ = setup(client, session)
    assert update(client, root, remark="已更正").status_code == 200
    assert update(client, root, amount="50000").status_code == 409
    session.rollback()
    current = client.get(f"/api/accruals?store_id={root['store_id']}").json()["data"]
    row = next(row for row in current if row["id"] == root["id"])
    for change in (
        {"amount": "-1"},
        {"amount": "0"},
        {"amount": "1.001"},
        {"remark": " "},
        {"reason": " "},
        {"entry_type": "reversal"},
    ):
        assert update(client, row, **change).status_code == 422
    assert update(client, row, category_l1="不存在", category_l2="不存在").status_code == 409


def test_coverage_floor_and_category_change_are_protected(client, session):
    root, _ = setup(client, session)
    approval, *_ = matched_approval(session, root["store_id"], "70000")
    user = session.scalar(select(User).where(User.username == "admin"))
    session.add(
        AccrualApprovalLink(
            original_id=root["id"],
            approval_id=approval.id,
            amount=60000,
            active=True,
            remark="已覆盖",
            request_key="coverage",
            created_by=user.id,
        )
    )
    session.commit()
    assert update(client, root, amount="1000").status_code == 409
    session.rollback()
    assert update(client, root, period="2026-10").status_code == 409
    session.rollback()
    new_category(session)
    assert update(client, root, category_l1="运营费用", category_l2="测试费用").status_code == 409
    session.rollback()
    assert update(client, root, remark="只更正备注").status_code == 200


def test_category_edit_rejects_closed_family_month(client, session):
    root, extra = setup(client, session)
    session.scalar(
        select(Ledger).where(Ledger.store_id == root["store_id"], Ledger.period == extra["period"])
    ).status = "closed"
    session.commit()
    new_category(session)
    assert update(client, root, category_l1="运营费用", category_l2="测试费用").status_code == 409
    session.rollback()
    assert session.get(ExpenseItem, root["id"]).category_l1 == "人力成本"


def remove(client, row, reason="确认重复录入，删除"):
    expected = {
        key: row[key] for key in ("period", "category_l1", "category_l2", "amount", "remark")
    }
    return client.request(
        "DELETE", f"/api/accruals/{row['id']}", json={"expected": expected, "reason": reason}
    )


def test_delete_adjustment_then_original_leaves_audit_and_blocks_old_retry(client, session):
    root, extra = setup(client, session)
    assert remove(client, root).status_code == 409
    session.rollback()
    assert remove(client, extra).status_code == 200
    assert calculate_store_ledger_profit(session, root["store_id"], extra["period"]) == 0
    assert remove(client, root).status_code == 200
    assert session.get(AccrualEntry, root["id"]) is None
    assert session.get(ExpenseItem, root["id"]) is None
    assert calculate_store_ledger_profit(session, root["store_id"], root["period"]) == 0
    assert (
        len(list(session.scalars(select(AuditLog).where(AuditLog.action == "accrual.delete")))) == 2
    )
    original_payload = {
        key: root[key]
        for key in (
            "store_id",
            "period",
            "category_l1",
            "category_l2",
            "amount",
            "remark",
            "request_key",
        )
    }
    assert client.post("/api/accruals", json=original_payload).status_code == 409


def test_delete_closed_record_or_delete_causing_over_reversal_rejected(client, session):
    root, extra = setup(client, session)
    response = client.post(
        "/api/accruals",
        json={
            **{key: root[key] for key in ("store_id", "category_l1", "category_l2")},
            "period": "2026-11",
            "entry_type": "reversal",
            "original_id": root["id"],
            "amount": "69000",
            "remark": "修正",
            "request_key": "reversal-delete-test",
        },
    )
    assert response.status_code == 200, response.text
    reversal = response.json()["data"]
    assert remove(client, extra).status_code == 409
    session.rollback()
    assert remove(client, reversal, " ").status_code == 422
    assert remove(client, reversal).status_code == 200
    session.scalar(
        select(Ledger).where(Ledger.store_id == root["store_id"], Ledger.period == extra["period"])
    ).status = "closed"
    session.commit()
    assert remove(client, extra).status_code == 409


def test_edit_reversal_keeps_signed_expense_and_detects_conflicting_delete(client, session):
    root, _ = setup(client, session)
    response = client.post(
        "/api/accruals",
        json={
            **{key: root[key] for key in ("store_id", "category_l1", "category_l2")},
            "period": "2026-11",
            "entry_type": "reversal",
            "original_id": root["id"],
            "amount": "1000",
            "remark": "修正",
            "request_key": "reversal-edit-test",
        },
    )
    row = response.json()["data"]
    assert update(client, row, amount="2000").status_code == 200
    assert session.get(ExpenseItem, row["id"]).amount == Decimal(-2000)
    assert remove(client, row).status_code == 409


def test_readonly_user_cannot_edit_or_delete(client, session):
    from app.core.security import hash_password

    root, _ = setup(client, session)
    session.add(
        User(
            username="accrual-viewer",
            display_name="只读",
            role="viewer",
            status="active",
            password_hash=hash_password("viewer-pass"),
        )
    )
    session.commit()
    assert (
        client.post(
            "/api/auth/login", json={"username": "accrual-viewer", "password": "viewer-pass"}
        ).status_code
        == 200
    )
    assert update(client, root, amount="1").status_code == 403
    assert remove(client, root).status_code == 403
