#!/usr/bin/env bash
# Sequenced production deploy to Fly.io. Run AFTER provision.sh + set-secrets.sh.
#
#   ./deploy/fly/deploy-production.sh
#
# Order is deliberate: migrate → seed → control plane → verify → UI → workers →
# wait for heartbeats → smoke. Any failure stops immediately with a recovery
# hint. Re-running is safe (migrate deploy + seed are idempotent).
#
# Env overrides:
#   API_APP (hive-api)  UI_APP (hive-ui)  API_BASE (https://hive-api.fly.dev)
#   SKIP_MIGRATE=1 SKIP_SEED=1  — skip those steps if already done this session
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
FLY_DIR="$ROOT/deploy/fly"

API_APP="${API_APP:-hive-api}"
UI_APP="${UI_APP:-hive-ui}"
API_BASE="${API_BASE:-https://hive-api.fly.dev}"

CONTROL_PLANE_AFTER_API=(dispatcher scheduler session-sweeper)
WORKERS=(
  worker-scraper worker-monitor worker-ai-agent worker-trading
  worker-mcp-host worker-ci-agent worker-task-runner
)

command -v flyctl >/dev/null 2>&1 || { echo "✗ flyctl not found" >&2; exit 1; }
command -v jq >/dev/null 2>&1 || { echo "✗ jq not found (brew install jq)" >&2; exit 1; }

die() { echo "✗ $1" >&2; [ -n "${2:-}" ] && echo "  ↳ recover: $2" >&2; exit 1; }

deploy_cfg() {
  local svc="$1"
  local toml="$FLY_DIR/${svc}.fly.toml"
  [ -f "$toml" ] || die "missing $toml" "check the service name"
  echo "▶ deploying $svc ..."
  (cd "$ROOT" && flyctl deploy --config "$toml" --remote-only) \
    || die "$svc deploy failed" "flyctl logs -a hive-${svc#worker-}; fix and re-run (idempotent)"
}

verify_healthz() {
  local app="$1"
  local url="https://${app}.fly.dev/healthz"
  echo "  · checking $url"
  local status
  status=$(curl -fsS --max-time 10 "$url" | jq -r '.status' 2>/dev/null || echo "unreachable")
  [ "$status" = "ok" ] || die "$app /healthz status=$status" \
    "flyctl logs -a $app; a dependency (postgres/redis) is likely down"
  echo "    ✓ $app healthy"
}

# --- 1. migrate ------------------------------------------------------------
if [ "${SKIP_MIGRATE:-0}" != "1" ]; then
  echo "▶ [1/13] (migrations run automatically as the api's release_command on deploy) ..."
fi

# --- 2-4. api (release_command migrates first) + verify --------------------
echo "▶ [2/13] api — release_command applies pending migrations, then deploys ..."
deploy_cfg api
echo "▶ [3/13] verify _prisma_migrations ..."
flyctl postgres connect -a hive-pg -c \
  'SELECT count(*) AS applied FROM "_prisma_migrations" WHERE finished_at IS NOT NULL;' \
  || echo "  ⚠ could not auto-verify migration count — check manually (release_command output is in the api deploy log)"
echo "▶ [4/13] verify api /healthz ..."
verify_healthz "$API_APP"

# --- seed (idempotent) — needs the api machine, which now exists -----------
if [ "${SKIP_SEED:-0}" != "1" ]; then
  echo "▶ seeding (idempotent) ..."
  flyctl ssh console -a "$API_APP" -C "pnpm --filter @hive/api seed" \
    || die "seed failed" "inspect: flyctl logs -a $API_APP ; re-run is safe (seed is idempotent)"
fi

# --- 5-8. control plane + verify ------------------------------------------
echo "▶ [5-7/13] dispatcher, scheduler, session-sweeper ..."
for svc in "${CONTROL_PLANE_AFTER_API[@]}"; do deploy_cfg "$svc"; done
echo "▶ [8/13] verify control-plane /healthz ..."
for svc in dispatcher scheduler session-sweeper; do verify_healthz "hive-$svc"; done

# --- 9. ui -----------------------------------------------------------------
echo "▶ [9/13] ui ..."
deploy_cfg ui

# --- 10. workers (parallel) ------------------------------------------------
echo "▶ [10/13] worker pools (parallel) ..."
pids=()
for w in "${WORKERS[@]}"; do
  ( deploy_cfg "$w" ) &
  pids+=("$!")
done
fail=0
for pid in "${pids[@]}"; do wait "$pid" || fail=1; done
[ "$fail" -eq 0 ] || die "one or more worker deploys failed" "re-run this script (it resumes cleanly) or deploy the failed worker alone"

# --- 11. wait for heartbeats ----------------------------------------------
echo "▶ [11/13] waiting 30s for worker heartbeats to register ..."
sleep 30

# --- 12. smoke -------------------------------------------------------------
echo "▶ [12/13] smoke-cloud.sh ..."
AUTH_TOKEN="${AUTH_TOKEN:-}"
[ -n "$AUTH_TOKEN" ] || echo "  ⚠ AUTH_TOKEN not set — smoke will prompt/fail; export your API_AUTH_TOKEN"
API_BASE="$API_BASE" AUTH_TOKEN="$AUTH_TOKEN" "$ROOT/scripts/smoke-cloud.sh" \
  || die "smoke-cloud failed" "do NOT announce; inspect flyctl logs across services (GO_LIVE_RUNBOOK gate 8)"

# --- 13. done --------------------------------------------------------------
echo "▶ [13/13] done."
echo "✓ Production is live."
echo "  UI:  https://${UI_APP}.fly.dev   (custom domain after 6b: https://hive.<yourdomain>)"
echo "  API: ${API_BASE}"
