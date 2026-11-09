from datetime import date
from decimal import Decimal
from test_accruals import setup_store, matched_approval
from app.models import ExpenseItem, ExpenseBankMatch


def test_disjoint_details_no_double_expense_and_revoke(client, session):
    base = setup_store(client, session)
    root = client.post("/api/accruals", json=base).json()["data"]["id"]
    root2 = client.post("/api/accruals", json={**base, "request_key": "root2"}).json()["data"]["id"]
    approval, first, bank, _ = matched_approval(session, base["store_id"], "100")
    second = ExpenseItem(
        store_id=base["store_id"],
        ledger_period="2026-10",
        expense_date=date(2026, 10, 1),
        description="第二项",
        amount=Decimal(200),
        category_l1=first.category_l1,
        category_l2=first.category_l2,
        approval_instance_id=approval.id,
        source="dingtalk",
    )
    session.add(second)
    session.flush()
    session.add(
        ExpenseBankMatch(
            expense_item_id=second.id,
            bank_transaction_id=bank.id,
            amount=Decimal(200),
            accounting_period="2026-10",
            status="confirmed",
        )
    )
    session.commit()
    payload = dict(
        original_id=root,
        approval_id=approval.id,
        expense_item_ids=[first.id],
        remark="只关联第一项",
        request_key="detail1",
    )
    response = client.post("/api/accruals/links", json=payload)
    assert response.status_code == 200, response.text
    link = response.json()["data"]
    assert not link["whole_approval"]
    assert client.post("/api/accruals/links", json=payload).json()["data"]["id"] == link["id"]
    url = f"/api/store-ledgers/{base['store_id']}/report?period=2026-10"
    assert client.get(url).json()["data"]["metrics"]["expense_amount"] == "200.00"
    assert (
        client.post(
            "/api/accruals/links", json={**payload, "original_id": root2, "request_key": "overlap"}
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/accruals/links",
            json={**payload, "expense_item_ids": None, "request_key": "whole"},
        ).status_code
        == 409
    )
    response = client.post(
        "/api/accruals/links",
        json={
            **payload,
            "original_id": root2,
            "expense_item_ids": [second.id],
            "request_key": "detail2",
        },
    )
    assert response.status_code == 200, response.text
    assert client.get(url).json()["data"]["metrics"]["expense_amount"] == "0.00"
    assert (
        client.post(
            f"/api/accruals/links/{link['id']}/revoke", json={"reason": "恢复第一项"}
        ).status_code
        == 200
    )
    assert client.get(url).json()["data"]["metrics"]["expense_amount"] == "100.00"


def test_linked_unpaid_approval_notifies_and_detail_reversal_is_not_legacy_capacity(client, session):
    from sqlalchemy import select
    from app.models import ApprovalChangeNotice
    from app.modules.approval_notices import detect_source_change
    base = setup_store(client, session)
    root = client.post('/api/accruals', json={**base, 'amount':'100'}).json()['data']['id']
    approval, item, bank, match = matched_approval(session, base['store_id'], '100')
    session.delete(match); bank.matched_amount=Decimal(0); session.commit()
    response=client.post('/api/accruals/links',json=dict(original_id=root,approval_id=approval.id,expense_item_ids=[item.id],remark='已计提明细',request_key='selected'))
    assert response.status_code == 200,response.text
    detect_source_change(session,approval,{'title':'修改后的费用','result':'agree','status':'COMPLETED'})
    session.commit()
    assert session.scalar(select(ApprovalChangeNotice).where(ApprovalChangeNotice.approval_id==approval.id)) is not None
    # Detail links exclude the selected item, not a reserved amount on the accrual.
    result=client.post('/api/accruals',json={**base,'entry_type':'reversal','original_id':root,'period':'2026-10','amount':'10','request_key':'difference'})
    assert result.status_code==200,result.text
    selected=client.get(f'/api/accruals/approval-details/{approval.id}')
    assert selected.status_code==200,selected.text
    assert selected.json()['data'][0]['disabled'] is True
