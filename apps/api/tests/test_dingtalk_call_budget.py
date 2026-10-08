from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
from unittest.mock import Mock

import httpx
import pytest

from app.models import ApprovalInstance, ApprovalTemplate, DingTalkConfig, SyncJob, utc_now
from app.modules.dingtalk import client as client_module
from app.modules.dingtalk import router as sync
from app.modules.dingtalk.client import DingTalkClient, DingTalkCredentials


@pytest.fixture(autouse=True)
def empty_token_cache():
    with client_module._token_cache_lock:
        client_module._token_cache.clear()
    yield
    with client_module._token_cache_lock:
        client_module._token_cache.clear()


def response(url, payload, status=200):
    return httpx.Response(status, json=payload, request=httpx.Request('POST', url))


def test_token_shared_between_clients_and_concurrent_requests(monkeypatch):
    posts = Mock(side_effect=lambda url, **kwargs: response(url, {'accessToken': 'token', 'expireIn': 7200}))
    monkeypatch.setattr(client_module.httpx, 'post', posts)
    credentials = DingTalkCredentials('key', 'secret')
    with ThreadPoolExecutor(max_workers=8) as pool:
        assert list(pool.map(lambda _: DingTalkClient(credentials).get_access_token(), range(20))) == ['token']*20
    assert posts.call_count == 1
    DingTalkClient(DingTalkCredentials('key', 'new-secret')).get_access_token()
    assert posts.call_count == 2


