from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import func, select

from app.models import AccrualEntry, AuditLog, ExpenseCategory, Ledger


def matched_approval(session, store_id, amount, period="2026-10", suffix="one"):
    from app.models import (
        ApprovalInstance,
        ApprovalTemplate,
        BankTransaction,
        ExpenseBankMatch,
        ExpenseItem,
    )

    template = ApprovalTemplate(name="工资审批", process_code="salary-" + suffix)
    session.add(template)
    session.flush()
    approval = ApprovalInstance(
        template_id=template.id,
        dingtalk_instance_id="salary-" + suffix,
        store_id=store_id,
        approval_no="salary-" + suffix,
        approval_status="agree",
    )
    session.add(approval)
    session.flush()
    item = ExpenseItem(
        store_id=store_id,
        ledger_period=period,
        expense_date=date.fromisoformat(period + "-01"),
        description="实际工资",
        amount=Decimal(amount),
        category_l1="人力成本",
        category_l2="职工薪酬",
        approval_instance_id=approval.id,
        source="dingtalk",
        user_edited_fields_json='["category_l1","category_l2"]',
    )
    bank = BankTransaction(
        store_id=store_id,
        ledger_period=period,
        occurred_at=datetime.fromisoformat(period + "-01T12:00:00"),
        direction="expense",
        amount=Decimal(amount),
        matched_amount=Decimal(amount),
    )
    session.add_all([item, bank])
    session.flush()
    match = ExpenseBankMatch(
        expense_item_id=item.id,
        bank_transaction_id=bank.id,
        amount=Decimal(amount),
        accounting_period=period,
        status="confirmed",
    )
    session.add(match)
    session.commit()
    return approval, item, bank, match


def test_coverage_reports_supplement_and_frozen_original(client, session):
    from app.modules.store_ledgers.router import (
        calculate_store_ledger_profit,
        calculate_store_ledger_profits,
    )

    payload = setup_store(client, session)
    original = client.post("/api/accruals", json=payload).json()["data"]["id"]
    store = payload["store_id"]
    approval, _item, _bank, match = matched_approval(session, store, "70000")
    old_ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store, Ledger.period == "2026-09")
    )
    old_ledger.status = "closed"
    session.commit()
    link_payload = {
        "original_id": original,
        "approval_id": approval.id,
        "amount": "65000",
        "remark": "九月已计提",
        "request_key": "cover",
    }
    response = client.post("/api/accruals/links", json=link_payload)
    assert response.status_code == 200, response.text
    assert (
        client.post("/api/accruals/links", json=link_payload).json()["data"]["id"]
        == response.json()["data"]["id"]
    )

    def metrics(period):
        response = client.get(f"/api/store-ledgers/{store}/workspace", params={"period": period})
        assert response.status_code == 200, response.text
        return response.json()["data"]["metrics"]

    assert metrics("2026-09")["expense_amount"] == "65000.00"
    assert metrics("2026-10")["expense_amount"] == "5000.00"
    supplement = {
        **payload,
        "original_id": original,
        "entry_type": "supplement",
        "period": "2026-10",
        "amount": "5000",
        "remark": "实际七万，差额补提",
        "request_key": "extra",
    }
    assert client.post("/api/accruals", json=supplement).status_code == 200
    assert (
        client.post(
            "/api/accruals/links",
            json={**link_payload, "amount": "5000", "request_key": "extra-cover"},
        ).status_code
        == 200
    )
    assert metrics("2026-10")["expense_amount"] == "5000.00"
    assert sum(
        Decimal(row["amount"]) for row in metrics("2026-10")["expense_category_summary"]
    ) == Decimal(5000)
    assert calculate_store_ledger_profit(session, store, "2026-10") == Decimal(-5000)
    assert calculate_store_ledger_profits(session, store, ["2026-09", "2026-10"])[
        "2026-09"
    ] == Decimal(-65000)
    appendix = client.get(
        "/api/reports/financial-appendix", params={"store_id": store, "period": "2026-10"}
    ).json()["data"]
    assert sum(Decimal(row["amount"]) for row in appendix["expense_items"]) == Decimal(5000)
    analytics = client.get(
        "/api/reports/analytics",
        params={"store_id": store, "period_start": "2026-10", "period_end": "2026-10"},
    ).json()["data"]
    assert analytics["metrics"]["total_expense_amount"] == "5000.00"
    current = session.scalar(
        select(Ledger).where(Ledger.store_id == store, Ledger.period == "2026-10")
    )
    current.status = "closed"
    session.commit()
    assert (
        client.post(
            f"/api/accruals/links/{response.json()['data']['id']}/revoke", json={"reason": "测试"}
        ).status_code
        == 409
    )
    assert client.post(f"/api/matches/reconciliation/records/{match.id}/unmatch").status_code == 409


