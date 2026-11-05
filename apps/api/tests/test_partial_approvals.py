from datetime import datetime
from decimal import Decimal

from app.models import (
    ApprovalInstance,
    ApprovalTemplate,
    BankTransaction,
    ExpenseCategory,
    ExpenseItem,
)
from app.modules.approvals.status import approval_expense_stats_map


def salary_fixture(client, session, *, lines=False):
    store = client.post("/api/stores", json={"name": "工资分批发放店"}).json()["data"]["id"]
    for month in ("2026-09", "2026-10", "2026-11"):
        client.post("/api/ledgers", json={"store_id": store, "period": month})
    template = ApprovalTemplate(name="工资审批", process_code="salary-parts", is_enabled=True)
    category = ExpenseCategory(name="人力成本")
    session.add_all([template, category])
    session.flush()
    session.add(ExpenseCategory(name="职工薪酬", parent_id=category.id))
    approval = ApprovalInstance(
        template_id=template.id,
        dingtalk_instance_id="salary-many",
        approval_no="SALARY-60000",
        approval_status="agree",
        store_id=store,
        applicant_name="工资测试",
        parse_status="parsed",
    )
    session.add(approval)
    session.flush()
    items = []
    for index, amount in enumerate(["20000", "40000"] if lines else ["60000"]):
        item = ExpenseItem(
            store_id=store,
            ledger_period="2026-09",
            description="员工工资",
            amount=Decimal(amount),
            expense_date=datetime.fromisoformat("2026-09-30T00:00:00").date(),
            category_l1="人力成本",
            category_l2="职工薪酬",
            source="dingtalk",
            source_document_id=f"salary-many:{index}" if lines else "salary-many",
            approval_instance_id=approval.id,
            user_edited_fields_json='["category_l1","category_l2"]',
        )
        session.add(item)
        items.append(item)
    banks = []
    for index, amount in enumerate(["20000", "25000", "15000"]):
        period = "2026-10" if index == 0 else "2026-11"
        bank = BankTransaction(
            store_id=store,
            ledger_period=period,
            occurred_at=datetime.fromisoformat(period + f"-0{index + 1}T00:00:00"),
            direction="expense",
            amount=Decimal(amount),
            counterparty_name="工资代发",
        )
        session.add(bank)
        banks.append(bank)
    session.commit()
    return store, approval, items, banks


def match_bank(client, item, bank):
    response = client.post(
        "/api/matches",
        json={
            "expense_item_id": item.id,
            "bank_transaction_id": bank.id,
            "amount": str(bank.amount),
            "accounting_period": "2026-09",
            "category_l1": "人力成本",
            "category_l2": "职工薪酬",
        },
    )
    assert response.status_code == 201, response.text
    match_id = response.json()["data"]["id"]
    response = client.post(f"/api/matches/{match_id}/confirm")
    assert response.status_code == 200, response.text
    return match_id


def test_partial_approval_follows_confirmed_payments_and_reappears_on_unmatch(client, session):
    store, approval, items, banks = salary_fixture(client, session)
    endpoint = "/api/matches/reconciliation/partial-approvals"
    assert client.get(endpoint, params={"store_id": store}).json()["data"]["total"] == 0
    ids = [match_bank(client, items[0], banks[0])]
    row = client.get(endpoint, params={"store_id": store}).json()["data"]["items"][0]
    assert (
        row["total_amount"],
        row["matched_amount"],
        row["remaining_amount"],
        row["confirmed_payment_count"],
    ) == ("60000.00", "20000.00", "40000.00", 1)
    candidates = client.get(
        "/api/matches/reconciliation/candidates",
        params={"store_id": store, "bank_transaction_id": banks[1].id},
    ).json()["data"]["candidates"]
    assert len(candidates) == 1 and candidates[0]["remaining_amount"] == "40000.00"
    assert candidates[0]["approval_instance"]["processing_status"] == "partial_matched"
    ids.append(match_bank(client, items[0], banks[1]))
    row = client.get(endpoint, params={"store_id": store}).json()["data"]["items"][0]
    assert row["remaining_amount"] == "15000.00" and row["confirmed_payment_count"] == 2
    ids.append(match_bank(client, items[0], banks[2]))
    assert client.get(endpoint, params={"store_id": store}).json()["data"]["total"] == 0
    assert (
        approval_expense_stats_map(session, [approval.id])[approval.id]["processing_status"]
        == "matched"
    )
    assert client.post(f"/api/matches/reconciliation/records/{ids[1]}/unmatch").status_code == 200
    assert (
        client.get(endpoint, params={"store_id": store}).json()["data"]["items"][0][
            "remaining_amount"
        ]
        == "25000.00"
    )


