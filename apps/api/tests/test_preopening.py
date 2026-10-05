from datetime import UTC, datetime
from decimal import Decimal

from app.models import ApprovalInstance, ApprovalTemplate, BankTransaction, ExpenseItem, Store


def setup(session):
    store = Store(name="筹建测试门店")
    template = ApprovalTemplate(name="筹建报销", process_code="preopening-test")
    session.add_all([store, template])
    session.flush()
    approval = ApprovalInstance(
        template_id=template.id,
        store_id=store.id,
        dingtalk_instance_id="approval-preopening",
        approval_no="TEST-001",
        approval_status="agree",
        submit_at=datetime(2026, 8, 1, tzinfo=UTC),
    )
    session.add(approval)
    session.flush()
    items = [
        ExpenseItem(
            store_id=store.id,
            approval_instance_id=approval.id,
            approval_line_no=i,
            source="dingtalk",
            source_document_id=f"approval-preopening:line-{i}",
            ledger_period="2026-08",
            expense_date=datetime(2026, 8, 1, tzinfo=UTC),
            description=description,
            amount=Decimal(amount),
        )
        for i, (description, amount) in enumerate([("装修", "6000"), ("设备", "4000")], 1)
    ]
    banks = [
        BankTransaction(
            store_id=store.id,
            ledger_period="2026-08",
            occurred_at=datetime(2026, 8, i, tzinfo=UTC),
            direction="expense",
            amount=Decimal(5000),
            counterparty_name="施工单位",
        )
        for i in [1, 2]
    ]
    session.add_all([*items, *banks])
    session.commit()
    return store, template, approval, items, banks


def create_categories(client):
    root = client.post("/api/preopening/categories", json={"name": "筹建"}).json()["data"]
    result = []
    for name in ["装修", "设备"]:
        r = client.post("/api/preopening/categories", json={"name": name, "parent_id": root["id"]})
        assert r.status_code == 200, r.text
        result.append(r.json()["data"]["id"])
    return root["id"], result


def test_preopening_original_amount_dedupe_and_unmatch(client, session):
    store, template, a, items, banks = setup(session)
    response = client.patch(
        f"/api/dingtalk/templates/{template.id}", json={"is_preopening_expense": True}
    )
    assert response.status_code == 200, response.text
    assert response.json()["data"]["is_preopening_expense"] is True
    _root, cs = create_categories(client)
    classifications = {e.id: cs[i] for i, e in enumerate(items)}
    candidates = client.get(
        f"/api/preopening/stores/{store.id}/candidates?bank_transaction_id={banks[0].id}"
    )
    assert candidates.status_code == 200, candidates.text
    assert len(candidates.json()["data"]) == 1
    assert Decimal(candidates.json()["data"][0]["score"]) > 0
    ids = []
    for b in banks:
        r = client.post(
            f"/api/preopening/stores/{store.id}/matches",
            json={
                "approval_id": a.id,
                "bank_transaction_id": b.id,
                "amount": "5000",
                "categories": classifications,
            },
        )
        assert r.status_code == 200, r.text
        ids.append(r.json()["data"]["id"])
        report = client.get(f"/api/preopening/stores/{store.id}").json()["data"]
        assert Decimal(report["total"]) == Decimal(10000)
        assert len(report["details"]) == 2
        daily = client.get(f"/api/store-ledgers/{store.id}/workspace?period=2026-08")
        assert daily.status_code == 200, daily.text
        assert Decimal(daily.json()["data"]["metrics"]["expense_amount"]) == 0
        from app.modules.store_ledgers.router import confirmed_accounting_expense_rows

        assert confirmed_accounting_expense_rows(session, store.id, "2026-08") == []
    # Template switch cannot move confirmed reports.
    assert (
        client.patch(
            f"/api/dingtalk/templates/{template.id}", json={"is_preopening_expense": False}
        ).status_code
        == 409
    )
    for i, mid in enumerate(ids):
        assert (
            client.post(f"/api/preopening/stores/{store.id}/matches/{mid}/unmatch").status_code
            == 200
        )
        report = client.get(f"/api/preopening/stores/{store.id}").json()["data"]
        assert Decimal(report["total"]) == Decimal("10000" if i == 0 else "0")


