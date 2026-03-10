#!/bin/sh
set -e

MODULE_WASM="/opt/module/violin_session.wasm"
DB_NAME="violin-session"
STDB_URL="http://127.0.0.1:3000"

# Start SpacetimeDB in the background
spacetime start &
STDB_PID=$!

# Wait for SpacetimeDB to be ready by polling the HTTP endpoint
echo "[entrypoint] Waiting for SpacetimeDB to start..."
until curl -sf "$STDB_URL/v1/ping" > /dev/null 2>&1 || curl -sf "$STDB_URL/health" > /dev/null 2>&1 || curl -sf -o /dev/null -w '%{http_code}' "$STDB_URL/" 2>/dev/null | grep -q '200\|404'; do
    sleep 1
done
echo "[entrypoint] SpacetimeDB is responding"

# Configure CLI to talk to local server
spacetime server add --url "$STDB_URL" --no-fingerprint local 2>/dev/null || true
spacetime server set-default local 2>/dev/null || true

# Publish the module
echo "[entrypoint] Publishing module $DB_NAME..."
spacetime publish --server "$STDB_URL" --bin-path "$MODULE_WASM" "$DB_NAME" 2>&1 && \
    echo "[entrypoint] Module published successfully" || \
    echo "[entrypoint] Publish returned non-zero (module may already exist)"

echo "[entrypoint] SpacetimeDB ready with module $DB_NAME"

# Wait for the server process
wait $STDB_PID
