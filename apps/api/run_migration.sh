#!/bin/bash

# 运行数据库迁移

cd /Users/ompeak/work/github/pikecode/fin-hub/apps/api

echo "📋 当前迁移状态:"
python3 -m alembic current

echo ""
echo "🔄 执行迁移..."
python3 -m alembic upgrade head

echo ""
echo "✅ 迁移完成！当前状态:"
python3 -m alembic current
