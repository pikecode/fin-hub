"""Audited correction of open accrual entries, with optimistic conflict detection."""

from datetime import date
from decimal import Decimal

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, field_validator
from sqlalchemy import select, text

from app.models import (
    AccrualApprovalLink,
    AccrualEntry,
    ApprovalInstance,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
)
from app.modules.accrual_accounting import active_links, ensure_approval_open
from app.modules.audit.service import write_audit_log
from app.modules.auth.router import audit_actor
from app.modules.expense_classification import is_non_operating_expense


class EntryValues(BaseModel):
    model_config = ConfigDict(extra="forbid")
    period: str = Field(pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    category_l1: str = Field(min_length=1, max_length=100)
    category_l2: str = Field(min_length=1, max_length=100)
    amount: Decimal = Field(gt=0, max_digits=14, decimal_places=2)
    remark: str = Field(min_length=1, max_length=2000)

    @field_validator("category_l1", "category_l2", "remark")
    @classmethod
    def nonblank(cls, value):
        if not value.strip():
            raise ValueError("不能为空")
        return value.strip()


class EntryUpdate(EntryValues):
    expected: EntryValues
    reason: str = Field(min_length=1, max_length=2000)


class EntryDelete(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected: EntryValues
    reason: str = Field(min_length=1, max_length=2000)


def delete_entry(entry_id, payload, session, user):
    from app.modules.accruals import authorize
    from app.modules.bank.unpaid import mutation_lock

    entry = session.get(AccrualEntry, entry_id)
    if entry is None:
        raise HTTPException(404, "计提记录不存在")
    authorize(session, user, entry.store_id, "reconciliation.manage")
    if not payload.reason.strip():
        raise HTTPException(422, "请填写删除原因")
    mutation_lock(session)
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": "accrual:" + entry.store_id},
    )
    session.refresh(entry)
    if EntryValues.model_validate(entry, from_attributes=True) != payload.expected:
        raise HTTPException(409, "记录已被修改，请刷新后重新操作")
    ledger = session.scalar(
        select(Ledger)
        .where(Ledger.store_id == entry.store_id, Ledger.period == entry.period)
        .with_for_update()
    )
    if ledger is None or ledger.status != "open":
        raise HTTPException(409, "该账期不存在或已封账，请通过后续补提或冲销更正")
    root_id = entry.original_id or entry.id
    family = list(
        session.scalars(
            select(AccrualEntry)
            .where((AccrualEntry.id == root_id) | (AccrualEntry.original_id == root_id))
            .with_for_update()
        )
    )
    if entry.entry_type == "accrual":
        if len(family) > 1:
            raise HTTPException(409, "原计提已有补提或冲销，请先核对并处理调整记录")
        if session.scalar(
            select(AccrualApprovalLink.id)
            .where(AccrualApprovalLink.original_id == entry.id)
            .limit(1)
        ):
            raise HTTPException(409, "原计提存在审批覆盖历史，需保留原记录，请使用冲销更正")
    links = active_links(session, original_id=root_id)
    for link in links:
        ensure_approval_open(session, session.get(ApprovalInstance, link.approval_id))
    remaining = [row for row in family if row.id != entry.id]
    running = Decimal(0)
    for period in sorted({row.period for row in remaining}):
        running += sum(
            (
                row.amount * (-1 if row.entry_type == "reversal" else 1)
                for row in remaining
                if row.period == period
            ),
            Decimal(0),
        )
        if running < 0:
            raise HTTPException(409, "删除后某账期冲销超过可冲销额度")
    if running < sum((link.amount for link in links if not link.whole_approval and not link.detail_selection_json), Decimal(0)):
        raise HTTPException(409, "删除后有效金额不能低于已关联审批覆盖额")
    item = session.get(ExpenseItem, entry.id)
    if item is None or item.source != "accrual":
        raise HTTPException(409, "计提费用明细不完整，请先核对数据")
    if session.scalar(
        select(ExpenseBankMatch.id).where(ExpenseBankMatch.expense_item_id == entry.id).limit(1)
    ):
        raise HTTPException(409, "计提明细存在流水关联，请先核对")
    before = {column.name: str(getattr(entry, column.name)) for column in entry.__table__.columns}
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="accrual.delete",
        resource_type="accrual_entry",
        resource_id=entry.id,
        summary="删除未封账计提记录",
        metadata={"before": before, "reason": payload.reason.strip()},
    )
    session.delete(item)
    session.delete(entry)
    session.commit()
    return {"id": entry_id, "deleted": True}


