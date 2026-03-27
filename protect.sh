#!/usr/bin/env bash
# Build a protected (PyArmor-obfuscated) deployable package of the SCP Planner.
#
# Usage:
#   ./protect.sh          → builds into ./release/
#   ./protect.sh --zip    → also zips release/ into scp-planner-release.zip
#
# Requirements:
#   pyarmor   →  pip install pyarmor          (trial is fine for testing)
#   pyarmor license for production: https://pyarmor.readthedocs.io/en/stable/licenses.html

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

BACKEND="$SCRIPT_DIR/backend"
FRONTEND="$SCRIPT_DIR/frontend"
RELEASE="$SCRIPT_DIR/release"

echo "==> Cleaning previous release..."
rm -rf "$RELEASE"
mkdir -p "$RELEASE/backend" "$RELEASE/frontend"

# ── 1. Copy frontend dist ─────────────────────────────────────────────────────
# Build frontend first if needed: cd frontend && PATH="/tmp/node-v22.14.0-darwin-x64/bin:$PATH" npm run build
if [ ! -d "$FRONTEND/dist" ]; then
  echo "ERROR: $FRONTEND/dist not found. Build frontend first."
  exit 1
fi
echo "==> Copying frontend dist..."
cp -R "$FRONTEND/dist" "$RELEASE/frontend/dist"

# ── 2. Obfuscate backend with PyArmor ─────────────────────────────────────────
# Run from inside the backend dir so --exclude paths are resolved correctly
# and output doesn't nest a redundant "backend/" subdirectory.
echo "==> Obfuscating backend with PyArmor..."
(
  cd "$BACKEND"
  # Explicitly list only our source — avoids crawling into .venv
  pyarmor gen \
    --recursive \
    --output "$RELEASE/backend" \
    main.py models.py database.py routers/ algorithms/
)

# ── 3. Copy non-Python assets ─────────────────────────────────────────────────
echo "==> Copying runtime assets..."
cp "$BACKEND/requirements.txt" "$RELEASE/backend/"
mkdir -p "$RELEASE/backend/uploads"

# Empty starter DB (SQLAlchemy will init tables on first run)
touch "$RELEASE/backend/scmp.db"

# ── 4. Write a startup script for the customer ────────────────────────────────
cat > "$RELEASE/start.sh" << 'EOF'
#!/usr/bin/env bash
# SCP Planner — start script
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"

if [ ! -d "$DIR/backend/.venv" ]; then
  echo "==> Creating virtual environment..."
  python3 -m venv "$DIR/backend/.venv"
  "$DIR/backend/.venv/bin/pip" install --quiet -r "$DIR/backend/requirements.txt"
fi

echo "==> Starting SCP Planner on http://localhost:8000 ..."
"$DIR/backend/.venv/bin/python" -m uvicorn main:app --host 0.0.0.0 --port 8000 --app-dir "$DIR/backend"
EOF
chmod +x "$RELEASE/start.sh"

# ── 5. Optional zip ───────────────────────────────────────────────────────────
if [[ "${1:-}" == "--zip" ]]; then
  OUT="$SCRIPT_DIR/scp-planner-release.zip"
  echo "==> Zipping to $OUT..."
  cd "$SCRIPT_DIR"
  zip -qr "$OUT" release/
  echo "==> Done: $OUT ($(du -h "$OUT" | cut -f1))"
fi

echo ""
echo "==> Release built at: $RELEASE"
echo "    Customer runs:  ./release/start.sh"
