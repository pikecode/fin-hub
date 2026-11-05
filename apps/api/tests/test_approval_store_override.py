import json
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    AuditLog,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
    PreopeningStore,
    Store,
    SyncJob,
)
from app.modules.dingtalk import router as sync


def setup(session):
    old, target = Store(name="原报销门店"), Store(name="正确门店")
    template = ApprovalTemplate(name="报销", process_code="store-correction", is_enabled=True)
    job = SyncJob(job_type="dingtalk_auto_sync", status="running")
    session.add_all([old, target, template, job])
    session.flush()
    raw = {
        "process_instance_id": "store-correction-instance",
        "result": "agree",
        "create_time": "2026-09-20 10:00:00",
        "business_id": "CORRECTION-001",
        "form_component_values": [
            {"name": "报销门店", "value": old.name},
            {"name": "金额", "value": "100"},
        ],
    }
    assert sync.sync_real_instance(session, template, job, raw)
    session.commit()
    instance = session.scalar(
        select(ApprovalInstance).where(
            ApprovalInstance.dingtalk_instance_id == raw["process_instance_id"]
        )
    )
    item = session.scalar(
        select(ExpenseItem).where(ExpenseItem.approval_instance_id == instance.id)
    )
    return old, target, template, job, raw, instance, item


def test_correct_store_sync_preserves_and_restore_automatic(client, session):
    old, target, template, job, raw, instance, item = setup(session)
    endpoint = f"/api/dingtalk/approval-instances/{instance.id}/store"
    original_payload = instance.raw_payload
    response = client.patch(endpoint, json={"store_id": target.id, "reason": "填错门店"})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["manual_store_id"] == target.id
    session.refresh(item)
    assert item.store_id == target.id and item.amount == Decimal("100")
    assert instance.raw_payload == original_payload
    assert sync.build_approval_parse_preview(session, template, instance).store_id == target.id
    assert sync.sync_real_instance(session, template, job, raw)
    session.commit()
    session.refresh(item)
    assert item.store_id == target.id
    assert instance.store_id == target.id
    response = client.patch(endpoint, json={"store_id": None, "reason": "恢复原始识别"})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["manual_store_id"] is None
    session.refresh(item)
    assert item.store_id == old.id
    assert sync.sync_real_instance(session, template, job, raw)
    session.commit()
    assert instance.store_id == old.id
    audits = list(session.scalars(select(AuditLog).where(AuditLog.resource_id == instance.id)))
    assert len(audits) == 2


@pytest.mark.parametrize(
    "blocker",
    [
        "candidate",
        "confirmed",
        "manual_matched",
        "old_closed",
        "target_closed",
        "preopening_closed",
    ],
)
def test_store_correction_protects_accounting(client, session, blocker):
    old, target, _, _, _, instance, item = setup(session)
    if blocker in {"candidate", "confirmed"}:
        bank = BankTransaction(
            store_id=old.id,
            ledger_period=item.ledger_period,
            occurred_at=item.expense_date,
            direction="expense",
            amount=100,
        )
        session.add(bank)
        session.flush()
        session.add(
            ExpenseBankMatch(
                expense_item_id=item.id,
                bank_transaction_id=bank.id,
                amount=100,
                status=blocker,
                accounting_period=item.ledger_period,
            )
        )
    elif blocker == "manual_matched":
        instance.processing_status = "manual_matched"
    elif blocker == "preopening_closed":
        instance.expense_scope = "preopening"
        session.add(PreopeningStore(store_id=target.id, status="closed"))
    else:
        store_id = old.id if blocker == "old_closed" else target.id
        ledger = session.scalar(
            select(Ledger).where(Ledger.store_id == store_id, Ledger.period == item.ledger_period)
        )
        if ledger:
            ledger.status = "closed"
        else:
            session.add(Ledger(store_id=store_id, period=item.ledger_period, status="closed"))
    session.commit()
    response = client.patch(
        f"/api/dingtalk/approval-instances/{instance.id}/store",
        json={"store_id": target.id, "reason": "修正"},
    )
    assert response.status_code == 409, response.text
    session.rollback()
    session.refresh(item)
    assert item.store_id == old.id


