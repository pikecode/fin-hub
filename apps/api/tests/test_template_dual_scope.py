from decimal import Decimal

import pytest
from fastapi import HTTPException
from sqlalchemy import select
from test_preopening import create_categories, setup

from app.models import (
    ApprovalTemplate,
    ExpenseBankMatch,
    ExpenseCategory,
    Ledger,
)
from app.modules.preopening.eligibility import claim_scope


def enable(client, template):
    r = client.patch(
        f"/api/dingtalk/templates/{template.id}", json={"allow_dual_reconciliation": True}
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["allow_dual_reconciliation"] is True


def test_preopening_claim_and_daily_mutex(client, session):
    store, template, approval, items, banks = setup(session)
    enable(client, template)
    _, cs = create_categories(client)
    url = f"/api/preopening/stores/{store.id}"
    before = client.get(url).json()["data"]
    assert before["total"] == "0" and len(before["approvals"]) == 1
    r = client.post(
        url + "/matches",
        json={
            "approval_id": approval.id,
            "bank_transaction_id": banks[0].id,
            "amount": "5000",
            "categories": {e.id: cs[i] for i, e in enumerate(items)},
        },
    )
    assert r.status_code == 200, r.text
    assert approval.expense_scope == "preopening"
    assert all(e.expense_scope == "preopening" for e in items)
    result = client.get(
        f"/api/matches/reconciliation/candidates?store_id={store.id}&bank_transaction_id={banks[1].id}"
    )
    assert result.status_code == 200, result.text
    assert result.json()["data"]["candidates"] == []
    r = client.post(
        "/api/matches",
        json={"expense_item_id": items[0].id, "bank_transaction_id": banks[1].id, "amount": "5000"},
    )
    assert r.status_code == 409, r.text
    assert client.get(url).json()["data"]["total"] == "10000.00"
    # Turning off the new option preserves all current records, unlike old bulk scope conversion.
    r = client.patch(
        f"/api/dingtalk/templates/{template.id}", json={"allow_dual_reconciliation": False}
    )
    assert r.status_code == 200, r.text
    assert approval.expense_scope == "preopening"


def test_daily_claim_from_preopening_and_plan_preview(client, session):
    store, template, approval, items, banks = setup(session)
    client.patch(f"/api/dingtalk/templates/{template.id}", json={"is_preopening_expense": True})
    enable(client, template)
    r = client.get(f"/api/matches/approval-accounting/{approval.id}")
    assert r.status_code == 200 and Decimal(r.json()["data"]["approval_total"]) == 10000
    assert approval.expense_scope == "preopening", "read must not claim"
    r = client.get(
        f"/api/matches/reconciliation/candidates?store_id={store.id}&bank_transaction_id={banks[0].id}"
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["candidates"]
    root = ExpenseCategory(name="日常支出测试")
    session.add(root)
    session.flush()
    session.add(ExpenseCategory(name="日常明细测试", parent_id=root.id))
    session.commit()
    r = client.post(
        "/api/matches",
        json={
            "expense_item_id": items[0].id,
            "bank_transaction_id": banks[0].id,
            "amount": "5000",
            "accounting_period": "2026-08",
            "category_l1": "日常支出测试",
            "category_l2": "日常明细测试",
        },
    )
    assert r.status_code == 201, r.text
    match_id = r.json()["data"]["id"]
    r = client.post(f"/api/matches/{match_id}/confirm")
    assert r.status_code == 200, r.text
    assert all(e.expense_scope == "operating" for e in items)
    with pytest.raises(HTTPException) as e:
        claim_scope(session, approval.id, "preopening")
    assert e.value.status_code == 409
    assert client.get(f"/api/preopening/stores/{store.id}").json()["data"]["approvals"] == []


def test_closed_and_disabled_template_cannot_cross_claim(client, session):
    store, template, approval, _items, _banks = setup(session)
    with pytest.raises(HTTPException):
        claim_scope(session, approval.id, "preopening")
    enable(client, template)
    session.add(Ledger(store_id=store.id, period="2026-08", status="closed"))
    session.commit()
    with pytest.raises(HTTPException):
        claim_scope(session, approval.id, "preopening")


def test_source_verification_before_scope_claim(client, session, monkeypatch):
    _store, template, approval, items, banks = setup(session)
    client.patch(f"/api/dingtalk/templates/{template.id}", json={"is_preopening_expense": True})
    enable(client, template)
    from app.modules.matching import router

    def changed(*args):
        raise HTTPException(409, "来源已变化")

    monkeypatch.setattr(router, "verify_approval_source", changed)
    r = client.post(
        "/api/matches",
        json={"expense_item_id": items[0].id, "bank_transaction_id": banks[0].id, "amount": "5000"},
    )
    assert r.status_code == 409
    assert approval.expense_scope == "preopening"
    assert all(e.expense_scope == "preopening" for e in items)


def test_453_unmatch_does_not_reduce_another_partial_match(client, session):
    from test_partial_approvals import match_bank, salary_fixture

    from app.modules.approvals.status import approval_expense_stats_map

    _store, approval, items, banks = salary_fixture(client, session)
    items[0].amount = Decimal("64286.67")
    for b, amount in zip(banks, ["59366.67", "453.00", "4920.00"]):
        b.amount = Decimal(amount)
    session.commit()
    match_bank(client, items[0], banks[0])
    small = match_bank(client, items[0], banks[1])
    r = client.post(
        "/api/matches",
        json={
            "expense_item_id": items[0].id,
            "bank_transaction_id": banks[2].id,
            "amount": "4467.00",
            "accounting_period": "2026-09",
        },
    )
    assert r.status_code == 201, r.text
    other = r.json()["data"]["id"]
    assert client.post(f"/api/matches/{other}/confirm").status_code == 200
    for index in range(3):
        assert (
            client.post(f"/api/matches/reconciliation/records/{small}/unmatch").status_code == 200
        )
        stats = approval_expense_stats_map(session, [approval.id])[approval.id]
        assert stats["confirmed_match_amount"] == Decimal("63833.67")
        assert stats["remaining_match_amount"] == Decimal(453)
        assert session.get(ExpenseBankMatch, other).amount == Decimal(4467)
        assert (
            client.post(f"/api/matches/reconciliation/records/{small}/unmatch").status_code == 409
        )
        if index < 2:
            small = match_bank(client, items[0], banks[1])
    r = client.patch(f"/api/matches/reconciliation/records/{other}", json={"amount": "4920.00"})
    assert r.status_code == 200, r.text
    stats = approval_expense_stats_map(session, [approval.id])[approval.id]
    assert stats["confirmed_match_amount"] == Decimal("64286.67")
    assert stats["remaining_match_amount"] == 0


def test_two_entry_claim_race_has_only_one_winner(client, session):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    from sqlalchemy.orm import Session

    from app.modules.bank.unpaid import mutation_lock

    _store, template, approval, items, banks = setup(session)
    enable(client, template)
    barrier = Barrier(2)

    def claim(target, bank_id):
        with Session(session.get_bind()) as other:
            barrier.wait(timeout=5)
            mutation_lock(other)
            try:
                claim_scope(other, approval.id, target)
                other.add(
                    ExpenseBankMatch(
                        expense_item_id=items[0].id,
                        bank_transaction_id=bank_id,
                        amount=5000,
                        status="candidate",
                        expense_scope=target,
                    )
                )
                other.commit()
                return "claimed"
            except HTTPException as error:
                other.rollback()
                assert error.status_code == 409
                return "blocked"

    with ThreadPoolExecutor(2) as pool:
        a = pool.submit(claim, "operating", banks[0].id)
        b = pool.submit(claim, "preopening", banks[1].id)
        assert sorted([a.result(timeout=15), b.result(timeout=15)]) == ["blocked", "claimed"]
    session.expire_all()
    active = list(
        session.scalars(
            select(ExpenseBankMatch).where(
                ExpenseBankMatch.expense_item_id.in_([i.id for i in items]),
                ExpenseBankMatch.status == "candidate",
            )
        )
    )
    assert len(active) == 1
    assert active[0].expense_scope == approval.expense_scope


def test_additive_migration_preserves_template_default(session):
    import importlib.util
    from pathlib import Path

    from alembic.migration import MigrationContext
    from alembic.operations import Operations

    file = Path(__file__).parents[1] / "alembic/versions/20261116_0050_template_dual_scope.py"
    spec = importlib.util.spec_from_file_location("dual_migration", file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    template = ApprovalTemplate(name="历史模板", process_code="legacy-default")
    session.add(template)
    session.commit()
    module.op = Operations(MigrationContext.configure(session.connection()))
    module.downgrade()
    module.upgrade()
    session.commit()
    session.expire_all()
    assert session.get(ApprovalTemplate, template.id).allow_dual_reconciliation is False


def test_legacy_source_only_active_match_cannot_cross_claim(client, session):
    from app.modules.preopening.eligibility import claim_scope

    _store, template, approval, items, banks = setup(session)
    enable(client, template)
    items[0].approval_instance_id = None
    session.add(
        ExpenseBankMatch(
            expense_item_id=items[0].id,
            bank_transaction_id=banks[0].id,
            amount=5000,
            status="confirmed",
            expense_scope="operating",
        )
    )
    session.commit()
    with pytest.raises(HTTPException) as error:
        claim_scope(session, approval.id, "preopening")
    assert error.value.status_code == 409
    assert approval.expense_scope == "operating"


def test_invalid_switch_rejected_without_scope_change(client, session):
    _store, template, approval, _items, _banks = setup(session)
    response = client.patch(
        f"/api/dingtalk/templates/{template.id}", json={"allow_dual_reconciliation": None}
    )
    assert response.status_code == 422
    assert template.allow_dual_reconciliation is False
    assert approval.expense_scope == "operating"


def test_pc_real_approval_filter_respects_dual_entry(client, session):
    store, template, approval, items, banks = setup(session)
    client.patch(f"/api/dingtalk/templates/{template.id}", json={"is_preopening_expense": True})
    enable(client, template)
    url = f"/api/matches/reconciliation/candidates?store_id={store.id}&bank_transaction_id={banks[0].id}&approval_only=true&compact=true&approval_no=TEST-001"
    response = client.get(url)
    assert response.status_code == 200, response.text
    assert len(response.json()["data"]["candidates"]) == 1
    assert approval.expense_scope == "preopening", "candidate reads must not claim"
    session.add(ExpenseBankMatch(expense_item_id=items[0].id, bank_transaction_id=banks[1].id,
        amount=Decimal("100"), status="confirmed", expense_scope="preopening"))
    session.commit()
    assert client.get(url).json()["data"]["candidates"] == []


def test_dual_default_switch_preserves_claimed_approvals(client, session):
    store, template, approval, items, banks = setup(session)
    enable(client, template)
    session.add(ExpenseBankMatch(expense_item_id=items[0].id, bank_transaction_id=banks[0].id,
        amount=Decimal("100"), status="confirmed", expense_scope="operating"))
    session.commit()
    response = client.patch(f"/api/dingtalk/templates/{template.id}", json={"is_preopening_expense": True})
    assert response.status_code == 200, response.text
    assert response.json()["data"]["is_preopening_expense"] is True
    assert approval.expense_scope == "operating"
    assert all(item.expense_scope == "operating" for item in items)
    assert session.scalar(select(ExpenseBankMatch.amount)) == Decimal("100")


def test_dual_default_switch_keeps_closed_history_and_moves_free_approval(client, session):
    from app.models import ApprovalInstance, ExpenseItem

    store, template, approval, items, banks = setup(session)
    enable(client, template)
    other = ApprovalInstance(template_id=template.id, store_id=store.id,
        dingtalk_instance_id="free-dual-approval", approval_status="agree")
    session.add(other)
    session.flush()
    free = ExpenseItem(store_id=store.id, approval_instance_id=other.id,
        source="dingtalk", source_document_id="free-dual-approval", description="待认领费用", amount=Decimal("50"),
        ledger_period="2026-09", expense_scope="operating")
    session.add_all([free, Ledger(store_id=store.id, period="2026-08", status="closed")])
    session.commit()
    r = client.patch(f"/api/dingtalk/templates/{template.id}", json={"is_preopening_expense": True})
    assert r.status_code == 200, r.text
    assert approval.expense_scope == "operating"
    assert all(item.expense_scope == "operating" for item in items)
    assert other.expense_scope == "preopening"
    assert free.expense_scope == "preopening"


def test_dormant_paid_mode_after_unmatch_can_cross_entry(client, session):
    from app.models import ApprovalPaidAccounting
    store, template, approval, items, banks = setup(session)
    enable(client, template)
    session.add(ApprovalPaidAccounting(approval_id=approval.id, period="2026-08", updated_by="admin"))
    session.add(ExpenseBankMatch(expense_item_id=items[0].id, bank_transaction_id=banks[0].id,
        amount=Decimal("100"), status="rejected", expense_scope="operating"))
    session.commit()
    result = client.get(f"/api/preopening/stores/{store.id}")
    assert any(a["id"] == approval.id for a in result.json()["data"]["approvals"])
    claim_scope(session, approval.id, "preopening")
    session.flush()
    assert approval.expense_scope == "preopening"
    assert session.get(ApprovalPaidAccounting, approval.id) is None