def test_paid_line_does_not_hide_remaining_approval_and_candidate_does_not_complete_it(
    client, session
):
    store, approval, items, banks = salary_fixture(client, session, lines=True)
    match_bank(client, items[0], banks[0])
    assert items[0].payment_status == "paid"
    result = client.get(
        "/api/matches/reconciliation/candidates",
        params={"store_id": store, "bank_transaction_id": banks[1].id},
    )
    assert result.status_code == 200, result.text
    candidate = result.json()["data"]["candidates"][0]
    assert (
        candidate["approval_instance"]["id"] == approval.id
        and candidate["remaining_amount"] == "40000.00"
    )
    response = client.post(
        "/api/matches",
        json={
            "expense_item_id": items[1].id,
            "bank_transaction_id": banks[1].id,
            "amount": "25000",
            "accounting_period": "2026-09",
            "category_l1": "人力成本",
            "category_l2": "职工薪酬",
        },
    )
    assert response.status_code == 201
    row = client.get(
        "/api/matches/reconciliation/partial-approvals", params={"store_id": store}
    ).json()["data"]["items"][0]
    assert row["matched_amount"] == "20000.00" and row["confirmed_payment_count"] == 1


def test_legacy_summary_matches_count_without_double_counting_approval_total(client, session):
    from app.models import ExpenseBankMatch

    store, approval, _items, banks = salary_fixture(client, session, lines=True)
    summary = ExpenseItem(
        store_id=store,
        ledger_period="2026-09",
        description="旧整单摘要",
        amount=60000,
        source="dingtalk",
        source_document_id="salary-many",
        approval_instance_id=None,
    )
    session.add(summary)
    session.flush()
    session.add(
        ExpenseBankMatch(
            expense_item_id=summary.id,
            bank_transaction_id=banks[0].id,
            amount=20000,
            accounting_period="2026-09",
            status="confirmed",
        )
    )
    session.commit()
    stats = approval_expense_stats_map(session, [approval.id])[approval.id]
    assert stats["total_expense_amount"] == Decimal(60000) and stats[
        "confirmed_match_amount"
    ] == Decimal(20000)
    row = client.get(
        "/api/matches/reconciliation/partial-approvals", params={"store_id": store}
    ).json()["data"]["items"][0]
    assert row["remaining_amount"] == "40000.00"


def test_partial_list_is_store_scoped_and_keyword_filterable(client, session):
    from sqlalchemy import select

    from app.models import User

    store, _, items, banks = salary_fixture(client, session)
    match_bank(client, items[0], banks[0])
    endpoint = "/api/matches/reconciliation/partial-approvals"
    assert (
        client.get(endpoint, params={"store_id": store, "keyword": "no-such-approval"}).json()[
            "data"
        ]["total"]
        == 0
    )
    assert (
        client.get(endpoint, params={"store_id": store, "keyword": "工资测试"}).json()["data"][
            "total"
        ]
        == 1
    )
    user = session.scalar(select(User).where(User.username == "admin"))
    user.role = "viewer"
    session.commit()
    assert client.get(endpoint, params={"store_id": store}).status_code == 403


def test_matching_ignores_closed_bank_source_period_but_protects_accounting_month(client, session):
    from sqlalchemy import select
    from app.models import Ledger

    store, approval, items, banks = salary_fixture(client, session)
    source = session.scalar(select(Ledger).where(Ledger.store_id == store, Ledger.period == "2026-10"))
    source.status = "closed"
    session.commit()
    target = session.scalar(select(Ledger).where(Ledger.store_id == store, Ledger.period == "2026-09"))
    target.status = "closed"
    session.commit()
    response = client.post("/api/matches", json={
        "expense_item_id": items[0].id,
        "bank_transaction_id": banks[1].id,
        "amount": str(banks[1].amount),
        "accounting_period": "2026-09",
    })
    assert response.status_code == 201, response.text
    match_id = response.json()["data"]["id"]
    response = client.post(f"/api/matches/{match_id}/confirm")
    assert response.status_code == 409, response.text
    session.rollback()
    target.status = "open"
    session.commit()
    match_bank(client, items[0], banks[0])
