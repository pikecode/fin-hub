# 同步测试数据清理脚本

脚本位置：`apps/api/scripts/reset-sync-data.py`

执行清理或重新同步前，先确认数据库已经升级到当前代码版本：

```bash
cd apps/api
DATABASE_URL="postgresql+psycopg://finhub:finhub@localhost:5432/finhub" \
  .venv/bin/alembic upgrade head
```

默认是 dry-run，不会真正删除数据：

```bash
cd apps/api
DATABASE_URL="postgresql+psycopg://finhub:finhub@localhost:5432/finhub" \
  .venv/bin/python scripts/reset-sync-data.py
```

执行钉钉同步数据清理：

```bash
cd apps/api
DATABASE_URL="postgresql+psycopg://finhub:finhub@localhost:5432/finhub" \
  .venv/bin/python scripts/reset-sync-data.py \
  --execute \
  --yes-i-know-this-deletes-data
```

默认 `dingtalk-sync` 范围会清理：

- 钉钉审批实例 `approval_instances`
- 钉钉审批模板和解析映射
- 钉钉部门快照
- 钉钉同步产生的费用明细
- 上述费用明细关联的支出流水匹配
- 钉钉附件占位或下载记录
- 钉钉同步任务日志
- 钉钉配置里的模板/审批同步时间
- 自动同步设置里的审批水位、续跑状态和最近执行状态

默认范围会保留：

- 用户、角色、权限
- 门店、门店分组
- 钉钉凭证配置
- 费用分类、供应商、收入渠道
- 银行流水和营业收入记录

测试阶段如果需要清掉更多业务数据，可以使用：

```bash
cd apps/api
DATABASE_URL="postgresql+psycopg://finhub:finhub@localhost:5432/finhub" \
  .venv/bin/python scripts/reset-sync-data.py \
  --scope all-test-data \
  --execute \
  --yes-i-know-this-deletes-data
```

`all-test-data` 还会清理银行流水、营业收入记录、套帐和所有对账匹配，但仍保留用户、门店、权限、基础档案和钉钉密钥，方便重新测试同步流程。
