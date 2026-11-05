import json
from datetime import datetime, timedelta
from decimal import Decimal
from unittest.mock import Mock

from sqlalchemy import func, select

from app.models import (
    ApprovalChangeNotice,
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
    Store,
    SyncJob,
    User,
    utc_now,
)
from app.modules.approval_notices import detect_source_change, mark_source_unavailable
from app.modules.dingtalk import router as sync


def reconciled(session):
    store = Store(name="审批变更测试门店")
    template = ApprovalTemplate(name="报销", process_code="change-test", is_enabled=True)
    session.add_all([store, template])
    session.flush()
    raw = {
        "process_instance_id": "approval-change-one",
        "business_id": "NOTICE-001",
        "result": "agree",
        "title": "报销",
        "create_time": "2026-09-01 12:00:00",
        "form_component_values": [{"id": "amount", "name": "金额", "value": "100"}],
    }
    approval = ApprovalInstance(
        template_id=template.id,
        dingtalk_instance_id=raw["process_instance_id"],
        approval_no=raw["business_id"],
        approval_status="agree",
        raw_payload=json.dumps(raw),
        store_id=store.id,
        parse_status="parsed",
        approved_at=utc_now() - timedelta(days=80),
        last_parsed_at=utc_now() - timedelta(days=2),
    )
    session.add(approval)
    session.flush()
    item = ExpenseItem(
        store_id=store.id,
        ledger_period="2026-09",
        description="原报销",
        amount=100,
        category_l1="运营费用",
        category_l2="差旅费",
        source="dingtalk",
        source_document_id=raw["process_instance_id"],
        approval_instance_id=approval.id,
    )
    bank = BankTransaction(
        store_id=store.id,
        ledger_period="2026-10",
        occurred_at=datetime.fromisoformat("2026-10-01T12:00:00"),
        direction="expense",
        amount=100,
        matched_amount=100,
    )
    session.add_all([item, bank])
    session.flush()
    session.add(
        ExpenseBankMatch(
            expense_item_id=item.id,
            bank_transaction_id=bank.id,
            amount=100,
            accounting_period="2026-09",
            status="confirmed",
        )
    )
    session.add(Ledger(store_id=store.id, period="2026-09", status="closed"))
    session.commit()
    return store, template, approval, item, raw


def test_changed_approval_notice_dedup_review_and_reopen(client, session):
    store, _, approval, item, raw = reconciled(session)
    incoming = {**raw, "form_component_values": [{"id": "amount", "name": "金额", "value": "120"}]}
    detect_source_change(session, approval, incoming)
    session.commit()
    detect_source_change(session, approval, incoming)
    session.commit()
    assert session.scalar(select(func.count()).select_from(ApprovalChangeNotice)) == 1
    result = client.get("/api/approval-change-notices", params={"store_id": store.id}).json()[
        "data"
    ]
    assert result["pending_count"] == 1
    row = result["items"][0]
    assert row["version"] == 1 and row["periods"] == row["closed_periods"] == ["2026-09"]
    assert "表单内容" in row["changed_fields"]
    assert row["before"]["表单内容"][0]["value"] == "100"
    assert row["after"]["表单内容"][0]["value"] == "120"
    assert (
        client.post(
            f"/api/approval-change-notices/{row['id']}/review", json={"version": 1, "note": " "}
        ).status_code
        == 422
    )
    assert (
        client.post(
            f"/api/approval-change-notices/{row['id']}/review",
            json={"version": 1, "note": "已核对，差额在下月补提"},
        ).status_code
        == 200
    )
    assert (
        client.get("/api/approval-change-notices", params={"store_id": store.id}).json()["data"][
            "pending_count"
        ]
        == 0
    )
    approval.raw_payload = json.dumps(incoming)
    session.commit()
    newer = {**incoming, "status": "TERMINATED"}
    detect_source_change(session, approval, newer)
    session.commit()
    assert (
        client.post(
            f"/api/approval-change-notices/{row['id']}/review",
            json={"version": 1, "note": "旧窗口"},
        ).status_code
        == 409
    )
    notice = session.get(ApprovalChangeNotice, row["id"])
    assert notice.status == "pending" and notice.version == 2
    assert session.get(ExpenseItem, item.id).amount == Decimal(100)
    assert client.get("/api/matches/reconciliation/records", params={"store_id": store.id}).json()[
        "data"
    ]["items"][0]["approval_change_pending"]


