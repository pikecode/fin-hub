import json
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from unittest.mock import Mock

import pytest
from sqlalchemy import select

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    AuditLog,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseCategory,
    ExpenseItem,
    Ledger,
    Store,
    SyncJob,
    utc_now,
)
from app.modules.dingtalk import router as sync
from app.modules.dingtalk.client import DingTalkClientError


def fixture(session):
    store = Store(name="来源复查店")
    template = ApprovalTemplate(name="报销", process_code="source-verify", is_enabled=True)
    category = ExpenseCategory(name="运营费用")
    session.add_all([store, template, category])
    session.flush()
    session.add_all(
        [
            ExpenseCategory(name="差旅费", parent_id=category.id),
            Ledger(store_id=store.id, period="2026-10"),
        ]
    )
    job = SyncJob(job_type="dingtalk_approval_sync", status="succeeded")
    session.add(job)
    session.flush()
    raw = {
        "process_instance_id": "verify-one",
        "business_id": "VERIFY-001",
        "result": "agree",
        "status": "COMPLETED",
        "create_time": "2026-10-09 12:00:00",
        "form_component_values": [
            {"name": "报销门店", "value": store.name},
            {"name": "金额", "value": "654.19"},
        ],
    }
    assert sync.sync_real_instance(session, template, job, raw)
    approval = session.scalar(
        select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == "verify-one")
    )
    item = session.scalar(
        select(ExpenseItem).where(ExpenseItem.approval_instance_id == approval.id)
    )
    item.category_l1, item.category_l2 = "运营费用", "差旅费"
    item.user_edited_fields_json = '["category_l1", "category_l2"]'
    bank = BankTransaction(
        store_id=store.id,
        ledger_period="2026-10",
        direction="expense",
        occurred_at=datetime(2026, 10, 12, tzinfo=UTC),
        amount=Decimal("654.19"),
    )
    session.add(bank)
    session.commit()
    return template, approval, item, bank, raw


def propose(client, item, bank, amount="654.19"):
    return client.post(
        "/api/matches",
        json={
            "expense_item_id": item.id,
            "bank_transaction_id": bank.id,
            "amount": amount,
            "accounting_period": "2026-10",
        },
    )


def remote(monkeypatch, raw):
    api = Mock()
    api.get_process_instance.return_value = raw
    monkeypatch.setattr(sync, "should_use_real_dingtalk", lambda: True)
    monkeypatch.setattr(sync, "dingtalk_client", lambda _: api)
    return api


def test_live_confirmation_updates_source_rejects_cached_match_and_requires_refresh(
    client, session, monkeypatch
):
    _, approval, item, bank, raw = fixture(session)
    proposed = propose(client, item, bank)
    assert proposed.status_code == 201, proposed.text
    match_id = proposed.json()["data"]["id"]
    revised = {
        **raw,
        "form_component_values": [
            raw["form_component_values"][0],
            {"name": "金额", "value": "610.08"},
        ],
    }
    api = remote(monkeypatch, revised)
    response = client.post(f"/api/matches/{match_id}/confirm")
    assert response.status_code == 409, response.text
    session.expire_all()
    assert session.get(ExpenseItem, item.id).amount == Decimal("610.08")
    assert session.get(ExpenseBankMatch, match_id).status == "rejected"
    assert session.get(BankTransaction, bank.id).matched_amount == 0
    assert session.get(ApprovalInstance, approval.id).raw_payload != json.dumps(raw)
    assert client.post(f"/api/matches/{match_id}/confirm").status_code == 409
    proposed = propose(client, item, bank, "610.08")
    assert proposed.status_code == 201, proposed.text
    assert client.post(f"/api/matches/{proposed.json()['data']['id']}/confirm").status_code == 200
    assert api.get_process_instance.call_count == 3
    audit = session.scalar(select(AuditLog).where(AuditLog.action == "approval.source.updated"))
    metadata = json.loads(audit.metadata_json)
    assert metadata["before"]["表单内容"][-1]["value"] == "654.19"
    assert metadata["after"]["表单内容"][-1]["value"] == "610.08"


@pytest.mark.parametrize("status", ["TERMINATED", "refuse", "RUNNING", "RETURNED", "PAUSED"])
def test_changed_status_persists_and_prevents_matching(client, session, monkeypatch, status):
    _, approval, item, bank, raw = fixture(session)
    remote(monkeypatch, {**raw, "status": status})
    assert propose(client, item, bank).status_code == 409
    session.expire_all()
    assert session.get(ApprovalInstance, approval.id).approval_status == status
    assert propose(client, item, bank).status_code == 409
    assert session.scalar(select(ExpenseBankMatch)) is None


