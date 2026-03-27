#!/usr/bin/env bash
# Build and optionally export the SCP Planner Docker image.
#
# Usage:
#   ./deploy.sh              → build image locally (for docker compose up)
#   ./deploy.sh --export     → build + save as scp-planner.tar.gz for offline delivery

set -euo pipefail

IMAGE="scp-planner:latest"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "==> Building $IMAGE ..."
docker build -t "$IMAGE" "$SCRIPT_DIR"

echo "==> Build complete."

if [[ "${1:-}" == "--export" ]]; then
  OUT="$SCRIPT_DIR/scp-planner.tar.gz"
  echo "==> Exporting image to $OUT ..."
  docker save "$IMAGE" | gzip > "$OUT"
  echo "==> Saved: $OUT ($(du -h "$OUT" | cut -f1))"
  echo ""
  echo "    Deliver scp-planner.tar.gz + docker-compose.yml to the customer."
  echo "    Customer loads it with:"
  echo "      docker load < scp-planner.tar.gz"
  echo "      docker compose up -d"
fi

echo "==> Done."
