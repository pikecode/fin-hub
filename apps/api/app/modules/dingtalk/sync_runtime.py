"""Database-backed execution lease and recovery for interrupted sync workers."""
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import timedelta
from functools import wraps

from fastapi import HTTPException
from sqlalchemy import or_, select, text
from sqlalchemy.orm import Session

from app.models import DingTalkAutoSyncSetting, SyncJob, utc_now
from app.modules.audit.service import write_audit_log

SYNC_LOCK_KEY = 2026093001
SYNC_JOB_TYPES = {"dingtalk_auto_sync", "dingtalk_approval_sync", "dingtalk_store_approval_sync"}
_lease_held: ContextVar[bool] = ContextVar("dingtalk_sync_lease", default=False)


@contextmanager
def sync_lease(session: Session) -> Iterator[bool]:
    if _lease_held.get():
        yield True
        return
    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        token = _lease_held.set(True)
        try:
            yield True
        finally:
            _lease_held.reset(token)
        return
    with bind.connect() as connection:
        acquired = bool(connection.scalar(text("SELECT pg_try_advisory_lock(:key)"), {"key": SYNC_LOCK_KEY}))
        connection.commit()
        if not acquired:
            yield False
            return
        token = _lease_held.set(True)
        try:
            yield True
        finally:
            _lease_held.reset(token)
            connection.execute(text("SELECT pg_advisory_unlock(:key)"), {"key": SYNC_LOCK_KEY})
            connection.commit()


def guarded_sync(function):
    @wraps(function)
    def wrapped(session: Session, *args, **kwargs):
        with sync_lease(session) as acquired:
            if not acquired:
                raise HTTPException(status_code=409, detail="已有钉钉同步进程正在执行，请稍后再试")
            return function(session, *args, **kwargs)
    return wrapped


def recover_interrupted_sync_jobs(session: Session) -> int:
    """Recover orphan jobs only when no worker owns the execution lease."""
    with sync_lease(session) as acquired:
        if not acquired:
            return 0
        now = utc_now()
        cutoff = now - timedelta(minutes=5)
        jobs = list(session.scalars(select(SyncJob).where(
            SyncJob.job_type.in_(SYNC_JOB_TYPES), SyncJob.status == "running", SyncJob.created_at < cutoff,
        )))
        for job in jobs:
            job.status = "failed"
            job.finished_at = now
            job.error_message = "同步执行进程已中断，已自动恢复任务状态；已保存的审批单保留，下次同步重新拉取未完成窗口"
            for setting in session.scalars(select(DingTalkAutoSyncSetting).where(or_(DingTalkAutoSyncSetting.last_job_id == job.id, job.job_type == "dingtalk_auto_sync"))):
                setting.last_job_id = job.id
                setting.last_status = "failed"
                setting.last_error = job.error_message
                setting.next_run_at = now
            write_audit_log(session, actor="auto-sync", action="dingtalk.sync.recover_interrupted",
                            resource_type="sync_job", resource_id=job.id, summary=job.error_message)
        if jobs:
            session.commit()
        return len(jobs)
