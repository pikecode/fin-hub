# 数据库优化指南

**生成时间**: 2026-09-02  
**目标**: 优化查询性能，添加关键索引

---

## 1. 核心索引审计

### 1.1 已有索引检查

运行以下 SQL 检查当前索引：

```sql
-- 查看所有表的索引
SELECT
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY tablename, indexname;

-- 查看表大小和索引使用情况
SELECT
    relname AS table_name,
    pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
    pg_size_pretty(pg_relation_size(relid)) AS table_size,
    pg_size_pretty(pg_total_relation_size(relid) - pg_relation_size(relid)) AS index_size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;
```

### 1.2 建议添加的索引

基于业务查询模式，建议添加以下索引：

#### 支出明细表 (expense_items)

```sql
-- 门店 + 账期查询（最常用）
CREATE INDEX IF NOT EXISTS idx_expense_store_ledger 
ON expense_items(store_id, ledger_id);

-- 付款状态筛选
CREATE INDEX IF NOT EXISTS idx_expense_payment_status 
ON expense_items(payment_status);

-- 供应商查询
CREATE INDEX IF NOT EXISTS idx_expense_supplier 
ON expense_items(supplier_id) 
WHERE supplier_id IS NOT NULL;

-- 费用分类查询
CREATE INDEX IF NOT EXISTS idx_expense_category 
ON expense_items(category_l1_id, category_l2_id);

-- 创建时间排序
CREATE INDEX IF NOT EXISTS idx_expense_created 
ON expense_items(created_at DESC);
```

#### 银行流水表 (bank_transactions)

```sql
-- 门店 + 发生时间（对账核心）
CREATE INDEX IF NOT EXISTS idx_bank_store_occurred 
ON bank_transactions(store_id, occurred_at DESC);

-- 门店 + 账期
CREATE INDEX IF NOT EXISTS idx_bank_store_ledger 
ON bank_transactions(store_id, ledger_id);

-- 金额范围查询（匹配算法）
CREATE INDEX IF NOT EXISTS idx_bank_amount 
ON bank_transactions(amount);

-- 交易方向
CREATE INDEX IF NOT EXISTS idx_bank_direction 
ON bank_transactions(direction);
```

#### 匹配关系表 (matches)

```sql
-- 匹配状态 + 创建时间（待处理列表）
CREATE INDEX IF NOT EXISTS idx_match_status_created 
ON matches(match_status, created_at DESC);

-- 银行流水反查
CREATE INDEX IF NOT EXISTS idx_match_bank 
ON matches(bank_transaction_id) 
WHERE bank_transaction_id IS NOT NULL;

-- 支出明细反查
CREATE INDEX IF NOT EXISTS idx_match_expense 
ON matches(expense_item_id) 
WHERE expense_item_id IS NOT NULL;

-- 收入记录反查
CREATE INDEX IF NOT EXISTS idx_match_revenue 
ON matches(revenue_record_id) 
WHERE revenue_record_id IS NOT NULL;
```

#### 营业收入表 (revenue_records)

```sql
-- 门店 + 账期
CREATE INDEX IF NOT EXISTS idx_revenue_store_ledger 
ON revenue_records(store_id, ledger_id);

-- 营业日期
CREATE INDEX IF NOT EXISTS idx_revenue_occurred 
ON revenue_records(occurred_at DESC);

-- 收入渠道
CREATE INDEX IF NOT EXISTS idx_revenue_channel 
ON revenue_records(channel_id) 
WHERE channel_id IS NOT NULL;
```

#### 审计日志表 (audit_logs)

```sql
-- 操作时间（最近操作查询）
CREATE INDEX IF NOT EXISTS idx_audit_created 
ON audit_logs(created_at DESC);

-- 操作人
CREATE INDEX IF NOT EXISTS idx_audit_user 
ON audit_logs(user_id);

-- 操作类型
CREATE INDEX IF NOT EXISTS idx_audit_action 
ON audit_logs(action);

-- 实体类型 + 实体 ID（查询某条记录的历史）
CREATE INDEX IF NOT EXISTS idx_audit_entity 
ON audit_logs(entity_type, entity_id) 
WHERE entity_id IS NOT NULL;
```

---

## 2. 查询性能分析

### 2.1 慢查询识别

```sql
-- 启用慢查询日志（PostgreSQL）
ALTER SYSTEM SET log_min_duration_statement = 1000; -- 记录超过 1 秒的查询
SELECT pg_reload_conf();

-- 查看最慢的查询
SELECT
    calls,
    total_exec_time,
    mean_exec_time,
    query
FROM pg_stat_statements
ORDER BY mean_exec_time DESC
LIMIT 20;
```

### 2.2 EXPLAIN ANALYZE 使用

对关键查询使用 EXPLAIN ANALYZE 验证索引使用：

