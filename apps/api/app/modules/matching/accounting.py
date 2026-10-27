"""One accounting schedule per approval; payment matches never multiply its cost."""

import json
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import delete, select

from app.models import (
    ApprovalAccountingAllocation,
    ApprovalAccountingPlan,
    ApprovalInstance,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
    utc_now,
)
from app.modules.approvals.status import canonical_expense_items
from app.modules.audit.service import write_audit_log


def approval_for_item(session, item):
    from app.modules.store_ledgers.router import approval_expense_join_condition

    return session.scalar(
        select(ApprovalInstance)
        .join(ExpenseItem, approval_expense_join_condition())
        .where(ExpenseItem.id == item.id)
    )


def approval_items(session, approval_id):
    from app.modules.store_ledgers.router import approval_expense_join_condition

    return canonical_expense_items(
        list(
            session.scalars(
                select(ExpenseItem)
                .join(ApprovalInstance, approval_expense_join_condition())
                .where(ApprovalInstance.id == approval_id, ExpenseItem.expense_scope == "operating")
                .order_by(ExpenseItem.id)
            )
        )
    )


def read_plan(session, approval_id):
    approval = session.get(ApprovalInstance, approval_id)
    if approval is None:
        raise HTTPException(404, "审批单不存在")
    plan = session.get(ApprovalAccountingPlan, approval_id)
    items = approval_items(session, approval_id)
    allocations = [
        {"period": r.period, "amount": str(r.amount)}
        for r in session.scalars(
            select(ApprovalAccountingAllocation)
            .where(ApprovalAccountingAllocation.approval_id == approval_id)
            .order_by(ApprovalAccountingAllocation.period)
        )
    ]
    return {
        "approval_id": approval_id,
        "approval_total": str(
            sum((Decimal(i.amount) for i in items), Decimal(0)).quantize(Decimal(".01"))
        ),
        "configured": plan is not None,
        "version": plan.version if plan else 0,
        "allocations": allocations,
    }


def validate_allocations(session, approval, allocations, version, *, check_closed=True):
    from app.modules.dividend.opening import valid_period

    if not approval or approval.expense_scope != "operating":
        raise HTTPException(422, "只有日常审批单支持多账期入账")
    items = approval_items(session, approval.id)
    total = sum((Decimal(item.amount) for item in items), Decimal(0))
    if total <= 0 or any(Decimal(item.amount) < 0 for item in items):
        raise HTTPException(422, "审批金额必须为正，含负数明细时请先核对原始费用")
    if not allocations or len(allocations) > 60:
        raise HTTPException(422, "请录入1至60个入账账期")
    periods = [a["period"] for a in allocations]
    for period in periods:
        valid_period(period)
    if len(set(periods)) != len(periods):
        raise HTTPException(422, "入账账期不能重复")
    if any(Decimal(a["amount"]) <= 0 for a in allocations):
        raise HTTPException(422, "各账期入账金额必须大于0")
    if sum((Decimal(a["amount"]) for a in allocations), Decimal(0)) != total:
        raise HTTPException(422, f"各账期入账金额合计必须等于审批单总额 {total:.2f} 元")
    current = read_plan(session, approval.id)
    if version is not None and version != current["version"]:
        raise HTTPException(409, "审批单入账方案已更新，请重新打开弹窗")
    if current["configured"] and version is None:
        raise HTTPException(409, "请先读取当前入账方案后再修改")
    changed = sorted((a["period"], Decimal(a["amount"])) for a in allocations) != sorted(
        (a["period"], Decimal(a["amount"])) for a in current["allocations"]
    )
    if check_closed and changed:
        affected = set(periods) | {a["period"] for a in current["allocations"]}
        from app.modules.store_ledgers.router import approval_expense_join_condition

        affected.update(
            p
            for p in session.scalars(
                select(ExpenseBankMatch.accounting_period)
                .join(ExpenseItem, ExpenseItem.id == ExpenseBankMatch.expense_item_id)
                .join(ApprovalInstance, approval_expense_join_condition())
                .where(ApprovalInstance.id == approval.id, ExpenseBankMatch.status == "confirmed")
            )
            if p
        )
        ledgers = session.scalars(
            select(Ledger)
            .where(Ledger.store_id == approval.store_id, Ledger.period.in_(affected))
            .with_for_update()
        ).all()
        closed = next((ledger.period for ledger in ledgers if ledger.status == "closed"), None)
        if closed:
            raise HTTPException(409, f"{closed} 账期已封账，不能调整审批单入账方案")
    return current