def test_signed_reversal_detail_and_coverage_release(client, session):
    payload = setup_store(client, session)
    store = payload["store_id"]
    original = client.post("/api/accruals", json=payload).json()["data"]["id"]
    approval, _, _, match = matched_approval(session, store, "60000")
    response = client.post(
        "/api/accruals/links",
        json={
            "original_id": original,
            "approval_id": approval.id,
            "amount": "60000",
            "remark": "已计提工资",
            "request_key": "cover",
        },
    )
    assert response.status_code == 200, response.text
    reversal = {
        **payload,
        "entry_type": "reversal",
        "original_id": original,
        "period": "2026-10",
        "amount": "5000",
        "request_key": "reverse",
    }
    assert client.post("/api/accruals", json=reversal).status_code == 200
    assert (
        client.post(
            "/api/accruals", json={**reversal, "amount": "1", "request_key": "too-far"}
        ).status_code
        == 409
    )
    for endpoint in ("/api/reports/financial-appendix", "/api/reports/analytics/details"):
        result = client.get(
            endpoint,
            params={
                "store_id": store,
                "period": "2026-10",
                "period_start": "2026-10",
                "period_end": "2026-10",
                "detail_type": "report_expense",
                "category_l1": "人力成本",
            },
        )
        assert result.status_code == 200, result.text
        assert sum(
            Decimal(row["amount"]) for row in result.json()["data"]["expense_items"]
        ) == Decimal(-5000)
    assert client.patch(f"/api/expense-items/{original}", json={"amount": "1"}).status_code == 409
    assert client.post(f"/api/matches/reconciliation/records/{match.id}/unmatch").status_code == 200
    links = client.get("/api/accruals/links", params={"store_id": store}).json()["data"]
    assert not links[0]["active"]


def test_coverage_cent_rounding_across_accounting_months(client, session):
    from app.models import ApprovalAccountingAllocation, ApprovalAccountingPlan
    from app.modules.store_ledgers.router import confirmed_accounting_expense_rows

    payload = {**setup_store(client, session), "amount": "1.01"}
    original = client.post("/api/accruals", json=payload).json()["data"]["id"]
    approval, _, _, _ = matched_approval(session, payload["store_id"], "3.03")
    session.add(ApprovalAccountingPlan(approval_id=approval.id, updated_by="test"))
    session.flush()
    session.add_all(
        [
            ApprovalAccountingAllocation(
                approval_id=approval.id, period="2026-10", amount=Decimal("1.01")
            ),
            ApprovalAccountingAllocation(
                approval_id=approval.id, period="2026-11", amount=Decimal("2.02")
            ),
        ]
    )
    session.commit()
    response = client.post(
        "/api/accruals/links",
        json={
            "original_id": original,
            "approval_id": approval.id,
            "amount": "1.01",
            "remark": "分月费用部分计提",
            "request_key": "fraction",
        },
    )
    assert response.status_code == 200, response.text
    totals = [
        sum(
            (
                row[3]
                for row in confirmed_accounting_expense_rows(session, payload["store_id"], period)
            ),
            Decimal(0),
        )
        for period in ("2026-10", "2026-11")
    ]
    assert totals == [Decimal("0.67"), Decimal("1.35")]
    assert sum(totals) == Decimal("2.02")


def test_concurrent_reversals_do_not_overdraw(client, session):
    from concurrent.futures import ThreadPoolExecutor

    from fastapi import HTTPException
    from sqlalchemy.orm import Session

    from app.models import User
    from app.modules.accruals import EntryCreate, create_entry

    payload = setup_store(client, session)
    original = client.post("/api/accruals", json=payload).json()["data"]["id"]
    engine = session.get_bind()

    def reverse(key):
        with Session(engine) as worker:
            user = worker.scalar(select(User).where(User.username == "admin"))
            try:
                create_entry(
                    EntryCreate(
                        **{
                            **payload,
                            "entry_type": "reversal",
                            "original_id": original,
                            "period": "2026-10",
                            "amount": "60000",
                            "request_key": key,
                        }
                    ),
                    worker,
                    user,
                )
                return 200
            except HTTPException as exc:
                worker.rollback()
                return exc.status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(reverse, ["concurrent-a", "concurrent-b"])) == [200, 409]


