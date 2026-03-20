#!/usr/bin/env bash
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
BACKEND="$ROOT/backend"
FRONTEND="$ROOT/frontend"

# Detect node (Playwright bundled or system)
NODE_BIN=""
if command -v node >/dev/null 2>&1; then
  NODE_BIN="$(command -v node)"
elif [ -f "/Users/$USER/Library/Caches/ms-playwright-go/1.50.1/node" ]; then
  NODE_BIN="/Users/$USER/Library/Caches/ms-playwright-go/1.50.1/node"
fi

NPM_CLI="/private/tmp/package/bin/npm-cli.js"
if [ -n "$NODE_BIN" ] && [ -f "$NPM_CLI" ]; then
  NPM="$NODE_BIN $NPM_CLI"
elif command -v npm >/dev/null 2>&1; then
  NPM="npm"
else
  echo "⚠️  npm not found. Install Node.js from https://nodejs.org and re-run."
  NPM=""
fi

echo "🔧 Supply Chain Planner — Setup & Start"
echo "========================================"

# --- Backend ---
echo ""
echo "📦 Setting up Python backend..."
cd "$BACKEND"

if [ ! -d ".venv" ]; then
  python3.9 -m venv .venv
fi
source .venv/bin/activate
pip install -q -r requirements.txt

if [ ! -f "scmp.db" ]; then
  echo "🌱 Seeding demo data..."
  python seed.py
fi

echo "🚀 Starting FastAPI backend on http://localhost:8000 ..."
uvicorn main:app --host 0.0.0.0 --port 8000 --reload &
BACKEND_PID=$!

# --- Frontend ---
echo ""
echo "📦 Setting up frontend..."
cd "$FRONTEND"

if [ ! -d "node_modules" ] && [ -n "$NPM" ]; then
  export PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin"
  $NPM install
fi

echo "🚀 Starting Vite dev server on http://localhost:5173 ..."
if [ -n "$NODE_BIN" ]; then
  export PATH="$(dirname "$NODE_BIN"):/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin"
  "$NODE_BIN" node_modules/.bin/vite &
elif command -v npx >/dev/null 2>&1; then
  npx vite &
else
  npm run dev &
fi
FRONTEND_PID=$!

echo ""
echo "✅ Both services running!"
echo "   Frontend: http://localhost:5173"
echo "   API docs: http://localhost:8000/docs"
echo ""
echo "Press Ctrl+C to stop both servers."

trap "kill $BACKEND_PID $FRONTEND_PID 2>/dev/null; exit" INT TERM
wait
