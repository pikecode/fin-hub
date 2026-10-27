"""Derived entries owned by bank transactions; no matching records are created."""

from datetime import datetime, time, timedelta
from decimal import Decimal

from fastapi import HTTPException
from sqlalchemy import select, func, text
from sqlalchemy.orm import Session

from app.models import (
    BankTransaction,
    ExpenseItem,
    ExpenseCategory,
    RevenueChannel,
    RevenueRecord,
    Ledger,
)

LABELS = {
    "bank_interest": "银行结息",
    "bank_fee": "银行手续费",
    "bank_sms_fee": "银行短信费",
    "bank_other_expense": "银行其他支出",
}
SOURCE = "bank_direct"


def validate_direct_posting(kind, direction, special_type):
    if kind and special_type:
        raise HTTPException(422, "直接入账属性不能与特殊流水属性同时选择")
    if kind and direction != ("income" if kind == "bank_interest" else "expense"):
        raise HTTPException(422, "银行结息必须为收入，银行费用必须为支出")


def posting_key(transaction):
    return (
        (transaction.store_id, transaction.occurred_at.date())
        if transaction.direct_posting_type == "bank_interest"
        else None
    )


def open_period(session, store_id, period):
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store_id, Ledger.period == period)
    )
    if ledger and ledger.status == "closed":
        raise HTTPException(409, "直接入账涉及的月份已封账，不能修改")
    if not ledger:
        session.add(Ledger(store_id=store_id, period=period))
        session.flush()


def sync_direct_posting(session: Session, bank: BankTransaction, *, old_key=None, deleting=False):
    kind = bank.direct_posting_type
    if kind and not deleting and bank.payment_status != "paid":
        raise HTTPException(422, "直接入账仅支持已实付或已实收流水")
    if kind and not deleting:
        if bank.special_type:
            raise HTTPException(422, "直接入账属性不能与特殊流水属性同时选择")
        if bank.direction != ("income" if kind == "bank_interest" else "expense"):
            raise HTTPException(422, "银行结息必须为收入，银行费用必须为支出")
    existing = session.scalar(
        select(ExpenseItem).where(
            ExpenseItem.source == SOURCE, ExpenseItem.source_document_id == bank.id
        )
    )
    keys = {key for key in (old_key, posting_key(bank)) if key}
    if not kind and not existing and not keys:
        return
    # Serialize short derived-entry updates, including first insertion for a day.
    if session.get_bind().dialect.name == "postgresql":
        session.execute(text("SELECT pg_advisory_xact_lock(2026102601)"))
    if existing:
        open_period(session, existing.store_id, existing.ledger_period)
    if kind and not deleting:
        open_period(session, bank.store_id, bank.occurred_at.strftime("%Y-%m"))
    if existing and (deleting or not kind or kind == "bank_interest"):
        session.delete(existing)
    if kind and kind != "bank_interest" and not deleting:
        parent = session.scalar(
            select(ExpenseCategory).where(
                ExpenseCategory.name == "银行费用", ExpenseCategory.parent_id.is_(None)
            )
        )
        if not parent:
            parent = ExpenseCategory(name="银行费用")
            session.add(parent)
            session.flush()
        child = session.scalar(
            select(ExpenseCategory).where(
                ExpenseCategory.name == "银行相关支出", ExpenseCategory.parent_id == parent.id
            )
        )
        if not child:
            child = ExpenseCategory(name="银行相关支出", parent_id=parent.id)
            session.add(child)
        if not existing:
            existing = ExpenseItem(
                source=SOURCE,
                source_document_id=bank.id,
                description=LABELS[kind],
                amount=bank.amount,
            )
            session.add(existing)
        existing.store_id = bank.store_id
        existing.ledger_period = bank.occurred_at.strftime("%Y-%m")
        existing.expense_date = bank.occurred_at.date()
        existing.description = LABELS[kind]
        existing.amount = bank.amount
        existing.category_l1, existing.category_l2 = "银行费用", "银行相关支出"
        existing.payment_status = "paid"
        existing.remark = bank.summary
    session.flush()
    for store_id, day in sorted(keys):
        period = day.strftime("%Y-%m")
        open_period(session, store_id, period)
        query = select(func.sum(BankTransaction.amount)).where(
            BankTransaction.store_id == store_id,
            BankTransaction.direct_posting_type == "bank_interest",
            BankTransaction.occurred_at >= datetime.combine(day, time.min),
            BankTransaction.occurred_at < datetime.combine(day, time.min) + timedelta(days=1),
        )
        if deleting:
            query = query.where(BankTransaction.id != bank.id)
        total = session.scalar(query) or Decimal("0")
        record = session.scalar(
            select(RevenueRecord).where(
                RevenueRecord.store_id == store_id,
                RevenueRecord.ledger_period == period,
                RevenueRecord.revenue_date == day,
                RevenueRecord.channel == "银行结息",
            )
        )
        if record and not record.is_bank_direct and total:
            raise HTTPException(409, "该日已有手工银行结息收入，请先核对，避免重复入账")
        if total == 0:
            if record and record.is_bank_direct:
                session.delete(record)
            continue
        channel = session.scalar(select(RevenueChannel).where(RevenueChannel.name == "银行结息"))
        if not channel:
            session.add(RevenueChannel(name="银行结息", requires_bank_match=False))
        if not record:
            record = RevenueRecord(
                store_id=store_id,
                ledger_period=period,
                revenue_date=day,
                channel="银行结息",
                gross_amount=total,
                net_amount=total,
                is_bank_direct=True,
            )
            session.add(record)
        record.gross_amount = record.net_amount = total
        record.fee_amount = Decimal("0")
        record.remark = "由银行流水直接入账，修改请前往银行流水"
    session.flush()