def test_real_sync_cancellation_keeps_pending_warning(client, session):
    store, template, _approval, item, raw = reconciled(session)
    job = SyncJob(job_type="dingtalk_approval_sync", status="running")
    session.add(job)
    session.flush()
    assert sync.sync_real_instance(session, template, job, {**raw, "status": "TERMINATED"})
    session.commit()
    result = client.get("/api/approval-change-notices", params={"store_id": store.id}).json()[
        "data"
    ]
    assert result["pending_count"] == 1
    assert "审批状态" in result["items"][0]["changed_fields"]
    assert session.get(ExpenseItem, item.id).amount == Decimal(100)


def test_unmatched_and_workflow_only_changes_do_not_notify(client, session):
    _, _, approval, _, raw = reconciled(session)
    detect_source_change(
        session, approval, {**raw, "tasks": [{"status": "done"}], "modify_time": "2026-11-03"}
    )
    session.commit()
    assert session.scalar(select(func.count()).select_from(ApprovalChangeNotice)) == 0
    for match in session.scalars(select(ExpenseBankMatch)):
        match.status = "rejected"
    session.commit()
    detect_source_change(session, approval, {**raw, "status": "TERMINATED"})
    session.commit()
    assert session.scalar(select(func.count()).select_from(ApprovalChangeNotice)) == 0


def test_disabled_or_other_store_users_cannot_review(client, session):
    store, _, approval, _, raw = reconciled(session)
    detect_source_change(session, approval, {**raw, "status": "TERMINATED"})
    session.commit()
    notice = session.scalar(select(ApprovalChangeNotice))
    user = session.scalar(select(User).where(User.username == "admin"))
    user.role = "viewer"
    session.commit()
    assert (
        client.post(
            f"/api/approval-change-notices/{notice.id}/review",
            json={"version": 1, "note": "无管理权限"},
        ).status_code
        == 403
    )
    assert (
        client.get("/api/approval-change-notices", params={"store_id": store.id}).status_code == 403
    )


def test_legacy_matched_approval_is_rechecked_outside_sync_window(client, session, monkeypatch):
    _, template, approval, _, raw = reconciled(session)
    job = SyncJob(job_type="dingtalk_auto_sync", status="running")
    session.add(job)
    session.commit()
    remote = Mock()
    remote.list_process_instance_ids.return_value = ([], None)
    remote.get_process_instance.return_value = {**raw, "status": "TERMINATED"}
    monkeypatch.setattr(sync, "should_use_real_dingtalk", lambda: True)
    monkeypatch.setattr(sync, "dingtalk_client", lambda _: remote)
    sync.run_approval_sync(session, job=job, templates=[template], page_size=10, max_pages=1)
    remote.get_process_instance.assert_called_once_with(approval.dingtalk_instance_id)
    assert session.scalar(select(func.count()).select_from(ApprovalChangeNotice)) == 1
    assert not sync.approval_detail_refresh_due(approval, monitor_matched=True)


def test_missing_source_is_not_silently_ignored(client, session):
    _, _, approval, _, raw = reconciled(session)
    mark_source_unavailable(session, approval)
    session.commit()
    mark_source_unavailable(session, approval)
    session.commit()
    notice = session.scalar(select(ApprovalChangeNotice))
    assert notice.version == 1
    assert "来源暂不可访问" in json.loads(notice.after_json)["审批状态"]
    detect_source_change(session, approval, raw)
    session.commit()
    assert notice.version == 2
    assert "来源恢复" in json.loads(notice.changed_fields_json)


def test_revised_approval_warns_original_reconciled_approval(client, session):
    _, template, approval, _, raw = reconciled(session)
    job = SyncJob(job_type="dingtalk_approval_sync", status="running")
    session.add(job)
    session.flush()
    revised = {
        **raw,
        "process_instance_id": "revision-new",
        "main_process_instance_id": approval.dingtalk_instance_id,
        "biz_action": "MODIFY",
        "status": "TERMINATED",
    }
    sync.sync_real_instance(session, template, job, revised)
    session.commit()
    notice = session.scalar(select(ApprovalChangeNotice))
    assert notice.approval_id == approval.id
    assert "原审批" in json.loads(notice.changed_fields_json)


def test_migration_backfills_existing_matched_conflict(client, session, monkeypatch):
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    store, _, _, item, _ = reconciled(session)
    item.sync_conflict_status = "amount_changed_after_matched"
    session.commit()
    ApprovalChangeNotice.__table__.drop(session.connection())
    filename = (
        Path(__file__).resolve().parents[1]
        / "alembic/versions/20261103_0039_approval_change_notices.py"
    )
    spec = importlib.util.spec_from_file_location("notice_migration", filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "op", Operations(MigrationContext.configure(session.connection())))
    module.upgrade()
    session.commit()
    result = client.get("/api/approval-change-notices", params={"store_id": store.id}).json()[
        "data"
    ]
    assert result["pending_count"] == 1
    assert "历史变更前快照不可用" in result["items"][0]["before"]["说明"]
