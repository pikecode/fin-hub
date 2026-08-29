#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_DIR="$ROOT_DIR/apps/api"
DATABASE_URL_VALUE="${DATABASE_URL:-sqlite+pysqlite:///$API_DIR/data/dev.db}"

cd "$API_DIR"

if [ ! -d ".venv" ]; then
  uv venv --python python3.12 .venv
fi

.venv/bin/uv pip install -e ".[dev]"
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/alembic upgrade head
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/python -m app.dev_seed
DATABASE_URL="$DATABASE_URL_VALUE" .venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
