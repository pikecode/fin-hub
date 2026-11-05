"""Accrual ledger with audited open-period corrections and approval coverage."""

from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import JSON, cast, func, select, text
from sqlalchemy.orm import Session

from app.core.database import get_session
from app.models import (
    AccrualApprovalLink,
    AccrualEntry,
    ApprovalInstance,
    AuditLog,
    ExpenseItem,
    Ledger,
    Store,
    User,
)
from app.modules.accrual_editing import EntryDelete, EntryUpdate, delete_entry, update_entry
from app.modules.audit.service import write_audit_log
from app.modules.auth.permissions import ensure_permission, ensure_store_access
from app.modules.auth.router import audit_actor, get_current_user
from app.modules.expense_classification import is_non_operating_expense
from app.modules.matching.router import expense_category_exists
from app.schemas import ApiEnvelope

router = APIRouter(prefix="/accruals", tags=["accruals"])
SessionDependency = Annotated[Session, Depends(get_session)]
UserDependency = Annotated[User, Depends(get_current_user)]


class EntryCreate(BaseModel):
    store_id: str
    period: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    entry_type: Literal["accrual", "supplement", "reversal"] = "accrual"
    original_id: str | None = None
    category_l1: str = Field(min_length=1, max_length=100)
    category_l2: str = Field(min_length=1, max_length=100)
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    remark: str = Field(min_length=1, max_length=2000)
    request_key: str = Field(min_length=1, max_length=64)

    @field_validator("remark", "category_l1", "category_l2", "request_key")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("不能为空")
        return value.strip()


class EntryRead(EntryCreate):
    model_config = ConfigDict(from_attributes=True)
    id: str
    created_by: str
    created_at: datetime


def authorize(session, user, store_id, permission):
    ensure_permission(session, user, permission)
    ensure_store_access(session, user, store_id)
    if session.get(Store, store_id) is None:
        raise HTTPException(404, "门店不存在")


@router.get("", response_model=ApiEnvelope[list[EntryRead]])
def list_entries(
    store_id: str, session: SessionDependency, user: UserDependency, period: str | None = None
):
    authorize(session, user, store_id, "reconciliation.view")
    query = select(AccrualEntry).where(AccrualEntry.store_id == store_id)
    if period:
        query = query.where(AccrualEntry.period == period)
    return ApiEnvelope(
        data=list(session.scalars(query.order_by(AccrualEntry.created_at.desc(), AccrualEntry.id)))
    )


@router.post("", response_model=ApiEnvelope[EntryRead])
def create_entry(payload: EntryCreate, session: SessionDependency, user: UserDependency):
    authorize(session, user, payload.store_id, "reconciliation.manage")
    from app.modules.bank.unpaid import mutation_lock

    mutation_lock(session)
    # Same-store writes serialize both idempotency and remaining-amount checks.
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": "accrual:" + payload.store_id},
    )
    existing = session.scalar(
        select(AccrualEntry).where(
            AccrualEntry.store_id == payload.store_id,
            AccrualEntry.request_key == payload.request_key,
        )
    )
    if existing:
        if any(getattr(existing, key) != value for key, value in payload.model_dump().items()):
            raise HTTPException(409, "重复请求参数不一致")
        return ApiEnvelope(data=existing)
    # Deleted entries retain their request key in audit, so a retry cannot recreate a cost.
    deleted = session.scalar(
        select(AuditLog.id)
        .where(
            AuditLog.action == "accrual.delete",
            func.json_extract_path_text(cast(AuditLog.metadata_json, JSON), "before", "store_id")
            == payload.store_id,
            func.json_extract_path_text(cast(AuditLog.metadata_json, JSON), "before", "request_key")
            == payload.request_key,
        )
        .limit(1)
    )
    if deleted:
        raise HTTPException(409, "该请求对应的记录已删除，请刷新后重新提交新记录")
    ledger = session.scalar(
        select(Ledger)
        .where(Ledger.store_id == payload.store_id, Ledger.period == payload.period)
        .with_for_update()
    )
    if ledger is None:
        raise HTTPException(409, "请先创建目标账期")
    if ledger.status != "open":
        raise HTTPException(409, "目标账期已封账")
    if payload.entry_type == "accrual":
        if payload.original_id:
            raise HTTPException(422, "原计提不能关联其他计提")
    else:
        original = session.get(AccrualEntry, payload.original_id) if payload.original_id else None
        if (
            original is None
            or original.store_id != payload.store_id
            or original.entry_type != "accrual"
        ):
            raise HTTPException(409, "原计提不存在或不属于当前门店")
        if payload.period < original.period:
            raise HTTPException(409, "调整账期不能早于原计提账期")
        if (payload.category_l1, payload.category_l2) != (
            original.category_l1,
            original.category_l2,
        ):
            raise HTTPException(409, "调整必须使用原计提分类，分类转移另行处理")
        adjustments = list(
            session.scalars(select(AccrualEntry).where(AccrualEntry.original_id == original.id))
        )
        # Validate every monthly prefix, including existing later adjustments.
        changes = (
            [(original.period, original.amount)]
            + [
                (row.period, -row.amount if row.entry_type == "reversal" else row.amount)
                for row in adjustments
            ]
            + [
                (
                    payload.period,
                    -payload.amount if payload.entry_type == "reversal" else payload.amount,
                )
            ]
        )
        running = Decimal(0)
        for period in sorted({period for period, _ in changes}):
            running += sum((amount for month, amount in changes if month == period), Decimal(0))
            if running < 0:
                raise HTTPException(409, "冲销金额超过该账期可冲销额度")
        from app.modules.accrual_accounting import active_links

        covered = sum(
            (
                link.amount
                for link in active_links(session, original_id=original.id)
                if not link.whole_approval
            ),
            Decimal(0),
        )
        if sum((amount for _, amount in changes), Decimal(0)) < covered:
            raise HTTPException(409, "冲销后金额不能低于已关联审批覆盖额，请先核对关联")
    # Existing historical categories remain usable for adjustments.
    if payload.entry_type == "accrual" and (
        not expense_category_exists(session, payload.category_l1, payload.category_l2)
        or is_non_operating_expense(payload.category_l1, payload.category_l2)
    ):
        raise HTTPException(409, "请选择有效的经营费用二级分类")
    entry = AccrualEntry(**payload.model_dump(), created_by=user.id)
    session.add(entry)
    session.flush()
    from datetime import date

    label = {"accrual": "计提", "supplement": "补提", "reversal": "冲销"}[entry.entry_type]
    session.add(
        ExpenseItem(
            id=entry.id,
            store_id=entry.store_id,
            ledger_period=entry.period,
            expense_date=date.fromisoformat(entry.period + "-01"),
            description=f"[{label}] {entry.remark}",
            amount=-entry.amount if entry.entry_type == "reversal" else entry.amount,
            category_l1=entry.category_l1,
            category_l2=entry.category_l2,
            source="accrual",
            source_document_id=entry.id,
            payment_status="no_bank_flow",
        )
    )
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="accrual." + payload.entry_type,
        resource_type="accrual_entry",
        resource_id=entry.id,
        summary="记录计提或调整",
        metadata={
            "period": entry.period,
            "amount": str(entry.amount),
            "original_id": entry.original_id,
        },
    )
    session.commit()
    session.refresh(entry)
    return ApiEnvelope(data=entry)