def update_entry(entry_id, payload, session, user):
    from app.modules.accruals import authorize
    from app.modules.bank.unpaid import mutation_lock
    from app.modules.matching.router import expense_category_exists

    entry = session.get(AccrualEntry, entry_id)
    if entry is None:
        raise HTTPException(404, "计提记录不存在")
    authorize(session, user, entry.store_id, "reconciliation.manage")
    if not payload.reason.strip():
        raise HTTPException(422, "请填写修改原因")
    mutation_lock(session)
    session.execute(
        text("SELECT pg_advisory_xact_lock(hashtextextended(:key, 0))"),
        {"key": "accrual:" + entry.store_id},
    )
    session.refresh(entry)
    before = EntryValues.model_validate(entry, from_attributes=True)
    if before != payload.expected:
        raise HTTPException(409, "记录已被修改，请刷新后重新编辑")
    root_id = entry.original_id or entry.id
    family = list(
        session.scalars(
            select(AccrualEntry)
            .where((AccrualEntry.id == root_id) | (AccrualEntry.original_id == root_id))
            .with_for_update()
        )
    )
    new = EntryValues(**payload.model_dump(include=set(EntryValues.model_fields)))
    category_changed = (new.category_l1, new.category_l2) != (entry.category_l1, entry.category_l2)
    if category_changed and (
        not expense_category_exists(session, new.category_l1, new.category_l2)
        or is_non_operating_expense(new.category_l1, new.category_l2)
    ):
        raise HTTPException(409, "请选择有效的经营费用二级分类")
    affected = family if category_changed else [entry]
    periods = {row.period for row in affected} | {new.period}
    ledgers = {
        row.period: row
        for row in session.scalars(
            select(Ledger)
            .where(Ledger.store_id == entry.store_id, Ledger.period.in_(periods))
            .with_for_update()
        )
    }
    if any(period not in ledgers for period in periods):
        raise HTTPException(409, "请先创建目标账期")
    if any(row.status != "open" for row in ledgers.values()):
        raise HTTPException(
            409, "原账期、目标账期或同组分类受影响账期已封账，请通过后续补提或冲销更正"
        )
    links = active_links(session, original_id=root_id)
    if links and (category_changed or new.period != entry.period):
        raise HTTPException(409, "已关联审批覆盖，修改月份或分类前请先核对并解除覆盖")
    if links and new.amount != entry.amount:
        for link in links:
            ensure_approval_open(session, session.get(ApprovalInstance, link.approval_id))
    proposed = {
        row.id: (
            new if row.id == entry.id else EntryValues.model_validate(row, from_attributes=True)
        )
        for row in family
    }
    root_period = proposed[root_id].period
    if any(value.period < root_period for key, value in proposed.items() if key != root_id):
        raise HTTPException(409, "补提或冲销月份不能早于原计提月份")
    changes = [
        (
            proposed[row.id].period,
            proposed[row.id].amount * (-1 if row.entry_type == "reversal" else 1),
        )
        for row in family
    ]
    running = Decimal(0)
    for period in sorted({period for period, _ in changes}):
        running += sum((amount for month, amount in changes if month == period), Decimal(0))
        if running < 0:
            raise HTTPException(409, "修改后某账期冲销超过可冲销额度")
    if running < sum((link.amount for link in links if not link.whole_approval and not link.detail_selection_json), Decimal(0)):
        raise HTTPException(409, "修改后有效金额不能低于已关联审批覆盖额")
    before_group = {
        row.id: EntryValues.model_validate(row, from_attributes=True).model_dump(mode="json")
        for row in affected
    }
    # Verify all expense mirrors before changing any objects.
    mirrors = {row.id: session.get(ExpenseItem, row.id) for row in affected}
    if any(item is None or item.source != "accrual" for item in mirrors.values()):
        raise HTTPException(409, "计提费用明细不完整，请先核对数据")
    for row in affected:
        if row.id == entry.id:
            for field, value in new.model_dump().items():
                setattr(row, field, value)
        if category_changed:
            row.category_l1, row.category_l2 = new.category_l1, new.category_l2
        item = mirrors[row.id]
        item.ledger_period = row.period
        item.expense_date = date.fromisoformat(row.period + "-01")
        item.amount = -row.amount if row.entry_type == "reversal" else row.amount
        item.category_l1, item.category_l2 = row.category_l1, row.category_l2
        label = {"accrual": "计提", "supplement": "补提", "reversal": "冲销"}[row.entry_type]
        item.description = f"[{label}] {row.remark}"
    write_audit_log(
        session,
        actor=audit_actor(user),
        action="accrual.update",
        resource_type="accrual_entry",
        resource_id=entry.id,
        summary="更正未封账计提记录",
        metadata={
            "reason": payload.reason.strip(),
            "before": before_group,
            "after": {
                row.id: EntryValues.model_validate(row, from_attributes=True).model_dump(
                    mode="json"
                )
                for row in affected
            },
        },
    )
    session.commit()
    return entry