```sql
-- 示例：门店账期支出明细查询
EXPLAIN ANALYZE
SELECT * FROM expense_items
WHERE store_id = 'xxx'
  AND ledger_id = 'yyy'
ORDER BY created_at DESC
LIMIT 50;

-- 检查输出：
-- ✅ 好：Index Scan using idx_expense_store_ledger
-- ❌ 差：Seq Scan on expense_items
```

---

## 3. 数据库连接池配置

### 3.1 SQLAlchemy 连接池

```python
# apps/api/app/core/database.py
from sqlalchemy import create_engine
from sqlalchemy.pool import QueuePool

engine = create_engine(
    settings.database_url,
    poolclass=QueuePool,
    pool_size=10,          # 基础连接数
    max_overflow=20,       # 最大溢出连接
    pool_timeout=30,       # 获取连接超时
    pool_recycle=3600,     # 1 小时回收连接（避免 idle timeout）
    pool_pre_ping=True,    # 连接前检查可用性
)
```

### 3.2 连接池监控

```python
# 添加到健康检查
@router.get("/health/db")
def db_health():
    pool = engine.pool
    return {
        "status": "ok",
        "pool_size": pool.size(),
        "checked_out": pool.checked_out_connections(),
        "overflow": pool.overflow(),
        "available": pool.size() - pool.checked_out_connections(),
    }
```

---

## 4. 数据归档策略

### 4.1 审计日志归档

审计日志会无限增长，建议定期归档：

```sql
-- 创建归档表
CREATE TABLE audit_logs_archive (
    LIKE audit_logs INCLUDING ALL
);

-- 归档 6 个月前的日志
INSERT INTO audit_logs_archive
SELECT * FROM audit_logs
WHERE created_at < NOW() - INTERVAL '6 months';

-- 删除已归档数据
DELETE FROM audit_logs
WHERE created_at < NOW() - INTERVAL '6 months';

-- 建议：使用分区表（PostgreSQL 10+）
CREATE TABLE audit_logs (
    ...
) PARTITION BY RANGE (created_at);

CREATE TABLE audit_logs_2026_09 PARTITION OF audit_logs
    FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
```

### 4.2 附件清理

定期清理孤立附件（数据库记录已删除但文件仍存在）：

```bash
# scripts/cleanup-orphaned-files.sh
#!/bin/bash
# 查找文件系统中的附件
# 对比数据库中的 attachments 表
# 删除孤立文件
```

---

## 5. 备份和恢复

### 5.1 自动备份脚本

```bash
#!/bin/bash
# scripts/backup-database.sh

set -e

BACKUP_DIR="/backups/postgres"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_NAME="finhub"

# 创建备份
pg_dump -h localhost -U finhub -Fc $DB_NAME > "$BACKUP_DIR/finhub_$TIMESTAMP.dump"

# 压缩备份
gzip "$BACKUP_DIR/finhub_$TIMESTAMP.dump"

# 删除 7 天前的备份
find $BACKUP_DIR -name "finhub_*.dump.gz" -mtime +7 -delete

echo "Backup completed: finhub_$TIMESTAMP.dump.gz"
```

### 5.2 定时任务

```bash
# Cron 任务（每天 3AM）
0 3 * * * /app/scripts/backup-database.sh >> /var/log/backup.log 2>&1
```

### 5.3 恢复测试

```bash
# 恢复数据库
pg_restore -h localhost -U finhub -d finhub_test /backups/finhub_20260902_030000.dump.gz

# 验证数据完整性
psql -h localhost -U finhub -d finhub_test -c "SELECT COUNT(*) FROM expense_items;"
```

---

## 6. 性能监控指标

### 6.1 关键指标

- **查询响应时间**: P50 < 100ms, P99 < 500ms
- **连接池使用率**: < 70%
- **索引命中率**: > 95%
- **缓存命中率**: > 90%
- **慢查询数**: < 10 次/小时

### 6.2 监控工具

- **PgHero**: PostgreSQL 性能仪表板
- **pg_stat_statements**: 查询统计
- **Prometheus + Grafana**: 指标可视化

---

## 7. 执行清单

### 立即执行（P0）

- [ ] 运行索引审计 SQL
- [ ] 添加核心索引（expense_items, bank_transactions, matches）
- [ ] 配置连接池参数
- [ ] 启用慢查询日志

### 短期执行（P1）

- [ ] 设置自动备份脚本
- [ ] 配置备份定时任务
- [ ] 添加数据库健康检查端点
- [ ] 测试恢复流程

### 长期规划（P2）

- [ ] 审计日志分区表
- [ ] 历史数据归档
- [ ] 读写分离（如需要）
- [ ] 性能监控看板

---

## 8. 性能基准测试

执行基准测试验证优化效果：

```bash
# 测试查询性能
python scripts/benchmark-queries.py

# 输出示例：
# 门店账期支出查询: 45ms → 12ms (提升 73%)
# 银行流水匹配查询: 320ms → 85ms (提升 73%)
# 待处理事项统计: 180ms → 40ms (提升 78%)
```

---

**建议**: 先在测试环境执行索引创建，验证无问题后再应用到生产环境。
