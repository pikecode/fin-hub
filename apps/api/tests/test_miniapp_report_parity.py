from datetime import date, datetime
from decimal import Decimal
from test_miniapp import setup
from app.models import Attachment, BankTransaction, ExpenseItem
from app.modules.miniapp.router import make_token


def test_mobile_all_sources_and_pc_details_share_amounts(client, session):
    a, b, user = setup(session)
    for source, amount in [("kuailv_purchase", "20"), ("revenue_fee", "10"), ("bank_direct", "30"), ("accrual", "-5")]:
        session.add(ExpenseItem(store_id=a.id, ledger_period="2026-10", expense_date=date(2026,10,1),
            source=source, description=source, amount=amount, category_l1="运营费用", category_l2="测试"))
    session.commit()
    # PC API uses the admin session; mobile uses the dedicated read-only token.
    pc = client.get('/api/reports/analytics/details',params={"detail_type":"report_expense",
        "store_id":a.id,"period_start":"2026-10","period_end":"2026-10"})
    assert pc.status_code == 200, pc.text
    client.cookies.clear()
    headers={"authorization":"Bearer "+make_token(user)}
    r=client.get('/api/miniapp/expenses',params={"store_id":a.id,"period":"2026-10","category":"运营费用"},headers=headers)
    assert r.status_code==200,r.text
    assert Decimal(r.json()['data']['total_amount'])==55
    assert r.json()['data']['total']==4
    assert {x['id']:x['amount'] for x in r.json()['data']['items']}=={x['id']:x['amount'] for x in pc.json()['data']['expense_items']}
    report=client.get('/api/miniapp/report',params={"store_id":a.id,"period":"2026-10"},headers=headers)
    assert report.status_code==200,report.text
    assert report.json()['data']['contract_version']=='pc-parity-1'
    assert report.json()['data']['major_vouchers']==[]
    assert client.get('/api/miniapp/expenses',params={"store_id":b.id,"period":"2026-10"},headers=headers).status_code==403


def test_special_rows_and_receipts_are_scoped(client, session):
    a,b,user=setup(session)
    bank=BankTransaction(store_id=a.id,ledger_period='2026-10',occurred_at=datetime(2026,10,2),
        amount=50,direction='income',direct_posting_type='bank_interest')
    item=ExpenseItem(store_id=b.id,ledger_period='2026-10',expense_date=date(2026,10,1),
        source='bank_direct',description='其他门店',amount=10)
    session.add_all([bank,item]);session.flush()
    attachment=Attachment(resource_type='expense_item',resource_id=item.id,file_name='test.png',source='manual',download_status='pending')
    session.add(attachment);session.commit()
    client.cookies.clear();headers={'authorization':'Bearer '+make_token(user)}
    r=client.get('/api/miniapp/report-special',params={'store_id':a.id,'period':'2026-10'},headers=headers)
    assert r.status_code==200,r.text
    assert r.json()['data']['total']==1
    assert r.json()['data']['items'][0]['transaction']['id']==bank.id
    assert client.get('/api/miniapp/record-attachments',params={'resource_type':'expense_item','resource_id':item.id},headers=headers).status_code==403
    assert client.get('/api/miniapp/attachments/'+attachment.id,headers=headers).status_code==403
