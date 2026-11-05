from datetime import UTC, date, datetime
from decimal import Decimal

from sqlalchemy import func, select

from app.models import (
    AuditLog,
    BankBalanceCorrection,
    BankTransaction,
    FinancialReportMonthSetting,
    Ledger,
    Store,
    User,
)


def setup(session):
    store = Store(name="手工报表余额测试")
    session.add(store)
    session.flush()
    session.add(Ledger(store_id=store.id, period="2026-09"))
    session.commit()
    return store


def save(client, store, amount, expected=None, period="2026-09", reason="按银行确认余额录入"):
    return client.patch(
        f"/api/reports/financial-bank-balance?store_id={store.id}&period={period}",
        json={"amount": amount, "expected": expected, "reason": reason},
    )


def test_manual_balance_is_report_only_zero_negative_and_clear(client, session):
    store = setup(session)
    user = session.scalar(select(User).where(User.username == "admin"))
    session.add_all(
        [
            BankBalanceCorrection(
                store_id=store.id,
                correction_date=date(2026, 9, 1),
                balance_amount=1000,
                remark="真实银行余额",
                created_by=user.id,
            ),
            BankTransaction(
                store_id=store.id,
                ledger_period="2026-09",
                occurred_at=datetime(2026, 9, 2, tzinfo=UTC),
                direction="expense",
                amount=100,
                payment_status="paid",
            ),
        ]
    )
    session.commit()
    bank_url = f"/api/bank-balance?store_id={store.id}"
    real = client.get(bank_url).json()["data"]
    report_url = f"/api/store-ledgers/{store.id}/report?period=2026-09"
    metrics = client.get(report_url).json()["data"]["metrics"]
    supplement = client.get(
        f"/api/reports/financial-supplement?store_id={store.id}&period=2026-09"
    ).json()["data"]
    assert supplement["bank_balance"]["status"] == "missing_manual"
    assert supplement["bank_balance"]["amount"] is None  # No automatic bank fallback.
    expected = None
    for amount in ("25000.18", "0", "-12.34", None):
        response = save(client, store, amount, expected)
        assert response.status_code == 200, response.text
        balance = response.json()["data"]["bank_balance"]
        assert balance["source"] == "manual"
        assert balance["status"] == ("ready" if amount is not None else "missing_manual")
        expected = str(Decimal(amount).quantize(Decimal(".01"))) if amount is not None else None
        assert balance["amount"] == expected
        assert client.get(bank_url).json()["data"] == real
        assert client.get(report_url).json()["data"]["metrics"] == metrics
    assert session.scalar(select(func.count()).select_from(BankBalanceCorrection)) == 1
    assert session.scalar(select(func.count()).select_from(BankTransaction)) == 1
    logs = list(
        session.scalars(select(AuditLog).where(AuditLog.action == "report.bank_balance.update"))
    )
    assert len(logs) == 4 and "按银行确认余额录入" in logs[0].metadata_json


def test_balance_conflict_and_period_isolation(client, session):
    store = setup(session)
    assert save(client, store, "100").status_code == 200
    assert save(client, store, "200").status_code == 409
    session.rollback()
    other = setup(session)
    assert save(client, other, "300").status_code == 200
    session.expire_all()
    setting = session.scalar(
        select(FinancialReportMonthSetting).where(FinancialReportMonthSetting.store_id == store.id)
    )
    assert setting.bank_balance_manual == Decimal(100)
    assert save(client, store, "200", "100", period="2026-10").status_code == 409


def test_balance_validation_closed_and_readonly(client, session):
    from app.core.security import hash_password

    store = setup(session)
    for amount in ("NaN", "1.001", "1234567890123.00"):
        assert save(client, store, amount).status_code == 422
    assert save(client, store, "100", reason=" ").status_code == 422
    session.scalar(select(Ledger).where(Ledger.store_id == store.id)).status = "closed"
    session.commit()
    assert save(client, store, "100").status_code == 409
    session.rollback()
    session.add(
        User(
            username="manual-balance-viewer",
            display_name="只读",
            role="viewer",
            status="active",
            password_hash=hash_password("viewer-pass"),
        )
    )
    session.commit()
    assert (
        client.post(
            "/api/auth/login", json={"username": "manual-balance-viewer", "password": "viewer-pass"}
        ).status_code
        == 200
    )
    assert save(client, store, "100").status_code == 403


def test_0041_migration_preserves_targets_without_fabricating_balance(client, session):
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations
    from sqlalchemy import text

    store = setup(session)
    session.add(
        FinancialReportMonthSetting(store_id=store.id, period="2026-09", revenue_target=1000)
    )
    session.commit()
    session.execute(
        text("ALTER TABLE financial_report_month_settings DROP COLUMN bank_balance_manual")
    )
    session.commit()
    spec = importlib.util.spec_from_file_location(
        "balance_migration",
        Path(__file__).parents[1] / "alembic/versions/20261104_0041_report_manual_bank_balance.py",
    )
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    migration.op = Operations(MigrationContext.configure(session.connection()))
    migration.upgrade()
    row = session.execute(
        text("SELECT revenue_target,bank_balance_manual FROM financial_report_month_settings")
    ).one()
    assert row[0] == Decimal(1000) and row[1] is None
    migration.downgrade()
    migration.upgrade()
    session.commit()
