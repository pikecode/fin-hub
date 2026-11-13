"""Refresh changed sources independently before a financial write may proceed."""

import httpx
from fastapi import HTTPException
from sqlalchemy import select

from app.models import ApprovalInstance, ApprovalTemplate, SyncJob, utc_now
from app.modules.approval_notices import source_snapshot
from app.modules.matching.accounting import approval_for_item, approval_items


def verify_approval_source(session, item, actor):
    from app.modules.dingtalk import router as sync
    from app.modules.dingtalk.client import DingTalkClientError

    if item.source != "dingtalk" or not sync.should_use_real_dingtalk():
        return
    approval = approval_for_item(session, item)
    if approval is None:
        raise HTTPException(409, "审批来源关联缺失，请重新同步审批单")
    template = session.get(ApprovalTemplate, approval.template_id)
    if template is None or not template.is_enabled:
        raise HTTPException(409, "审批模板未启用，请先核对模板")
    try:
        client = sync.dingtalk_client(sync.get_or_create_config(session))
        client.timeout = 5.0
        client.retry_rate_limits = False
        raw = client.get_process_instance(approval.dingtalk_instance_id)
    except (DingTalkClientError, HTTPException, httpx.HTTPError):
        raise HTTPException(503, "暂时无法核验钉钉最新审批，请稍后重试；本次未确认匹配") from None
    if not isinstance(raw, dict) or not (
        "form_component_values" in raw or "formComponentValues" in raw
    ):
        raise HTTPException(503, "钉钉审批详情不完整，请稍后重试；本次未确认匹配")
    identity = raw.get("process_instance_id") or raw.get("processInstanceId")
    if identity and identity != approval.dingtalk_instance_id:
        raise HTTPException(503, "钉钉返回的审批单不一致，本次未确认匹配")
    raw.setdefault("process_instance_id", approval.dingtalk_instance_id)
    approval = session.scalar(
        select(ApprovalInstance)
        .where(ApprovalInstance.id == approval.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    previous = sync.approval_raw_payload(approval)
    if source_snapshot(previous, approval.approval_status) != source_snapshot(raw):
        # This function is called before caller mutations. Persist only the source
        # refresh, so returning 409 cannot roll it back or commit a partial match.
        job = SyncJob(
            job_type="dingtalk_match_verify",
            status="running",
            started_by=actor,
            started_at=utc_now(),
            processed_count=1,
        )
        session.add(job)
        session.flush()
        parsed = sync.sync_real_instance(session, template, job, raw)
        job.status = "succeeded" if parsed else "failed"
        job.success_count = int(parsed)
        job.failed_count = int(not parsed)
        job.finished_at = utc_now()
        session.commit()
        raise HTTPException(409, "审批状态或金额等内容已变更，已刷新来源；请刷新审批明细后重新匹配")
    session.refresh(item)
    lines = approval_items(session, approval.id)
    for line in lines:
        session.refresh(line)
    if sync.approval_source_status(raw).lower() not in sync.COMPLETED_APPROVAL_STATUSES:
        raise HTTPException(409, "该审批尚未通过、已退回或已撤回，不能确认匹配")
    if approval.parse_status != "parsed":
        raise HTTPException(409, "审批解析未完成或已被修订替代，请先同步核对")
    if any(line.sync_conflict_status not in (None, "none", "source_removed") for line in lines):
        raise HTTPException(409, "审批存在来源变更冲突，请先核对历史入账后再匹配")
