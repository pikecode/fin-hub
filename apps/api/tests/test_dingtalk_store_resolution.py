from decimal import Decimal

from app.models import ApprovalInstance, ApprovalTemplate, DingTalkDepartment, Store, utc_now
from app.modules.dingtalk import router as sync


def test_child_department_resolution_and_ambiguous_name(session):
    stores = [Store(name='门店甲', dingtalk_dept_id='a'), Store(name='门店乙', dingtalk_dept_id='b')]
    session.add_all(stores)
    session.flush()
    session.add_all([
        DingTalkDepartment(dept_id='a', name='门店甲', path='甲', store_id=stores[0].id),
        DingTalkDepartment(dept_id='b', name='门店乙', path='乙', store_id=stores[1].id),
        DingTalkDepartment(dept_id='a-child', parent_id='a', name='前厅', path='甲/前厅'),
        DingTalkDepartment(dept_id='b-child', parent_id='b', name='前厅', path='乙/前厅'),
    ])
    session.flush()
    assert sync.resolve_store(session, 'a-child').id == stores[0].id
    assert sync.resolve_store(session, '甲/前厅').id == stores[0].id
    assert sync.resolve_store(session, '前厅') is None


def test_source_update_recovers_stale_conflict_but_preserves_manual_edit(session, monkeypatch):
    store = Store(name='门店甲')
    template = ApprovalTemplate(name='报销', process_code='test')
    session.add_all([store, template]); session.flush()
    instance = ApprovalInstance(template_id=template.id, dingtalk_instance_id='source-test', approval_status='agree')
    session.add(instance); session.flush()
    args = dict(instance=instance, source_document_id='source-test:1', snapshot={'amount': '100'},
                row={'description': '原内容', 'amount': Decimal('100')}, store_id=store.id,
                ledger_period='2026-10', expense_date=utc_now(), category_l1=None, category_l2=None,
                supplier_name=None, payee_account=None, payee_snapshot={}, line_no=1, line_key='1', line_source_type='table')
    item, _ = sync.sync_expense_line(session, **args)
    item.sync_conflict_status = 'source_changed'
    args['snapshot'] = {'amount': '200'}
    args['row'] = {'description': '新内容', 'amount': Decimal('200')}
    sync.sync_expense_line(session, **args)
    assert item.amount == Decimal('200')
    assert item.sync_conflict_status == 'none'
    with monkeypatch.context() as patch:
        patch.setattr(sync, 'expense_has_bank_match', lambda *_: True)
        args['snapshot'] = {'amount': '300'}
        args['row']['amount'] = Decimal('300')
        sync.sync_expense_line(session, **args)
        assert item.amount == Decimal('200')
        assert item.sync_conflict_status == 'amount_changed_after_matched'
        sync.sync_expense_line(session, **args)
        assert item.sync_conflict_status == 'amount_changed_after_matched'
    args['snapshot'] = {'amount': '200'}
    args['row']['amount'] = Decimal('200')
    sync.sync_expense_line(session, **args)
    item.user_edited_fields_json = '["description"]'
    item.description = '人工内容'
    sync.sync_expense_line(session, **args)
    assert item.sync_conflict_status == 'none'
    args['snapshot'] = {'amount': '200', 'description': '再次变更'}
    args['row']['description'] = '再次变更'
    sync.sync_expense_line(session, **args)
    assert item.description == '人工内容'
    assert item.sync_conflict_status == 'source_changed'
    item.description = '再次变更'
    sync.sync_expense_line(session, **args)
    assert item.sync_conflict_status == 'none'


def test_backfill_orphan_recovered(session):
    from datetime import timedelta
    from app.models import SyncJob
    from app.modules.dingtalk.sync_runtime import recover_interrupted_sync_jobs
    job = SyncJob(job_type='dingtalk_approval_backfill', status='running', created_at=utc_now()-timedelta(days=2))
    session.add(job); session.commit()
    assert recover_interrupted_sync_jobs(session) == 1
    assert job.status == 'failed'


