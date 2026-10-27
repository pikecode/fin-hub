from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import select, func

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    AuditLog,
    BankBalanceCorrection,
    BankTransaction,
    DividendEntry,
    DividendMonth,
    ExpenseBankMatch,
    ExpenseItem,
    Ledger,
    PreopeningStore,
    RevenueBankMatch,
    RevenueRecord,
    Store,
    User,
)
from app.modules.reports.financial import balance_at


def store_row(session):
    store = Store(name="月报调整测试门店")
    session.add(store)
    session.commit()
    return store


def bank_row(session, store, day, amount, direction="expense", **kwargs):
    bank = BankTransaction(
        store_id=store.id,
        ledger_period=day[:7],
        occurred_at=datetime.fromisoformat(day + "T12:00:00"),
        direction=direction,
        amount=amount,
        payment_status="paid",
        **kwargs,
    )
    session.add(bank)
    session.flush()
    return bank


def test_month_target_validation_lock_audit_and_read_without_writes(client, session):
    store = store_row(session)
    url = f"/api/reports/financial-supplement?store_id={store.id}&period=2026-09"
    before = session.scalar(select(func.count()).select_from(DividendMonth))
    data = client.get(url)
    assert data.status_code == 200, data.text
    assert data.json()["data"]["revenue_target"] is None
    assert data.json()["data"]["bank_balance"]["date"] == "2026-10-10"
    assert session.scalar(select(func.count()).select_from(DividendMonth)) == before
    assert session.scalar(select(func.count()).select_from(Ledger)) == 0
    target = f"/api/reports/financial-target?store_id={store.id}&period=2026-09"
    for value in ["100000.55", "0", None]:
        response = client.patch(target, json={"revenue_target": value})
        assert response.status_code == 200, response.text
        assert response.json()["data"]["revenue_target"] == (
            None if value is None else str(Decimal(value).quantize(Decimal(".01")))
        )
    assert client.patch(target, json={"revenue_target": "-1"}).status_code == 422
    assert client.get(url.replace("2026-09", "2026-13")).status_code == 422
    session.add(Ledger(store_id=store.id, period="2026-09", status="closed"))
    session.commit()
    assert client.patch(target, json={"revenue_target": "2"}).status_code == 409
    assert (
        session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.action == "report.target.update")
        )
        == 3
    )


def test_cutoff_balance_inclusive_day_future_base_and_unpaid(client, session):
    store = store_row(session)
    user = session.scalar(select(User))
    session.add_all(
        [
            BankBalanceCorrection(
                store_id=store.id,
                correction_date=date(2026, 10, 1),
                balance_amount=1000,
                remark="测试基准",
                created_by=user.id,
            ),
            BankBalanceCorrection(
                store_id=store.id,
                correction_date=date(2026, 10, 11),
                balance_amount=99999,
                remark="后续校正",
                created_by=user.id,
            ),
        ]
    )
    bank_row(session, store, "2026-10-01", 50)
    bank_row(session, store, "2026-10-10", 100, "income")
    bank_row(session, store, "2026-10-11", 500)
    unpaid = bank_row(session, store, "2026-10-03", 700)
    unpaid.payment_status = "unpaid"
    unreceived = bank_row(session, store, "2026-10-03", 200, "income")
    unreceived.payment_status = "unreceived"
    archived = bank_row(session, store, "2026-10-04", 300)
    archived.is_archived = True
    session.commit()
    result = balance_at(session, store.id, date(2026, 10, 10), today=date(2026, 10, 12))
    assert result["amount"] == "1050.00"
    assert (
        balance_at(session, store.id, date(2026, 10, 10), today=date(2026, 10, 10))["status"]
        == "pending"
    )
    response = client.get(f"/api/reports/financial-supplement?store_id={store.id}&period=2026-12")
    assert response.json()["data"]["bank_balance"]["date"] == "2027-01-10"


