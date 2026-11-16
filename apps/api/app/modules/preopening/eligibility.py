"""Candidate visibility is read-only; mutation locks claim the whole approval."""

from fastapi import HTTPException
from sqlalchemy import and_, exists, func, or_, select
from sqlalchemy.orm import Session

from app.models import (
    AccrualApprovalLink,
    ApprovalAccountingPlan,
    ApprovalInstance,
    ApprovalPaidAccounting,
    ApprovalTemplate,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
    PreopeningStore,
)


def dual_unclaimed(approval=ApprovalInstance):
    item = ExpenseItem.__table__.alias("scope_item")
    match = ExpenseBankMatch.__table__.alias("scope_match")
    item_belongs = or_(
        item.c.approval_instance_id == approval.id,
        and_(
            item.c.approval_instance_id.is_(None),
            item.c.source == "dingtalk",
            item.c.store_id == approval.store_id,
            or_(
                item.c.source_document_id == approval.dingtalk_instance_id,
                func.starts_with(item.c.source_document_id, approval.dingtalk_instance_id + ":"),
            ),
        ),
    )
    occupied = exists(
        select(1)
        .select_from(item.join(match, item.c.id == match.c.expense_item_id))
        .where(
            item_belongs,
            match.c.status.in_(["candidate", "confirmed"]),
        )
        .correlate(approval)
    )
    return and_(
        exists(
            select(1)
            .where(
                ApprovalTemplate.id == approval.template_id,
                ApprovalTemplate.allow_dual_reconciliation.is_(True),
                ApprovalTemplate.is_enabled.is_(True),
            )
            .correlate(approval)
        ),
        ~occupied,
        ~exists(
            select(1).where(ApprovalAccountingPlan.approval_id == approval.id).correlate(approval)
        ),
        ~exists(
            select(1).where(ApprovalPaidAccounting.approval_id == approval.id).correlate(approval)
        ),
        ~exists(
            select(1)
            .where(
                AccrualApprovalLink.approval_id == approval.id, AccrualApprovalLink.active.is_(True)
            )
            .correlate(approval)
        ),
        ~exists(
            select(1)
            .where(
                PreopeningStore.store_id == approval.store_id, PreopeningStore.status == "closed"
            )
            .correlate(approval)
        ),
        ~exists(
            select(1)
            .select_from(Ledger)
            .join(
                item,
                and_(item.c.store_id == Ledger.store_id, item.c.ledger_period == Ledger.period),
            )
            .where(item_belongs, Ledger.status == "closed")
            .correlate(approval)
        ),
    )


def approval_scope_condition(target):
    return or_(ApprovalInstance.expense_scope == target, dual_unclaimed())


def claim_scope(session: Session, approval_id: str, target: str):
    # Both entry points acquire the shared bank mutation lock before this lock.
    approval = session.scalar(
        select(ApprovalInstance).where(ApprovalInstance.id == approval_id).with_for_update()
    )
    if not approval:
        raise HTTPException(404, "审批单不存在")
    from app.modules.store_ledgers.router import approval_expense_join_condition

    opposite_active = session.scalar(
        select(ExpenseBankMatch.id)
        .join(ExpenseItem, ExpenseItem.id == ExpenseBankMatch.expense_item_id)
        .join(ApprovalInstance, approval_expense_join_condition())
        .where(
            ApprovalInstance.id == approval.id,
            ExpenseBankMatch.status.in_(["candidate", "confirmed"]),
            ExpenseBankMatch.expense_scope != target,
        )
        .limit(1)
    )
    if opposite_active:
        raise HTTPException(409, "该审批单已在另一费用入口匹配，不能同时计入筹建和日常报表")
    if approval.expense_scope == target:
        return
    if not session.scalar(
        select(ApprovalInstance.id).where(ApprovalInstance.id == approval_id, dual_unclaimed())
    ):
        raise HTTPException(
            409, "该审批单已在另一费用入口占用、已封账或模板未开放双入口；不能跨筹建和日常重复匹配"
        )
    previous = approval.expense_scope
    approval.expense_scope = target
    for item in session.scalars(
        select(ExpenseItem)
        .join(ApprovalInstance, approval_expense_join_condition())
        .where(ApprovalInstance.id == approval.id)
    ):
        item.expense_scope = target
        if target == "operating":
            item.preopening_category_id = item.preopening_category_l1 = (
                item.preopening_category_l2
            ) = None
        else:
            item.category_l1 = item.category_l2 = None
    from app.modules.audit.service import write_audit_log

    write_audit_log(
        session,
        actor="system",
        action="approval.scope.claim",
        resource_type="approval_instance",
        resource_id=approval.id,
        summary="匹配时确定审批单整单费用归属",
        metadata={"before": previous, "after": target},
    )
    session.flush()