def test_reimbursement_store_alias(session):
    import json
    from sqlalchemy import select
    from app.models import SyncJob
    store = Store(name='加盟门店')
    template = ApprovalTemplate(name='门店筹建普通报销（加盟）', process_code='alias', is_enabled=True)
    job = SyncJob(job_type='dingtalk_auto_sync', status='running')
    session.add_all([store, template, job]); session.flush()
    raw = {'process_instance_id': 'alias-instance', 'result': 'agree', 'create_time': '2026-10-01 10:00:00',
           'form_component_values': [{'name': '报销门店', 'value': '加盟门店'}, {'name': '金额', 'value': '100'}]}
    assert sync.sync_real_instance(session, template, job, raw)
    instance = session.scalar(select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == 'alias-instance'))
    assert instance.store_id == store.id
    assert instance.parse_error is None


def test_manual_categories_preserved_without_stale_or_new_conflict(session):
    store = Store(name='分类门店')
    template = ApprovalTemplate(name='报销', process_code='category-test')
    session.add_all([store, template]); session.flush()
    instance = ApprovalInstance(template_id=template.id, dingtalk_instance_id='category-instance', approval_status='agree')
    session.add(instance); session.flush()
    args = dict(instance=instance, source_document_id='category-instance:1', snapshot={'amount':'100', 'category_l1':'来源分类'},
                row={'description':'费用', 'amount':Decimal('100')}, store_id=store.id,
                ledger_period='2026-10', expense_date=utc_now(), category_l1='来源分类', category_l2=None,
                supplier_name=None, payee_account=None, payee_snapshot={}, line_no=1, line_key='1', line_source_type='table')
    item, _ = sync.sync_expense_line(session, **args)
    item.user_edited_fields_json = '["category_l1", "category_l2"]'
    item.category_l1, item.category_l2 = '食材成本', '鸡'
    item.sync_conflict_status = 'source_changed'
    sync.sync_expense_line(session, **args)
    assert item.sync_conflict_status == 'none'
    args['snapshot']['category_l1'] = '来源新分类'
    args['category_l1'] = '来源新分类'
    sync.sync_expense_line(session, **args)
    assert (item.category_l1, item.category_l2) == ('食材成本', '鸡')
    assert item.sync_conflict_status == 'none'


def test_pending_zero_amount_recovers_when_source_amount_is_filled(session):
    from sqlalchemy import select
    from app.models import SyncJob, ExpenseItem
    store = Store(name='待补金额门店')
    template = ApprovalTemplate(name='食材报销', process_code='pending-amount', is_enabled=True)
    job = SyncJob(job_type='dingtalk_auto_sync', status='running')
    session.add_all([store, template, job]); session.flush()
    raw = {'process_instance_id': 'pending-amount-instance', 'status': 'RUNNING',
           'create_time': '2026-10-01 10:00:00', 'form_component_values': [
               {'name': '支出门店', 'value': store.name}, {'name': '金额', 'value': '0'}]}
    assert sync.sync_real_instance(session, template, job, raw)
    instance = session.scalar(select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == 'pending-amount-instance'))
    assert instance.parse_status == 'pending_amount'
    assert instance.parse_error is None
    assert sync.approval_needs_detail_resync(instance)
    assert sync.approval_detail_refresh_due(instance)
    assert not list(session.scalars(select(ExpenseItem).where(ExpenseItem.approval_instance_id == instance.id)))
    raw['form_component_values'][1]['value'] = '123.45'
    assert sync.sync_real_instance(session, template, job, raw)
    assert instance.parse_status == 'parsed'
    assert instance.parse_error is None
    items = list(session.scalars(select(ExpenseItem).where(ExpenseItem.approval_instance_id == instance.id)))
    assert len(items) == 1 and items[0].amount == Decimal('123.45')
    raw['form_component_values'][1]['value'] = '0'
    raw['result'] = 'agree'
    raw['status'] = 'COMPLETED'
    assert not sync.sync_real_instance(session, template, job, raw)
    assert instance.parse_error == 'Unable to resolve approval amount'