def test_preopening_root_rejection_and_closed_protection(client, session):
    store, template, a, items, banks = setup(session)
    assert (
        client.patch(
            f"/api/dingtalk/templates/{template.id}", json={"is_preopening_expense": True}
        ).status_code
        == 200
    )
    root, cs = create_categories(client)
    payload = {
        "approval_id": a.id,
        "bank_transaction_id": banks[0].id,
        "amount": "5000",
        "categories": {e.id: root for e in items},
    }
    assert (
        client.post(f"/api/preopening/stores/{store.id}/matches", json=payload).status_code == 422
    )
    payload["categories"] = {e.id: cs[i] for i, e in enumerate(items)}
    match = client.post(f"/api/preopening/stores/{store.id}/matches", json=payload)
    assert match.status_code == 200, match.text
    assert client.post(f"/api/preopening/stores/{store.id}/close").status_code == 200
    assert (
        client.post(
            f"/api/preopening/stores/{store.id}/matches/{match.json()['data']['id']}/unmatch"
        ).status_code
        == 409
    )
    assert (
        client.patch(f"/api/bank-transactions/{banks[0].id}", json={"remark": "不能改"}).status_code
        == 409
    )
    payload["bank_transaction_id"] = banks[1].id
    assert (
        client.post(f"/api/preopening/stores/{store.id}/matches", json=payload).status_code == 409
    )


def test_preopening_categories_and_daily_isolation(client, session):
    store, template, _a, items, banks = setup(session)
    assert (
        client.patch(
            f"/api/dingtalk/templates/{template.id}", json={"is_preopening_expense": True}
        ).status_code
        == 200
    )
    _root, _cs = create_categories(client)
    assert client.post("/api/preopening/categories", json={"name": " 装修 "}).status_code == 409
    r = client.post(
        "/api/matches",
        json={"expense_item_id": items[0].id, "bank_transaction_id": banks[0].id, "amount": "5000"},
    )
    assert r.status_code == 409, r.text
    report = client.get(f"/api/store-ledgers/{store.id}/workspace?period=2026-08")
    assert report.status_code == 200, report.text


def test_new_sync_inherits_preopening_scope(client, session):
    from app.modules.dingtalk.router import sync_expense_line

    store, template, _a, _items, _banks = setup(session)
    client.patch(f"/api/dingtalk/templates/{template.id}", json={"is_preopening_expense": True})
    a = ApprovalInstance(
        template_id=template.id,
        store_id=store.id,
        dingtalk_instance_id="new-sync",
        approval_status="agree",
    )
    session.add(a)
    session.flush()
    item, created = sync_expense_line(
        session,
        instance=a,
        source_document_id="new-sync:line-1",
        snapshot={"amount": "100.00"},
        row={"description": "筹建费用", "amount": Decimal(100)},
        store_id=store.id,
        ledger_period="2026-08",
        expense_date=datetime(2026, 8, 1, tzinfo=UTC),
        category_l1="日常分类",
        category_l2="日常二级",
        supplier_name=None,
        payee_account=None,
        payee_snapshot={},
        line_no=1,
        line_key="line-1",
        line_source_type="table",
    )
    assert created
    assert a.expense_scope == "preopening"
    assert item.expense_scope == "preopening"
    assert item.category_l1 is None and item.category_l2 is None


def test_sealed_sync_preserves_financial_data_with_invalid_previous_payload(session):
    from app.models import PreopeningStore, SyncJob
    from app.modules.dingtalk.router import sync_real_instance

    store, template, approval, items, _banks = setup(session)
    approval.expense_scope = "preopening"
    approval.raw_payload = "invalid-json"
    session.add(PreopeningStore(store_id=store.id, status="closed"))
    job = SyncJob(job_type="dingtalk_approval_sync")
    session.add(job)
    session.flush()
    assert sync_real_instance(
        session,
        template,
        job,
        {
            "process_instance_id": approval.dingtalk_instance_id,
            "status": "TERMINATED",
        },
    )
    assert approval.approval_status == "agree"
    assert [item.amount for item in items] == [Decimal(6000), Decimal(4000)]
    assert all(item.sync_conflict_status == "source_changed_after_sealed" for item in items)
