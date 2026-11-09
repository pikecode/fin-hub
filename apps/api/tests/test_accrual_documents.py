from sqlalchemy import func, select
from test_accruals import setup_store

from app.models import AccrualDocument, AccrualEntry, ExpenseItem


def test_document_atomic_creation_idempotency_and_legacy(client, session):
    base = setup_store(client, session)
    payload = {key: base[key] for key in ('store_id', 'period', 'remark', 'request_key')}
    line = {key: base[key] for key in ('category_l1', 'category_l2', 'amount', 'remark')}
    payload['lines'] = [line, {**line, 'amount': '500'}]
    response = client.post('/api/accruals/documents', json=payload)
    assert response.status_code == 200, response.text
    document = response.json()['data']
    assert document['amount'] == '65500.00'
    assert len(document['lines']) == 2
    assert all(row['document_id'] == document['id'] for row in document['lines'])
    assert client.post('/api/accruals/documents', json=payload).json()['data']['id'] == document['id']
    assert client.post('/api/accruals/documents', json={**payload, 'remark': 'changed'}).status_code == 409
    assert session.scalar(select(func.count()).select_from(AccrualEntry)) == 2
    assert session.scalar(select(func.count()).select_from(ExpenseItem)) == 2
    bad = {**payload, 'request_key': 'bad', 'lines': [line, {**line, 'category_l2': '无效分类'}]}
    assert client.post('/api/accruals/documents', json=bad).status_code == 409
    assert session.scalar(select(func.count()).select_from(AccrualDocument)) == 1
    assert session.scalar(select(func.count()).select_from(AccrualEntry)) == 2
    assert client.post('/api/accruals', json={**base, 'request_key': 'legacy'}).status_code == 200
    rows = client.get('/api/accruals', params={'store_id':base['store_id']}).json()['data']
    assert len(rows) == 3
    assert sum(row['document_id'] is None for row in rows) == 1