def test_store_correction_validation_and_unresolved_source(client, session):
    old, target, _, _, _, instance, item = setup(session)
    endpoint = f"/api/dingtalk/approval-instances/{instance.id}/store"
    for payload in [
        {"store_id": target.id, "reason": "  "},
        {"store_id": "missing", "reason": "修正"},
    ]:
        assert client.patch(endpoint, json=payload).status_code == 422
    target.status = "inactive"
    session.commit()
    assert client.patch(endpoint, json={"store_id": target.id, "reason": "修正"}).status_code == 422
    target.status = "active"
    instance.store_id = None
    instance.raw_payload = json.dumps(
        {"form_component_values": [{"name": "报销门店", "value": "不存在的门店"}]}
    )
    session.commit()
    assert (
        client.patch(endpoint, json={"store_id": target.id, "reason": "人工补充"}).status_code
        == 200
    )
    assert client.patch(endpoint, json={"store_id": None, "reason": "恢复"}).status_code == 422
    session.refresh(instance)
    assert instance.store_id == target.id and instance.manual_store_id == target.id


def test_correct_store_moves_all_lines_and_legacy_lines_without_changing_expenses(client, session):
    old, target, _, _, _, instance, item = setup(session)
    item.category_l1, item.category_l2 = "食材成本", "鸡"
    legacy = ExpenseItem(
        store_id=old.id,
        ledger_period=item.ledger_period,
        expense_date=item.expense_date,
        description="历史明细",
        amount=20,
        source="dingtalk",
        source_document_id=instance.dingtalk_instance_id + ":legacy",
    )
    unrelated = ExpenseItem(
        store_id=old.id,
        ledger_period=item.ledger_period,
        expense_date=item.expense_date,
        description="其他单据",
        amount=30,
        source="manual",
    )
    session.add_all([legacy, unrelated])
    session.commit()
    response = client.patch(
        f"/api/dingtalk/approval-instances/{instance.id}/store",
        json={"store_id": target.id, "reason": "门店更正"},
    )
    assert response.status_code == 200, response.text
    for line in [item, legacy, unrelated]:
        session.refresh(line)
    assert item.store_id == legacy.store_id == target.id
    assert unrelated.store_id == old.id
    assert item.category_l1 == "食材成本" and item.category_l2 == "鸡"
    assert item.amount == 100 and legacy.amount == 20


def test_only_admin_can_correct_store(session):
    from types import SimpleNamespace
    from fastapi import HTTPException
    from app.modules.dingtalk.store_override import change_approval_store

    with pytest.raises(HTTPException) as error:
        change_approval_store(session, SimpleNamespace(role="viewer"), "unknown", "unknown", "更正")
    assert error.value.status_code == 403


def test_store_issue_filter_detects_source_and_expense_mismatch_and_clears_after_correction(client, session):
    old, target, template, job, raw, instance, item = setup(session)
    endpoint = "/api/dingtalk/approval-instances"
    params = {"store_issue_only": "true", "compact": "true", "page_size": 1}
    assert client.get(endpoint, params=params).json()["data"]["total"] == 0
    # Source form says old store, while both persisted records say another store.
    instance.store_id = target.id
    item.store_id = target.id
    session.commit()
    response = client.get(endpoint, params=params)
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["total"] == 1 and data["items"][0]["id"] == instance.id
    assert "来源门店" in data["items"][0]["store_issue"]
    assert client.get(endpoint, params={**params, "store_id": old.id}).json()["data"]["total"] == 0
    assert client.get(endpoint, params={**params, "keyword": "CORRECTION"}).json()["data"]["total"] == 1
    response = client.patch(f"{endpoint}/{instance.id}/store", json={"store_id": target.id, "reason": "人工确认目标门店"})
    assert response.status_code == 200, response.text
    # An intentional manual override must not be flagged just because source differs.
    assert client.get(endpoint, params=params).json()["data"]["total"] == 0
    item.store_id = old.id
    session.commit()
    response = client.get(endpoint, params=params)
    assert "费用明细" in response.json()["data"]["items"][0]["store_issue"]
    # Reads must never repair or mutate persisted assignments.
    session.refresh(item)
    assert item.store_id == old.id


def test_store_issue_filter_missing_and_unresolved_source(client, session):
    old, target, template, job, raw, instance, item = setup(session)
    instance.store_id = None
    session.commit()
    params = {"store_issue_only": "true", "page_size": 1, "page": 1}
    endpoint = "/api/dingtalk/approval-instances"
    data = client.get(endpoint, params=params).json()["data"]
    assert data["total"] == 1 and "未关联有效门店" in data["items"][0]["store_issue"]
    instance.store_id = old.id
    raw["form_component_values"][0]["value"] = "待确认的未知门店"
    instance.raw_payload = json.dumps(raw, ensure_ascii=False)
    session.commit()
    data = client.get(endpoint, params=params).json()["data"]
    assert data["total"] == 1 and "来源门店无法识别" in data["items"][0]["store_issue"]
    assert client.get(endpoint, params={**params, "page": 2}).json()["data"]["items"] == []
    # Default listing remains available and includes the original record.
    assert client.get(endpoint).json()["data"]["total"] == 1
