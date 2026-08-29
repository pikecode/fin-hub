#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"
DATABASE_URL_VALUE="${DATABASE_URL:-sqlite+pysqlite:///$API_DIR/data/dev.db}"
API_BASE_URL="${API_BASE_URL:-http://localhost:8000}"
ADMIN_BASE_URL="${ADMIN_BASE_URL:-http://localhost:3000}"
RUN_SMOKE=false
RUN_ADMIN_BUILD=true
RUN_MINIAPP_BUILD=true

for arg in "$@"; do
  case "$arg" in
    --smoke)
      RUN_SMOKE=true
      ;;
    --skip-admin-build)
      RUN_ADMIN_BUILD=false
      ;;
    --skip-miniapp-build)
      RUN_MINIAPP_BUILD=false
      ;;
    *)
      echo "Unknown option: $arg" >&2
      exit 2
      ;;
  esac
done

step() {
  printf "\n==> %s\n" "$1"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing required command: $1" >&2
    exit 1
  fi
}

step "Check local toolchain"
require_command pnpm
require_command curl
require_command node
if ! command -v uv >/dev/null 2>&1; then
  echo "Missing required command: uv" >&2
  exit 1
fi

step "Install API dependencies"
cd "$API_DIR"
if [ ! -d ".venv" ]; then
  uv venv --python python3.12 .venv
fi
uv pip install --python .venv/bin/python -e ".[dev]"

step "Run API migrations"
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/alembic upgrade head

step "Run API tests"
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/pytest tests

step "Run API lint"
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/ruff check app tests --ignore B008,DTZ001,DTZ007,FLY002,I001,UP046

cd "$ROOT_DIR"

step "Install workspace dependencies"
pnpm install --frozen-lockfile

step "Typecheck admin web and miniapp"
pnpm --filter @fin-hub/admin-web typecheck
pnpm --filter @fin-hub/shareholder-miniapp typecheck

if [ "$RUN_ADMIN_BUILD" = true ]; then
  step "Build admin web"
  pnpm --filter @fin-hub/admin-web build
fi

if [ "$RUN_MINIAPP_BUILD" = true ]; then
  step "Build shareholder miniapp"
  pnpm --filter @fin-hub/shareholder-miniapp build
fi

if [ "$RUN_SMOKE" = true ]; then
  step "Run HTTP smoke checks"
  curl -fsS "$API_BASE_URL/api/health" >/dev/null
  curl -fsS -o /dev/null "$ADMIN_BASE_URL/login"
  curl -fsS -c /tmp/fin-hub-preflight-cookie.txt \
    -H "content-type: application/json" \
    -d '{"username":"admin","password":"admin123456"}' \
    "$API_BASE_URL/api/auth/login" >/dev/null
  curl -fsS -b /tmp/fin-hub-preflight-cookie.txt "$API_BASE_URL/api/system/readiness" >/dev/null
fi

step "Preflight passed"
