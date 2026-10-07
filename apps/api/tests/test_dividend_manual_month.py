from decimal import Decimal
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session
from app.models import DividendEntry, DividendMonth


def test_historical_amounts_are_manual_even_with_ledger(client: TestClient) -> None:
    store_id = client.post('/api/stores', json={'name': '历史人工分红店'}).json()['data']['id']
    client.post('/api/ledgers', json={'store_id': store_id, 'period': '2026-09'})
    url = f'/api/dividends/months/{store_id}/2026-09'
    row = client.put(url, json={'manual_net_profit': '-1200.50', 'manual_remaining_undistributed': '9000.00'}).json()['data']['current']
    assert row['net_profit'] == '-1200.50'
    assert row['remaining_undistributed'] == '9000.00'
    assert row['profit_source'] == 'manual'
    response = client.put(url, json={'manual_net_profit': '200.00', 'manual_remaining_undistributed': '7500.00'})
    assert response.status_code == 200
    assert response.json()['data']['current']['remaining_undistributed'] == '7500.00'
    client.post(url + '/lock')
    assert client.put(url, json={'manual_remaining_undistributed': '0'}).status_code == 409


def test_transition_balance_carries_forward_without_capital_or_double_counting(client: TestClient, session: Session, monkeypatch) -> None:
    from app.modules.dividend import router as module
    monkeypatch.setattr(module, 'calculate_store_ledger_profits', lambda session, store, periods: {period: Decimal({'2026-10': '500', '2026-11': '200', '2026-12': '-100'}.get(period, '0')) for period in periods})
    store_id = client.post('/api/stores', json={'name': '余额结转店'}).json()['data']['id']
    base = f'/api/dividends/months/{store_id}'
    assert client.put(base + '/2026-09', json={'manual_net_profit': '9999', 'manual_remaining_undistributed': '8888'}).status_code == 200
    october = client.put(base + '/2026-10', json={'manual_remaining_undistributed': '1000'}).json()['data']['current']
    assert october['net_profit'] == '500.00'
    assert october['remaining_undistributed'] == '1000.00'
    assert client.put(base + '/2026-10', json={'manual_net_profit': '1'}).status_code == 422
    assert client.put(base + '/2026-11', json={'manual_remaining_undistributed': '1'}).status_code == 422
    assert client.put(base + '/2026-11', json={'manual_net_profit': '1'}).status_code == 422
    november = DividendMonth(store_id=store_id, period='2026-11')
    session.add(november)
    session.flush()
    session.add_all([DividendEntry(month_id=november.id, entry_type='distribution', shareholder_name='股东', holding_ratio=100, amount=50), DividendEntry(month_id=november.id, entry_type='capital', shareholder_name='股东', holding_ratio=100, amount=500)])
    session.commit()
    workspace = client.get('/api/dividends/workspace', params={'store_id': store_id, 'period': '2026-12'}).json()['data']
    rows = {row['period']: row for row in workspace['history']}
    assert rows['2026-09']['remaining_undistributed'] == '8888.00'
    assert rows['2026-11']['remaining_undistributed'] == '1150.00'
    assert rows['2026-12']['remaining_undistributed'] == '1050.00'
    assert client.put(base + '/2026-10', json={'manual_remaining_undistributed': '2000'}).status_code == 200
    assert client.get('/api/dividends/workspace', params={'store_id': store_id, 'period': '2026-12'}).json()['data']['current']['remaining_undistributed'] == '2050.00'


def test_missing_manual_balance_does_not_fall_back_to_formula(client: TestClient) -> None:
    store_id = client.post('/api/stores', json={'name': '待录入余额店'}).json()['data']['id']
    for period in ('2026-09', '2026-10', '2026-11'):
        current = client.get('/api/dividends/workspace', params={'store_id': store_id, 'period': period}).json()['data']['current']
        assert current['remaining_undistributed'] is None
    assert client.put(f'/api/dividends/months/{store_id}/2026-00', json={'manual_net_profit': '1'}).status_code == 422
