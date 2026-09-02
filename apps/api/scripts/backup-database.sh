#!/bin/bash
#
# 数据库自动备份脚本
# 用途：定期备份 PostgreSQL 数据库
# 使用：./backup-database.sh 或配置 cron 定时任务
#

set -e

# 配置
BACKUP_DIR="${BACKUP_DIR:-./data/backups}"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
DB_URL="${DATABASE_URL:-postgresql+psycopg://finhub:finhub@localhost:5432/finhub}"

# 从 DATABASE_URL 解析连接信息
# 格式: postgresql+psycopg://user:password@host:port/database
DB_USER=$(echo "$DB_URL" | sed -n 's|.*://\([^:]*\):.*|\1|p')
DB_PASS=$(echo "$DB_URL" | sed -n 's|.*://[^:]*:\([^@]*\)@.*|\1|p')
DB_HOST=$(echo "$DB_URL" | sed -n 's|.*@\([^:]*\):.*|\1|p')
DB_PORT=$(echo "$DB_URL" | sed -n 's|.*:\([0-9]*\)/.*|\1|p')
DB_NAME=$(echo "$DB_URL" | sed -n 's|.*/\([^?]*\).*|\1|p')

# 默认值
DB_USER="${DB_USER:-finhub}"
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-finhub}"

# 创建备份目录
mkdir -p "$BACKUP_DIR"

BACKUP_FILE="$BACKUP_DIR/finhub_$TIMESTAMP.dump"

echo "=================================================="
echo "数据库备份开始"
echo "=================================================="
echo "时间: $(date)"
echo "数据库: $DB_NAME"
echo "主机: $DB_HOST:$DB_PORT"
echo "备份文件: $BACKUP_FILE"
echo ""

# 设置密码环境变量
export PGPASSWORD="$DB_PASS"

# 使用 pg_dump 创建备份（自定义格式，支持并行恢复）
pg_dump \
    -h "$DB_HOST" \
    -p "$DB_PORT" \
    -U "$DB_USER" \
    -Fc \
    -f "$BACKUP_FILE" \
    "$DB_NAME"

# 清除密码环境变量
unset PGPASSWORD

# 压缩备份文件
echo "压缩备份文件..."
gzip "$BACKUP_FILE"
BACKUP_FILE="${BACKUP_FILE}.gz"

# 计算文件大小
BACKUP_SIZE=$(du -h "$BACKUP_FILE" | cut -f1)

echo ""
echo "=================================================="
echo "备份完成"
echo "=================================================="
echo "备份文件: $BACKUP_FILE"
echo "文件大小: $BACKUP_SIZE"
echo ""

# 清理旧备份（保留最近 7 天）
echo "清理 7 天前的旧备份..."
find "$BACKUP_DIR" -name "finhub_*.dump.gz" -mtime +7 -delete
OLD_COUNT=$(find "$BACKUP_DIR" -name "finhub_*.dump.gz" | wc -l)
echo "当前保留备份数: $OLD_COUNT"

echo ""
echo "备份任务完成: $(date)"
