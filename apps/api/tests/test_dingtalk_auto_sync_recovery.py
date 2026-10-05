import json
from datetime import timedelta
from decimal import Decimal
from unittest.mock import Mock

import pytest
from sqlalchemy import select, text

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    DingTalkAutoSyncSetting,
    ExpenseItem,
    Store,
    SyncJob,
    utc_now,
)
from app.modules.approvals.status import refresh_approval_processing_status
from app.modules.dingtalk import router as sync
from app.modules.dingtalk.sync_runtime import (
    SYNC_LOCK_KEY,
    recover_interrupted_sync_jobs,
    sync_lease,
)


def template_and_setting(session):
    template = ApprovalTemplate(name="测试报销", process_code="PROC-TEST", is_enabled=True)
    setting = DingTalkAutoSyncSetting(enabled=True, sync_departments=False, sync_templates=False, sync_approvals=True)
    session.add_all([template, setting])
    session.commit()
    return template, setting


def test_parse_failure_does_not_freeze_next_window(session, monkeypatch):
    template, setting = template_and_setting(session)
    previous_end = utc_now() - timedelta(days=4)
    setting.approval_watermark_at = previous_end
    setting.approval_resume_state = sync.serialize_auto_sync_resume_state(previous_end - timedelta(days=2), previous_end, {})
    session.commit()

    def fake_sync(session, *, job, **kwargs):
        job.failed_count = 1
        job.status = "failed"
        job.error_message = "Unable to resolve approval amount"
        job.finished_at = utc_now()
        job.raw_summary = json.dumps({"pull_completed": True, "parse_failed_count": 1})
        session.commit()

    monkeypatch.setattr(sync, "run_approval_sync", fake_sync)
    result = sync.execute_auto_sync(session, setting, started_by="test")
    assert result.job.status == "failed"
    assert setting.approval_watermark_at > previous_end
    assert setting.approval_resume_state is None
    assert result.job.request_end_at > previous_end


def test_incomplete_pull_keeps_watermark_and_cursor(session, monkeypatch):
    template, setting = template_and_setting(session)
    previous_end = utc_now() - timedelta(days=4)
    setting.approval_watermark_at = previous_end
    session.commit()

    def fake_sync(session, *, job, **kwargs):
        job.status = "failed"
        job.next_cursor = sync.serialize_sync_cursors({template.process_code: 10})
        job.raw_summary = json.dumps({"pull_completed": False})
        job.finished_at = utc_now()
        session.commit()

    monkeypatch.setattr(sync, "run_approval_sync", fake_sync)
    sync.execute_auto_sync(session, setting, started_by="test")
    assert setting.approval_watermark_at == previous_end
    assert sync.parse_auto_sync_resume_state(setting.approval_resume_state)[2] == {template.process_code: 10}


def test_transport_error_does_not_advance_watermark(session, monkeypatch):
    _, setting = template_and_setting(session)
    previous_end = utc_now() - timedelta(days=4)
    setting.approval_watermark_at = previous_end
    session.commit()
    monkeypatch.setattr(sync, "run_approval_sync", Mock(side_effect=RuntimeError("network down")))
    result = sync.execute_auto_sync(session, setting, started_by="test")
    assert result.job.status == "failed"
    assert setting.approval_watermark_at == previous_end
    assert result.job.error_message == "network down"


def test_orphan_recovered_but_newly_queued_job_preserved(session):
    old = SyncJob(job_type="dingtalk_auto_sync", status="running", created_at=utc_now()-timedelta(hours=2))
    session.add(old)
    session.commit()
    setting = DingTalkAutoSyncSetting(enabled=True, last_job_id=old.id)
    session.add(setting)
    session.commit()
    assert recover_interrupted_sync_jobs(session) == 1
    assert old.status == "failed"
    assert old.finished_at is not None
    assert setting.next_run_at <= utc_now()
    fresh = SyncJob(job_type="dingtalk_auto_sync", status="running")
    session.add(fresh)
    session.commit()
    assert recover_interrupted_sync_jobs(session) == 0
    assert fresh.status == "running"


def test_live_worker_lease_blocks_recovery_and_competing_worker(session):
    old = SyncJob(job_type="dingtalk_auto_sync", status="running", created_at=utc_now()-timedelta(hours=2))
    session.add(old)
    session.commit()
    with session.get_bind().connect() as connection:
        connection.execute(text("SELECT pg_advisory_lock(:key)"), {"key": SYNC_LOCK_KEY})
        connection.commit()
        try:
            assert recover_interrupted_sync_jobs(session) == 0
            with sync_lease(session) as acquired:
                assert acquired is False
            assert old.status == "running"
        finally:
            connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": SYNC_LOCK_KEY})
            connection.commit()


