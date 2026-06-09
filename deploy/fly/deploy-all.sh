#!/usr/bin/env bash
# Sequenced Fly deploy for the Hive monorepo.
#
# Prerequisites:
#   - flyctl installed and authenticated (`flyctl auth login`).
#   - Postgres + Redis already provisioned (Fly Postgres or Supabase + Upstash).
#   - The shared secrets set on every Fly app:
#       DATABASE_URL, REDIS_URL, API_AUTH_TOKEN, WORKER_AUTH_TOKEN,
#       JWT_SECRET, SESSION_SECRET, HIVE_SECRETS_KEY
#     plus app-specific secrets (ANTHROPIC_API_KEY, DISCORD_BOT_TOKEN, …).
#   - For artifacts: an S3-compatible bucket (Tigris recommended). Set
#       HIVE_STORAGE_PROVIDER=s3, HIVE_ARTIFACT_S3_BUCKET,
#       HIVE_ARTIFACT_S3_ENDPOINT, HIVE_ARTIFACT_S3_REGION,
#       AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
#     on the API app *and* every worker that uploads artifacts.
#
# Usage:
#   ./deploy/fly/deploy-all.sh             # deploy everything
#   ./deploy/fly/deploy-all.sh api         # one service
#   ./deploy/fly/deploy-all.sh --dry-run   # print what would happen
#
# Note: rpa_desktop is *not* deployed to the cloud — it requires a physical
# desktop session. Run that pool on a real machine via `pnpm workers:dev`.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLY_DIR="$ROOT/deploy/fly"

# Order matters: control plane first, then workers.
SERVICES=(
  "api"
  "dispatcher"
  "scheduler"
  "session-sweeper"
  "ui"
  "worker-scraper"
  "worker-monitor"
  "worker-browser"
  "worker-ai-agent"
  "worker-trading"
  "worker-mcp-host"
  "worker-ci-agent"
  "worker-task-runner"
  "worker-discord"
)

DRY_RUN=0
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run|-n) DRY_RUN=1 ;;
    *) TARGETS+=("$arg") ;;
  esac
done
if [ "${#TARGETS[@]}" -eq 0 ]; then
  TARGETS=("${SERVICES[@]}")
fi

deploy_one() {
  local svc="$1"
  local toml="$FLY_DIR/${svc}.fly.toml"
  if [ ! -f "$toml" ]; then
    echo "✗ missing $toml" >&2
    return 1
  fi
  echo "▶ deploying $svc ..."
  if [ "$DRY_RUN" = "1" ]; then
    echo "   would run: flyctl deploy --config $toml --remote-only (from $ROOT)"
    return 0
  fi
  (cd "$ROOT" && flyctl deploy --config "$toml" --remote-only)
}

# Run a one-time db migration container before deploying app services. We do
# this against the production DATABASE_URL fetched from the API app's secrets.
if [ "$DRY_RUN" = "0" ] && [[ " ${TARGETS[*]} " == *" api "* ]]; then
  echo "▶ running database migrations against production DB ..."
  DB=$(flyctl secrets list --app hive-api --json 2>/dev/null | jq -r '.[] | select(.Name=="DATABASE_URL") | .Value' || true)
  if [ -n "$DB" ] && [ "$DB" != "null" ]; then
    (cd "$ROOT" && DATABASE_URL="$DB" pnpm --filter @hive/db migrate deploy)
  else
    echo "   ⚠ couldn't read DATABASE_URL secret; skipping migrations (set it first or run prisma migrate deploy manually)"
  fi
fi

for svc in "${TARGETS[@]}"; do
  deploy_one "$svc"
done

echo "✓ done"