def test_failed_live_check_never_confirms_or_alters_source(client, session, monkeypatch):
    _, approval, item, bank, raw = fixture(session)
    proposed = propose(client, item, bank)
    match_id = proposed.json()["data"]["id"]
    api = remote(monkeypatch, raw)
    api.get_process_instance.side_effect = DingTalkClientError("source unavailable")
    assert client.post(f"/api/matches/{match_id}/confirm").status_code == 503
    session.expire_all()
    assert session.get(ExpenseBankMatch, match_id).status == "candidate"
    assert session.get(ExpenseItem, item.id).amount == Decimal("654.19")
    assert json.loads(session.get(ApprovalInstance, approval.id).raw_payload)["result"] == "agree"


def test_periodic_sync_rechecks_withdrawn_and_old_finished_outside_window(session, monkeypatch):
    template, approval, _, _, raw = fixture(session)
    approval.approval_status = "TERMINATED"
    approval.last_parsed_at = utc_now() - timedelta(days=2)
    approval.raw_payload = json.dumps({**raw, "status": "TERMINATED"})
    job = SyncJob(job_type="dingtalk_auto_sync", status="running")
    session.add(job)
    session.commit()
    api = remote(monkeypatch, raw)
    api.list_process_instance_ids.return_value = ([], None)
    sync.run_approval_sync(session, job=job, templates=[template], page_size=10, max_pages=1)
    assert approval.approval_status == "agree"
    api.get_process_instance.assert_called_once()
    approval.approved_at = approval.dingtalk_modified_at = utc_now() - timedelta(days=90)
    approval.last_parsed_at = utc_now() - timedelta(days=8)
    session.commit()
    assert sync.approval_detail_refresh_due(approval)
    api.get_process_instance.reset_mock()
    sync.run_approval_sync(session, job=job, templates=[template], page_size=10, max_pages=1)
    api.get_process_instance.assert_called_once()


def test_historical_queue_is_bounded_and_oldest_checks_go_first(session):
    template, approval, _, _, _ = fixture(session)
    approval.last_parsed_at = utc_now() - timedelta(days=8)
    older = ApprovalInstance(
        template_id=template.id,
        dingtalk_instance_id="older-withdrawn",
        approval_status="TERMINATED",
        last_parsed_at=utc_now() - timedelta(days=10),
    )
    session.add(older)
    session.commit()
    assert sync.historical_approval_refresh_ids(session, [template.id], set(), limit=1) == {
        older.id
    }
    older.last_parsed_at = utc_now()
    session.commit()
    assert sync.historical_approval_refresh_ids(session, [template.id], set(), limit=1) == {
        approval.id
    }


def test_confirmed_history_survives_source_change_and_blocks_additional_matches(
    client, session, monkeypatch
):
    from app.models import ApprovalChangeNotice

    template, _approval, item, bank, raw = fixture(session)
    proposal = propose(client, item, bank)
    match_id = proposal.json()["data"]["id"]
    assert client.post(f"/api/matches/{match_id}/confirm").status_code == 200
    revised = {
        **raw,
        "form_component_values": [
            raw["form_component_values"][0],
            {"name": "金额", "value": "610.08"},
        ],
    }
    job = SyncJob(job_type="dingtalk_approval_sync", status="succeeded")
    session.add(job)
    session.flush()
    assert sync.sync_real_instance(session, template, job, revised)
    session.commit()
    assert item.amount == Decimal("654.19")
    assert item.sync_conflict_status == "amount_changed_after_matched"
    assert session.get(ExpenseBankMatch, match_id).status == "confirmed"
    assert session.scalar(select(ApprovalChangeNotice)).status == "pending"
    remote(monkeypatch, revised)
    response = client.patch(
        f"/api/matches/reconciliation/records/{match_id}", json={"reason": "修改备注"}
    )
    assert response.status_code == 409, response.text
    assert session.get(ExpenseBankMatch, match_id).amount == Decimal("654.19")


@pytest.mark.parametrize(
    "failure", [{}, {"form_component_values": [], "process_instance_id": "wrong-id"}]
)
def test_incomplete_or_wrong_source_is_rejected_without_any_match(
    client, session, monkeypatch, failure
):
    _, _, item, bank, _ = fixture(session)
    remote(monkeypatch, failure)
    assert propose(client, item, bank).status_code == 503
    assert session.scalar(select(ExpenseBankMatch)) is None


def test_transport_timeout_is_a_retryable_failure(client, session, monkeypatch):
    import httpx

    _, _, item, bank, raw = fixture(session)
    api = remote(monkeypatch, raw)
    api.get_process_instance.side_effect = httpx.ReadTimeout("timeout")
    assert propose(client, item, bank).status_code == 503
    assert api.timeout == 5.0 and api.retry_rate_limits is False
    assert session.scalar(select(ExpenseBankMatch)) is None
