#!/usr/bin/env bash
# Start the local demo API. Does not purchase telephony or call a paid API.
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed. The demo can still run with: pnpm dev:api" >&2
  exit 1
fi

if [[ -f .env ]] && ! git check-ignore -q .env; then
  echo ".env is not gitignored. Refusing to start." >&2
  exit 1
fi

docker compose up -d --build
echo "Demo (simulation): http://127.0.0.1:3000/demo"
echo "Status: http://127.0.0.1:3000/demo/status"
echo "Health: http://127.0.0.1:3000/api/health"
echo "Stop: docker compose down"
