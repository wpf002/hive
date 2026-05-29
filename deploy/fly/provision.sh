#!/usr/bin/env bash
# One-shot, idempotent Fly.io provisioning for a Hive production deploy.
#
#   FLY_ORG=my-org FLY_REGION=ord ./deploy/fly/provision.sh
#
# Creates one Fly app per service + worker pool, creates Fly Postgres, and
# attaches Postgres to every service that needs it. Re-running is safe:
# already-existing apps / attachments are detected and skipped.
#
# Two pieces CANNOT be scripted (third-party handshakes) — this script prints
# the exact commands to run for them:
#   1. Upstash Redis  (Fly's Upstash integration is dashboard-driven)
#   2. Tigris bucket  (flyctl storage create — captures access key + secret)
#
# Prereqs: see docs/PRODUCTION_CHECKLIST.md. flyctl must be authed.
set -euo pipefail

FLY_ORG="${FLY_ORG:?set FLY_ORG to your Fly organization slug (flyctl orgs list)}"
FLY_REGION="${FLY_REGION:-ord}"
PG_APP="${PG_APP:-hive-pg}"

if ! command -v flyctl >/dev/null 2>&1; then
  echo "✗ flyctl not found — brew install flyctl, then flyctl auth login" >&2
  exit 1
fi
flyctl auth whoami >/dev/null 2>&1 || { echo "✗ not authenticated — run: flyctl auth login" >&2; exit 1; }

# Control-plane services + worker pools (rpa_desktop is intentionally excluded —
# it needs a physical desktop session and runs on a real machine, not Fly).
CONTROL_PLANE=(hive-api hive-ui hive-dispatcher hive-scheduler hive-session-sweeper)
WORKERS=(
  hive-worker-scraper hive-worker-monitor hive-worker-ai-agent hive-worker-trading
  hive-worker-mcp-host hive-worker-ci-agent hive-worker-task-runner
  hive-worker-discord hive-worker-telegram hive-worker-browser
)
ALL_APPS=("${CONTROL_PLANE[@]}" "${WORKERS[@]}")

# Services that talk to Postgres (workers reach the DB only via the API, so
# they do NOT get a direct DATABASE_URL attachment).
PG_CONSUMERS=(hive-api hive-dispatcher hive-scheduler hive-session-sweeper)

app_exists() { flyctl apps list --json 2>/dev/null | grep -q "\"Name\":[[:space:]]*\"$1\""; }

echo "▶ Step 1/4 — creating apps in org '$FLY_ORG' ..."
for app in "${ALL_APPS[@]}"; do
  if app_exists "$app"; then
    echo "  = $app already exists"
  else
    echo "  + creating $app"
    flyctl apps create "$app" --org "$FLY_ORG"
  fi
done

echo "▶ Step 2/4 — Fly Postgres ($PG_APP) ..."
if app_exists "$PG_APP"; then
  echo "  = $PG_APP already exists (single-region; multi-region is a later upgrade — see docs/PRODUCTION.md)"
else
  echo "  + creating $PG_APP in $FLY_REGION"
  flyctl postgres create \
    --name "$PG_APP" \
    --org "$FLY_ORG" \
    --region "$FLY_REGION" \
    --initial-cluster-size 1 \
    --vm-size shared-cpu-1x \
    --volume-size 10
fi

echo "▶ Step 3/4 — attaching Postgres (ONE shared database for all services) ..."
# IMPORTANT: `flyctl postgres attach` creates a SEPARATE database + user per app
# by default (hive_api, hive_dispatcher, ...). Hive needs ALL services on the
# SAME database (migrations + seed live in one place). So we attach only to the
# API, then copy that exact DATABASE_URL to every other consumer.
API_APP_FOR_DB="hive-api"
if flyctl secrets list --app "$API_APP_FOR_DB" --json 2>/dev/null | grep -q '"Name":[[:space:]]*"DATABASE_URL"'; then
  echo "  = $API_APP_FOR_DB already has DATABASE_URL"
else
  echo "  + attaching $PG_APP -> $API_APP_FOR_DB"
  flyctl postgres attach "$PG_APP" --app "$API_APP_FOR_DB" || \
    echo "  ⚠ attach failed — re-run: flyctl postgres attach $PG_APP --app $API_APP_FOR_DB"
fi
# Read the API's DATABASE_URL from the running app and fan it out unchanged.
SHARED_DB="$(flyctl ssh console -a "$API_APP_FOR_DB" -C "node -e 'process.stdout.write(process.env.DATABASE_URL||\"\")'" 2>/dev/null | grep -oE 'postgres://[^ ]+' | head -1 | tr -d '\r' || true)"
if [ -z "$SHARED_DB" ]; then
  echo "  ⚠ couldn't read DATABASE_URL from $API_APP_FOR_DB yet (deploy the API first, then re-run this step)."
else
  for app in "${PG_CONSUMERS[@]}"; do
    [ "$app" = "$API_APP_FOR_DB" ] && continue
    echo "  + pointing $app at the shared database"
    flyctl secrets set --app "$app" --stage DATABASE_URL="$SHARED_DB" >/dev/null 2>&1 || \
      echo "  ⚠ failed to set DATABASE_URL on $app"
  done
fi

echo "▶ Step 4/4 — MANUAL STEPS (cannot be scripted) ----------------------------"
cat <<EOF

  (a) Upstash Redis — provision via Fly's integration, then attach to EVERY app:

      flyctl redis create --org $FLY_ORG --region $FLY_REGION --name hive-redis
      # Copy the printed redis:// connection string, then set it everywhere:
      REDIS_URL='redis://...'   # from the command above
      for app in ${ALL_APPS[*]}; do
        flyctl secrets set --app \$app --stage REDIS_URL="\$REDIS_URL"
      done
      # NOTE the browser pool opens many short-lived clients — if you hit
      # Upstash connection limits, upgrade the Upstash tier (see docs/PRODUCTION.md).

  (b) Tigris S3 bucket — creates the bucket AND prints AWS_ACCESS_KEY_ID /
      AWS_SECRET_ACCESS_KEY. Capture both — they are shown ONCE:

      flyctl storage create --app hive-api --name hive-artifacts-prod
      # Endpoint is https://fly.storage.tigris.dev ; region 'auto'.
      # Put the key/secret/bucket/endpoint into your set-secrets env file
      # (see deploy/fly/set-secrets.sh).

  Once (a) and (b) are done, set all remaining secrets:

      ./deploy/fly/set-secrets.sh ./deploy/fly/.secrets.env

------------------------------------------------------------------------------
✓ provisioning (scriptable parts) complete.
EOF
