"""Accrual reporting and approval coverage, with cent-exact cross-month deductions."""

from decimal import Decimal
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import select

from app.models import (
    AccrualApprovalLink,
    AccrualEntry,
    ApprovalAccountingAllocation,
    ApprovalAccountingPlan,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
)


def active_links(session, **filters):
    query = select(AccrualApprovalLink).where(AccrualApprovalLink.active.is_(True))
    for key, value in filters.items():
        query = query.where(getattr(AccrualApprovalLink, key) == value)
    return list(session.scalars(query))


def effective_amount(session, original):
    return original.amount + sum(
        (
            (-r.amount if r.entry_type == "reversal" else r.amount)
            for r in session.scalars(
                select(AccrualEntry).where(AccrualEntry.original_id == original.id)
            )
        ),
        Decimal(0),
    )


def ensure_approval_open(session, approval):
    from app.modules.matching.accounting import approval_items

    ids = [item.id for item in approval_items(session, approval.id)]
    periods = set(
        session.scalars(
            select(ExpenseBankMatch.accounting_period).where(
                ExpenseBankMatch.expense_item_id.in_(ids), ExpenseBankMatch.status == "confirmed"
            )
        )
    )
    periods.update(
        session.scalars(
            select(ApprovalAccountingAllocation.period).where(
                ApprovalAccountingAllocation.approval_id == approval.id
            )
        )
    )
    closed = session.scalar(
        select(Ledger.period)
        .where(
            Ledger.store_id == approval.store_id,
            Ledger.period.in_([p for p in periods if p]),
            Ledger.status == "closed",
        )
        .with_for_update()
    )
    if closed:
        raise HTTPException(409, f"{closed} 已封账，不能改变审批计提覆盖")


def coverage_deductions(session, store_id):
    """Spread covered cents over the approval's complete accounting matrix once."""
    from app.modules.matching.accounting import approval_items
    from app.modules.store_ledgers.router import confirmed_accounting_expense_rows

    links = list(
        session.scalars(
            select(AccrualApprovalLink)
            .join(AccrualEntry, AccrualEntry.id == AccrualApprovalLink.original_id)
            .where(AccrualEntry.store_id == store_id, AccrualApprovalLink.active.is_(True))
        )
    )
    result = {}
    for approval_id in {row.approval_id for row in links}:
        ids = {item.id for item in approval_items(session, approval_id)}
        periods = set(
            session.scalars(
                select(ExpenseBankMatch.accounting_period).where(
                    ExpenseBankMatch.expense_item_id.in_(ids),
                    ExpenseBankMatch.status == "confirmed",
                )
            )
        )
        periods.update(
            session.scalars(
                select(ApprovalAccountingAllocation.period).where(
                    ApprovalAccountingAllocation.approval_id == approval_id
                )
            )
        )
        cells = {}
        for period in sorted(p for p in periods if p):
            for row in confirmed_accounting_expense_rows(
                session, store_id, period, apply_accrual=False
            ):
                if row[0] in ids and row[3] > 0:
                    cells[(row[0], period)] = int(row[3] * 100)
        if any(link.whole_approval for link in links if link.approval_id == approval_id):
            result.update({key: Decimal(value) / 100 for key, value in cells.items()})
            continue
        total = sum(cells.values())
        # Legacy multiple payments can reference the same approval in multiple
        # months. Once accrual-covered, recognize its uncovered cost only once;
        # an explicit accounting plan remains authoritative when configured.
        if cells and not session.get(ApprovalAccountingPlan, approval_id):
            first_period = min(period for _, period in cells)
            result.update(
                {
                    key: Decimal(value) / 100
                    for key, value in cells.items()
                    if key[1] != first_period
                }
            )
            cells = {key: value for key, value in cells.items() if key[1] == first_period}
            total = sum(cells.values())
        if not total:
            continue
        covered = min(
            total,
            int(sum((l.amount for l in links if l.approval_id == approval_id), Decimal(0)) * 100),
        )
        shares = {key: value * covered // total for key, value in cells.items()}
        for key in sorted(cells, key=lambda k: (-(cells[k] * covered % total), k))[
            : covered - sum(shares.values())
        ]:
            shares[key] += 1
        result.update({key: Decimal(value) / 100 for key, value in shares.items()})
    return result


def adjust_rows(session, store_id, period, rows):
    deductions = coverage_deductions(session, store_id)
    return [
        (key, l1, l2, amount - deductions.get((key, period), Decimal(0)))
        for key, l1, l2, amount in rows
        if amount - deductions.get((key, period), Decimal(0)) != 0
    ]


def release_unmatched_coverage(session, item, actor):
    from app.modules.audit.service import write_audit_log
    from app.modules.matching.accounting import approval_for_item, approval_items

    approval = approval_for_item(session, item)
    if not approval:
        return
    ids = [row.id for row in approval_items(session, approval.id)]
    if session.scalar(
        select(ExpenseBankMatch.id)
        .where(ExpenseBankMatch.expense_item_id.in_(ids), ExpenseBankMatch.status == "confirmed")
        .limit(1)
    ):
        return
    for link in active_links(session, approval_id=approval.id):
        link.active = False
        write_audit_log(
            session,
            actor=actor,
            action="accrual.unlink",
            resource_type="accrual_approval_link",
            resource_id=link.id,
            summary="最后一笔审批对账解除，释放计提覆盖",
            metadata={"approval_id": approval.id},
        )


def overlay_reports(session, base_items, store_ids, start=None, end=None, *, aggregate=False):
    """Stores using accruals share the canonical monthly expense source in all reports."""
    from app.modules.expense_classification import is_non_operating_expense
    from app.modules.store_ledgers.router import confirmed_accounting_expense_rows

    affected = set(
        session.scalars(
            select(AccrualEntry.store_id).where(AccrualEntry.store_id.in_(store_ids)).distinct()
        )
    )
    result = [row for row in base_items if row.store_id not in affected]
    for store_id in affected:
        periods = set(session.scalars(select(Ledger.period).where(Ledger.store_id == store_id)))
        for period in sorted(
            p for p in periods if (not start or p >= start) and (not end or p <= end)
        ):
            rows = confirmed_accounting_expense_rows(session, store_id, period)
            automatic = list(
                session.scalars(
                    select(ExpenseItem).where(
                        ExpenseItem.store_id == store_id,
                        ExpenseItem.ledger_period == period,
                        ExpenseItem.source.in_(["revenue_fee", "kuailv_purchase"]),
                    )
                )
            )
            values = {key: amount for key, _, _, amount in rows}
            originals = list(session.scalars(select(ExpenseItem).where(ExpenseItem.id.in_(values))))
            for item in originals + automatic:
                if is_non_operating_expense(item.category_l1, item.category_l2):
                    continue
                data = {c.key: getattr(item, c.key) for c in ExpenseItem.__table__.columns}
                data.update(amount=values.get(item.id, item.amount), ledger_period=period)
                result.append(SimpleNamespace(**data))
    if aggregate:
        combined = {}
        for row in result:
            if row.id in combined:
                combined[row.id].amount += row.amount
            else:
                combined[row.id] = SimpleNamespace(
                    **{c.key: getattr(row, c.key) for c in ExpenseItem.__table__.columns}
                )
        return list(combined.values())
    return result
