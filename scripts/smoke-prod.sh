#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-http://127.0.0.1}}"
TIMEOUT="${SMOKE_TIMEOUT:-10}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required" >&2
  exit 1
fi

check_status() {
  local label="$1"
  local url="$2"
  local expected="$3"
  local status
  status="$(curl -sS -o /tmp/fin-hub-smoke-body -w '%{http_code}' --max-time "$TIMEOUT" "$url" || true)"
  if [ "$status" != "$expected" ]; then
    echo "❌ $label failed: expected $expected, got $status, url=$url" >&2
    if [ -s /tmp/fin-hub-smoke-body ]; then
      head -c 500 /tmp/fin-hub-smoke-body >&2 || true
      echo >&2
    fi
    exit 1
  fi
  echo "✅ $label $status"
}

check_contains() {
  local label="$1"
  local url="$2"
  local expected_text="$3"
  local body
  body="$(curl -sS --max-time "$TIMEOUT" "$url")"
  if ! grep -Fq "$expected_text" <<<"$body"; then
    echo "❌ $label failed: missing text '$expected_text', url=$url" >&2
    echo "$body" | head -c 500 >&2 || true
    echo >&2
    exit 1
  fi
  echo "✅ $label contains $expected_text"
}

check_status "首页" "$BASE_URL/" "200"
check_status "登录页" "$BASE_URL/login" "200"
check_contains "API 健康检查" "$BASE_URL/api/health" '"status":"ok"'
check_status "未登录接口应返回 401" "$BASE_URL/api/stores?page_size=1" "401"
