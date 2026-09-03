#!/usr/bin/env bash
set -euo pipefail

# fin-hub 完整启动脚本
# 用法: ./scripts/start.sh [选项]
# 选项:
#   --api-only     仅启动 API 服务
#   --admin-only   仅启动后台管理
#   --help         显示此帮助信息

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_LOG="${API_LOG:-/tmp/fin-hub-api.log}"
ADMIN_LOG="${ADMIN_LOG:-/tmp/fin-hub-admin-web.log}"
START_API=true
START_ADMIN=true
API_PID=""
ADMIN_PID=""

# 颜色定义
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 帮助信息
show_help() {
  cat << EOF
使用方法: ./scripts/start.sh [选项]

选项:
  --api-only       仅启动 API 服务 (http://localhost:8000)
  --admin-only     仅启动后台管理 (http://localhost:3000)
  --help           显示此帮助信息

示例:
  ./scripts/start.sh              # 启动 API 和后台管理
  ./scripts/start.sh --api-only   # 仅启动 API
  ./scripts/start.sh --admin-only # 仅启动后台管理

默认访问地址:
  后台管理: http://localhost:3000 (admin / admin123456)
  API:     http://localhost:8000
  API文档:  http://localhost:8000/docs
  钉钉同步: http://localhost:3000/dingtalk

日志文件:
  API 日志:   $API_LOG
  Admin 日志: $ADMIN_LOG

按 Ctrl+C 停止所有服务
EOF
}

# 解析命令行参数
while [[ $# -gt 0 ]]; do
  case $1 in
    --api-only)
      START_ADMIN=false
      shift
      ;;
    --admin-only)
      START_API=false
      shift
      ;;
    --help)
      show_help
      exit 0
      ;;
    *)
      echo "未知选项: $1"
      show_help
      exit 1
      ;;
  esac
done

# 清理函数
cleanup() {
  if [ -n "$API_PID" ]; then
    kill "$API_PID" 2>/dev/null || true
  fi
  if [ -n "$ADMIN_PID" ]; then
    kill "$ADMIN_PID" 2>/dev/null || true
  fi
  echo -e "\n${YELLOW}所有服务已停止${NC}"
}

trap cleanup EXIT INT TERM

cd "$ROOT_DIR"

# 显示启动信息
echo -e "${BLUE}╭─────────────────────────────────────────╮${NC}"
echo -e "${BLUE}│  fin-hub 启动中...${NC}"
echo -e "${BLUE}╰─────────────────────────────────────────╯${NC}"
echo ""

# 安装依赖
echo -e "${YELLOW}[1/3]${NC} 检查并安装依赖..."
if ! pnpm install --frozen-lockfile > /dev/null 2>&1; then
  echo -e "${YELLOW}[1/3]${NC} 安装依赖完成"
fi

# 启动 API
if [ "$START_API" = true ]; then
  echo -e "${YELLOW}[2/3]${NC} 启动 API 服务..."
  scripts/dev-api-postgres.sh > "$API_LOG" 2>&1 &
  API_PID=$!

  # 等待 API 启动
  echo -e "${YELLOW}     等待 API 启动...${NC}"
  for i in {1..30}; do
    if grep -q "Application startup complete" "$API_LOG" 2>/dev/null; then
      echo -e "${GREEN}✓ API 已启动${NC}"
      break
    fi
    sleep 1
  done
fi

# 启动后台管理
if [ "$START_ADMIN" = true ]; then
  echo -e "${YELLOW}[3/3]${NC} 启动后台管理..."
  pnpm dev:admin > "$ADMIN_LOG" 2>&1 &
  ADMIN_PID=$!

  # 等待后台启动
  echo -e "${YELLOW}     等待后台启动...${NC}"
  for i in {1..30}; do
    if grep -q "compiled client and server successfully\|Ready on" "$ADMIN_LOG" 2>/dev/null; then
      echo -e "${GREEN}✓ 后台管理已启动${NC}"
      break
    fi
    sleep 1
  done
fi

echo ""
echo -e "${GREEN}╭─────────────────────────────────────────╮${NC}"
echo -e "${GREEN}│  fin-hub 启动完成！${NC}"
echo -e "${GREEN}╰─────────────────────────────────────────╯${NC}"
echo ""

# 显示访问地址
if [ "$START_API" = true ]; then
  echo -e "${BLUE}API 服务:${NC}"
  echo -e "  主页:      ${GREEN}http://localhost:8000${NC}"
  echo -e "  API 文档:  ${GREEN}http://localhost:8000/docs${NC}"
  echo -e "  日志:      ${YELLOW}$API_LOG${NC}"
  echo ""
fi

if [ "$START_ADMIN" = true ]; then
  echo -e "${BLUE}后台管理:${NC}"
  echo -e "  地址:      ${GREEN}http://localhost:3000${NC}"
  echo -e "  用户名:    ${GREEN}admin${NC}"
  echo -e "  密码:      ${GREEN}admin123456${NC}"
  echo -e "  钉钉同步:  ${GREEN}http://localhost:3000/dingtalk${NC}"
  echo -e "  日志:      ${YELLOW}$ADMIN_LOG${NC}"
  echo ""
fi

echo -e "${YELLOW}按 Ctrl+C 停止所有服务${NC}"
echo ""

# 保持进程运行
while true; do
  if [ "$START_API" = true ] && ! kill -0 "$API_PID" 2>/dev/null; then
    echo -e "${YELLOW}⚠ API 进程已停止${NC}"
    break
  fi
  if [ "$START_ADMIN" = true ] && ! kill -0 "$ADMIN_PID" 2>/dev/null; then
    echo -e "${YELLOW}⚠ 后台管理进程已停止${NC}"
    break
  fi
  sleep 2
done

wait "$API_PID" "$ADMIN_PID" 2>/dev/null || true
