#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"
ADMIN_DIR="$ROOT_DIR/apps/admin-web"
DB_PORT="${DB_PORT:-15432}"
REDIS_PORT="${REDIS_PORT:-16379}"
API_PORT="${API_PORT:-8057}"
ADMIN_PORT="${ADMIN_PORT:-3077}"
ADMIN_LOG="${ADMIN_LOG:-/tmp/fin-hub-admin-web.log}"

cd "$API_DIR"

if [ ! -d ".venv" ]; then
  uv venv --python python3.12 .venv
fi
uv pip install --python .venv/bin/python -e ".[dev]"

SSH_TUNNEL_PID=""
ADMIN_PID=""
cleanup() {
  [ -n "$SSH_TUNNEL_PID" ] && kill "$SSH_TUNNEL_PID" 2>/dev/null || true
  [ -n "$ADMIN_PID" ] && kill "$ADMIN_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

if ! nc -z 127.0.0.1 "$DB_PORT" 2>/dev/null || ! nc -z 127.0.0.1 "$REDIS_PORT" 2>/dev/null; then
  ssh -N -o ExitOnForwardFailure=yes \
    -L "$DB_PORT:127.0.0.1:$DB_PORT" \
    -L "$REDIS_PORT:127.0.0.1:$REDIS_PORT" \
    fin-hub-server &
  SSH_TUNNEL_PID=$!
  sleep 1
fi

DB_PASSWORD="$(ssh fin-hub-server "sed -n 's/^POSTGRES_PASSWORD=//p' /opt/fin-hub/.env.production")"
DB_PASSWORD_URLENCODED="$(.venv/bin/python -c 'import sys; from urllib.parse import quote; print(quote(sys.argv[1], safe=""))' "$DB_PASSWORD")"

for pid in $(lsof -tiTCP:"$API_PORT" -sTCP:LISTEN 2>/dev/null || true); do
  process_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [ "$process_cwd" = "$API_DIR" ] && kill "$pid" 2>/dev/null || true
done

for pid in $(lsof -tiTCP:"$ADMIN_PORT" -sTCP:LISTEN 2>/dev/null || true); do
  process_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  if [ "$process_cwd" = "$ROOT_DIR" ] || [ "$process_cwd" = "$ADMIN_DIR" ]; then
    kill "$pid" 2>/dev/null || true
  fi
done
sleep 1

cd "$ROOT_DIR"
NEXT_PUBLIC_API_BASE_URL="http://localhost:${API_PORT}" \
  pnpm --filter @fin-hub/admin-web exec next dev --port "$ADMIN_PORT" >"$ADMIN_LOG" 2>&1 &
ADMIN_PID=$!

for _ in {1..60}; do
  if nc -z 127.0.0.1 "$ADMIN_PORT" 2>/dev/null; then
    break
  fi
  if ! kill -0 "$ADMIN_PID" 2>/dev/null; then
    echo "admin-web failed to start. Log: $ADMIN_LOG"
    tail -n 80 "$ADMIN_LOG" 2>/dev/null || true
    exit 1
  fi
  sleep 1
done

echo
echo "fin-hub API production data mode"
echo "Web:       http://localhost:${ADMIN_PORT}"
echo "Ding:      http://localhost:${ADMIN_PORT}/dingtalk"
echo "API:       http://localhost:${API_PORT}"
echo "Health:    http://localhost:${API_PORT}/api/health"
echo "Admin log: $ADMIN_LOG"
echo "DB:        127.0.0.1:${DB_PORT} -> fin-hub-server"
echo "Redis:     127.0.0.1:${REDIS_PORT} -> fin-hub-server"
echo

cd "$API_DIR"
DATABASE_URL="postgresql+psycopg://finhub:${DB_PASSWORD_URLENCODED}@127.0.0.1:${DB_PORT}/finhub" \
REDIS_URL="redis://127.0.0.1:${REDIS_PORT}/0" \
DINGTALK_SYNC_MODE=real \
.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port "$API_PORT"
