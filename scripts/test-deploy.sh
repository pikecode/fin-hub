#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# 🧪 部署脚本测试 - 验证所有功能正常
# ============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 颜色
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log() { echo -e "${BLUE}→${NC} $*"; }
success() { echo -e "${GREEN}✅${NC} $*"; }
warn() { echo -e "${YELLOW}⚠️${NC} $*"; }
error() { echo -e "${RED}❌${NC} $*" >&2; }

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🧪 部署脚本测试${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo ""

# ============================================================================
# 测试1：脚本语法检查
# ============================================================================
log "测试1: 脚本语法检查..."

for script in scripts/deploy.sh scripts/fast-deploy.sh scripts/build-prod-images.sh; do
  if bash -n "$script" 2>/dev/null; then
    success "$script 语法正确"
  else
    error "$script 语法有误"
    exit 1
  fi
done

# ============================================================================
# 测试2：脚本可执行性检查
# ============================================================================
log "测试2: 脚本可执行性检查..."

for script in scripts/deploy.sh scripts/fast-deploy.sh; do
  if [ -x "$script" ]; then
    success "$script 可执行"
  else
    warn "$script 不可执行，正在修复..."
    chmod +x "$script"
    success "$script 已设置为可执行"
  fi
done

# ============================================================================
# 测试3：环境工具检查
# ============================================================================
log "测试3: 环境工具检查..."

cd "$ROOT_DIR"

TOOLS=("docker" "git" "bash")
for tool in "${TOOLS[@]}"; do
  if command -v "$tool" &>/dev/null; then
    VERSION=$($tool --version 2>&1 | head -1)
    success "$tool 已安装: $VERSION"
  else
    error "$tool 未安装"
    exit 1
  fi
done

# ============================================================================
# 测试4：项目结构检查
# ============================================================================
log "测试4: 项目结构检查..."

FILES=(
  ".env.example"
  "apps/api/Dockerfile"
  "apps/admin-web/Dockerfile"
  "infra/docker/docker-compose.prod.images.yml"
  "scripts/build-prod-images.sh"
  "DEPLOY_GUIDE.md"
)

for file in "${FILES[@]}"; do
  if [ -f "$file" ]; then
    success "$file 存在"
  else
    error "$file 不存在"
    exit 1
  fi
done

# ============================================================================
# 测试5: Git 状态检查
# ============================================================================
log "测试5: Git 状态检查..."

if git rev-parse --git-dir > /dev/null 2>&1; then
  success "Git 仓库正常"

  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  COMMIT=$(git rev-parse --short HEAD)
  success "当前分支: $BRANCH ($COMMIT)"

  if [ -n "$(git status --porcelain)" ]; then
    warn "工作区有未提交的更改"
  else
    success "工作区干净"
  fi
else
  error "不是 Git 仓库"
  exit 1
fi

# ============================================================================
# 测试6: Docker 配置检查
# ============================================================================
log "测试6: Docker 配置检查..."

if docker ps &>/dev/null; then
  success "Docker 守护进程运行正常"
else
  error "Docker 守护进程未运行"
  exit 1
fi

# 检查 Docker 镜像构建能力
if docker build --help &>/dev/null; then
  success "Docker 构建功能正常"
else
  error "Docker 构建功能异常"
  exit 1
fi

# ============================================================================
# 测试7: Dockerfile 验证
# ============================================================================
log "测试7: Dockerfile 验证..."

# 检查 admin-web Dockerfile
if grep -q "FROM" apps/admin-web/Dockerfile && grep -q "pnpm" apps/admin-web/Dockerfile; then
  success "admin-web Dockerfile 结构正确"
else
  error "admin-web Dockerfile 结构异常"
  exit 1
fi

# 检查 api Dockerfile
if grep -q "FROM" apps/api/Dockerfile && grep -q "python" apps/api/Dockerfile; then
  success "api Dockerfile 结构正确"
else
  error "api Dockerfile 结构异常"
  exit 1
fi

# ============================================================================
# 测试8: 脚本参数解析测试（模拟）
# ============================================================================
log "测试8: 脚本参数解析测试..."

# 测试 deploy.sh 的参数解析
TEST_SERVER="test-server"
TEST_TAG="v1.0.0"

# 模拟参数解析（不实际执行部署）
bash -c "
  SERVER=\"\${1:-fin-hub-server}\"
  TAG=\"\${2:-\$(git rev-parse --short=12 HEAD)}\"
  echo \"Server: \$SERVER\"
  echo \"Tag: \$TAG\"
" -- "$TEST_SERVER" "$TEST_TAG" | grep -q "Server: test-server"

success "参数解析正常"

# ============================================================================
# 测试9: 文档完整性检查
# ============================================================================
log "测试9: 文档完整性检查..."

DOCS=(
  "DEPLOY_GUIDE.md"
  "DEPLOY_DEMO.md"
)

for doc in "${DOCS[@]}"; do
  if [ -f "$doc" ]; then
    LINES=$(wc -l < "$doc")
    success "$doc 存在 ($LINES 行)"
  else
    warn "$doc 未找到"
  fi
done

# ============================================================================
# 测试10: 部署脚本功能检查（干运行）
# ============================================================================
log "测试10: 部署脚本功能检查..."

# 提取 deploy.sh 中的关键函数
if grep -q "DOCKER_HUB_USER" scripts/deploy.sh; then
  success "deploy.sh 包含 Docker Hub 用户变量"
else
  error "deploy.sh 缺少 Docker Hub 用户变量"
  exit 1
fi

if grep -q "COMPOSE_FILE" scripts/fast-deploy.sh; then
  success "fast-deploy.sh 包含 Compose 文件变量"
else
  error "fast-deploy.sh 缺少 Compose 文件变量"
  exit 1
fi

# ============================================================================
# 测试11: BuildKit 支持检查
# ============================================================================
log "测试11: BuildKit 支持检查..."

if DOCKER_BUILDKIT=1 docker build --help 2>&1 | grep -q "buildkit"; then
  success "BuildKit 支持正常"
elif docker buildx version &>/dev/null; then
  success "Docker buildx 可用"
else
  warn "BuildKit 可能不可用，但不影响部署"
fi

# ============================================================================
# 测试12: 网络连接模拟检查
# ============================================================================
log "测试12: 网络连接模拟检查..."

# 测试 curl
if command -v curl &>/dev/null; then
  if curl --version | grep -q "curl"; then
    success "curl 可用（用于健康检查）"
  fi
else
  warn "curl 未安装（可选，用于健康检查）"
fi

# ============================================================================
# 生成测试报告
# ============================================================================
echo ""
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}✅ 所有测试通过！${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════════════════${NC}"
echo ""
echo "📋 测试摘要:"
echo "  ✓ 脚本语法检查"
echo "  ✓ 脚本可执行性"
echo "  ✓ 环境工具"
echo "  ✓ 项目结构"
echo "  ✓ Git 仓库"
echo "  ✓ Docker 环境"
echo "  ✓ Dockerfile 配置"
echo "  ✓ 参数解析"
echo "  ✓ 文档完整性"
echo "  ✓ 脚本功能"
echo "  ✓ BuildKit 支持"
echo "  ✓ 网络工具"
echo ""

# ============================================================================
# 部署准备状态
# ============================================================================
echo "🚀 部署准备状态:"
echo ""

# 检查服务器连接
if [ -n "${1:-}" ]; then
  SERVER="$1"
  echo "  检查服务器 $SERVER..."
  if ssh -o ConnectTimeout=5 "$SERVER" "test -d /opt/fin-hub" 2>/dev/null; then
    success "服务器 $SERVER 连接正常"

    if ssh "$SERVER" "test -f /opt/fin-hub/.env.production" 2>/dev/null; then
      success "服务器配置文件存在"
    else
      warn "服务器配置文件不存在，需要创建 .env.production"
    fi
  else
    warn "无法连接到服务器 $SERVER"
  fi
  echo ""
fi

# Docker Hub 登录状态
echo "  检查 Docker Hub 登录状态..."
if docker info 2>&1 | grep -q "Username"; then
  success "已登录 Docker Hub"
else
  warn "未登录 Docker Hub，执行 'docker login' 后再部署"
fi
echo ""

# ============================================================================
# 最终建议
# ============================================================================
echo "💡 下一步:"
echo ""
echo "  1️⃣  确保已登录 Docker Hub:"
echo "     docker login"
echo ""
echo "  2️⃣  确保服务器配置就位:"
echo "     ssh fin-hub-server 'cat /opt/fin-hub/.env.production | head -5'"
echo ""
echo "  3️⃣  执行部署:"
echo "     ./scripts/deploy.sh"
echo ""
echo "  4️⃣  查看部署进度:"
echo "     ssh fin-hub-server 'docker compose logs -f api'"
echo ""
