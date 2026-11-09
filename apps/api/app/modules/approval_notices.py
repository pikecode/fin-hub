"""Durable notices; reviewing a notice never changes accounting records."""

import json
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    AccrualApprovalLink,
    AccrualEntry,
    ApprovalAccountingAllocation,
    ApprovalChangeNotice,
    ApprovalInstance,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
    User,
    utc_now,
)
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import (
    ensure_permission,
    ensure_store_access,
    scoped_store_condition,
)
from app.modules.auth.router import audit_actor, get_current_user
from app.schemas import ApiEnvelope

router = APIRouter(prefix="/approval-change-notices", tags=["approval-change-notices"])
DB = Annotated[Session, Depends(get_session)]
Actor = Annotated[User, Depends(get_current_user)]


def source_snapshot(raw, fallback_status=None):
    from app.modules.dingtalk.router import approval_source_status

    fields = raw.get("form_component_values", raw.get("formComponentValues", []))
    if isinstance(fields, list):
        fields = sorted(
            fields,
            key=lambda row: (
                str(row.get("id", row.get("name", ""))) if isinstance(row, dict) else str(row)
            ),
        )
    return {
        "审批状态": "来源暂不可访问，需核实"
        if raw.get("_fin_hub_unavailable")
        else approval_source_status(raw)
        if raw
        else fallback_status,
        "审批单号": raw.get("business_id", raw.get("businessId")),
        "标题": raw.get("title"),
        "表单内容": fields,
        "申请时间": raw.get("create_time", raw.get("createTime")),
        "关联修订": sorted(str(x) for x in raw.get("attached_process_instance_ids", []) or []),
        "原审批": raw.get("main_process_instance_id"),
        "修订类型": raw.get("biz_action"),
    }