def test_match_confirm_coverage_rolls_back_on_invalid_original(client, session):
    from app.models import ExpenseBankMatch

    payload = setup_store(client, session)
    _, _item, _, match = matched_approval(session, payload["store_id"], "100")
    match.status = "candidate"
    match.accrual_coverage_json = '{"original_id":"missing","amount":"100","remark":"原计提不存在","confirm_category_difference":false}'
    session.commit()
    response = client.post(f"/api/matches/{match.id}/confirm")
    assert response.status_code == 404, response.text
    session.expire_all()
    assert session.get(ExpenseBankMatch, match.id).status == "candidate"


def test_match_confirmation_creates_coverage_atomically(client, session):
    from app.models import AccrualApprovalLink

    payload = {**setup_store(client, session), "amount": "100"}
    original = client.post("/api/accruals", json=payload).json()["data"]["id"]
    _, _item, bank, match = matched_approval(session, payload["store_id"], "100")
    match.status = "candidate"
    bank.matched_amount = Decimal(0)
    match.accrual_coverage_json = (
        '{"original_id":"'
        + original
        + '","amount":"100","remark":"工资已计提","confirm_category_difference":false}'
    )
    session.commit()
    response = client.post(f"/api/matches/{match.id}/confirm")
    assert response.status_code == 200, response.text
    assert client.post(f"/api/matches/{match.id}/confirm").status_code == 200
    assert session.scalar(select(func.count()).select_from(AccrualApprovalLink)) == 1
    result = client.get(
        f"/api/store-ledgers/{payload['store_id']}/workspace", params={"period": "2026-10"}
    )
    assert result.json()["data"]["metrics"]["expense_amount"] == "0.00"


