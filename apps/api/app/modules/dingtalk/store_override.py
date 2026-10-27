"""Audited store corrections, independent from DingTalk source form values."""

from fastapi import HTTPException
from sqlalchemy import select, or_

from app.models import (
    ApprovalInstance,
    ExpenseItem,
    ExpenseBankMatch,
    Ledger,
    PreopeningStore,
    Store,
)
from app.modules.auth.permissions import ensure_store_access
from app.modules.auth.router import audit_actor
from app.modules.audit.service import write_audit_log
from app.modules.bank.unpaid import mutation_lock


def change_approval_store(session, user, approval_id, target_id, reason):
    from app.modules.dingtalk.router import (
        approval_raw_payload,
        mapped_values_for_template,
        mapped_or_form_value,
        parse_text,
        resolve_store,
    )

    if user.role != "admin":
        raise HTTPException(403, "仅管理员可更正审批单门店")
    if not reason.strip():
        raise HTTPException(422, "请填写更正原因")
    mutation_lock(session)
    instance = session.scalar(
        select(ApprovalInstance).where(ApprovalInstance.id == approval_id).with_for_update()
    )
    if instance is None:
        raise HTTPException(404, "审批单不存在")
    if instance.store_id:
        ensure_store_access(session, user, instance.store_id)
    if target_id:
        target = session.get(Store, target_id)
    else:
        raw = approval_raw_payload(instance)
        mapped = mapped_values_for_template(session, instance.template_id, raw)
        text = parse_text(
            mapped_or_form_value(
                mapped, raw, "store", "支出门店", "门店", "费用门店", "所属门店", "报销门店"
            )
        ) or parse_text(mapped.get("store_name"))
        target = (
            resolve_store(session, text)
            or resolve_store(
                session, parse_text(raw.get("originator_dept_id") or raw.get("originatorDeptId"))
            )
            or resolve_store(
                session,
                parse_text(raw.get("originator_dept_name") or raw.get("originatorDeptName")),
            )
        )
    if target is None:
        raise HTTPException(422, "目标门店不存在或原始数据无法自动识别门店，请手动选择")
    if target.status != "active":
        raise HTTPException(422, "请选择启用状态的门店")
    ensure_store_access(session, user, target.id)
    items = list(
        session.scalars(
            select(ExpenseItem)
            .where(
                or_(
                    ExpenseItem.approval_instance_id == instance.id,
                    (ExpenseItem.approval_instance_id.is_(None))
                    & (ExpenseItem.source == "dingtalk")
                    & (
                        (ExpenseItem.source_document_id == instance.dingtalk_instance_id)
                        | ExpenseItem.source_document_id.startswith(
                            instance.dingtalk_instance_id + ":", autoescape=True
                        )
                    ),
                )
            )
            .with_for_update()
        )
    )
    if instance.processing_status == "manual_matched" or (
        items
        and session.scalar(
            select(ExpenseBankMatch.id)
            .where(
                ExpenseBankMatch.expense_item_id.in_([i.id for i in items]),
                ExpenseBankMatch.status.in_(["candidate", "confirmed"]),
            )
            .limit(1)
        )
    ):
        raise HTTPException(
            409, "审批单已有对账记录或已手动标记匹配，请先解除对账或撤销标记再更正门店"
        )
    store_ids = {i.store_id for i in items} | {instance.store_id, target.id}
    if instance.expense_scope == "preopening":
        if session.scalar(
            select(PreopeningStore.store_id)
            .where(
                PreopeningStore.store_id.in_([s for s in store_ids if s]),
                PreopeningStore.status == "closed",
            )
            .limit(1)
        ):
            raise HTTPException(409, "原门店或目标门店筹建报表已封账，不能更正")
    for item in items:
        for store_id in {item.store_id, target.id}:
            ledger = session.scalar(
                select(Ledger)
                .where(Ledger.store_id == store_id, Ledger.period == item.ledger_period)
                .with_for_update()
            )
            if ledger and ledger.status == "closed":
                raise HTTPException(409, "原门店或目标门店相关账期已封账，不能更正")
        if not session.scalar(
            select(Ledger.id).where(
                Ledger.store_id == target.id, Ledger.period == item.ledger_period
            )
        ):
            session.add(Ledger(store_id=target.id, period=item.ledger_period))
            session.flush()
    before = instance.store_id
    instance.store_id = target.id
    instance.manual_store_id = target.id if target_id else None
    instance.store_override_reason = reason.strip() if target_id else None
    for item in items:
        item.store_id = target.id
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="dingtalk.approval.store_override"
        if target_id
        else "dingtalk.approval.store_restore",
        resource_type="approval_instance",
        resource_id=instance.id,
        summary=f"审批单门店更正：{instance.approval_no or instance.id}",
        metadata={
            "old_store_id": before,
            "new_store_id": target.id,
            "manual": bool(target_id),
            "reason": reason.strip(),
        },
    )
