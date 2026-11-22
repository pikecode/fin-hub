from decimal import Decimal

from sqlalchemy import select
from test_partial_approvals import match_bank, salary_fixture

from app.models import ApprovalPaidAccounting, ExpenseBankMatch, Ledger
from app.modules.store_ledgers.router import confirmed_accounting_expense_rows


def rows(session, store, month):
    return confirmed_accounting_expense_rows(session, store, month)


def create(client, item, bank, amount=None, allocations=None):
    body = {
        "expense_item_id": item.id,
        "bank_transaction_id": bank.id,
        "amount": str(amount if amount is not None else bank.amount),
        "accounting_period": "2026-09",
    }
    if allocations:
        body.update(accounting_allocations=allocations, accounting_version=0)
    r = client.post("/api/matches", json=body)
    assert r.status_code == 201, r.text
    return r.json()["data"]["id"]


def test_confirm_overpaid_whole_approval_proportions_and_unmatch(client, session):
    store, approval, items, banks = salary_fixture(client, session, lines=True)
    banks[0].amount = Decimal("75000.01")
    banks[0].payment_status = "paid"
    session.commit()
    mid = create(client, items[0], banks[0])
    url = f"/api/matches/{mid}/confirm?paid_accounting=true"
    r = client.post(url)
    assert r.status_code == 200, r.text
    mode = session.get(ApprovalPaidAccounting, approval.id)
    assert mode.period == "2026-09"
    assert sorted(row[3] for row in rows(session, store, "2026-09")) == [
        Decimal("25000.00"),
        Decimal("50000.01"),
    ]
    assert rows(session, store, "2026-10") == []
    assert (
        client.get(f"/api/matches/approval-accounting/{approval.id}").json()["data"][
            "paid_accounting"
        ]
        is True
    )
    assert client.post(url).status_code == 200
    assert sum(row[3] for row in rows(session, store, "2026-09")) == Decimal("75000.01")
    assert client.post(f"/api/matches/reconciliation/records/{mid}/unmatch").status_code == 200
    assert sum((row[3] for row in rows(session, store, "2026-09")), Decimal(0)) == 0


def test_enabling_on_new_match_counts_all_confirmed_payments(client, session):
    store, approval, items, banks = salary_fixture(client, session, lines=True)
    for bank in banks:
        bank.payment_status = "paid"
    banks[1].amount = Decimal(45000)
    session.commit()
    match_bank(client, items[0], banks[0])
    mid = create(client, items[1], banks[1])
    r = client.post(f"/api/matches/{mid}/confirm?paid_accounting=true")
    assert r.status_code == 200, r.text
    assert sorted(row[3] for row in rows(session, store, "2026-09")) == [
        Decimal("21666.67"),
        Decimal("43333.33"),
    ]
    assert session.get(ApprovalPaidAccounting, approval.id).period == "2026-09"


def test_confirm_without_option_keeps_original_accounting(client, session):
    store, approval, items, banks = salary_fixture(client, session, lines=True)
    mid = create(client, items[0], banks[0])
    assert client.post(f"/api/matches/{mid}/confirm").status_code == 200
    assert session.get(ApprovalPaidAccounting, approval.id) is None
    assert sum(row[3] for row in rows(session, store, "2026-09")) == 60000
    assert client.post(f"/api/matches/{mid}/confirm?paid_accounting=true").status_code == 409


def test_multi_month_paid_failure_rolls_back_confirmation_and_plan(client, session):
    store, approval, items, banks = salary_fixture(client, session)
    mid = create(
        client,
        items[0],
        banks[0],
        allocations=[
            {"period": "2026-09", "amount": "30000"},
            {"period": "2026-10", "amount": "30000"},
        ],
    )
    r = client.post(f"/api/matches/{mid}/confirm?paid_accounting=true")
    assert r.status_code == 409, r.text
    session.expire_all()
    assert session.get(ExpenseBankMatch, mid).status == "candidate"
    assert session.get(ApprovalPaidAccounting, approval.id) is None
    assert banks[0].matched_amount == 0
    assert rows(session, store, "2026-09") == []


def test_paid_option_does_not_expense_unpaid_transaction(client, session):
    store, _approval, items, banks = salary_fixture(client, session)
    banks[0].payment_status = "unpaid"
    session.commit()
    mid = create(client, items[0], banks[0])
    r = client.post(f"/api/matches/{mid}/confirm?paid_accounting=true")
    assert r.status_code == 200, r.text
    assert sum((row[3] for row in rows(session, store, "2026-09")), Decimal(0)) == 0


def test_paid_option_cannot_exceed_bank_remaining(client, session):
    _store, approval, items, banks = salary_fixture(client, session)
    mid = create(client, items[0], banks[0], amount="20000.01")
    r = client.post(f"/api/matches/{mid}/confirm?paid_accounting=true")
    assert r.status_code == 409, r.text
    assert session.get(ApprovalPaidAccounting, approval.id) is None


def test_closed_month_cannot_enable_paid_at_confirmation(client, session):
    store, approval, items, banks = salary_fixture(client, session)
    mid = create(client, items[0], banks[0])
    ledger = session.scalar(
        select(Ledger).where(Ledger.store_id == store, Ledger.period == "2026-09")
    )
    ledger.status = "closed"
    session.commit()
    r = client.post(f"/api/matches/{mid}/confirm?paid_accounting=true")
    assert r.status_code == 409, r.text
    assert session.get(ApprovalPaidAccounting, approval.id) is None


