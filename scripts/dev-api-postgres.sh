#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"
DATABASE_URL_VALUE="${DATABASE_URL:-postgresql+psycopg://finhub:finhub@localhost:5432/finhub}"
START_DOCKER_INFRA="${START_DOCKER_INFRA:-true}"

if [ "$START_DOCKER_INFRA" = "true" ] && command -v docker >/dev/null 2>&1; then
  docker compose -f "$ROOT_DIR/infra/docker/docker-compose.yml" up -d postgres redis
fi

cd "$API_DIR"

if [ ! -d ".venv" ]; then
  uv venv --python python3.12 .venv
fi

uv pip install --python .venv/bin/python -e ".[dev]"
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/alembic upgrade head
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/python -m app.dev_seed
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
