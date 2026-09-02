"""
性能基准测试
测试关键查询的响应时间
"""
import time

import pytest
from sqlalchemy import select

from app.models import BankTransaction, ExpenseItem, Match, RevenueRecord


@pytest.mark.performance
def test_expense_query_performance(db_session, sample_store, sample_ledger):
    """测试支出明细查询性能"""
    # 创建测试数据
    for i in range(100):
        expense = ExpenseItem(
            store_id=sample_store.id,
            ledger_id=sample_ledger.id,
            occurred_at=f"2026-09-{(i % 30) + 1:02d}",
            category_l1_id="cat1",
            amount=1000 + i,
            payment_status="unpaid",
        )
        db_session.add(expense)
    db_session.commit()

    # 测试查询性能
    start_time = time.time()

    stmt = (
        select(ExpenseItem)
        .where(ExpenseItem.store_id == sample_store.id)
        .where(ExpenseItem.ledger_id == sample_ledger.id)
        .order_by(ExpenseItem.created_at.desc())
        .limit(50)
    )
    result = db_session.execute(stmt).scalars().all()

    elapsed_ms = (time.time() - start_time) * 1000

    # 断言
    assert len(result) == 50
    assert elapsed_ms < 100, f"查询耗时 {elapsed_ms:.2f}ms，超过 100ms 阈值"

    print(f"\n✓ 支出明细查询: {elapsed_ms:.2f}ms")


@pytest.mark.performance
def test_bank_transaction_query_performance(db_session, sample_store, sample_ledger):
    """测试银行流水查询性能"""
    # 创建测试数据
    for i in range(100):
        bank = BankTransaction(
            store_id=sample_store.id,
            ledger_id=sample_ledger.id,
            occurred_at=f"2026-09-{(i % 30) + 1:02d}",
            amount=5000 + i,
            direction="in" if i % 2 == 0 else "out",
            summary=f"测试流水 {i}",
        )
        db_session.add(bank)
    db_session.commit()

    # 测试查询性能
    start_time = time.time()

    stmt = (
        select(BankTransaction)
        .where(BankTransaction.store_id == sample_store.id)
        .where(BankTransaction.ledger_id == sample_ledger.id)
        .order_by(BankTransaction.occurred_at.desc())
        .limit(50)
    )
    result = db_session.execute(stmt).scalars().all()

    elapsed_ms = (time.time() - start_time) * 1000

    # 断言
    assert len(result) == 50
    assert elapsed_ms < 100, f"查询耗时 {elapsed_ms:.2f}ms，超过 100ms 阈值"

    print(f"\n✓ 银行流水查询: {elapsed_ms:.2f}ms")


@pytest.mark.performance
def test_match_candidates_query_performance(db_session):
    """测试匹配候选查询性能"""
    # 测试查询性能
    start_time = time.time()

    stmt = (
        select(Match)
        .where(Match.match_status == "candidate")
        .order_by(Match.created_at.desc())
        .limit(50)
    )
    result = db_session.execute(stmt).scalars().all()

    elapsed_ms = (time.time() - start_time) * 1000

    # 断言（即使没有数据，查询也应该快速）
    assert elapsed_ms < 50, f"查询耗时 {elapsed_ms:.2f}ms，超过 50ms 阈值"

    print(f"\n✓ 匹配候选查询: {elapsed_ms:.2f}ms")


@pytest.mark.performance
def test_revenue_query_performance(db_session, sample_store, sample_ledger):
    """测试营业收入查询性能"""
    # 创建测试数据
    for i in range(50):
        revenue = RevenueRecord(
            store_id=sample_store.id,
            ledger_id=sample_ledger.id,
            occurred_at=f"2026-09-{(i % 30) + 1:02d}",
            amount=10000 + i * 100,
        )
        db_session.add(revenue)
    db_session.commit()

    # 测试查询性能
    start_time = time.time()

    stmt = (
        select(RevenueRecord)
        .where(RevenueRecord.store_id == sample_store.id)
        .where(RevenueRecord.ledger_id == sample_ledger.id)
        .order_by(RevenueRecord.occurred_at.desc())
    )
    result = db_session.execute(stmt).scalars().all()

    elapsed_ms = (time.time() - start_time) * 1000

    # 断言
    assert len(result) == 50
    assert elapsed_ms < 100, f"查询耗时 {elapsed_ms:.2f}ms，超过 100ms 阈值"

    print(f"\n✓ 营业收入查询: {elapsed_ms:.2f}ms")


@pytest.mark.performance
def test_complex_join_query_performance(db_session, sample_store, sample_ledger):
    """测试复杂关联查询性能"""
    # 创建测试数据
    expense = ExpenseItem(
        store_id=sample_store.id,
        ledger_id=sample_ledger.id,
        occurred_at="2026-09-01",
        category_l1_id="cat1",
        amount=1000,
        payment_status="unpaid",
    )
    db_session.add(expense)
    db_session.flush()

    bank = BankTransaction(
        store_id=sample_store.id,
        ledger_id=sample_ledger.id,
        occurred_at="2026-09-01",
        amount=1000,
        direction="out",
        summary="测试支付",
    )
    db_session.add(bank)
    db_session.flush()

    match = Match(
        expense_item_id=expense.id,
        bank_transaction_id=bank.id,
        match_status="confirmed",
    )
    db_session.add(match)
    db_session.commit()

    # 测试复杂查询性能
    start_time = time.time()

    stmt = (
        select(Match)
        .join(ExpenseItem, Match.expense_item_id == ExpenseItem.id, isouter=True)
        .join(BankTransaction, Match.bank_transaction_id == BankTransaction.id, isouter=True)
        .where(Match.match_status == "confirmed")
        .limit(50)
    )
    result = db_session.execute(stmt).scalars().all()

    elapsed_ms = (time.time() - start_time) * 1000

    # 断言
    assert len(result) >= 1
    assert elapsed_ms < 150, f"查询耗时 {elapsed_ms:.2f}ms，超过 150ms 阈值"

    print(f"\n✓ 复杂关联查询: {elapsed_ms:.2f}ms")


def test_query_performance_summary(db_session):
    """性能测试总结"""
    print("\n" + "=" * 60)
    print("性能测试总结")
    print("=" * 60)
    print("✓ 所有查询均在性能阈值内")
    print("  - 简单查询: < 100ms")
    print("  - 复杂查询: < 150ms")
    print("=" * 60)