@router.patch("/{entry_id}", response_model=ApiEnvelope[EntryRead])
def edit_entry(
    entry_id: str, payload: EntryUpdate, session: SessionDependency, user: UserDependency
):
    return ApiEnvelope(data=update_entry(entry_id, payload, session, user))


@router.delete("/{entry_id}")
def remove_entry(
    entry_id: str, payload: EntryDelete, session: SessionDependency, user: UserDependency
):
    return ApiEnvelope(data=delete_entry(entry_id, payload, session, user))


class LinkCreate(BaseModel):
    original_id: str
    approval_id: str
    amount: Decimal | None = Field(default=None, gt=0, max_digits=14, decimal_places=2)
    remark: str = Field(min_length=1, max_length=2000)
    request_key: str = Field(min_length=1, max_length=64)
    confirm_category_difference: bool = False


def link_read(link):
    return {
        key: getattr(link, key)
        for key in (
            "id",
            "original_id",
            "approval_id",
            "amount",
            "whole_approval",
            "active",
            "remark",
            "created_at",
        )
    }


@router.get("/links")
def list_links(store_id: str, session: SessionDependency, user: UserDependency):
    authorize(session, user, store_id, "reconciliation.view")
    rows = session.scalars(
        select(AccrualApprovalLink)
        .join(AccrualEntry, AccrualEntry.id == AccrualApprovalLink.original_id)
        .where(AccrualEntry.store_id == store_id)
        .order_by(AccrualApprovalLink.created_at.desc())
    )
    result = []
    for row in rows:
        data = link_read(row)
        approval = session.get(ApprovalInstance, row.approval_id)
        data["approval_no"] = approval.approval_no if approval else None
        result.append(data)
    return ApiEnvelope(data=result)


