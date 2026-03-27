#!/usr/bin/env bash
# SCP Planner - Safe server update script
# Run this on the Mac Mini to deploy a new version.
#
# What it does:
#   1. Syncs latest code (git pull if git repo, otherwise assumes OneDrive synced)
#   2. Backs up the current database (timestamped copy in ./backups/)
#   3. Saves the current Docker image as a rollback target
#   4. Builds and starts the new image (Alembic migrations run on startup)
#   5. Verifies the app is healthy and row counts are intact
#   6. On failure: automatically restores the backup DB and previous image

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_DIR="$SCRIPT_DIR/backups"
BACKUP_FILE="$BACKUP_DIR/scmp_$TIMESTAMP.db"
VOLUME_NAME="supply-chain-planner_scp-data"  # docker volume name (compose project + service)
IMAGE="scp-planner:latest"
ROLLBACK_IMAGE="scp-planner:rollback"

mkdir -p "$BACKUP_DIR" data/uploads

# ── helpers ────────────────────────────────────────────────────────────────────

log()  { echo "==> $*"; }
fail() { echo ""; echo "ERROR: $*" >&2; exit 1; }

# More reliable: count rows in each table individually
total_rows() {
    local vol="$1"
    docker run --rm \
        -v "$vol:/data" \
        keinos/sqlite3 \
        sqlite3 /data/scmp.db \
        "SELECT SUM(cnt) FROM (
            SELECT COUNT(*) as cnt FROM suppliers UNION ALL
            SELECT COUNT(*) FROM products UNION ALL
            SELECT COUNT(*) FROM sales_history UNION ALL
            SELECT COUNT(*) FROM forecast_runs UNION ALL
            SELECT COUNT(*) FROM forecasts UNION ALL
            SELECT COUNT(*) FROM inventory UNION ALL
            SELECT COUNT(*) FROM purchase_orders UNION ALL
            SELECT COUNT(*) FROM production_orders UNION ALL
            SELECT COUNT(*) FROM mrp_runs UNION ALL
            SELECT COUNT(*) FROM customer_demand UNION ALL
            SELECT COUNT(*) FROM bom_items UNION ALL
            SELECT COUNT(*) FROM data_connectors
         );" 2>/dev/null || echo "0"
}

# Restore backup and restart rollback image
rollback() {
    log "ROLLING BACK..."
    docker compose down 2>/dev/null || true

    if [ -f "$BACKUP_FILE" ]; then
        log "Restoring database from $BACKUP_FILE ..."
        docker run --rm \
            -v "$VOLUME_NAME:/data" \
            -v "$BACKUP_DIR:/backup" \
            alpine \
            cp "/backup/scmp_$TIMESTAMP.db" /data/scmp.db
    fi

    if docker image inspect "$ROLLBACK_IMAGE" &>/dev/null; then
        log "Restoring previous Docker image..."
        docker tag "$ROLLBACK_IMAGE" "$IMAGE"
    fi

    docker compose up -d
    echo ""
    echo "ROLLBACK COMPLETE. The previous version is running."
    echo "Backup kept at: $BACKUP_FILE"
    exit 1
}

# ── step 1: sync latest code ──────────────────────────────────────────────────
# Pull from git if this is a git repo. Otherwise files arrive via OneDrive sync.
if git -C "$SCRIPT_DIR" rev-parse --is-inside-work-tree &>/dev/null 2>&1; then
    log "Pulling latest code from git..."
    git pull || fail "git pull failed. Check your connection or resolve conflicts first."
else
    log "Files managed via OneDrive sync - skipping git pull."
fi

# ── step 2: record current row counts ─────────────────────────────────────────
log "Recording current database state..."
ROWS_BEFORE=0
if docker volume inspect "$VOLUME_NAME" &>/dev/null; then
    ROWS_BEFORE=$(total_rows "$VOLUME_NAME")
    log "Rows before update: $ROWS_BEFORE"
else
    log "No existing volume found - this appears to be a first install."
fi

# ── step 3: back up the database ──────────────────────────────────────────────
if docker volume inspect "$VOLUME_NAME" &>/dev/null; then
    log "Backing up database to $BACKUP_FILE ..."
    docker run --rm \
        -v "$VOLUME_NAME:/data" \
        -v "$BACKUP_DIR:/backup" \
        alpine \
        cp /data/scmp.db "/backup/scmp_$TIMESTAMP.db"
    log "Backup saved: $BACKUP_FILE"
fi

# ── step 4: save current image as rollback target ─────────────────────────────
if docker image inspect "$IMAGE" &>/dev/null; then
    log "Saving current image as rollback target..."
    docker tag "$IMAGE" "$ROLLBACK_IMAGE"
fi

# ── step 5: build new image ────────────────────────────────────────────────────
log "Building new Docker image..."
docker compose build || { rollback; }

# ── step 6: start new container ───────────────────────────────────────────────
log "Starting new container (Alembic migrations will run automatically)..."
docker compose down 2>/dev/null || true
docker compose up -d || { rollback; }

# ── step 7: wait for health check ─────────────────────────────────────────────
log "Waiting for app to start..."
HEALTH_OK=false
for i in $(seq 1 30); do
    if curl -sf http://localhost:8000/api/health >/dev/null 2>&1; then
        HEALTH_OK=true
        break
    fi
    sleep 2
done

if [ "$HEALTH_OK" = false ]; then
    echo ""
    echo "Health check failed after 60s."
    docker compose logs --tail=50
    rollback
fi

log "App is healthy."

# ── step 8: verify row counts ──────────────────────────────────────────────────
if [ "$ROWS_BEFORE" -gt 0 ]; then
    log "Verifying data integrity..."
    ROWS_AFTER=$(total_rows "$VOLUME_NAME")
    log "Rows after update: $ROWS_AFTER"

    if [ "$ROWS_AFTER" -lt "$ROWS_BEFORE" ]; then
        echo ""
        echo "DATA LOSS DETECTED: had $ROWS_BEFORE rows, now $ROWS_AFTER rows."
        rollback
    fi

    log "Data integrity OK ($ROWS_BEFORE -> $ROWS_AFTER rows)."
fi

# ── step 9: clean up old rollback image ───────────────────────────────────────
docker rmi "$ROLLBACK_IMAGE" 2>/dev/null || true

echo ""
echo "======================================================"
echo " Update complete!"
echo " App running at: http://$(hostname -s).local:8000"
echo " Backup saved:   $BACKUP_FILE"
echo "======================================================"