def matched_periods(session, approval):
    query = (
        select(ExpenseItem.store_id, ExpenseBankMatch.accounting_period)
        .join(ExpenseBankMatch, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
        .where(
            ExpenseBankMatch.status == "confirmed",
            ExpenseBankMatch.expense_scope == "operating",
            or_(
                ExpenseItem.approval_instance_id == approval.id,
                ExpenseItem.source_document_id == approval.dingtalk_instance_id,
                ExpenseItem.source_document_id.startswith(
                    approval.dingtalk_instance_id + ":", autoescape=True
                ),
            ),
        )
    )
    result = {}
    allocations = list(
        session.scalars(
            select(ApprovalAccountingAllocation.period).where(
                ApprovalAccountingAllocation.approval_id == approval.id
            )
        )
    )
    for store_id, period in session.execute(query):
        if store_id:
            result.setdefault(store_id, set()).update([p for p in [period, *allocations] if p])
    for store_id, period in session.execute(select(AccrualEntry.store_id, AccrualEntry.period).join(AccrualApprovalLink, AccrualApprovalLink.original_id == AccrualEntry.id).where(AccrualApprovalLink.approval_id == approval.id, AccrualApprovalLink.active.is_(True))):
        result.setdefault(store_id, set()).add(period)
    return result


def detect_source_change(session, approval, incoming):
    if approval is None:
        return
    stores = matched_periods(session, approval)
    if not stores:
        return
    try:
        previous = json.loads(approval.raw_payload or "{}")
    except (ValueError, TypeError):
        previous = {}
    if not isinstance(previous, dict):
        previous = {}
    before = source_snapshot(previous, approval.approval_status)
    if not previous:
        before["说明"] = "旧来源快照缺失，需对照已入账费用核实，不能推断原表单内容"
    after = source_snapshot(incoming)
    changed = [key for key in after if before.get(key) != after[key]]
    if not changed:
        # A missing source may recover without changing its original raw payload.
        missing_notice = session.scalar(
            select(ApprovalChangeNotice)
            .where(
                ApprovalChangeNotice.approval_id == approval.id,
                ApprovalChangeNotice.store_id.in_(stores),
            )
            .limit(1)
        )
        if (
            not missing_notice
            or json.loads(missing_notice.after_json).get("审批状态") != "来源暂不可访问，需核实"
        ):
            return
        changed = ["审批状态", "来源恢复"]
        after["来源恢复"] = "来源已恢复可访问，请核实原异常是否仍需更正"
    for store_id, periods in stores.items():
        notice = session.scalar(
            select(ApprovalChangeNotice)
            .where(
                ApprovalChangeNotice.approval_id == approval.id,
                ApprovalChangeNotice.store_id == store_id,
            )
            .with_for_update()
        )
        serialized = json.dumps(after, ensure_ascii=False, sort_keys=True, default=str)
        if notice and notice.after_json == serialized:
            continue
        if notice is None:
            notice = ApprovalChangeNotice(
                approval_id=approval.id,
                store_id=store_id,
                before_json=json.dumps(before, ensure_ascii=False, default=str),
            )
            session.add(notice)
        else:
            if notice.status == "reviewed":
                notice.before_json = json.dumps(before, ensure_ascii=False, default=str)
                notice.changed_fields_json = "[]"
            notice.version += 1
        old_fields = json.loads(notice.changed_fields_json or "[]")
        old_periods = json.loads(notice.periods_json or "[]")
        notice.after_json = serialized
        notice.changed_fields_json = json.dumps(
            sorted(set(old_fields) | set(changed)), ensure_ascii=False
        )
        notice.periods_json = json.dumps(sorted(set(old_periods) | periods))
        notice.status = "pending"
        notice.detected_at = utc_now()
        notice.reviewed_at = None
        notice.reviewed_by = None
        notice.review_note = None
        session.flush()
        write_audit_log(
            session,
            actor="dingtalk-sync",
            action="approval.change.detected",
            resource_type="approval_change_notice",
            resource_id=notice.id,
            summary="已对账审批来源发生变更，需核对财务报表",
            metadata={
                "version": notice.version,
                "approval_id": approval.id,
                "fields": changed,
                "periods": sorted(periods),
            },
        )


def mark_source_unavailable(session, approval):
    if approval is None:
        return
    try:
        raw = json.loads(approval.raw_payload or "{}")
    except (ValueError, TypeError):
        raw = {}
    detect_source_change(
        session, approval, {**(raw if isinstance(raw, dict) else {}), "_fin_hub_unavailable": True}
    )


def serialize_notice(session, notice, approval):
    periods = json.loads(notice.periods_json)
    closed = list(
        session.scalars(
            select(Ledger.period).where(
                Ledger.store_id == notice.store_id,
                Ledger.period.in_(periods),
                Ledger.status == "closed",
            )
        )
    )
    return {
        "id": notice.id,
        "approval_id": notice.approval_id,
        "approval_no": approval.approval_no or approval.dingtalk_instance_id,
        "store_id": notice.store_id,
        "status": notice.status,
        "version": notice.version,
        "before": json.loads(notice.before_json),
        "after": json.loads(notice.after_json),
        "changed_fields": json.loads(notice.changed_fields_json),
        "periods": periods,
        "closed_periods": closed,
        "detected_at": notice.detected_at,
        "reviewed_at": notice.reviewed_at,
        "review_note": notice.review_note,
    }


@router.get("")
def list_notices(
    session: DB,
    user: Actor,
    store_id: str | None = None,
    include_reviewed: bool = False,
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=20, ge=1, le=100),
):
    ensure_permission(session, user, "reconciliation.view")
    query = select(ApprovalChangeNotice, ApprovalInstance).join(
        ApprovalInstance, ApprovalInstance.id == ApprovalChangeNotice.approval_id
    )
    if store_id:
        ensure_store_access(session, user, store_id)
        query = query.where(ApprovalChangeNotice.store_id == store_id)
    else:
        query = query.where(scoped_store_condition(session, user, ApprovalChangeNotice.store_id))
    pending = (
        session.scalar(
            select(func.count()).select_from(
                query.where(ApprovalChangeNotice.status == "pending").subquery()
            )
        )
        or 0
    )
    if not include_reviewed:
        query = query.where(ApprovalChangeNotice.status == "pending")
    total = session.scalar(select(func.count()).select_from(query.subquery())) or 0
    rows = session.execute(
        query.order_by(ApprovalChangeNotice.detected_at.desc(), ApprovalChangeNotice.id)
        .offset((page - 1) * page_size)
        .limit(page_size)
    )
    return ApiEnvelope(
        data={
            "items": [serialize_notice(session, row, approval) for row, approval in rows],
            "total": total,
            "pending_count": pending,
            "page": page,
            "page_size": page_size,
        }
    )


class ReviewNotice(BaseModel):
    version: int = Field(ge=1)
    note: str = Field(min_length=1, max_length=2000)


@router.post("/{notice_id}/review")
def review_notice(notice_id: str, payload: ReviewNotice, session: DB, user: Actor):
    ensure_permission(session, user, "reconciliation.manage")
    notice = session.scalar(
        select(ApprovalChangeNotice).where(ApprovalChangeNotice.id == notice_id).with_for_update()
    )
    if notice is None:
        raise HTTPException(404, "提醒不存在")
    ensure_store_access(session, user, notice.store_id)
    if notice.version != payload.version:
        raise HTTPException(409, "审批又有新变更，请重新查看后核对")
    if not payload.note.strip():
        raise HTTPException(422, "请填写核对结果、报表更正方式或无需调整原因")
    if notice.status == "pending":
        notice.status = "reviewed"
        notice.review_note = payload.note.strip()
        notice.reviewed_at = utc_now()
        notice.reviewed_by = user.id
        write_audit_log(
            session,
            actor=audit_actor(user),
            action="approval.change.reviewed",
            resource_type="approval_change_notice",
            resource_id=notice.id,
            summary="人工核对审批变更（不自动调整报表）",
            metadata={"version": notice.version, "note": notice.review_note},
        )
        session.commit()
    return ApiEnvelope(data={"reviewed": True})
