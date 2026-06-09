#!/usr/bin/env bash
# Run the ci_agent worker on your own Mac (it needs a Docker daemon, which the
# Railway container platform can't provide), connected to the live Railway
# control plane over its public Postgres/Redis proxies.
#
# NOTE: CI normally runs as a background launchd service installed at
# ~/Library/LaunchAgents/com.hive.ci-agent.plist — it auto-starts at login and
# needs no open terminal. This script is only for running it manually in the
# foreground (e.g. to watch logs).
#
# Prereqs:
#   • Docker Desktop running.
#   • A gitignored scripts/.localworker.env with the Railway connection vars
#     (DATABASE_URL=<Postgres PUBLIC_URL>, REDIS_URL=<Redis PUBLIC_URL>,
#      API_BASE_URL, WORKER_AUTH_TOKEN, HIVE_SECRETS_KEY, HIVE_KMS_PROVIDER,
#      HIVE_WORKER_REGION, DOCKER_HOST).
#
# Usage:  bash scripts/run-local-workers.sh
set -uo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENVF="${LOCALWORKER_ENV:-$ROOT/scripts/.localworker.env}"
[ -f "$ENVF" ] || { echo "missing $ENVF — see the header of this script"; exit 1; }
set -a; . "$ENVF"; set +a
: "${REDIS_URL:?set REDIS_URL}" "${DATABASE_URL:?set DATABASE_URL}" "${WORKER_AUTH_TOKEN:?set WORKER_AUTH_TOKEN}" "${HIVE_SECRETS_KEY:?set HIVE_SECRETS_KEY}"
echo "→ starting ci_agent (requires Docker Desktop)…"
exec "$ROOT/workers/ci_agent/.venv/bin/hive-ci-agent"