def test_manual_dividend_remaining_and_zero_funding_override(client, session):
    store = store_row(session)
    months = [
        DividendMonth(store_id=store.id, period=p, manual_remaining_undistributed=value)
        for p, value in [("2026-09", 12), ("2026-10", 100), ("2026-11", None), ("2026-12", None)]
    ]
    session.add_all(months)
    session.flush()
    session.add_all(
        [
            DividendEntry(
                month_id=months[2].id,
                entry_type="capital",
                shareholder_name="股东",
                holding_ratio=100,
                amount=20,
            ),
            DividendEntry(
                month_id=months[2].id,
                entry_type="distribution",
                shareholder_name="股东",
                holding_ratio=100,
                amount=10,
            ),
            DividendEntry(
                month_id=months[3].id,
                entry_type="distribution",
                shareholder_name="股东",
                holding_ratio=100,
                amount=999,
            ),
            RevenueRecord(
                store_id=store.id,
                ledger_period="2026-11",
                revenue_date=date(2026, 11, 2),
                channel="测试",
                gross_amount=50,
                net_amount=50,
                fee_amount=0,
            ),
        ]
    )
    session.commit()
    funding_url = f"/api/dividends/stores/{store.id}/funding-settings"
    response = client.patch(
        funding_url, json={"preopening_investment": "1000", "preopening_expense_override": "0"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["preopening_expense_amount"] == "0.00"
    assert response.json()["data"]["preopening_expense_source"] == "manual"
    supplement = client.get(
        f"/api/reports/financial-supplement?store_id={store.id}&period=2026-11"
    ).json()["data"]
    assert supplement["remaining_undistributed"] == "140.00"
    assert supplement["total_capital"] == "1020.00"
    assert supplement["cumulative_distribution"] == "10.00"
    historical = client.get(
        f"/api/reports/financial-supplement?store_id={store.id}&period=2026-09"
    ).json()["data"]
    assert historical["remaining_undistributed"] == "12.00"
    assert (
        client.patch(
            funding_url, json={"preopening_investment": "0", "preopening_expense_override": None}
        ).json()["data"]["preopening_expense_source"]
        == "report"
    )
    session.add(PreopeningStore(store_id=store.id, status="closed"))
    session.commit()
    assert client.patch(funding_url, json={"preopening_investment": "1"}).status_code == 409


def test_appendix_uses_accounting_month_full_approval_details_and_no_500_limit(client, session):
    store = store_row(session)
    template = ApprovalTemplate(name="测试报销", process_code="monthly-appendix")
    session.add(template)
    session.flush()
    approval = ApprovalInstance(
        template_id=template.id,
        store_id=store.id,
        dingtalk_instance_id="appendix-approval",
        approval_status="agree",
        submit_at=datetime(2026, 9, 1),
    )
    session.add(approval)
    session.flush()
    items = [
        ExpenseItem(
            store_id=store.id,
            ledger_period="2026-09",
            expense_date=date(2026, 9, 2),
            description=name,
            amount=amount,
            category_l1="食材成本",
            category_l2=name,
            approval_instance_id=approval.id,
            source="dingtalk",
            source_document_id=f"appendix-approval:{i}",
        )
        for i, (name, amount) in enumerate([("鸡", 60), ("青菜", 40)])
    ]
    session.add_all(items)
    bank = bank_row(session, store, "2026-10-05", 100)
    session.flush()
    session.add_all(
        [
            ExpenseBankMatch(
                expense_item_id=items[0].id,
                bank_transaction_id=bank.id,
                amount=60,
                status="confirmed",
                accounting_period="2026-09",
            ),
            ExpenseBankMatch(
                expense_item_id=items[1].id,
                bank_transaction_id=bank.id,
                amount=40,
                status="confirmed",
                accounting_period="2026-10",
            ),
        ]
    )
    for i in range(501):
        bank_row(
            session, store, "2026-09-01", 1, special_type="other_income_expense", summary=f"备注{i}"
        )
    revenue_bank = bank_row(session, store, "2026-10-08", 20, "income")
    session.add(
        RevenueBankMatch(
            bank_transaction_id=revenue_bank.id,
            channel="美团",
            revenue_start_date=date(2026, 9, 1),
            revenue_end_date=date(2026, 9, 2),
            amount=20,
            status="confirmed",
            accounting_period="2026-09",
        )
    )
    session.commit()
    response = client.get(f"/api/reports/financial-appendix?store_id={store.id}&period=2026-09")
    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert len(data["rows"]) == 503
    bank_detail = next(row for row in data["rows"] if row["transaction"]["id"] == bank.id)
    assert bank_detail["business"][0]["accounting_amount"] == "60.00"
    assert len(bank_detail["business"][0]["expense_details"]) == 2
    assert len(data["expense_items"]) == 2
    assert data["expense_items"][0]["application_date"].startswith("2026-09-01")
    october = client.get(
        f"/api/reports/financial-appendix?store_id={store.id}&period=2026-10"
    ).json()["data"]
    assert any(row["transaction"]["id"] == bank.id for row in october["rows"])


def test_preopening_fallback_deduplicates_whole_approval_and_partial_payments(client, session):
    store = store_row(session)
    template = ApprovalTemplate(name="筹建报销", process_code="funding-fallback")
    session.add(template)
    session.flush()
    approval = ApprovalInstance(
        template_id=template.id,
        store_id=store.id,
        dingtalk_instance_id="funding-expense",
        approval_status="agree",
        expense_scope="preopening",
    )
    session.add(approval)
    session.flush()
    summary = ExpenseItem(
        store_id=store.id,
        ledger_period="2026-09",
        expense_date=date(2026, 9, 1),
        description="整单",
        amount=100,
        source="dingtalk",
        source_document_id="funding-expense",
        expense_scope="preopening",
        approval_instance_id=approval.id,
    )
    lines = [
        ExpenseItem(
            store_id=store.id,
            ledger_period="2026-09",
            expense_date=date(2026, 9, 1),
            description="明细",
            amount=50,
            source="dingtalk",
            source_document_id=f"funding-expense:{i}",
            expense_scope="preopening",
            approval_instance_id=approval.id,
        )
        for i in range(2)
    ]
    session.add_all([summary, *lines])
    b1 = bank_row(session, store, "2026-09-01", 10)
    b2 = bank_row(session, store, "2026-09-02", 20)
    session.add_all(
        [
            ExpenseBankMatch(
                expense_item_id=lines[0].id,
                bank_transaction_id=b.id,
                amount=10,
                status="confirmed",
                expense_scope="preopening",
            )
            for b in [b1, b2]
        ]
    )
    session.commit()
    response = client.get(f"/api/dividends/stores/{store.id}/funding-settings")
    assert response.status_code == 200, response.text
    assert response.json()["data"]["preopening_expense_amount"] == "100.00"
    monthly = client.get(
        f"/api/reports/financial-appendix?store_id={store.id}&period=2026-09"
    ).json()["data"]
    assert monthly["rows"] == [] and monthly["expense_items"] == []


def test_completed_unpaid_appendix_keeps_real_payments_and_original_expenses(client, session):
    store = store_row(session)
    template = ApprovalTemplate(name="工资", process_code="appendix-settled")
    session.add(template)
    session.flush()
    approval = ApprovalInstance(
        template_id=template.id,
        store_id=store.id,
        dingtalk_instance_id="appendix-salary",
        approval_status="agree",
    )
    session.add(approval)
    session.flush()
    expense = ExpenseItem(
        store_id=store.id,
        ledger_period="2026-09",
        expense_date=date(2026, 9, 20),
        description="工资",
        amount=100,
        source="dingtalk",
        source_document_id="appendix-salary",
        category_l1="人力成本",
        category_l2="工资",
        approval_instance_id=approval.id,
    )
    session.add(expense)
    source = bank_row(session, store, "2026-09-20", 100)
    source.payment_status = "unpaid"
    real = [bank_row(session, store, "2026-10-01", 40), bank_row(session, store, "2026-10-02", 55)]
    session.add(
        ExpenseBankMatch(
            expense_item_id=expense.id,
            bank_transaction_id=source.id,
            accounting_period="2026-09",
            amount=100,
            status="confirmed",
            bank_occurred=False,
        )
    )
    session.commit()
    base = f"/api/bank-payment-settlements/{source.id}"
    assert (
        client.post(
            base + "/links", json={"bank_transaction_ids": [b.id for b in real]}
        ).status_code
        == 200
    )
    response = client.post(
        base + "/complete", json={"confirm_difference": True, "remark": "实际扣除差额"}
    )
    assert response.status_code == 200, response.text
    result = client.get(f"/api/reports/financial-appendix?store_id={store.id}&period=2026-09")
    assert result.status_code == 200, result.text
    data = result.json()["data"]
    assert {row["transaction"]["id"] for row in data["rows"]} == {b.id for b in real}
    assert all(row["business"][0]["settlement_group"] == source.id for row in data["rows"])
    assert len(data["expense_items"]) == 1
    assert Decimal(data["expense_items"][0]["amount"]) == 100


def test_missing_anchor_is_not_recomputed_from_historical_profits(client, session):
    store = store_row(session)
    session.add(
        DividendMonth(
            store_id=store.id,
            period="2026-09",
            manual_net_profit=999,
            manual_remaining_undistributed=12,
        )
    )
    session.commit()
    result = client.get(f"/api/reports/financial-supplement?store_id={store.id}&period=2026-11")
    assert result.status_code == 200, result.text
    assert result.json()["data"]["remaining_undistributed"] is None


def test_report_settings_reject_viewer_and_cross_store(client, session):
    from app.models import UserStorePermission
    from app.core.security import hash_password

    store = store_row(session)
    other = Store(name="无权限门店")
    user = User(
        username="report-viewer",
        display_name="只读",
        password_hash=hash_password("viewerpass"),
        role="viewer",
        status="active",
    )
    session.add_all([other, user])
    session.flush()
    session.add(UserStorePermission(user_id=user.id, store_id=store.id))
    session.commit()
    assert (
        client.post(
            "/api/auth/login", json={"username": "report-viewer", "password": "viewerpass"}
        ).status_code
        == 200
    )
    assert (
        client.get(
            f"/api/reports/financial-supplement?store_id={store.id}&period=2026-09"
        ).status_code
        == 200
    )
    assert (
        client.patch(
            f"/api/reports/financial-target?store_id={store.id}&period=2026-09",
            json={"revenue_target": "5"},
        ).status_code
        == 403
    )
    assert (
        client.patch(
            f"/api/dividends/stores/{store.id}/funding-settings",
            json={"preopening_investment": "5"},
        ).status_code
        == 403
    )
    assert (
        client.get(
            f"/api/reports/financial-appendix?store_id={other.id}&period=2026-09"
        ).status_code
        == 403
    )


def test_direct_postings_export_their_expenses_and_income_dates(client, session):
    store = store_row(session)
    for direction, kind, amount in [
        ("income", "bank_interest", "20"),
        ("expense", "bank_fee", "5"),
    ]:
        response = client.post(
            "/api/bank-transactions",
            json={
                "store_id": store.id,
                "ledger_period": "2026-09",
                "occurred_at": "2026-09-05T12:00:00",
                "direction": direction,
                "amount": amount,
                "counterparty_name": kind,
                "direct_posting_type": kind,
                "payment_status": "paid",
            },
        )
        assert response.status_code == 201, response.text
    response = client.get(f"/api/reports/financial-appendix?store_id={store.id}&period=2026-09")
    assert response.status_code == 200, response.text
    result = response.json()["data"]
    assert len(result["expense_items"]) == 1
    assert result["expense_items"][0]["category_l1"] == "银行费用"
    interest = next(
        row
        for row in result["rows"]
        if row["transaction"]["direct_posting_type"] == "bank_interest"
    )
    assert interest["business"][0]["revenue_start"] == "2026-09-05"
    fee = next(
        row for row in result["rows"] if row["transaction"]["direct_posting_type"] == "bank_fee"
    )
    assert fee["business"][0]["category_l1"] == "银行费用"

    report = client.get(f"/api/store-ledgers/{store.id}/report?period=2026-09")
    assert report.status_code == 200, report.text
    assert report.json()["data"]["metrics"]["expense_amount"] == "5.00"
    from app.modules.store_ledgers.router import calculate_store_ledger_profits

    assert calculate_store_ledger_profits(session, store.id, ["2026-09"])["2026-09"] == Decimal(
        "15.00"
    )