def test_token_expiry_and_missing_ttl(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(client_module, 'monotonic', lambda: clock[0])
    posts = Mock(side_effect=lambda url, **kwargs: response(url, {'accessToken': 'token', 'expireIn': 100}))
    monkeypatch.setattr(client_module.httpx, 'post', posts)
    client = DingTalkClient(DingTalkCredentials('key', 'secret'))
    client.get_access_token(); clock[0] = 189; client.get_access_token()
    assert posts.call_count == 1
    clock[0] = 190; client.get_access_token()
    assert posts.call_count == 2
    posts.side_effect = lambda url, **kwargs: response(url, {'accessToken': 'no-ttl'})
    client_module._token_cache.clear()
    client.get_access_token(); client.get_access_token()
    assert posts.call_count == 4


def test_expired_oapi_token_refreshes_once(monkeypatch):
    token_calls, data_calls = [], []
    def post(url, **kwargs):
        if url.endswith('accessToken'):
            token_calls.append(url)
            return response(url, {'accessToken': f'token-{len(token_calls)}', 'expireIn': 7200})
        data_calls.append(kwargs['params']['access_token'])
        return response(url, {'errcode': 40014} if len(data_calls)==1 else {'errcode': 0, 'result': []})
    monkeypatch.setattr(client_module.httpx, 'post', post)
    DingTalkClient(DingTalkCredentials('key', 'secret')).list_child_departments()
    assert data_calls == ['token-1', 'token-2']
    assert len(token_calls) == 2


def test_modern_api_expired_token_refreshes_once(monkeypatch):
    tokens, calls = [], []
    def post(url, **kwargs):
        if url.endswith('accessToken'):
            tokens.append(url)
            return response(url, {'accessToken': f'token-{len(tokens)}', 'expireIn': 7200})
        calls.append(kwargs['headers']['x-acs-dingtalk-access-token'])
        return response(url, {'code':'InvalidAccessToken'}, 401) if len(calls)==1 else response(url, {'result':{}})
    monkeypatch.setattr(client_module.httpx, 'post', post)
    DingTalkClient(DingTalkCredentials('key', 'secret')).forecast_process_nodes('proc', 'user', 'dept')
    assert calls == ['token-1', 'token-2']


def test_running_always_refreshes_finished_and_parse_errors_daily():
    for status in ['RUNNING', 'new']:
        assert sync.approval_detail_refresh_due(ApprovalInstance(approval_status=status, last_parsed_at=utc_now()))
    for status in ['TERMINATED', 'refuse']:
        assert not sync.approval_detail_refresh_due(ApprovalInstance(approval_status=status))
    for error in [None, 'Missing store']:
        instance = ApprovalInstance(approval_status='agree', store_id='store', parse_status='parsed', processing_status='pending_classification', parse_error=error, approved_at=utc_now(), last_parsed_at=utc_now())
        assert not sync.approval_detail_refresh_due(instance)
        instance.last_parsed_at = utc_now()-timedelta(hours=25)
        assert sync.approval_detail_refresh_due(instance)


def test_metadata_sync_does_not_forecast_nodes(session, monkeypatch):
    session.add(DingTalkConfig(admin_user_id='admin'))
    session.commit()
    client = Mock()
    client.list_processes_by_user.return_value = [{'process_code':'test', 'name':'模板新名'}]
    monkeypatch.setattr(sync, 'should_use_real_dingtalk', lambda: True)
    monkeypatch.setattr(sync, 'dingtalk_client', lambda _: client)
    result = sync.sync_templates_core(session, sync_nodes=False)
    assert result['pulled'] == 1 and result['node_skipped'] == 1
    client.forecast_process_nodes.assert_not_called()


def test_repeat_completed_overlap_and_parse_error_skip_but_pending_fetches(session, monkeypatch):
    template=ApprovalTemplate(name='test',process_code='test',is_enabled=True)
    session.add(template);session.flush()
    for identity, status in [('finished','agree'),('error','agree'),('pending','RUNNING'),('terminal','TERMINATED')]:
        session.add(ApprovalInstance(template_id=template.id,dingtalk_instance_id=identity,approval_status=status,store_id=None,
                                    parse_status='skipped',parse_error='Missing store' if identity=='error' else None,last_parsed_at=utc_now()))
    job=SyncJob(job_type='dingtalk_auto_sync',status='running')
    session.add(job);session.commit()
    client=Mock()
    client.list_process_instance_ids.return_value=(['finished','error','pending','terminal'],None)
    client.get_process_instance.side_effect=lambda identity:{'process_instance_id':identity}
    monkeypatch.setattr(sync,'should_use_real_dingtalk',lambda:True)
    monkeypatch.setattr(sync,'dingtalk_client',lambda _:client)
    monkeypatch.setattr(sync,'sync_real_instance',lambda *args:True)
    sync.run_approval_sync(session,job=job,templates=[template],page_size=10,max_pages=10)
    assert [c.args[0] for c in client.get_process_instance.call_args_list]==['pending']
    client.get_process_instance.reset_mock()
    sync.run_approval_sync(session,job=job,templates=[template],page_size=10,max_pages=10,skip_existing=False)
    assert {c.args[0] for c in client.get_process_instance.call_args_list}=={'finished','error','pending','terminal'}


def test_one_hundred_business_calls_only_acquire_token_once(monkeypatch):
    counts={'token':0,'business':0}
    def post(url, **kwargs):
        if url.endswith('accessToken'):
            counts['token']+=1
            return response(url, {'accessToken':'token','expireIn':7200})
        counts['business']+=1
        return response(url, {'errcode':0,'result':[]})
    monkeypatch.setattr(client_module.httpx,'post',post)
    for _ in range(100):
        DingTalkClient(DingTalkCredentials('key','secret')).list_child_departments()
    assert counts=={'token':1,'business':100}


def test_automatic_node_refresh_daily_including_failures(session):
    import json
    assert sync.automatic_template_node_refresh_due(session)
    job=SyncJob(job_type='dingtalk_auto_sync',status='succeeded',finished_at=utc_now(),
                raw_summary=json.dumps({'template_sync':{'node_attempted':9,'node_failed':9}}))
    session.add(job);session.commit()
    assert not sync.automatic_template_node_refresh_due(session)
    job.finished_at=utc_now()-timedelta(hours=25);session.commit()
    assert sync.automatic_template_node_refresh_due(session)


def test_automatic_node_refresh_only_enabled_templates(session,monkeypatch):
    session.add(DingTalkConfig(admin_user_id='admin'))
    session.add(ApprovalTemplate(name='启用',process_code='enabled',is_enabled=True))
    session.commit()
    client=Mock()
    client.list_processes_by_user.return_value=[{'process_code':'enabled','name':'启用'}, {'process_code':'disabled','name':'新模板'}]
    client.forecast_process_nodes.return_value={}
    monkeypatch.setattr(sync,'should_use_real_dingtalk',lambda:True)
    monkeypatch.setattr(sync,'dingtalk_client',lambda _:client)
    result=sync.sync_templates_core(session,sync_nodes=True,enabled_nodes_only=True)
    assert result['node_attempted']==1 and result['node_skipped']==1
    assert client.forecast_process_nodes.call_args.args[0]=='enabled'


def test_explicit_connection_check_forces_a_live_token_request(monkeypatch):
    posts=Mock(side_effect=lambda url,**kwargs:response(url,{'accessToken':'token','expireIn':7200}))
    monkeypatch.setattr(client_module.httpx,'post',posts)
    client=DingTalkClient(DingTalkCredentials('key','secret'))
    client.get_access_token();client.get_access_token()
    assert posts.call_count==1
    client.get_access_token(force_refresh=True)
    assert posts.call_count==2


def test_department_lookahead_and_walk_fetch_each_department_once(monkeypatch):
    from collections import Counter
    monkeypatch.setattr(sync,'sleep',lambda _:None)
    tree={'1':[{'dept_id':'ops','name':'门店运营部','parent_id':'1'}],
          'ops':[{'dept_id':'region','name':'区域','parent_id':'ops'}],
          'region':[{'dept_id':'store','name':'示例门店','parent_id':'region'}],
          'store':[{'dept_id':'front','name':'前厅','parent_id':'store'}],
          'front':[]}
    client=Mock()
    client.list_child_departments.side_effect=lambda dept:tree[dept]
    rows=sync.build_department_tree(client,max_depth=8)
    assert Counter(c.args[0] for c in client.list_child_departments.call_args_list)==Counter({key:1 for key in tree})
    assert [r.dept_id for r in rows]==['ops','region','store','front']
    assert next(r for r in rows if r.dept_id=='store').is_store_candidate
    # A later pull must discover a new child; nothing is cached across pulls.
    tree['store'].append({'dept_id':'kitchen','name':'后厨','parent_id':'store'});tree['kitchen']=[]
    rows=sync.build_department_tree(client,max_depth=8)
    assert 'kitchen' in {r.dept_id for r in rows}


def test_department_depth_limit_still_preserves_store_detection(monkeypatch):
    monkeypatch.setattr(sync,'sleep',lambda _:None)
    client=Mock()
    tree={'1':[{'dept_id':'a','name':'部门'}], 'a':[{'dept_id':'b','name':'区域'}],
          'b':[{'dept_id':'store','name':'测试店'}], 'store':[{'dept_id':'front','name':'前厅'}]}
    client.list_child_departments.side_effect=lambda dept:tree[dept]
    rows=sync.build_department_tree(client,max_depth=3)
    assert [r.dept_id for r in rows]==['a','b','store']
    assert rows[-1].is_store_candidate
    assert client.list_child_departments.call_count==4
