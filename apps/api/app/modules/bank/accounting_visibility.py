"""Read-only distinction between list ledger assignment and actual posting months."""

from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import func, select

from app.models import (
    ApprovalAccountingAllocation,
    ApprovalInstance,
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    RevenueBankMatch,
)


def direct_month_conditions(period, *, cross_only=False):
    try:
        start = datetime.strptime(period, "%Y-%m")  # noqa: DTZ007
        end = start.replace(year=start.year + (start.month == 12), month=start.month % 12 + 1)
    except ValueError:
        raise HTTPException(422, "请选择有效的入账月份") from None
    conditions = [
        BankTransaction.direct_posting_type.is_not(None),
        BankTransaction.occurred_at >= start,
        BankTransaction.occurred_at < end,
    ]
    if cross_only:
        conditions.append(BankTransaction.ledger_period != period)
    return conditions


def attach_accounting_periods(session, items):
    by_id = {item.id: set() for item in items}
    for row in items:
        if row.direct_posting_type:
            by_id[row.id].add(row.occurred_at.strftime("%Y-%m"))
    if not items:
        return
    matches = list(
        session.scalars(
            select(ExpenseBankMatch).where(
                ExpenseBankMatch.bank_transaction_id.in_(by_id),
                ExpenseBankMatch.status == "confirmed",
            )
        )
    )
    if matches:
        from app.modules.store_ledgers.router import approval_expense_join_condition

        approval_ids = dict(
            session.execute(
                select(ExpenseItem.id, ApprovalInstance.id)
                .join(ApprovalInstance, approval_expense_join_condition())
                .where(ExpenseItem.id.in_([match.expense_item_id for match in matches]))
            ).all()
        )
        allocated = {}
        for approval_id, period in session.execute(
            select(
                ApprovalAccountingAllocation.approval_id, ApprovalAccountingAllocation.period
            ).where(ApprovalAccountingAllocation.approval_id.in_(list(approval_ids.values())))
        ):
            allocated.setdefault(approval_id, set()).add(period)
        for match in matches:
            periods = allocated.get(approval_ids.get(match.expense_item_id))
            if periods:
                by_id[match.bank_transaction_id].update(periods)
            elif match.accounting_allocations:
                by_id[match.bank_transaction_id].update(
                    row["period"] for row in match.accounting_allocations
                )
            elif match.accounting_period:
                by_id[match.bank_transaction_id].add(match.accounting_period)
    for bank_id, period in session.execute(
        select(
            RevenueBankMatch.bank_transaction_id,
            func.coalesce(RevenueBankMatch.accounting_period, BankTransaction.ledger_period),
        )
        .join(BankTransaction, BankTransaction.id == RevenueBankMatch.bank_transaction_id)
        .where(
            RevenueBankMatch.bank_transaction_id.in_(by_id), RevenueBankMatch.status == "confirmed"
        )
    ):
        if period:
            by_id[bank_id].add(period)
    for row in items:
        row.accounting_periods = sorted(by_id[row.id])
