#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env.production}"
TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD 2>/dev/null || date +%Y%m%d%H%M%S)}"
REGISTRY="${IMAGE_REGISTRY:-}"
SAVE_TAR="${SAVE_TAR:-false}"
PUSH="${PUSH:-false}"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/reports/deploy}"
PLATFORM="${DOCKER_PLATFORM:-linux/amd64}"

usage() {
  cat <<'USAGE'
Usage: scripts/build-prod-images.sh [options]

Build production images away from the server.

Options:
  --tag TAG          Image tag. Defaults to current git short SHA.
  --registry NAME    Registry/repository prefix, for example ghcr.io/org/fin-hub.
  --platform VALUE   Build platform. Defaults to linux/amd64.
  --push            Push images after build.
  --save            Save images to a tar archive for scp/docker load deployment.

Environment:
  NEXT_PUBLIC_API_BASE_URL is read from .env.production when present.
  IMAGE_TAG, IMAGE_REGISTRY, DOCKER_PLATFORM, PUSH, SAVE_TAR and OUTPUT_DIR can also be set.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --tag)
      TAG="${2:?missing tag value}"
      shift 2
      ;;
    --registry)
      REGISTRY="${2:?missing registry value}"
      shift 2
      ;;
    --platform)
      PLATFORM="${2:?missing platform value}"
      shift 2
      ;;
    --push)
      PUSH=true
      shift
      ;;
    --save)
      SAVE_TAR=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required to build production images" >&2
  exit 1
fi

if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

prefix=""
if [ -n "$REGISTRY" ]; then
  prefix="${REGISTRY%/}/"
fi

API_IMAGE="${API_IMAGE:-${prefix}fin-hub-api:$TAG}"
ADMIN_WEB_IMAGE="${ADMIN_WEB_IMAGE:-${prefix}fin-hub-admin-web:$TAG}"
NEXT_PUBLIC_API_BASE_URL="${NEXT_PUBLIC_API_BASE_URL:-http://localhost:8000}"

cd "$ROOT_DIR"

echo "Building API image: $API_IMAGE"
docker build --platform "$PLATFORM" -f apps/api/Dockerfile -t "$API_IMAGE" .

echo "Building admin-web image: $ADMIN_WEB_IMAGE"
docker build \
  --platform "$PLATFORM" \
  -f apps/admin-web/Dockerfile \
  --build-arg "NEXT_PUBLIC_API_BASE_URL=$NEXT_PUBLIC_API_BASE_URL" \
  -t "$ADMIN_WEB_IMAGE" .

if [ "$PUSH" = "true" ]; then
  echo "Pushing images..."
  docker push "$API_IMAGE"
  docker push "$ADMIN_WEB_IMAGE"
fi

if [ "$SAVE_TAR" = "true" ]; then
  mkdir -p "$OUTPUT_DIR"
  tar_file="$OUTPUT_DIR/fin-hub-images-$TAG.tar"
  env_file="$OUTPUT_DIR/fin-hub-images-$TAG.env"
  echo "Saving images to $tar_file"
  docker save -o "$tar_file" "$API_IMAGE" "$ADMIN_WEB_IMAGE"
  {
    echo "IMAGE_TAG=$TAG"
    echo "API_IMAGE=$API_IMAGE"
    echo "ADMIN_WEB_IMAGE=$ADMIN_WEB_IMAGE"
  } > "$env_file"
  echo "Wrote image env file: $env_file"
fi

echo "Done."
echo "DOCKER_PLATFORM=$PLATFORM"
echo "IMAGE_TAG=$TAG"
echo "API_IMAGE=$API_IMAGE"
echo "ADMIN_WEB_IMAGE=$ADMIN_WEB_IMAGE"
