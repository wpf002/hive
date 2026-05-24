#!/bin/bash
# Run all enabled worker pools in parallel.
# Use `mprocs` for a nicer UI: `mprocs` from repo root.
set -e
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

set -a; source .env; set +a

echo "🐝 Starting worker pools..."

"$ROOT_DIR/workers/scraper/.venv/bin/python" -m hive_scraper.main &
SCRAPER_PID=$!

"$ROOT_DIR/workers/monitor/.venv/bin/python" -m hive_monitor.main &
MONITOR_PID=$!

pnpm --filter @hive/worker-ai-agent dev &
AI_PID=$!

trap "kill $SCRAPER_PID $MONITOR_PID $AI_PID 2>/dev/null" INT TERM EXIT
wait
