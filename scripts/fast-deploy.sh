#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# 🚀 fin-hub 快速部署脚本 - Docker Hub 增量部署
# ============================================================================
# 用法: ./scripts/deploy.sh [docker_hub_user] [tag] [server]
# 示例:
#   ./scripts/deploy.sh                        # 使用所有默认值
#   ./scripts/deploy.sh ompeak                 # 自定义用户名
#   ./scripts/deploy.sh ompeak v1.0.0          # 自定义 tag
#   ./scripts/deploy.sh ompeak v1.0.0 my-server  # 完全自定义
# ============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DOCKER_HUB_USER="${1:-ompeak}"
TAG="${2:-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)}"
SERVER="${3:-fin-hub-server}"
REGISTRY="docker.io/${DOCKER_HUB_USER}/fin-hub"
COMPOSE_FILE="infra/docker/docker-compose.prod.images.yml"

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 日志函数
log() { echo -e "${BLUE}→${NC} $*"; }
success() { echo -e "${GREEN}✅${NC} $*"; }
warn() { echo -e "${YELLOW}⚠️${NC} $*"; }
error() { echo -e "${RED}❌${NC} $*" >&2; }

# ============================================================================
# 第0步：环境检查
# ============================================================================
cd "$ROOT_DIR"

log "环境检查..."
for cmd in docker git; do
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
echo "  Registry: $REGISTRY"
echo "  Tag:      $TAG"
echo "  Server:   $SERVER"
echo "  Image:    ${REGISTRY}/fin-hub-api:${TAG}"
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

# 检查是否登录 Docker Hub
if ! docker info >/dev/null 2>&1; then
  error "Docker 守护进程未运行"
  exit 1
fi

if ! docker inspect "docker.io/$DOCKER_HUB_USER" >/dev/null 2>&1; then
  warn "可能未登录 Docker Hub，请执行: docker login"
  read -p "继续？(y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 0
  fi
fi

success "部署配置验证完成"

# ============================================================================
# 第2步：本地构建并推送镜像
# ============================================================================
echo ""
log "启动本地构建并推送镜像..."
echo "  • 启用 BuildKit 加速"
echo "  • 利用缓存减少构建时间"
echo "  • 增量上传到 Docker Hub"
echo ""

export DOCKER_BUILDKIT=1
export BUILDKIT_PROGRESS=plain

# 预检查镜像是否已存在于 Docker Hub
EXISTING_TAG=$(docker pull "${REGISTRY}/fin-hub-api:${TAG}" 2>&1 || echo "not-found")
if [[ ! "$EXISTING_TAG" == *"not-found"* ]]; then
  warn "镜像 ${TAG} 已存在于 Docker Hub，跳过构建"
  success "镜像已准备: ${REGISTRY}/fin-hub-api:${TAG}"
else
  log "构建并推送镜像..."
  time scripts/build-prod-images.sh \
    --registry "$REGISTRY" \
    --tag "$TAG" \
    --push || {
    error "镜像构建或推送失败"
    exit 1
  }
  success "镜像构建并推送完成"
fi

# ============================================================================
# 第3步：连接服务器并部署
# ============================================================================
echo ""
log "连接服务器: $SERVER"

if ! ssh -o ConnectTimeout=10 "$SERVER" "test -f /opt/fin-hub/.env.production" 2>/dev/null; then
  error "无法连接到 $SERVER 或 /opt/fin-hub/.env.production 不存在"
  exit 1
fi
success "服务器连接成功"

# ============================================================================
# 第4步：远程执行部署
# ============================================================================
echo ""
log "远程执行部署..."

ssh "$SERVER" bash << DEPLOY_SCRIPT
set -euo pipefail

cd /opt/fin-hub

# 验证配置文件
if [ ! -f .env.production ]; then
  echo "❌ .env.production 文件不存在" >&2
  exit 1
fi

# 导出镜像变量
export API_IMAGE="${REGISTRY}/fin-hub-api:${TAG}"
export ADMIN_WEB_IMAGE="${REGISTRY}/fin-hub-admin-web:${TAG}"

echo "📦 拉取镜像..."
docker compose \\
  --env-file .env.production \\
  -f "${COMPOSE_FILE}" \\
  pull

echo ""
echo "🚀 启动服务..."
docker compose \\
  --env-file .env.production \\
  -f "${COMPOSE_FILE}" \\
  up -d

echo ""
echo "⏳ 等待服务启动..."
sleep 5

# 检查服务状态
echo "📊 服务状态:"
docker compose \\
  --env-file .env.production \\
  -f "${COMPOSE_FILE}" \\
  ps

# 健康检查
echo ""
echo "🏥 健康检查..."
MAX_RETRIES=10
RETRY=0
while [ \$RETRY -lt \$MAX_RETRIES ]; do
  if curl -sf http://localhost:8000/health >/dev/null 2>&1; then
    echo "✅ API 服务健康"
    break
  fi
  RETRY=\$((RETRY + 1))
  if [ \$RETRY -lt \$MAX_RETRIES ]; then
    echo "  等待中... (\$RETRY/\$MAX_RETRIES)"
    sleep 2
  fi
done

if [ \$RETRY -eq \$MAX_RETRIES ]; then
  echo "⚠️  API 服务未在预期时间内就绪"
  echo "查看日志: docker compose -f ${COMPOSE_FILE} logs api"
else
  echo "✅ 所有检查通过"
fi
DEPLOY_SCRIPT

success "远程部署完成"

# ============================================================================
# 完成
# ============================================================================
echo ""
echo "════════════════════════════════════════════════════════════════"
echo "🎉 部署完成！"
echo "════════════════════════════════════════════════════════════════"
echo ""
echo "📋 部署信息:"
echo "  Registry:  $REGISTRY"
echo "  Tag:       $TAG"
echo "  Server:    $SERVER"
echo ""
echo "🔗 后续操作:"
echo "  • 查看日志:     ssh $SERVER 'docker compose -f ${COMPOSE_FILE} logs -f api'"
echo "  • 查看状态:     ssh $SERVER 'docker compose -f ${COMPOSE_FILE} ps'"
echo "  • 进入容器:     ssh $SERVER 'docker compose -f ${COMPOSE_FILE} exec api bash'"
echo "  • 回滚版本:     ./scripts/deploy.sh ompeak previous-tag $SERVER"
echo ""
echo "💡 提示:"
echo "  • 下次部署只需: ./scripts/deploy.sh"
echo "  • 缓存生效后，后续部署耗时 5-7 分钟"
echo ""
