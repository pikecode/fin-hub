#!/usr/bin/env bash
set -euo pipefail

# ============================================================================
# 🚀 fin-hub 一键部署脚本 - 超简单版
# ============================================================================
# 这是最简单的部署方式，隐藏了所有复杂度
#
# 用法:
#   ./scripts/deploy.sh              # 使用所有默认值
#   ./scripts/deploy.sh my-server    # 部署到指定服务器
#   ./scripts/deploy.sh my-server v1.0.0  # 指定 tag（版本号）
#
# 示例:
#   ./scripts/deploy.sh              # 部署到 fin-hub-server，tag 是当前 git commit
#   ./scripts/deploy.sh prod-server  # 部署到 prod-server
#   ./scripts/deploy.sh prod v1.2.3  # 部署 v1.2.3 到 prod
#
# ============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 参数解析
SERVER="${1:-fin-hub-server}"
TAG="${2:-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)}"
DOCKER_HUB_USER="ompeak"  # 改成你的用户名

# 彩色输出
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo ""
echo -e "${BLUE}════════════════════════════════════════════════════${NC}"
echo -e "${GREEN}🚀 fin-hub 部署${NC}"
echo -e "${BLUE}════════════════════════════════════════════════════${NC}"
echo ""
echo "服务器: $SERVER"
echo "版本:   $TAG"
echo ""

# 快速检查
cd "$ROOT_DIR"

# 1. 检查必要工具
for tool in docker git; do
  if ! command -v $tool &>/dev/null; then
    echo -e "${RED}❌ 需要安装 $tool${NC}" >&2
    exit 1
  fi
done

# 2. 检查未提交的更改
if [ -n "$(git status --porcelain)" ]; then
  echo -e "${YELLOW}⚠️  有未提交的更改${NC}"
  git status --short | sed 's/^/   /'
  echo ""
  read -p "确认部署？(y/n) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    exit 0
  fi
fi

# 3. 执行实际的部署脚本
exec ./scripts/fast-deploy.sh "$DOCKER_HUB_USER" "$TAG" "$SERVER"