def test_whole_accrual_still_excludes_paid_confirmed_approval(client, session):
    from test_accruals import matched_approval, setup_store

    payload = setup_store(client, session)
    root = client.post("/api/accruals", json=payload).json()["data"]["id"]
    approval, item, bank, match = matched_approval(
        session, payload["store_id"], "60000", suffix="confirm-paid-covered"
    )
    bank.amount = Decimal(65000)
    bank.payment_status = "paid"
    bank.matched_amount = 0
    match.status = "candidate"
    match.amount = Decimal(65000)
    session.commit()
    response = client.post(f"/api/matches/{match.id}/confirm?paid_accounting=true")
    assert response.status_code == 200, response.text
    response = client.post(
        "/api/accruals/links/batch",
        json={
            "original_id": root,
            "approval_ids": [approval.id],
            "remark": "整单覆盖不重复计费",
            "request_key": "confirm-paid-covered",
        },
    )
    assert response.status_code == 200, response.text
    assert all(row[0] != item.id for row in rows(session, payload["store_id"], "2026-10"))


def test_fully_matched_approval_can_explicitly_add_real_payment(client, session):
    store, approval, items, banks = salary_fixture(client, session)
    banks[0].amount = Decimal(60000)
    banks[1].amount = Decimal(1000)
    banks[0].payment_status = banks[1].payment_status = "paid"
    session.commit()
    match_bank(client, items[0], banks[0])
    mid = create(client, items[0], banks[1])
    response = client.post(f"/api/matches/{mid}/confirm?paid_accounting=true")
    assert response.status_code == 200, response.text
    assert sum(row[3] for row in rows(session, store, "2026-09")) == Decimal(61000)
    assert session.get(ApprovalPaidAccounting, approval.id).period == "2026-09"


def test_paid_checkbox_cannot_move_existing_approval_to_payment_month(client, session):
    _store, approval, items, banks = salary_fixture(client, session)
    match_bank(client, items[0], banks[0])
    mid = create(client, items[0], banks[1])
    match = session.get(ExpenseBankMatch, mid)
    match.accounting_period = "2026-11"
    session.commit()
    response = client.post(f"/api/matches/{mid}/confirm?paid_accounting=true")
    assert response.status_code == 409, response.text
    session.expire_all()
    assert session.get(ExpenseBankMatch, mid).status == "candidate"
    assert session.get(ApprovalPaidAccounting, approval.id) is None


def test_edit_paid_month_moves_whole_approval_and_report(client, session):
    store, approval, items, banks = salary_fixture(client, session, lines=True)
    for bank in banks:
        bank.payment_status = "paid"
    session.commit()
    first = create(client, items[0], banks[0])
    assert client.post(f"/api/matches/{first}/confirm?paid_accounting=true").status_code == 200
    second = create(client, items[1], banks[1])
    assert client.post(f"/api/matches/{second}/confirm?paid_accounting=true").status_code == 200
    total = sum(row[3] for row in rows(session, store, "2026-09"))
    r = client.patch(f"/api/matches/reconciliation/records/{first}", json={"accounting_period": "2026-10"})
    assert r.status_code == 200, r.text
    assert session.get(ApprovalPaidAccounting, approval.id).period == "2026-10"
    assert all(session.get(ExpenseBankMatch, mid).accounting_period == "2026-10" for mid in [first, second])
    assert rows(session, store, "2026-09") == []
    assert sum(row[3] for row in rows(session, store, "2026-10")) == total


def test_edit_paid_month_cannot_move_into_closed_month(client, session):
    store, approval, items, banks = salary_fixture(client, session)
    banks[0].payment_status = "paid"
    session.commit()
    mid = create(client, items[0], banks[0])
    assert client.post(f"/api/matches/{mid}/confirm?paid_accounting=true").status_code == 200
    ledger = session.scalar(select(Ledger).where(Ledger.store_id == store, Ledger.period == "2026-10"))
    ledger.status = "closed"
    session.commit()
    r = client.patch(f"/api/matches/reconciliation/records/{mid}", json={"accounting_period":"2026-10"})
    assert r.status_code == 409, r.text
    session.expire_all()
    assert session.get(ApprovalPaidAccounting, approval.id).period == "2026-09"
    assert session.get(ExpenseBankMatch, mid).accounting_period == "2026-09"


def test_paid_month_edit_using_single_allocation(client, session):
    store, approval, items, banks = salary_fixture(client, session)
    banks[0].payment_status = "paid"
    session.commit()
    mid = create(client, items[0], banks[0])
    assert client.post(f"/api/matches/{mid}/confirm?paid_accounting=true").status_code == 200
    r = client.patch(f"/api/matches/reconciliation/records/{mid}", json={
        "accounting_allocations": [{"period":"2026-10","amount":str(items[0].amount)}],
        "accounting_version":0})
    assert r.status_code == 200, r.text
    assert session.get(ApprovalPaidAccounting, approval.id).period == "2026-10"
    assert session.get(ExpenseBankMatch, mid).accounting_period == "2026-10"
    assert rows(session, store, "2026-09") == []