def apply_link(payload: LinkCreate, session, user):
    from app.modules.accrual_accounting import active_links, effective_amount, ensure_approval_open
    from app.modules.bank.unpaid import mutation_lock
    from app.modules.matching.accounting import approval_items

    mutation_lock(session)
    original = session.get(AccrualEntry, payload.original_id)
    if original is None:
        raise HTTPException(404, "原计提不存在")
    authorize(session, user, original.store_id, "reconciliation.manage")
    existing = session.scalar(
        select(AccrualApprovalLink).where(AccrualApprovalLink.request_key == payload.request_key)
    )
    if existing:
        if existing.whole_approval != (payload.amount is None) or (
            existing.original_id,
            existing.approval_id,
            existing.amount,
            existing.remark,
        ) != (
            original.id,
            payload.approval_id,
            existing.amount
            if payload.amount is None and existing.whole_approval
            else payload.amount,
            payload.remark.strip(),
        ):
            raise HTTPException(409, "重复请求参数不一致")
        return ApiEnvelope(data=link_read(existing))
    approval = session.get(ApprovalInstance, payload.approval_id)
    if (
        original.entry_type != "accrual"
        or not approval
        or approval.store_id != original.store_id
        or approval.expense_scope != "operating"
    ):
        raise HTTPException(409, "只能关联同门店的原计提和日常审批单")
    if not payload.remark.strip():
        raise HTTPException(422, "关联原因不能为空")
    ensure_approval_open(session, approval)
    items = approval_items(session, approval.id)
    if not items or any(
        i.amount < 0 or is_non_operating_expense(i.category_l1, i.category_l2) for i in items
    ):
        raise HTTPException(409, "该审批包含非经营费用或负数明细，请先核对")
    if (
        any(
            (i.category_l1, i.category_l2) != (original.category_l1, original.category_l2)
            for i in items
        )
        and not payload.confirm_category_difference
    ):
        raise HTTPException(409, "审批分类与计提不同，请确认保留原计提分类或先办理分类调整")
    whole = payload.amount is None
    approval_links = active_links(session, approval_id=approval.id)
    if approval_links and (whole or any(link.whole_approval for link in approval_links)):
        raise HTTPException(409, "该审批已有有效计提关联，请先解除原关联")
    amount = sum((i.amount for i in items), Decimal(0)) if whole else payload.amount
    if not amount or amount <= 0:
        raise HTTPException(409, "审批金额必须大于零")
    if not whole:
        if sum(
            (
                l.amount
                for l in active_links(session, original_id=original.id)
                if not l.whole_approval
            ),
            Decimal(0),
        ) + amount > effective_amount(session, original):
            raise HTTPException(409, "覆盖金额超过计提可用额度")
        if sum((l.amount for l in approval_links), Decimal(0)) + amount > sum(
            (i.amount for i in items), Decimal(0)
        ):
            raise HTTPException(409, "覆盖金额超过审批单金额")
    link = AccrualApprovalLink(
        original_id=original.id,
        approval_id=approval.id,
        amount=amount.quantize(Decimal("0.01")),
        whole_approval=whole,
        remark=payload.remark.strip(),
        request_key=payload.request_key,
        created_by=user.id,
    )
    session.add(link)
    session.flush()
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="accrual.link",
        resource_type="accrual_approval_link",
        resource_id=link.id,
        summary="关联已计提审批费用",
        metadata={
            "original_id": original.id,
            "approval_id": approval.id,
            "amount": str(link.amount),
            "whole_approval": link.whole_approval,
            "reason": link.remark,
        },
    )
    session.flush()
    return ApiEnvelope(data=link_read(link))


@router.post("/links")
def create_link(payload: LinkCreate, session: SessionDependency, user: UserDependency):
    result = apply_link(payload, session, user)
    session.commit()
    return result


class WholeLinksCreate(BaseModel):
    original_id: str
    approval_ids: list[str] = Field(min_length=1, max_length=100)
    remark: str = Field(min_length=1, max_length=2000)
    request_key: str = Field(min_length=1, max_length=64)
    confirm_category_difference: bool = False


@router.post("/links/batch")
def create_whole_links(payload: WholeLinksCreate, session: SessionDependency, user: UserDependency):
    from hashlib import sha256

    if len(set(payload.approval_ids)) != len(payload.approval_ids):
        raise HTTPException(422, "审批单不能重复选择")
    try:
        results = []
        for approval_id in sorted(payload.approval_ids):
            result = apply_link(
                LinkCreate(
                    original_id=payload.original_id,
                    approval_id=approval_id,
                    remark=payload.remark,
                    confirm_category_difference=payload.confirm_category_difference,
                    request_key=sha256(f"{payload.request_key}:{approval_id}".encode()).hexdigest(),
                ),
                session,
                user,
            )
            results.append(result.data)
        session.commit()
    except Exception:
        session.rollback()
        raise
    return ApiEnvelope(data=results)


class UnlinkRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=2000)


@router.post("/links/{link_id}/revoke")
def revoke_link(
    link_id: str, payload: UnlinkRequest, session: SessionDependency, user: UserDependency
):
    from app.modules.accrual_accounting import ensure_approval_open
    from app.modules.bank.unpaid import mutation_lock

    mutation_lock(session)
    link = session.get(AccrualApprovalLink, link_id)
    if link is None:
        raise HTTPException(404, "关联不存在")
    original = session.get(AccrualEntry, link.original_id)
    authorize(session, user, original.store_id, "reconciliation.manage")
    if not payload.reason.strip():
        raise HTTPException(422, "解除原因不能为空")
    if link.active:
        ensure_approval_open(session, session.get(ApprovalInstance, link.approval_id))
        link.active = False
        write_audit_log(
            session,
            actor=audit_actor(user),
            action="accrual.unlink",
            resource_type="accrual_approval_link",
            resource_id=link.id,
            summary="解除计提覆盖",
            metadata={"reason": payload.reason.strip()},
        )
        session.commit()
    return ApiEnvelope(data=link_read(link))
