#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# 颜色输出
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "${BLUE}→${NC} $1"
}

success() {
    echo -e "${GREEN}✅${NC} $1"
}

error() {
    echo -e "${RED}❌${NC} $1"
}

warning() {
    echo -e "${YELLOW}⚠️${NC} $1"
}

# 解析参数
SSH_CONN="${1:-root@8.138.19.56}"
SSH_USER="${SSH_CONN%@*}"
SSH_HOST="${SSH_CONN#*@}"
SSH_PASS="${SSH_PASS:-}"

log "开始部署到服务器 ${SSH_USER}@${SSH_HOST}"

# 1. 准备本地代码
log "📦 准备本地代码..."
if ! git rev-parse --git-dir > /dev/null 2>&1; then
    warning "不是 Git 仓库，初始化..."
    git init
    git add .
    git commit -m "chore: initial commit" || true
fi

# 2. 上传配置文件
log "📤 上传配置文件..."
{
    if [ -f docker-compose.yml ]; then
        cat docker-compose.yml
    else
        echo "# Docker Compose 配置缺失"
    fi
} | ssh -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" "cat > /opt/fin-hub/docker-compose.yml"

{
    if [ -f .env.example ]; then
        cat .env.example
    else
        echo "# 环境变量缺失"
    fi
} | ssh -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" "cat > /opt/fin-hub/.env"

# 3. 上传代码
log "📤 上传代码到服务器..."
tar --exclude=node_modules --exclude=.next --exclude=.git --exclude=.env --exclude=dist -czf /tmp/fin-hub.tar.gz .
scp -o StrictHostKeyChecking=no /tmp/fin-hub.tar.gz "${SSH_USER}@${SSH_HOST}:/opt/"
rm /tmp/fin-hub.tar.gz

# 4. 服务器端构建和部署
log "🔨 服务器端构建镜像..."
ssh -o StrictHostKeyChecking=no "${SSH_USER}@${SSH_HOST}" <<'DEPLOY_SCRIPT'
set -euo pipefail
cd /opt/fin-hub

# 解压代码
tar -xzf /opt/fin-hub.tar.gz -C /opt/fin-hub/ || true

# 构建镜像
echo "📦 构建 API 镜像..."
docker build -f apps/api/Dockerfile -t fin-hub-api:latest .

echo "📦 构建 Admin-Web 镜像..."
docker build -f apps/admin-web/Dockerfile -t fin-hub-admin:latest .

# 停止旧容器
echo "⏹️  停止旧容器..."
docker-compose down || true

# 启动新容器
echo "🚀 启动新容器..."
docker-compose up -d

# 检查状态
echo "✅ 部署完成！"
docker ps --filter "label=com.docker.compose.project=fin-hub"
DEPLOY_SCRIPT

success "部署完成！"
success "API: http://${SSH_HOST}:8000"
success "Admin-Web: http://${SSH_HOST}:3000"