def prepare_candidate(session, match, item, allocations, version):
    for name in ("_effective_allocations", "_effective_accounting_version"):
        if hasattr(match, name):
            delattr(match, name)
    match.accounting_allocations_json = None
    match.requested_accounting_version = version
    if allocations is not None:
        rows = [a.model_dump(mode="json") if hasattr(a, "model_dump") else a for a in allocations]
        rows = [
            {"period": row["period"], "amount": f"{Decimal(row['amount']):.2f}"} for row in rows
        ]
        validate_allocations(session, approval_for_item(session, item), rows, version)
        match.accounting_allocations_json = json.dumps(rows, ensure_ascii=False)


def ensure_periods_open(session, item, periods=()):
    approval = approval_for_item(session, item)
    affected = set(periods)
    if approval:
        affected.update(a["period"] for a in read_plan(session, approval.id)["allocations"])
    ledgers = session.scalars(
        select(Ledger)
        .where(Ledger.store_id == item.store_id, Ledger.period.in_(affected))
        .with_for_update()
    ).all()
    closed = next((ledger for ledger in ledgers if ledger.status == "closed"), None)
    if closed:
        raise HTTPException(409, f"{closed.period} 账期已封账，不能调整入账或解除匹配")


def apply_plan(session, match, item, actor):
    approval = approval_for_item(session, item)
    if approval is None:
        if match.accounting_allocations_json:
            raise HTTPException(422, "该费用没有关联审批单，不能设置审批单多账期")
        return
    current = read_plan(session, approval.id)
    has_confirmed = session.scalar(
        select(ExpenseBankMatch.id)
        .where(
            ExpenseBankMatch.expense_item_id.in_(
                [e.id for e in approval_items(session, approval.id)]
            ),
            ExpenseBankMatch.status == "confirmed",
            ExpenseBankMatch.id != match.id,
        )
        .limit(1)
    )
    if not has_confirmed:
        ensure_periods_open(
            session, item, [match.accounting_period] if match.accounting_period else []
        )
    if not match.accounting_allocations_json:
        if current["configured"]:
            validate_allocations(session, approval, current["allocations"], current["version"])
        return
    rows = json.loads(match.accounting_allocations_json)
    current = validate_allocations(session, approval, rows, match.requested_accounting_version)
    if current["allocations"] == sorted(rows, key=lambda a: a["period"]):
        return
    plan = session.get(ApprovalAccountingPlan, approval.id)
    if plan is None:
        plan = ApprovalAccountingPlan(approval_id=approval.id, version=0, updated_by=actor)
        session.add(plan)
        session.flush()
    plan.version += 1
    plan.updated_by = actor
    plan.updated_at = utc_now()
    session.execute(
        delete(ApprovalAccountingAllocation).where(
            ApprovalAccountingAllocation.approval_id == approval.id
        )
    )
    from sqlalchemy.dialects.postgresql import insert

    for row in rows:
        session.execute(
            insert(Ledger)
            .values(store_id=approval.store_id, period=row["period"])
            .on_conflict_do_nothing(index_elements=["store_id", "period"])
        )
    for row in rows:
        session.add(
            ApprovalAccountingAllocation(
                approval_id=approval.id, period=row["period"], amount=Decimal(row["amount"])
            )
        )
    session.flush()
    write_audit_log(
        session,
        actor=actor,
        action="approval.accounting.update",
        resource_type="approval_instance",
        resource_id=approval.id,
        summary="更新审批单入账账期分配",
        metadata={"before": current["allocations"], "after": rows, "version": plan.version},
    )


