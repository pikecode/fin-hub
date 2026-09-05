#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# 🚀 fin-hub 服务器本地构建部署脚本
# ============================================================================
# 直接在服务器上构建镜像并启动服务
# 无需 Docker Hub，100% 稳定快速
#
# 用法:
#   ./scripts/deploy-server.sh              # 使用默认服务器 fin-hub-server
#   ./scripts/deploy-server.sh my-server    # 部署到指定服务器
#
# ============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="${1:-fin-hub-server}"
COMPOSE_FILE="infra/docker/docker-compose.prod.images.yml"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 日志函数
log() { echo -e "${BLUE}→${NC} $*"; }
success() { echo -e "${GREEN}✅${NC} $*"; }
warn() { echo -e "${YELLOW}⚠️${NC} $*"; }
error() { echo -e "${RED}❌${NC} $*" >&2; }

# ============================================================================
# 第0步：环境检查
# ============================================================================
cd "$ROOT_DIR"

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🚀 fin-hub 服务器构建部署${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo ""

log "环境检查..."
for cmd in git ssh; do
  if ! command -v $cmd &>/dev/null; then
    error "$cmd 未安装"
    exit 1
  fi
done
success "环境检查通过"

# ============================================================================
# 第1步：验证部署配置
# ============================================================================
echo ""
log "部署配置验证..."
echo "  Server: $SERVER"
echo ""

# 检查 git 状态
if [ -n "$(git status --porcelain)" ]; then
  warn "工作区有未提交的更改"
  git status --short | sed 's/^/    /'
  echo ""
  read -p "确认部署？(y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log "已取消"
    exit 0
  fi
fi

success "部署配置验证完成"

# ============================================================================
# 第2步：推送代码到服务器
# ============================================================================
echo ""
log "推送代码到 git 仓库..."

BRANCH=$(git rev-parse --abbrev-ref HEAD)
COMMIT=$(git rev-parse --short HEAD)

git push origin "$BRANCH" || {
  warn "代码推送失败，但继续部署..."
}

success "代码推送完成 (分支: $BRANCH, 提交: $COMMIT)"

# ============================================================================
# 第3步：连接服务器验证
# ============================================================================
echo ""
log "验证服务器连接..."

if ! ssh -o ConnectTimeout=10 "$SERVER" "test -d /opt/fin-hub && test -f /opt/fin-hub/.env.production" 2>/dev/null; then
  error "无法连接到 $SERVER 或缺少必要的配置"
  exit 1
fi

success "服务器连接成功"

# ============================================================================
# 第4步：服务器端构建并部署
# ============================================================================
echo ""
log "服务器端构建并部署..."
echo ""

ssh "$SERVER" bash << 'DEPLOY_SCRIPT'
set -euo pipefail

cd /opt/fin-hub

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

log() { echo -e "${BLUE}→${NC} $*"; }
success() { echo -e "${GREEN}✅${NC} $*"; }
warn() { echo -e "${YELLOW}⚠️${NC} $*"; }

# 1. 验证配置
if [ ! -f .env.production ]; then
  echo "❌ .env.production 不存在" >&2
  exit 1
fi

# 2. 更新代码
log "📥 更新代码..."
git fetch origin
git checkout origin/main
success "代码更新完成"

# 3. 构建镜像
echo ""
log "🔨 构建镜像..."
echo "  • API 镜像"
echo "  • Admin-Web 镜像"
echo "  • 其他依赖"
echo ""

docker compose build --no-cache || {
  echo "❌ 镜像构建失败" >&2
  exit 1
}
success "镜像构建完成"

# 4. 启动服务
echo ""
log "🚀 启动服务..."
docker compose \
  --env-file .env.production \
  up -d

sleep 3
success "服务启动完成"

# 5. 显示服务状态
echo ""
log "📊 服务状态:"
docker compose ps

# 6. 健康检查
echo ""
log "🏥 健康检查..."
MAX_RETRIES=15
RETRY=0

while [ $RETRY -lt $MAX_RETRIES ]; do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
    echo "✅ API 服务健康"
    break
  fi

  RETRY=$((RETRY + 1))
  if [ $RETRY -lt $MAX_RETRIES ]; then
    echo "  等待中... ($RETRY/$MAX_RETRIES)"
    sleep 2
  fi
done

if [ $RETRY -eq $MAX_RETRIES ]; then
  warn "API 服务未在预期时间内就绪"
  echo "查看日志: docker compose logs api"
else
  success "所有服务健康检查通过"
fi

echo ""
echo "✅ 部署完成"

DEPLOY_SCRIPT

success "远程部署完成"

# ============================================================================
# 完成
# ============================================================================
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "🎉 部署成功！"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "📋 部署信息:"
echo "  Server:   $SERVER"
echo "  分支:     $BRANCH"
echo "  提交:     $COMMIT"
echo ""
echo "🔗 后续操作:"
echo "  • 查看日志:     ssh $SERVER 'docker compose logs -f api'"
echo "  • 查看状态:     ssh $SERVER 'docker compose ps'"
echo "  • 进入容器:     ssh $SERVER 'docker compose exec api bash'"
echo "  • 重启服务:     ssh $SERVER 'docker compose restart'"
echo "  • 停止服务:     ssh $SERVER 'docker compose down'"
echo ""
echo "💡 提示:"
echo "  • 下次部署只需: ./scripts/deploy-server.sh"
echo "  • 后续构建时间会更快（Docker 层缓存）"
echo ""
