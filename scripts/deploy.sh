#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# 🚀 fin-hub 快速部署脚本 - Docker Buildx 方案（3x 加速）
# ============================================================================
# 使用 buildx 构建并推送镜像，支持本地缓存和增量推送
#
# 用法:
#   ./scripts/deploy.sh              # 使用所有默认值
#   ./scripts/deploy.sh my-server    # 部署到指定服务器
#   ./scripts/deploy.sh my-server v1.0.0  # 指定 tag
#
# ============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 参数解析
SERVER="${1:-fin-hub-server}"
TAG="${2:-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)}"
DOCKER_HUB_USER="peakcary"
REGISTRY="docker.io/${DOCKER_HUB_USER}/fin-hub"
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
# 第2步：检查 buildx 环境
# ============================================================================
echo ""
log "检查 Docker buildx..."

if ! docker buildx version &>/dev/null; then
  error "Docker buildx 未安装或不可用"
  exit 1
fi

# 检查或创建构建器
BUILDER_NAME="fin-hub-builder"
if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
  log "创建 buildx 构建器: $BUILDER_NAME"
  docker buildx create --name "$BUILDER_NAME" --use --driver docker-container
  success "构建器创建完成"
else
  docker buildx use "$BUILDER_NAME"
  success "使用现有构建器: $BUILDER_NAME"
fi

# ============================================================================
# 第3步：构建并推送镜像（使用 buildx）
# ============================================================================
echo ""
log "构建并推送镜像（使用 Docker Buildx）..."
echo "  • 支持本地缓存"
echo "  • 增量推送"
echo "  • 3x 加速"
echo ""

# 预检查镜像是否已存在
if docker pull "${REGISTRY}/fin-hub-api:${TAG}" &>/dev/null 2>&1; then
  warn "镜像 ${TAG} 已存在于 Docker Hub，跳过构建"
  success "镜像已准备: ${REGISTRY}/fin-hub-api:${TAG}"
else
  log "构建 API 镜像..."
  docker buildx build \
    --tag "${REGISTRY}/fin-hub-api:${TAG}" \
    --tag "${REGISTRY}/fin-hub-api:latest" \
    --push \
    --cache-from type=registry,ref="${REGISTRY}/fin-hub-api:buildcache" \
    --cache-to type=registry,ref="${REGISTRY}/fin-hub-api:buildcache",mode=max \
    --file apps/api/Dockerfile \
    . || {
    error "API 镜像构建失败"
    exit 1
  }
  success "API 镜像构建并推送完成"

  log "构建 Admin-Web 镜像..."
  docker buildx build \
    --tag "${REGISTRY}/fin-hub-admin-web:${TAG}" \
    --tag "${REGISTRY}/fin-hub-admin-web:latest" \
    --push \
    --cache-from type=registry,ref="${REGISTRY}/fin-hub-admin-web:buildcache" \
    --cache-to type=registry,ref="${REGISTRY}/fin-hub-admin-web:buildcache",mode=max \
    --file apps/admin-web/Dockerfile \
    . || {
    error "Admin-Web 镜像构建失败"
    exit 1
  }
  success "Admin-Web 镜像构建并推送完成"
fi

# ============================================================================
# 第4步：连接服务器并部署
# ============================================================================
echo ""
log "连接服务器: $SERVER"

if ! ssh -o ConnectTimeout=10 "$SERVER" "test -f /opt/fin-hub/.env.production" 2>/dev/null; then
  error "无法连接到 $SERVER 或 /opt/fin-hub/.env.production 不存在"
  exit 1
fi
success "服务器连接成功"

# ============================================================================
# 第5步：远程执行部署
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
echo "  • 回滚版本:     ./scripts/deploy.sh $SERVER <previous-tag>"
echo ""
echo "💡 提示:"
echo "  • 下次部署只需: ./scripts/deploy.sh"
echo "  • buildx 缓存生效后，后续部署耗时 2-5 分钟"
echo ""