def annotate_matches(session, matches):
    from app.modules.store_ledgers.router import approval_expense_join_condition

    mapping = dict(
        session.execute(
            select(ExpenseItem.id, ApprovalInstance.id)
            .join(ApprovalInstance, approval_expense_join_condition())
            .where(ExpenseItem.id.in_([m.expense_item_id for m in matches]))
        ).all()
    )
    headers = {
        p.approval_id: p
        for p in session.scalars(
            select(ApprovalAccountingPlan).where(
                ApprovalAccountingPlan.approval_id.in_(list(mapping.values()))
            )
        )
    }
    allocations = {}
    for row in session.scalars(
        select(ApprovalAccountingAllocation)
        .where(ApprovalAccountingAllocation.approval_id.in_(list(headers)))
        .order_by(ApprovalAccountingAllocation.period)
    ):
        allocations.setdefault(row.approval_id, []).append(
            {"period": row.period, "amount": str(row.amount)}
        )
    for match in matches:
        approval_id = mapping.get(match.expense_item_id)
        if approval_id in headers:
            match._effective_allocations = allocations.get(approval_id, [])
            match._effective_accounting_version = headers[approval_id].version


def allocation_matrix(items, allocations):
    """Integer cents, largest remainder, with both month and item totals conserved."""
    remaining = {item.id: int(Decimal(item.amount) * 100) for item in items}
    if sum(remaining.values()) != sum(int(Decimal(a["amount"]) * 100) for a in allocations):
        raise HTTPException(409, "审批金额已变化，请重新核对多账期入账金额")
    result = {}
    ordered = sorted(allocations, key=lambda a: a["period"])
    for index, row in enumerate(ordered):
        cents = int(Decimal(row["amount"]) * 100)
        total = sum(remaining.values())
        if index == len(ordered) - 1:
            shares = dict(remaining)
        else:
            shares = {key: cents * amount // total for key, amount in remaining.items()}
            rest = cents - sum(shares.values())
            ranks = sorted(remaining, key=lambda key: (-(cents * remaining[key] % total), key))
            for key in ranks[:rest]:
                shares[key] += 1
        result[row["period"]] = shares
        for key, amount in shares.items():
            remaining[key] -= amount
    return result


def planned_rows_for_periods(session, store_id, periods):
    from app.modules.store_ledgers.router import approval_expense_join_condition

    plans = list(
        session.scalars(
            select(ApprovalAccountingPlan)
            .join(ApprovalInstance, ApprovalInstance.id == ApprovalAccountingPlan.approval_id)
            .where(ApprovalInstance.store_id == store_id)
        )
    )
    ids = [p.approval_id for p in plans]
    if not ids:
        return set(), {}
    groups = {}
    owned = set()
    for item, approval_id in session.execute(
        select(ExpenseItem, ApprovalInstance.id)
        .join(ApprovalInstance, approval_expense_join_condition())
        .where(
            ApprovalInstance.id.in_(ids),
            ExpenseItem.store_id == store_id,
            ExpenseItem.expense_scope == "operating",
        )
    ):
        groups.setdefault(approval_id, []).append(item)
        owned.add(item.id)
    active = set(
        session.scalars(
            select(ApprovalInstance.id)
            .join(ExpenseItem, approval_expense_join_condition())
            .join(ExpenseBankMatch, ExpenseBankMatch.expense_item_id == ExpenseItem.id)
            .where(
                ApprovalInstance.id.in_(ids),
                ExpenseBankMatch.status == "confirmed",
                ExpenseBankMatch.expense_scope == "operating",
            )
        )
    )
    allocations = {}
    for row in session.scalars(
        select(ApprovalAccountingAllocation).where(
            ApprovalAccountingAllocation.approval_id.in_(ids)
        )
    ):
        allocations.setdefault(row.approval_id, []).append(
            {"period": row.period, "amount": str(row.amount)}
        )
    result = {period: [] for period in periods}
    for approval_id in active:
        items = canonical_expense_items(groups.get(approval_id, []))
        rows = allocations.get(approval_id, [])
        matrix = allocation_matrix(items, rows)
        for period in periods:
            for item in items:
                amount = matrix.get(period, {}).get(item.id, 0)
                if amount:
                    result[period].append(
                        (item.id, item.category_l1, item.category_l2, Decimal(amount) / 100)
                    )
    return owned, result


def protect_expense_changes(session, item, changes):
    changed = {
        key
        for key in ("amount", "category_l1", "category_l2")
        if key in changes and changes[key] != getattr(item, key)
    }
    if not changed:
        return
    approval = approval_for_item(session, item)
    if not approval:
        return
    from app.modules.bank.unpaid import mutation_lock

    mutation_lock(session)
    session.scalar(
        select(ApprovalInstance.id).where(ApprovalInstance.id == approval.id).with_for_update()
    )
    if not session.get(ApprovalAccountingPlan, approval.id, populate_existing=True):
        return
    ensure_periods_open(session, item)
    if "amount" in changed and session.scalar(
        select(ExpenseBankMatch.id)
        .where(
            ExpenseBankMatch.expense_item_id.in_(
                [row.id for row in approval_items(session, approval.id)]
            ),
            ExpenseBankMatch.status == "confirmed",
        )
        .limit(1)
    ):
        raise HTTPException(
            409, "审批单已有多账期入账，请先解除匹配再修改原金额，并重新核对入账方案"
        )


def overlay_planned_expenses(
    session, base_items, store_ids, period_start=None, period_end=None, *, aggregate=False
):
    """Replace only explicitly scheduled approvals; leave legacy analytics untouched."""
    from types import SimpleNamespace

    from app.modules.expense_classification import is_non_operating_expense

    owned_all = set()
    additions = []
    scheduled_store_ids = list(
        session.scalars(
            select(ApprovalInstance.store_id)
            .join(ApprovalAccountingPlan, ApprovalAccountingPlan.approval_id == ApprovalInstance.id)
            .where(ApprovalInstance.store_id.in_(store_ids))
            .distinct()
        )
    )
    for store_id in scheduled_store_ids:
        query = (
            select(ApprovalAccountingAllocation.period)
            .join(ApprovalInstance, ApprovalInstance.id == ApprovalAccountingAllocation.approval_id)
            .where(ApprovalInstance.store_id == store_id)
        )
        if period_start:
            query = query.where(ApprovalAccountingAllocation.period >= period_start)
        if period_end:
            query = query.where(ApprovalAccountingAllocation.period <= period_end)
        periods = list(session.scalars(query.distinct()))
        owned, rows = planned_rows_for_periods(session, store_id, periods)
        owned_all.update(owned)
        values = [
            (period, row)
            for period, items in rows.items()
            for row in items
            if not is_non_operating_expense(row[1], row[2])
        ]
        originals = {
            e.id: e
            for e in session.scalars(
                select(ExpenseItem).where(ExpenseItem.id.in_([row[0] for _, row in values]))
            )
        }
        combined = {}
        for period, row in values:
            item = originals[row[0]]
            key = item.id if aggregate else (item.id, period)
            if key in combined:
                combined[key].amount += row[3]
                continue
            data = {
                column.key: getattr(item, column.key) for column in ExpenseItem.__table__.columns
            }
            data.update(amount=row[3], ledger_period=period)
            combined[key] = SimpleNamespace(**data)
        additions.extend(combined.values())
    return [item for item in base_items if item.id not in owned_all] + additions