def test_sync_parse_error_details_preserve_snapshot_and_support_old_jobs(client, session):
    import json
    from app.models import SyncJob
    template = ApprovalTemplate(name='异常模板', process_code='parse-issue-test')
    job = SyncJob(job_type='dingtalk_approval_sync', status='succeeded', failed_count=1)
    session.add_all([template, job]); session.flush()
    instance = ApprovalInstance(template_id=template.id, dingtalk_instance_id='parse-issue-instance',
        approval_no='20261011-test', approval_status='agree', synced_job_id=job.id,
        parse_error='Missing required fields: store', parse_status='skipped',
        raw_payload=json.dumps({'_fin_hub_parse': {'store_text': '财务部'}}))
    session.add(instance); session.commit()
    url=f'/api/dingtalk/sync-jobs/{job.id}/parse-errors'
    response=client.get(url)
    assert response.status_code == 200
    data=response.json()['data']
    assert data['historical_snapshot'] is False
    assert data['items'][0]['source_store'] == '财务部'
    assert data['items'][0]['reason'] == '无法识别所属门店'
    assert '明确费用所属门店' in data['items'][0]['suggestion']
    snapshot=data['items']
    job.raw_summary=json.dumps({'approval_sync': {'parse_errors': snapshot}})
    instance.parse_error=None
    session.commit()
    data=client.get(url).json()['data']
    assert data['historical_snapshot'] is True
    assert data['items'] == snapshot
    assert client.get('/api/dingtalk/sync-jobs/nonexistent/parse-errors').status_code == 404


def test_running_result_agree_keeps_zero_amount_pending(session):
    from sqlalchemy import select
    from app.models import SyncJob, ExpenseItem
    store = Store(name='流程未结束门店')
    template = ApprovalTemplate(name='食材报销', process_code='running-result')
    job = SyncJob(job_type='dingtalk_approval_reparse', status='running')
    session.add_all([store, template, job]); session.flush()
    raw = {'process_instance_id': 'running-result', 'status': 'RUNNING', 'result': 'agree',
           'create_time': '2026-10-15 10:00:00', 'form_component_values': [
               {'name': '支出门店', 'value': store.name}, {'name': '金额', 'value': '0'}]}
    assert sync.sync_real_instance(session, template, job, raw)
    instance = session.scalar(select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == 'running-result'))
    assert instance.approval_status.lower() == 'running'
    assert instance.parse_status == 'pending_amount' and instance.parse_error is None
    assert sync.approval_detail_refresh_due(instance)
    assert not list(session.scalars(select(ExpenseItem).where(ExpenseItem.approval_instance_id == instance.id)))
    raw['status'] = 'COMPLETED'
    assert not sync.sync_real_instance(session, template, job, raw)
    assert instance.parse_error == 'Unable to resolve approval amount'


def test_explicit_parsed_revision_supersedes_original_without_duplicate_cost(session):
    import json
    from sqlalchemy import select
    from app.models import SyncJob, ExpenseItem
    store = Store(name='修订归属门店')
    template = ApprovalTemplate(name='日常报销', process_code='revision')
    job = SyncJob(job_type='dingtalk_approval_reparse', status='running')
    session.add_all([store, template, job]); session.flush()
    original = {'process_instance_id': 'original', 'business_id': 'same-no', 'status': 'COMPLETED', 'result': 'agree',
                'attached_process_instance_ids': ['revised'], 'create_time': '2026-06-29 10:00:00',
                'form_component_values': [{'name': '支出门店', 'value': '采购部'}, {'name': '金额', 'value': '100'}]}
    revised = {**original, 'process_instance_id': 'revised', 'main_process_instance_id': 'original',
               'biz_action': 'MODIFY', 'attached_process_instance_ids': [],
               'form_component_values': [{'name': '支出门店', 'value': store.name}, {'name': '金额', 'value': '100'}]}
    assert sync.sync_real_instance(session, template, job, revised)
    session.flush()
    assert sync.sync_real_instance(session, template, job, original)
    source = session.scalar(select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == 'original'))
    assert source.parse_status == 'superseded' and source.parse_error is None
    assert json.loads(source.raw_payload)['_fin_hub_parse']['superseded_by_dingtalk_id'] == 'revised'
    assert not list(session.scalars(select(ExpenseItem).where(ExpenseItem.approval_instance_id == source.id)))
    # A same-number/attached record alone is insufficient: reciprocal revision proof is required.
    target = session.scalar(select(ApprovalInstance).where(ApprovalInstance.dingtalk_instance_id == 'revised'))
    bad = json.loads(target.raw_payload); bad.pop('main_process_instance_id'); target.raw_payload = json.dumps(bad)
    session.flush()
    assert not sync.sync_real_instance(session, template, job, original)
    assert source.parse_error == 'Missing required fields: store'
