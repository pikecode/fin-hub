#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_LOG="${API_LOG:-/tmp/fin-hub-api.log}"
ADMIN_LOG="${ADMIN_LOG:-/tmp/fin-hub-admin-web.log}"

cd "$ROOT_DIR"

cleanup() {
  if [ -n "${API_PID:-}" ]; then
    kill "$API_PID" 2>/dev/null || true
  fi
  if [ -n "${ADMIN_PID:-}" ]; then
    kill "$ADMIN_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

scripts/dev-api-postgres.sh >"$API_LOG" 2>&1 &
API_PID=$!

pnpm dev:admin >"$ADMIN_LOG" 2>&1 &
ADMIN_PID=$!

echo "API:   http://localhost:8057  log: $API_LOG"
echo "Admin: http://localhost:3077  log: $ADMIN_LOG"
echo "Press Ctrl+C to stop both services."

while kill -0 "$API_PID" 2>/dev/null && kill -0 "$ADMIN_PID" 2>/dev/null; do
  sleep 2
done

wait "$API_PID" "$ADMIN_PID"
