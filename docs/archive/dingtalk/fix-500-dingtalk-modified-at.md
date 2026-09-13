# 修复 500 错误 - 添加 dingtalk_modified_at 字段

## 问题原因

代码中添加了 `dingtalk_modified_at` 字段，但数据库还没有这个列，导致查询失败。

## 解决方案

### 方法 1: 使用 SQL 直接添加（最快）

```bash
# 连接到 PostgreSQL 数据库
psql -U your_username -d your_database

# 执行以下 SQL
ALTER TABLE approval_instances ADD COLUMN IF NOT EXISTS dingtalk_modified_at TIMESTAMP;

# 为现有数据设置默认值
UPDATE approval_instances
SET dingtalk_modified_at = COALESCE(approved_at, created_at)
WHERE dingtalk_modified_at IS NULL;
```

或者执行 SQL 文件：
```bash
cd /Users/ompeak/work/github/pikecode/fin-hub/apps/api
psql -U your_username -d your_database -f add_dingtalk_modified_at.sql
```

### 方法 2: 使用 Alembic 迁移（推荐）

```bash
cd /Users/ompeak/work/github/pikecode/fin-hub/apps/api

# 如果有虚拟环境
source .venv/bin/activate  # 或 poetry shell

# 运行迁移
alembic upgrade head

# 或者使用 Python 模块方式
python -m alembic upgrade head
```

### 方法 3: 使用 Docker（如果使用 Docker）

```bash
cd /Users/ompeak/work/github/pikecode/fin-hub

# 进入 API 容器
docker compose exec api bash

# 运行迁移
alembic upgrade head

# 退出容器
exit

# 重启服务
docker compose restart api
```

## 验证

添加字段后，验证是否成功：

```bash
# 连接数据库
psql -U your_username -d your_database

# 检查字段
\d approval_instances

# 应该能看到 dingtalk_modified_at 列
```

或者测试 API：
```bash
curl 'http://localhost:8000/api/dingtalk/approval-instances?page_size=10'
```

应该返回正常数据，不再是 500 错误。

## 迁移文件位置

- `/Users/ompeak/work/github/pikecode/fin-hub/apps/api/alembic/versions/20260903_0009_add_dingtalk_modified_at.py`

## 后续步骤

1. 执行上述任一方法添加字段
2. 重启后端服务（如果需要）
3. 测试 API 是否正常
4. 如果仍有问题，检查后端日志
