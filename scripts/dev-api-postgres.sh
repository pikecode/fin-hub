#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"
DATABASE_URL_VALUE="${DATABASE_URL:-postgresql+psycopg://finhub:finhub@localhost:5432/finhub}"
DINGTALK_SYNC_MODE_VALUE="${DINGTALK_SYNC_MODE:-real}"
API_PORT="${API_PORT:-8057}"

cd "$API_DIR"

if [ ! -d ".venv" ]; then
  uv venv --python python3.12 .venv
fi

uv pip install --python .venv/bin/python -e ".[dev]"
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/alembic upgrade head
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/python -m app.dev_seed

for pid in $(lsof -tiTCP:"$API_PORT" -sTCP:LISTEN 2>/dev/null || true); do
  process_cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  [ "$process_cwd" = "$API_DIR" ] && kill "$pid" 2>/dev/null || true
done
sleep 1

DINGTALK_SYNC_MODE="$DINGTALK_SYNC_MODE_VALUE" DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port "$API_PORT"
