#!/usr/bin/env bash
# Run the worker pools that CANNOT run on Railway — ci_agent (needs a Docker
# daemon) and rpa_desktop (needs a real screen/keyboard) — on your own Mac,
# connected to the live Railway control plane over its public Postgres/Redis
# proxies.
#
# Prereqs
#   • Docker Desktop running (for ci_agent).
#   • For rpa_desktop: grant your TERMINAL app both Accessibility AND Screen
#     Recording in System Settings → Privacy & Security, then restart it.
#   • A gitignored scripts/.localworker.env with the Railway connection vars
#     (pull these from Railway → each service → Variables):
#       DATABASE_URL=<Postgres DATABASE_PUBLIC_URL>
#       REDIS_URL=<Redis REDIS_PUBLIC_URL>
#       API_BASE_URL=https://api-production-28ea.up.railway.app
#       WORKER_AUTH_TOKEN=...
#       HIVE_SECRETS_KEY=...
#       HIVE_KMS_PROVIDER=static
#       HIVE_WORKER_REGION=local-mac
#       DOCKER_HOST=unix://$HOME/.docker/run/docker.sock
#
# Usage:  bash scripts/run-local-workers.sh [ci|rpa|both]   (default: both)
#
# Keep this running in a Terminal (or under pm2/launchd) — when it stops, the
# workers go offline. Connections ride Railway's public Redis proxy, which can
# drop; if a worker exits, just re-run this.
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="${LOCALWORKER_ENV:-$ROOT/scripts/.localworker.env}"
[ -f "$ENVF" ] || { echo "missing $ENVF — see the header of this script"; exit 1; }
set -a; . "$ENVF"; set +a
: "${REDIS_URL:?set REDIS_URL}" "${DATABASE_URL:?set DATABASE_URL}" "${WORKER_AUTH_TOKEN:?set WORKER_AUTH_TOKEN}" "${HIVE_SECRETS_KEY:?set HIVE_SECRETS_KEY}"
WHICH="${1:-both}"
pids=()
if [ "$WHICH" = ci ] || [ "$WHICH" = both ]; then
  echo "→ starting ci_agent (requires Docker Desktop)…"
  "$ROOT/workers/ci_agent/.venv/bin/hive-ci-agent" & pids+=($!)
fi
if [ "$WHICH" = rpa ] || [ "$WHICH" = both ]; then
  echo "→ starting rpa_desktop (requires Accessibility + Screen Recording)…"
  "$ROOT/workers/rpa_desktop/.venv/bin/hive-rpa-desktop" & pids+=($!)
fi
trap 'echo "stopping…"; kill "${pids[@]}" 2>/dev/null' INT TERM
wait
