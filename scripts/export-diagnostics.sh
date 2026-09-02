#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/reports/diagnostics}"
API_BASE_URL="${API_BASE_URL:-http://localhost:8000}"
ADMIN_BASE_URL="${ADMIN_BASE_URL:-http://localhost:3000}"
DATABASE_URL_VALUE="${DATABASE_URL:-postgresql+psycopg://finhub:finhub@localhost:5432/finhub}"
TIMESTAMP="$(date '+%Y%m%d%H%M%S')"
PACKAGE_DIR="$OUTPUT_DIR/fin-hub-diagnostics-$TIMESTAMP"
ARCHIVE_PATH="$PACKAGE_DIR.tar.gz"

step() {
  printf "==> %s\n" "$1"
}

write_command() {
  local output_file="$1"
  shift
  {
    printf "$ %s\n\n" "$*"
    "$@" 2>&1 || true
  } | redact >"$output_file"
}

redact() {
  sed -E \
    -e 's#(SECRET_KEY|DINGTALK_APP_SECRET|DATABASE_URL|REDIS_URL|POSTGRES_PASSWORD|access_code|token|authorization)(["=: ]+)[^" ,}]+#\1\2[REDACTED]#Ig' \
    -e 's#(Bearer )[A-Za-z0-9._~+/-]+#\1[REDACTED]#Ig' \
    -e 's#(password["=: ]+)[^" ,}]+#\1[REDACTED]#Ig' \
    -e 's#(postgresql\\+psycopg://)[^[:space:]"'"'"']+#\1[REDACTED]#Ig' \
    -e 's#(redis://)[^[:space:]"'"'"']+#\1[REDACTED]#Ig'
}

mkdir -p "$PACKAGE_DIR"

step "Collect system metadata"
{
  echo "generated_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "root_dir=$ROOT_DIR"
  echo "api_base_url=$API_BASE_URL"
  echo "admin_base_url=$ADMIN_BASE_URL"
  echo "uname=$(uname -a)"
  echo "shell=${SHELL:-unknown}"
} | redact >"$PACKAGE_DIR/system.txt"

step "Collect git and workspace state"
write_command "$PACKAGE_DIR/git-status.txt" git -C "$ROOT_DIR" status --short
write_command "$PACKAGE_DIR/git-branch.txt" git -C "$ROOT_DIR" branch --show-current
write_command "$PACKAGE_DIR/workspace-files.txt" find "$ROOT_DIR" -maxdepth 3 \
  -path "$ROOT_DIR/node_modules" -prune -o \
  -path "$ROOT_DIR/apps/api/.venv" -prune -o \
  -path "$ROOT_DIR/apps/admin-web/.next" -prune -o \
  -path "$ROOT_DIR/apps/shareholder-miniapp/dist" -prune -o \
  -path "$ROOT_DIR/reports" -prune -o \
  -type f -print

step "Collect tool versions"
{
  command -v node >/dev/null 2>&1 && node --version || echo "node missing"
  command -v pnpm >/dev/null 2>&1 && pnpm --version || echo "pnpm missing"
  command -v uv >/dev/null 2>&1 && uv --version || echo "uv missing"
  [ -x "$API_DIR/.venv/bin/python" ] && "$API_DIR/.venv/bin/python" --version || echo "api python missing"
} | redact >"$PACKAGE_DIR/tool-versions.txt"

step "Collect package manifests"
for file in \
  "$ROOT_DIR/package.json" \
  "$ROOT_DIR/pnpm-workspace.yaml" \
  "$ROOT_DIR/apps/admin-web/package.json" \
  "$ROOT_DIR/apps/shareholder-miniapp/package.json" \
  "$ROOT_DIR/apps/api/pyproject.toml"; do
  if [ -f "$file" ]; then
    safe_name="$(echo "${file#$ROOT_DIR/}" | tr '/.' '__')"
    redact <"$file" >"$PACKAGE_DIR/$safe_name.txt"
  fi
done

step "Collect API migration status"
if [ -x "$API_DIR/.venv/bin/alembic" ]; then
  (
    cd "$API_DIR"
    DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/alembic current 2>&1 || true
    DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/alembic heads 2>&1 || true
    DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/alembic history --verbose 2>&1 || true
  ) | redact >"$PACKAGE_DIR/alembic.txt"
else
  echo "alembic not available" >"$PACKAGE_DIR/alembic.txt"
fi

step "Collect HTTP smoke output"
OPENAPI_TMP="$(mktemp)"
{
  echo "$ curl -fsS $API_BASE_URL/api/health"
  curl -fsS "$API_BASE_URL/api/health" || true
  printf "\n\n"
  echo "$ curl -I $ADMIN_BASE_URL/login"
  curl -fsSI "$ADMIN_BASE_URL/login" || true
  printf "\n\n"
  echo "$ curl -fsS $API_BASE_URL/openapi.json"
  if curl -fsS "$API_BASE_URL/openapi.json" -o "$OPENAPI_TMP"; then
    head -c 2000 "$OPENAPI_TMP"
  fi
  printf "\n"
} | redact >"$PACKAGE_DIR/http-smoke.txt"
rm -f "$OPENAPI_TMP"

step "Collect recent logs"
for file in /tmp/fin-hub-api.log /tmp/fin-hub-admin-web.log; do
  if [ -f "$file" ]; then
    safe_name="$(basename "$file")"
    tail -n 200 "$file" | redact >"$PACKAGE_DIR/$safe_name"
  fi
done

step "Collect port listeners"
{
  lsof -i :8000 -sTCP:LISTEN -n -P || true
  lsof -i :3000 -sTCP:LISTEN -n -P || true
} | redact >"$PACKAGE_DIR/ports.txt"

step "Create archive"
tar -czf "$ARCHIVE_PATH" -C "$OUTPUT_DIR" "$(basename "$PACKAGE_DIR")"
echo "$ARCHIVE_PATH"
