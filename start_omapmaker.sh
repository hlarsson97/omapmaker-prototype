#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

if [[ ! -x .venv/bin/python ]]; then
  echo "Pythonmiljön saknas. Följ SERVER_SETUP_UBUNTU.md först." >&2
  exit 1
fi

exec .venv/bin/python tools/height_server.py \
  --host "${OMAP_HOST:-127.0.0.1}" \
  --port "${OMAP_PORT:-8765}"

