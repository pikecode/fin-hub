#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ADMIN_DIR="$ROOT_DIR/apps/admin-web"

find "$ADMIN_DIR" -maxdepth 1 -type d \( \
  -name ".next" -o \
  -name ".next.bak-*" -o \
  -name ".next-build-backup-*" \
\) -print -exec rm -r {} +

