# fin-hub API

FastAPI service for fin-hub.

## 本地开发

推荐从仓库根目录启动本地 SQLite 版本：

```bash
scripts/dev-api-sqlite.sh
```

手动启动：

```bash
uv venv --python python3.12 .venv
.venv/bin/uv pip install -e ".[dev]"
DATABASE_URL="sqlite+pysqlite:///./data/dev.db" .venv/bin/alembic upgrade head
DATABASE_URL="sqlite+pysqlite:///./data/dev.db" .venv/bin/python -m app.dev_seed
DATABASE_URL="sqlite+pysqlite:///./data/dev.db" .venv/bin/uvicorn app.main:app --reload --port 8000
```

默认开发账号：

- 后台管理员：`admin / admin123456`
- 股东授权码：`share123456`

## 测试

```bash
apps/api/.venv/bin/pytest apps/api/tests
```

当前测试覆盖：

- 后台登录和会话
- 用户管理
- 门店、账套、封账检查
- 费用分类、供应商
- 支出明细
- 附件与凭证上传、下载
- 银行流水新增、编辑、CSV/XLSX 导入、导入预览
- 匹配候选、自动生成、确认、拒绝
- 钉钉模板、字段映射、连接测试、mock/real 审批同步
- 钉钉审批分页同步窗口和任务游标
- 报表汇总、明细、CSV 导出
- 股东授权登录和报表鉴权
- 操作日志
- SQLite 数据库备份

## 已实现 API 模块

- `/api/health`
- `/api/auth`
- `/api/users`
- `/api/stores`
- `/api/ledgers`
- `/api/categories`
- `/api/suppliers`
- `/api/expense-items`
- `/api/attachments`
- `/api/bank-transactions`
- `/api/matches`
- `/api/dingtalk`
- `/api/reports`
- `/api/shareholder-auth`
- `/api/shareholder-grants`
- `/api/audit-logs`
- `/api/system`

## 数据库迁移

```bash
cd apps/api
DATABASE_URL="sqlite+pysqlite:///./data/dev.db" .venv/bin/alembic upgrade head
```

迁移文件位于：

- `alembic/versions/`

Docker Compose 开发环境会在 API 容器启动时自动执行迁移，并在 `SEED_DEV_DATA=true` 时写入样例数据。

## 安全注意

- 生产环境必须设置强 `SECRET_KEY`。
- 钉钉 App Secret 不通过 API 明文返回。
- 后台写操作使用 Cookie 会话鉴权。
- 股东小程序使用 Bearer Token，报表接口按授权门店过滤。
- SQLite 备份文件包含完整业务数据和配置，不应外传。
- PostgreSQL 生产环境建议使用 `pg_dump`、托管数据库快照或云厂商备份策略。