@pytest.mark.parametrize("status", ["TERMINATED", "refuse"])
def test_terminal_approval_saved_without_parse_failure(session, status):
    template, _ = template_and_setting(session)
    job = SyncJob(job_type="dingtalk_auto_sync", status="running")
    session.add(job)
    session.commit()
    raw = {"process_instance_id": "terminal-1", "status": status, "result": "agree" if status == "TERMINATED" else "refuse"}
    assert sync.sync_real_instance(session, template, job, raw) is True
    instance = session.scalar(select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == "terminal-1"))
    assert instance.approval_status == status
    assert instance.parse_error is None
    assert sync.approval_needs_detail_resync(instance) is False


def test_manual_status_survives_refresh_and_source_reparse(session):
    template, _ = template_and_setting(session)
    store = Store(name="测试门店", dingtalk_dept_id="test-dept")
    session.add(store)
    session.commit()
    instance = ApprovalInstance(template_id=template.id, dingtalk_instance_id="manual-1", store_id=store.id,
                                processing_status="manual_matched", approval_status="agree", parse_status="parsed")
    session.add(instance)
    session.commit()
    item = ExpenseItem(store_id=store.id, approval_instance_id=instance.id, ledger_period="2026-09", amount=Decimal("100"),
                       expense_date=utc_now(), description="测试", source="dingtalk", source_document_id="manual-1")
    session.add(item)
    session.commit()
    assert refresh_approval_processing_status(session, instance.id) == "manual_matched"
    job = SyncJob(job_type="dingtalk_auto_sync", status="running")
    session.add(job)
    session.commit()
    raw = {"process_instance_id": "manual-1", "result": "agree", "originator_dept_id": "test-dept", "create_time": "2026-09-01 10:00:00",
           "form_component_values": [{"name": "金额", "value": "100"}]}
    assert sync.sync_real_instance(session, template, job, raw) is True
    assert instance.processing_status == "manual_matched"


def test_classification_and_matching_are_not_source_retry_reasons():
    for status in ["pending_classification", "pending_match", "manual_matched", "sync_conflict"]:
        instance = ApprovalInstance(approval_status="agree", store_id="store", parse_status="parsed", processing_status=status)
        assert sync.approval_needs_detail_resync(instance) is False


def test_historical_retry_respects_cooldown_and_terminal_status(session, monkeypatch):
    template, _ = template_and_setting(session)
    now = utc_now()
    instances = [
        ApprovalInstance(template_id=template.id, dingtalk_instance_id="recent-error", approval_status="agree", parse_status="skipped", parse_error="missing amount", last_parsed_at=now),
        ApprovalInstance(template_id=template.id, dingtalk_instance_id="old-error", approval_status="agree", parse_status="skipped", parse_error="missing amount", last_parsed_at=now-timedelta(days=2)),
        ApprovalInstance(template_id=template.id, dingtalk_instance_id="terminal", approval_status="TERMINATED", parse_status="skipped"),
        ApprovalInstance(template_id=template.id, dingtalk_instance_id="running", approval_status="RUNNING", parse_status="skipped"),
    ]
    session.add_all(instances)
    job = SyncJob(job_type="dingtalk_auto_sync", status="running", request_start_at=now-timedelta(days=2), request_end_at=now)
    session.add(job)
    session.commit()
    client = Mock()
    client.list_process_instance_ids.return_value = ([], None)
    client.get_process_instance.side_effect = lambda instance_id: {"process_instance_id": instance_id}
    monkeypatch.setattr(sync, "should_use_real_dingtalk", lambda: True)
    monkeypatch.setattr(sync, "dingtalk_client", lambda config: client)
    monkeypatch.setattr(sync, "sync_real_instance", lambda *args: True)
    sync.run_approval_sync(session, job=job, templates=[template], page_size=10, max_pages=10)
    assert {call.args[0] for call in client.get_process_instance.call_args_list} == {"old-error", "running"}
    assert job.status == "succeeded"


def test_saved_approval_parse_warning_is_not_a_pull_failure(session, monkeypatch):
    template, setting = template_and_setting(session)
    client = Mock()
    client.list_process_instance_ids.return_value = (["warning-1"], None)
    client.get_process_instance.return_value = {"process_instance_id": "warning-1", "result": "agree"}
    monkeypatch.setattr(sync, "should_use_real_dingtalk", lambda: True)
    monkeypatch.setattr(sync, "dingtalk_client", lambda config: client)
    result = sync.execute_auto_sync(session, setting, started_by="test")
    assert result.job.status == "succeeded"
    assert result.job.failed_count == 1
    assert setting.approval_watermark_at == result.job.request_end_at
    assert setting.approval_resume_state is None
    instance = session.scalar(select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == "warning-1"))
    assert instance is not None and instance.parse_error
    assert json.loads(result.job.raw_summary)["approval_sync"]["parse_failed_count"] == 1


def test_local_development_does_not_run_shared_database_scheduler(monkeypatch):
    from app.core.config import settings
    from app.main import should_start_background_jobs
    monkeypatch.delenv("PYTEST_CURRENT_TEST", raising=False)
    monkeypatch.setattr(settings, "app_env", "local")
    assert should_start_background_jobs() is False
    monkeypatch.setattr(settings, "app_env", "production")
    assert should_start_background_jobs() is True
