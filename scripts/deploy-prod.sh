#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT_DIR/.env.production"
COMPOSE_FILE="$ROOT_DIR/infra/docker/docker-compose.prod.yml"

cd "$ROOT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required on the server" >&2
  exit 1
fi

if ! docker compose version >/dev/null 2>&1; then
  echo "docker compose plugin is required on the server" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo ".env.production is missing. Create it from .env.production.example first." >&2
  exit 1
fi

required_vars=(
  POSTGRES_PASSWORD
  SECRET_KEY
  CORS_ORIGINS
  NEXT_PUBLIC_API_BASE_URL
)

for name in "${required_vars[@]}"; do
  if ! grep -Eq "^${name}=.+" "$ENV_FILE"; then
    echo "$name is required in .env.production" >&2
    exit 1
  fi
done

echo "Building production images..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" build

echo "Starting production services..."
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d

echo "Service status:"
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
