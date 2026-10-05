from decimal import Decimal
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    PreopeningCategory,
    PreopeningStore,
    RevenueBankMatch,
    Store,
    User,
    utc_now,
)
from app.modules.approvals.status import canonical_expense_items, refresh_approval_processing_status
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import ensure_permission, ensure_store_access
from app.modules.auth.router import audit_actor, get_current_user
from app.modules.preopening.service import ensure_open, lock_store
from app.schemas import ApiEnvelope

SessionDep = Annotated[Session, Depends(get_session)]
UserDep = Annotated[User, Depends(get_current_user)]

router = APIRouter(prefix="/preopening", tags=["preopening"])
TERMINAL = {
    "terminated",
    "canceled",
    "cancelled",
    "cancel",
    "withdrawn",
    "refuse",
    "rejected",
    "撤销",
    "已撤销",
}


class CategoryPayload(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    parent_id: str | None = None
    status: str = "active"
    sort_order: int = 0


class MatchPayload(BaseModel):
    approval_id: str
    bank_transaction_id: str
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    categories: dict[str, str]


def authorize(session, user, permission, store_id=None):
    ensure_permission(session, user, permission)
    if store_id:
        ensure_store_access(session, user, store_id)
        if session.get(Store, store_id) is None:
            raise HTTPException(404, "门店不存在")


def audit(session, user, action, resource_id, summary):
    write_audit_log(
        session,
        actor=audit_actor(user),
        action=f"preopening.{action}",
        resource_type="preopening",
        resource_id=resource_id,
        summary=summary,
    )


def category_read(c):
    return {
        "id": c.id,
        "name": c.name,
        "parent_id": c.parent_id,
        "status": c.status,
        "sort_order": c.sort_order,
    }


@router.get("/categories")
def categories(session: SessionDep, user: UserDep):
    authorize(session, user, "categories.view")
    items = session.scalars(
        select(PreopeningCategory).order_by(
            PreopeningCategory.status, PreopeningCategory.sort_order, PreopeningCategory.created_at
        )
    ).all()
    return ApiEnvelope(data=[category_read(c) for c in items])


def save_category(session, user, payload, category_id=None):
    authorize(session, user, "categories.manage")
    name = payload.name.strip()
    if not name:
        raise HTTPException(422, "请输入分类名称")
    if payload.status not in {"active", "inactive"}:
        raise HTTPException(422, "分类状态不正确")
    if payload.parent_id:
        parent = session.get(PreopeningCategory, payload.parent_id)
        if (
            not parent
            or parent.parent_id
            or parent.status != "active"
            or payload.parent_id == category_id
        ):
            raise HTTPException(422, "请选择启用的一级分类")
    c = session.get(PreopeningCategory, category_id) if category_id else PreopeningCategory()
    if not c:
        raise HTTPException(404, "分类不存在")
    used = category_id and session.scalar(
        select(ExpenseItem.id).where(ExpenseItem.preopening_category_id == category_id).limit(1)
    )
    if used and payload.parent_id != c.parent_id:
        raise HTTPException(409, "已引用分类不能更换上级分类")
    if (
        category_id
        and payload.parent_id
        and session.scalar(
            select(PreopeningCategory.id).where(PreopeningCategory.parent_id == category_id)
        )
    ):
        raise HTTPException(409, "有子分类的一级分类不能移到二级")
    if session.scalar(
        select(PreopeningCategory.id).where(
            PreopeningCategory.name == name, PreopeningCategory.id != (category_id or "")
        )
    ):
        raise HTTPException(409, "筹建分类名称已存在")
    for k, v in payload.model_dump().items():
        setattr(c, k, name if k == "name" else v)
    session.add(c)
    try:
        session.flush()
    except IntegrityError:
        session.rollback()
        raise HTTPException(409, "筹建分类名称已存在")
    audit(session, user, "category.save", c.id, f"保存筹建分类：{name}")
    session.commit()
    return ApiEnvelope(data=category_read(c))


@router.post("/categories")
def create_category(
    payload: CategoryPayload,
    session: SessionDep,
    user: UserDep,
):
    return save_category(session, user, payload)


@router.patch("/categories/{category_id}")
def update_category(
    category_id: str,
    payload: CategoryPayload,
    session: SessionDep,
    user: UserDep,
):
    return save_category(session, user, payload, category_id)


@router.delete("/categories/{category_id}")
def delete_category(
    category_id: str,
    session: SessionDep,
    user: UserDep,
):
    authorize(session, user, "categories.manage")
    c = session.get(PreopeningCategory, category_id)
    if not c:
        raise HTTPException(404, "分类不存在")
    if session.scalar(
        select(ExpenseItem.id).where(ExpenseItem.preopening_category_id == category_id)
    ) or session.scalar(
        select(PreopeningCategory.id).where(PreopeningCategory.parent_id == category_id)
    ):
        raise HTTPException(409, "已引用或有子分类的分类不能删除，请停用")
    audit(session, user, "category.delete", c.id, f"删除筹建分类：{c.name}")
    session.delete(c)
    session.commit()
    return ApiEnvelope(data={"deleted": True})


def approval_items(session, approval_id):
    return canonical_expense_items(
        list(
            session.scalars(
                select(ExpenseItem)
                .where(
                    ExpenseItem.approval_instance_id == approval_id,
                    ExpenseItem.expense_scope == "preopening",
                )
                .order_by(ExpenseItem.approval_line_no)
            )
        )
    )


def item_read(session, e, voucher_counts=None):
    from app.models import Attachment

    return {
        "id": e.id,
        "description": e.description,
        "amount": str(e.amount),
        "expense_date": e.expense_date,
        "category_id": e.preopening_category_id,
        "category_l1": e.preopening_category_l1,
        "category_l2": e.preopening_category_l2,
        "voucher_count": voucher_counts.get(e.id, 0) if voucher_counts is not None else session.scalar(
            select(func.count())
            .select_from(Attachment)
            .where(Attachment.resource_type == "expense_item", Attachment.resource_id == e.id)
        ),
    }


@router.get("/stores/{store_id}")
def workspace(store_id: str, session: SessionDep, user: UserDep):
    authorize(session, user, "reconciliation.view", store_id)
    state = session.get(PreopeningStore, store_id)
    approvals = session.scalars(
        select(ApprovalInstance)
        .where(
            ApprovalInstance.store_id == store_id, ApprovalInstance.expense_scope == "preopening"
        )
        .order_by(ApprovalInstance.created_at.desc())
    ).all()
    matches = session.scalars(
        select(ExpenseBankMatch)
        .join(ExpenseItem, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
        .where(
            ExpenseItem.store_id == store_id,
            ExpenseBankMatch.expense_scope == "preopening",
            ExpenseBankMatch.status == "confirmed",
        )
    ).all()
    matched_approvals = dict(session.execute(select(ExpenseItem.id, ExpenseItem.approval_instance_id).where(
        ExpenseItem.id.in_([m.expense_item_id for m in matches])
    )).all())
    matched_banks = {bank.id: bank for bank in session.scalars(select(BankTransaction).where(
        BankTransaction.id.in_([m.bank_transaction_id for m in matches])
    ))}
    approval_ids = set(matched_approvals.values())
    from app.models import Attachment
    items_by_approval = {}
    all_items = list(session.scalars(select(ExpenseItem).where(
        ExpenseItem.approval_instance_id.in_([a.id for a in approvals]),
        ExpenseItem.expense_scope == "preopening",
    ).order_by(ExpenseItem.approval_line_no)))
    for item in all_items:
        items_by_approval.setdefault(item.approval_instance_id, []).append(item)
    voucher_counts = dict(session.execute(select(Attachment.resource_id, func.count()).where(
        Attachment.resource_type == "expense_item",
        Attachment.resource_id.in_([e.id for e in all_items]),
    ).group_by(Attachment.resource_id)).all())
    templates_by_id = {t.id: t for t in session.scalars(select(ApprovalTemplate).where(
        ApprovalTemplate.id.in_([a.template_id for a in approvals])
    ))}
    details = []
    candidates = []
    for a in approvals:
        items = canonical_expense_items(items_by_approval.get(a.id, []))
        if not items:
            continue
        if a.id in approval_ids:
            details.extend(
                {
                    **item_read(session, e, voucher_counts),
                    "approval_id": a.id,
                    "approval_no": a.approval_no,
                    "submit_time": a.submit_at,
                }
                for e in items
            )
        template = templates_by_id.get(a.template_id)
        if template and template.is_enabled and (a.approval_status or "").lower() not in TERMINAL:
            candidates.append(
                {
                    "id": a.id,
                    "approval_no": a.approval_no,
                    "title": a.approval_no,
                    "submit_time": a.submit_at,
                    "finish_time": a.approved_at,
                    "amount": str(sum((Decimal(e.amount) for e in items), Decimal(0))),
                    "items": [item_read(session, e, voucher_counts) for e in items],
                }
            )
    return ApiEnvelope(
        data={
            "store_name": session.get(Store, store_id).name,
            "status": state.status if state else "open",
            "closed_at": state.closed_at if state else None,
            "total": str(sum((Decimal(e["amount"]) for e in details), Decimal(0))),
            "details": details,
            "approvals": candidates,
            "matches": [
                {
                    "id": m.id,
                    "amount": str(m.amount),
                    "approval_id": matched_approvals[m.expense_item_id],
                    "bank_transaction_id": m.bank_transaction_id,
                    "counterparty_name": matched_banks[m.bank_transaction_id].counterparty_name,
                    "occurred_at": matched_banks[m.bank_transaction_id].occurred_at,
                    "confirmed_at": m.confirmed_at,
                }
                for m in matches
            ],
        }
    )


@router.get("/stores/{store_id}/candidates")
def candidates(store_id: str, bank_transaction_id: str, session: SessionDep, user: UserDep):
    from types import SimpleNamespace

    from app.modules.matching.router import candidate_score

    authorize(session, user, "reconciliation.view", store_id)
    bank = session.get(BankTransaction, bank_transaction_id)
    if not bank or bank.store_id != store_id:
        raise HTTPException(404, "当前门店流水不存在")
    data = workspace(store_id, session, user).data
    result = []
    for a in data["approvals"]:
        total = Decimal(a["amount"])
        paid = sum(
            (Decimal(m["amount"]) for m in data["matches"] if m["approval_id"] == a["id"]),
            Decimal(0),
        )
        if paid >= total:
            continue
        item = session.get(ExpenseItem, a["items"][0]["id"])
        expense = SimpleNamespace(
            expense_date=a["finish_time"] or a["submit_time"] or item.expense_date
        )
        score, reason = candidate_score(bank, expense, total - paid, approval_total_amount=total)
        result.append({**a, "score": str(score), "reason": reason})
    return ApiEnvelope(data=sorted(result, key=lambda item: Decimal(item["score"]), reverse=True))


@router.post("/stores/{store_id}/matches")
def confirm(
    store_id: str,
    payload: MatchPayload,
    session: SessionDep,
    user: UserDep,
):
    authorize(session, user, "reconciliation.manage", store_id)
    state = lock_store(session, store_id)
    ensure_open(state)
    approval = session.scalar(
        select(ApprovalInstance).where(ApprovalInstance.id == payload.approval_id).with_for_update()
    )
    bank = session.scalar(
        select(BankTransaction)
        .where(BankTransaction.id == payload.bank_transaction_id)
        .with_for_update()
    )
    if not approval or not bank:
        raise HTTPException(404, "审批单或流水不存在")
    if approval.store_id != store_id or bank.store_id != store_id:
        raise HTTPException(409, "审批单和流水必须属于当前门店")
    if (
        approval.expense_scope != "preopening"
        or (approval.approval_status or "").lower() in TERMINAL
    ):
        raise HTTPException(409, "审批单不属于筹建费用或已撤销／拒绝")
    template = session.get(ApprovalTemplate, approval.template_id)
    if not template or not template.is_enabled:
        raise HTTPException(409, "审批模板已停用，不能新增对账")
    if bank.direction != "expense" or bank.special_type:
        raise HTTPException(409, "只允许普通支出流水参与筹建对账")
    if session.scalar(
        select(ExpenseBankMatch.id).where(
            ExpenseBankMatch.bank_transaction_id == bank.id,
            ExpenseBankMatch.status.in_(["candidate", "confirmed"]),
        )
    ) or session.scalar(
        select(RevenueBankMatch.id).where(
            RevenueBankMatch.bank_transaction_id == bank.id,
            RevenueBankMatch.status.in_(["candidate", "confirmed"]),
        )
    ):
        raise HTTPException(409, "该流水已被对账占用")
    items = approval_items(session, approval.id)
    if not items:
        raise HTTPException(409, "审批单尚无可用费用明细")
    total = sum((Decimal(e.amount) for e in items), Decimal(0))
    paid = session.scalar(
        select(func.coalesce(func.sum(ExpenseBankMatch.amount), 0)).where(
            ExpenseBankMatch.expense_item_id.in_([e.id for e in items]),
            ExpenseBankMatch.status == "confirmed",
        )
    )
    if payload.amount > Decimal(bank.amount) or payload.amount + Decimal(paid) > total:
        raise HTTPException(409, "匹配金额超过流水金额或审批单剩余可匹配金额")
    for e in items:
        c = session.get(PreopeningCategory, payload.categories.get(e.id, ""))
        parent = session.get(PreopeningCategory, c.parent_id) if c and c.parent_id else None
        if not c or not parent or c.status != "active" or parent.status != "active":
            raise HTTPException(422, "每条费用明细必须选择启用的筹建二级分类")
        e.preopening_category_id = c.id
        e.preopening_category_l1 = parent.name
        e.preopening_category_l2 = c.name
    existing = session.scalar(
        select(ExpenseBankMatch).where(
            ExpenseBankMatch.expense_item_id == items[0].id,
            ExpenseBankMatch.bank_transaction_id == bank.id,
        )
    )
    match = existing or ExpenseBankMatch(expense_item_id=items[0].id, bank_transaction_id=bank.id)
    match.expense_scope = "preopening"
    match.amount = payload.amount
    match.accounting_period = None
    match.status = "confirmed"
    match.bank_occurred = True
    match.confirmed_by = audit_actor(user)
    match.confirmed_at = utc_now()
    session.add(match)
    bank.matched_amount = payload.amount
    session.flush()
    refresh_approval_processing_status(session, approval.id)
    audit(session, user, "match.confirm", match.id, "确认筹建审批对账")
    session.commit()
    return ApiEnvelope(data={"id": match.id})


@router.post("/stores/{store_id}/matches/{match_id}/unmatch")
def unmatch(
    store_id: str,
    match_id: str,
    session: SessionDep,
    user: UserDep,
):
    authorize(session, user, "reconciliation.manage", store_id)
    ensure_open(lock_store(session, store_id))
    match = session.get(ExpenseBankMatch, match_id)
    expense = session.get(ExpenseItem, match.expense_item_id) if match else None
    if (
        not match
        or match.expense_scope != "preopening"
        or not expense
        or expense.store_id != store_id
    ):
        raise HTTPException(404, "筹建对账记录不存在")
    session.scalar(
        select(ApprovalInstance)
        .where(ApprovalInstance.id == expense.approval_instance_id)
        .with_for_update()
    )
    bank = session.scalar(
        select(BankTransaction)
        .where(BankTransaction.id == match.bank_transaction_id)
        .with_for_update()
    )
    match.status = "rejected"
    session.flush()
    bank.matched_amount = session.scalar(
        select(func.coalesce(func.sum(ExpenseBankMatch.amount), 0)).where(
            ExpenseBankMatch.bank_transaction_id == bank.id, ExpenseBankMatch.status == "confirmed"
        )
    )
    refresh_approval_processing_status(session, expense.approval_instance_id)
    audit(session, user, "match.unmatch", match.id, "撤销筹建审批对账")
    session.commit()
    return ApiEnvelope(data={"unmatched": True})


@router.post("/stores/{store_id}/close")
def close(store_id: str, session: SessionDep, user: UserDep):
    authorize(session, user, "reconciliation.manage", store_id)
    state = lock_store(session, store_id)
    ensure_open(state)
    state.status = "closed"
    state.closed_at = utc_now()
    state.closed_by = audit_actor(user)
    audit(session, user, "close", store_id, "筹建费用报表封账")
    session.commit()
    return ApiEnvelope(data={"status": "closed"})
