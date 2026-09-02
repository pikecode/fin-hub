import time
from datetime import UTC, date, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import (
    BankTransaction,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
    RevenueBankMatch,
    RevenueRecord,
    Store,
)


@pytest.fixture()
def sample_store(session: Session) -> Store:
    store = Store(name="性能测试门店")
    session.add(store)
    session.commit()
    session.refresh(store)
    return store


@pytest.fixture()
def sample_ledger(session: Session, sample_store: Store) -> Ledger:
    ledger = Ledger(store_id=sample_store.id, period="2026-09")
    session.add(ledger)
    session.commit()
    session.refresh(ledger)
    return ledger


@pytest.mark.performance
def test_expense_query_performance(
    session: Session,
    sample_store: Store,
    sample_ledger: Ledger,
) -> None:
    for index in range(100):
        session.add(
            ExpenseItem(
                store_id=sample_store.id,
                ledger_period=sample_ledger.period,
                expense_date=date(2026, 9, (index % 30) + 1),
                description=f"测试支出 {index}",
                amount=Decimal("1000.00") + index,
                payment_status="unpaid",
            )
        )
    session.commit()

    start_time = time.time()
    result = session.scalars(
        select(ExpenseItem)
        .where(
            ExpenseItem.store_id == sample_store.id,
            ExpenseItem.ledger_period == sample_ledger.period,
        )
        .order_by(ExpenseItem.created_at.desc())
        .limit(50)
    ).all()
    elapsed_ms = (time.time() - start_time) * 1000

    assert len(result) == 50
    assert elapsed_ms < 100, f"支出明细查询耗时 {elapsed_ms:.2f}ms，超过 100ms 阈值"


@pytest.mark.performance
def test_bank_transaction_query_performance(
    session: Session,
    sample_store: Store,
    sample_ledger: Ledger,
) -> None:
    for index in range(100):
        session.add(
            BankTransaction(
                store_id=sample_store.id,
                ledger_period=sample_ledger.period,
                occurred_at=datetime(2026, 9, (index % 30) + 1, 10, 0, tzinfo=UTC),
                amount=Decimal("5000.00") + index,
                direction="income" if index % 2 == 0 else "expense",
                summary=f"测试流水 {index}",
            )
        )
    session.commit()

    start_time = time.time()
    result = session.scalars(
        select(BankTransaction)
        .where(
            BankTransaction.store_id == sample_store.id,
            BankTransaction.ledger_period == sample_ledger.period,
        )
        .order_by(BankTransaction.occurred_at.desc())
        .limit(50)
    ).all()
    elapsed_ms = (time.time() - start_time) * 1000

    assert len(result) == 50
    assert elapsed_ms < 100, f"银行流水查询耗时 {elapsed_ms:.2f}ms，超过 100ms 阈值"


@pytest.mark.performance
def test_revenue_query_performance(
    session: Session,
    sample_store: Store,
    sample_ledger: Ledger,
) -> None:
    for index in range(50):
        session.add(
            RevenueRecord(
                store_id=sample_store.id,
                ledger_period=sample_ledger.period,
                revenue_date=date(2026, 9, (index % 30) + 1),
                channel=f"渠道 {index}",
                gross_amount=Decimal("10000.00") + index,
                net_amount=Decimal("9800.00") + index,
                fee_amount=Decimal("200.00"),
            )
        )
    session.commit()

    start_time = time.time()
    result = session.scalars(
        select(RevenueRecord)
        .where(
            RevenueRecord.store_id == sample_store.id,
            RevenueRecord.ledger_period == sample_ledger.period,
        )
        .order_by(RevenueRecord.revenue_date.desc(), RevenueRecord.created_at.desc())
    ).all()
    elapsed_ms = (time.time() - start_time) * 1000

    assert len(result) == 50
    assert elapsed_ms < 100, f"营业收入查询耗时 {elapsed_ms:.2f}ms，超过 100ms 阈值"


@pytest.mark.performance
def test_match_query_performance(
    session: Session,
    sample_store: Store,
    sample_ledger: Ledger,
) -> None:
    expense = ExpenseItem(
        store_id=sample_store.id,
        ledger_period=sample_ledger.period,
        expense_date=date(2026, 9, 1),
        description="测试支付",
        amount=Decimal("1000.00"),
        payment_status="unpaid",
    )
    bank = BankTransaction(
        store_id=sample_store.id,
        ledger_period=sample_ledger.period,
        occurred_at=datetime(2026, 9, 1, 10, 0, tzinfo=UTC),
        amount=Decimal("1000.00"),
        direction="expense",
        summary="测试支付",
    )
    income_bank = BankTransaction(
        store_id=sample_store.id,
        ledger_period=sample_ledger.period,
        occurred_at=datetime(2026, 9, 2, 10, 0, tzinfo=UTC),
        amount=Decimal("9800.00"),
        direction="income",
        summary="测试收入",
    )
    session.add_all([expense, bank, income_bank])
    session.flush()
    session.add_all(
        [
            ExpenseBankMatch(
                expense_item_id=expense.id,
                bank_transaction_id=bank.id,
                amount=Decimal("1000.00"),
                status="confirmed",
            ),
            RevenueBankMatch(
                bank_transaction_id=income_bank.id,
                channel="渠道 A",
                revenue_start_date=date(2026, 9, 1),
                revenue_end_date=date(2026, 9, 1),
                amount=Decimal("9800.00"),
                status="confirmed",
            ),
        ]
    )
    session.commit()

    start_time = time.time()
    expense_matches = session.scalars(
        select(ExpenseBankMatch)
        .where(ExpenseBankMatch.status == "confirmed")
        .order_by(ExpenseBankMatch.created_at.desc())
        .limit(50)
    ).all()
    revenue_matches = session.scalars(
        select(RevenueBankMatch)
        .where(RevenueBankMatch.status == "confirmed")
        .order_by(RevenueBankMatch.created_at.desc())
        .limit(50)
    ).all()
    elapsed_ms = (time.time() - start_time) * 1000

    assert len(expense_matches) >= 1
    assert len(revenue_matches) >= 1
    assert elapsed_ms < 150, f"匹配查询耗时 {elapsed_ms:.2f}ms，超过 150ms 阈值"
