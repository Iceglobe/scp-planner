#!/bin/bash
# SCP Planner launcher - double-click this file to start

DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# If already running, just open the browser
if lsof -ti:8000 > /dev/null 2>&1; then
    echo "SCP Planner is already running."
    open http://localhost:8000
    exit 0
fi

echo "Building SCP Planner Docker image..."
docker compose build

echo "Starting SCP Planner..."
docker compose up -d

# Wait for the app to be ready (up to 60s)
for i in $(seq 1 30); do
    if curl -sf http://localhost:8000/api/health > /dev/null 2>&1; then
        echo "Ready."
        open http://localhost:8000
        break
    fi
    sleep 2
done

echo ""
echo "SCP Planner is running at http://localhost:8000"
echo "To stop: docker compose -f \"$DIR/docker-compose.yml\" down"
echo ""