def test_one_accrual_can_cover_multiple_approvals_and_reject_overcoverage(client, session):
    payload = {**setup_store(client, session), "amount": "100"}
    original = client.post("/api/accruals", json=payload).json()["data"]["id"]
    first, _, _, _ = matched_approval(session, payload["store_id"], "60", suffix="first")
    second, _, _, _ = matched_approval(session, payload["store_id"], "40", suffix="second")
    data = {
        "original_id": original,
        "approval_id": first.id,
        "amount": "60",
        "remark": "分两笔发薪",
        "request_key": "first",
    }
    assert client.post("/api/accruals/links", json=data).status_code == 200
    assert (
        client.post(
            "/api/accruals/links",
            json={**data, "approval_id": second.id, "amount": "40", "request_key": "second"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            "/api/accruals/links", json={**data, "amount": "0.01", "request_key": "extra"}
        ).status_code
        == 409
    )
    result = client.get(
        f"/api/store-ledgers/{payload['store_id']}/workspace", params={"period": "2026-10"}
    )
    assert result.json()["data"]["metrics"]["expense_amount"] == "0.00"


def test_multiple_payment_months_do_not_repeat_covered_approval(client, session):
    from app.models import BankTransaction, ExpenseBankMatch

    payload = {**setup_store(client, session), "amount": "100"}
    original = client.post("/api/accruals", json=payload).json()["data"]["id"]
    approval, item, _, _ = matched_approval(session, payload["store_id"], "100")
    bank = BankTransaction(
        store_id=payload["store_id"],
        ledger_period="2026-11",
        occurred_at=datetime.fromisoformat("2026-11-01T00:00:00"),
        direction="expense",
        amount=Decimal(50),
    )
    session.add(bank)
    session.flush()
    session.add(
        ExpenseBankMatch(
            expense_item_id=item.id,
            bank_transaction_id=bank.id,
            amount=Decimal(50),
            accounting_period="2026-11",
            status="confirmed",
        )
    )
    session.commit()
    response = client.post(
        "/api/accruals/links",
        json={
            "original_id": original,
            "approval_id": approval.id,
            "amount": "100",
            "remark": "多笔付款",
            "request_key": "multiple",
        },
    )
    assert response.status_code == 200, response.text
    for period in ("2026-10", "2026-11"):
        result = client.get(
            f"/api/store-ledgers/{payload['store_id']}/workspace", params={"period": period}
        )
        assert result.json()["data"]["metrics"]["expense_amount"] == "0.00"


def test_accrual_requires_login(anonymous_client):
    assert anonymous_client.get("/api/accruals", params={"store_id": "unknown"}).status_code == 401


def setup_store(client, session):
    store = client.post("/api/stores", json={"name": "计提测试店"}).json()["data"]["id"]
    for period in ("2026-09", "2026-10", "2026-11"):
        client.post("/api/ledgers", json={"store_id": store, "period": period})
    root = ExpenseCategory(name="人力成本")
    session.add(root)
    session.flush()
    session.add(ExpenseCategory(name="职工薪酬", parent_id=root.id))
    session.commit()
    return {
        "store_id": store,
        "period": "2026-09",
        "category_l1": "人力成本",
        "category_l2": "职工薪酬",
        "amount": "65000",
        "remark": "九月工资暂估",
        "request_key": "salary-september",
    }


def test_supplement_into_new_later_month_after_original_closed(client, session):
    payload = {**setup_store(client, session), "period": "2026-10"}
    original = client.post("/api/accruals", json=payload).json()["data"]["id"]
    ledger = session.scalar(select(Ledger).where(
        Ledger.store_id == payload["store_id"], Ledger.period == "2026-10"))
    ledger.status = "closed"
    later = session.scalar(select(Ledger).where(
        Ledger.store_id == payload["store_id"], Ledger.period == "2026-11"))
    session.delete(later)
    session.commit()
    adjustment = {**payload, "period": "2026-11", "original_id": original,
        "entry_type": "supplement", "amount": "3000", "request_key": "november-adjustment"}
    response = client.post("/api/accruals", json=adjustment)
    assert response.status_code == 409
    assert "创建目标账期" in response.text
    session.rollback()
    response = client.post("/api/ledgers", json={"store_id": payload["store_id"], "period": "2026-11"})
    assert response.status_code == 201, response.text
    response = client.post("/api/accruals", json=adjustment)
    assert response.status_code == 200, response.text
    assert response.json()["data"]["period"] == "2026-11"
    assert session.get(Ledger, ledger.id).status == "closed"
    from app.modules.store_ledgers.router import calculate_store_ledger_profit
    assert calculate_store_ledger_profit(session, payload["store_id"], "2026-10") == Decimal("-65000")
    assert calculate_store_ledger_profit(session, payload["store_id"], "2026-11") == Decimal("-3000")


def test_accrual_adjustments_idempotency_and_close(client, session):
    payload = setup_store(client, session)
    response = client.post("/api/accruals", json=payload)
    assert response.status_code == 200, response.text
    original = response.json()["data"]["id"]
    assert client.post("/api/accruals", json=payload).json()["data"]["id"] == original
    assert client.post("/api/accruals", json={**payload, "amount": "64000"}).status_code == 409
    change = {
        **payload,
        "original_id": original,
        "period": "2026-10",
        "entry_type": "supplement",
        "amount": "5000",
        "request_key": "supplement",
        "remark": "实际工资七万",
    }
    assert client.post("/api/accruals", json=change).status_code == 200
    reversal = {**change, "entry_type": "reversal", "request_key": "reversal", "amount": "10000"}
    assert client.post("/api/accruals", json=reversal).status_code == 200
    assert (
        client.post(
            "/api/accruals", json={**reversal, "amount": "60000.01", "request_key": "excess"}
        ).status_code
        == 409
    )
    rows = client.get(
        "/api/accruals", params={"store_id": payload["store_id"], "period": "2026-09"}
    ).json()["data"]
    assert len(rows) == 1 and rows[0]["amount"] == "65000.00"
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == payload["store_id"], Ledger.period == "2026-10")
    )
    ledger.status = "closed"
    session.commit()
    assert client.post("/api/accruals", json={**change, "request_key": "closed"}).status_code == 409
    assert session.scalar(select(func.count()).select_from(AccrualEntry)) == 3
    assert (
        session.scalar(
            select(func.count())
            .select_from(AuditLog)
            .where(AuditLog.resource_type == "accrual_entry")
        )
        == 3
    )


def test_accrual_validation_and_future_supplement_cannot_fund_earlier_reversal(client, session):
    payload = setup_store(client, session)
    for changes in ({"remark": "  "}, {"amount": "0"}, {"amount": "-1"}, {"amount": "1.001"}):
        assert client.post("/api/accruals", json={**payload, **changes}).status_code == 422
    assert (
        client.post("/api/accruals", json={**payload, "category_l2": "不存在"}).status_code == 409
    )
    original = client.post("/api/accruals", json=payload).json()["data"]["id"]
    change = {
        **payload,
        "original_id": original,
        "entry_type": "supplement",
        "amount": "5000",
        "period": "2026-11",
        "request_key": "november",
    }
    assert client.post("/api/accruals", json=change).status_code == 200
    assert (
        client.post(
            "/api/accruals",
            json={
                **change,
                "entry_type": "reversal",
                "amount": "70000",
                "period": "2026-10",
                "request_key": "october",
            },
        ).status_code
        == 409
    )
    other = client.post("/api/stores", json={"name": "其他店"}).json()["data"]["id"]
    client.post("/api/ledgers", json={"store_id": other, "period": "2026-11"})
    assert client.post("/api/accruals", json={**change, "store_id": other}).status_code == 409
    assert session.scalar(
        select(AccrualEntry.amount).where(AccrualEntry.id == original)
    ) == Decimal(65000)
