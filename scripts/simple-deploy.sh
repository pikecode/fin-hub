#!/usr/bin/env bash
set -euo pipefail

# 简单直接部署脚本 - 直接推送代码到服务器编译运行
# 用法: ./scripts/simple-deploy.sh [server]

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${1:-fin-hub-server}"

echo "════════════════════════════════════════════════════════"
echo "🚀 简单直接部署 - 代码推送编译方案"
echo "════════════════════════════════════════════════════════"
echo "Server: $SERVER"
echo ""

# 检查本地仓库
echo "📋 检查本地仓库..."
cd "$ROOT_DIR"

# 检查是否有未提交的更改
if [ -n "$(git status --porcelain)" ]; then
  echo "⚠️  工作区有未提交的更改："
  git status --short
  echo ""
  read -p "确认部署？(y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "❌ 已取消"
    exit 0
  fi
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMIT=$(git rev-parse --short HEAD)

echo "分支: $BRANCH"
echo "最新提交: $COMMIT"
echo ""

# 推送代码到服务器
echo "📤 第1步: 推送代码到服务器..."
git push origin "$BRANCH" || {
  echo "⚠️  代码推送失败，但继续部署..."
}

# 服务器编译并重启
echo ""
echo "🔄 第2步: 服务器编译并重启服务..."
ssh "$SERVER" bash << 'REMOTE_SCRIPT'
set -euo pipefail

cd /opt/fin-hub

echo "更新代码..."
git fetch origin
git checkout origin/main  # 或你的分支名

echo "安装 Node 依赖..."
pnpm install --frozen-lockfile

echo "安装 Python 依赖..."
cd apps/api
if [ -d venv ]; then
  source venv/bin/activate
else
  python3 -m venv venv
  source venv/bin/activate
fi
pip install -e .
cd ../..

echo "执行数据库迁移..."
cd apps/api
alembic upgrade head
cd ../..

echo "构建前端..."
pnpm --filter @fin-hub/admin-web build

echo "重启服务..."
pkill -f "uvicorn app.main" || true
pkill -f "next start" || true
sleep 2

echo "启动 API..."
cd apps/api
nohup python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 > /tmp/api.log 2>&1 &
cd ../..

echo "启动前端..."
cd apps/admin-web
nohup pnpm start > /tmp/admin-web.log 2>&1 &
cd ../..

sleep 3

echo "验证服务..."
if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
  echo "✅ API 服务正常"
else
  echo "⚠️  API 服务验证失败"
fi

echo "✅ 部署完成"
ps aux | grep -E "uvicorn|next" | grep -v grep || echo "（进程列表为空）"

REMOTE_SCRIPT

echo ""
echo "════════════════════════════════════════════════════════"
echo "✅ 部署完成！"
echo "════════════════════════════════════════════════════════"
echo ""
echo "后续查看:"
echo "  • API 日志: ssh $SERVER 'tail -f /tmp/api.log'"
echo "  • 前端日志: ssh $SERVER 'tail -f /tmp/admin-web.log'"
echo "  • 访问地址: http://$SERVER:3000"
echo ""
