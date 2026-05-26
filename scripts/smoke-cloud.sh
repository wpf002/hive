#!/usr/bin/env bash
# Post-deploy smoke test against a deployed Hive environment.
#
#   API_BASE=https://hive-api.fly.dev \
#   AUTH_TOKEN=<your API_AUTH_TOKEN> \
#   ./scripts/smoke-cloud.sh
#
# Hits /healthz on the API + dispatcher + scheduler + session-sweeper, creates
# a Cron Heartbeat bot, runs it, and waits for it to finish. Catches the
# &ldquo;deployed but broken&rdquo; class of bugs without paging.
#
# Exits 0 on success, non-zero on any failure.
set -euo pipefail

API_BASE="${API_BASE:?API_BASE must be set, e.g. https://hive-api.fly.dev}"
AUTH_TOKEN="${AUTH_TOKEN:?AUTH_TOKEN (API_AUTH_TOKEN value) must be set}"

DISPATCHER_BASE="${DISPATCHER_BASE:-}"
SCHEDULER_BASE="${SCHEDULER_BASE:-}"
SWEEPER_BASE="${SWEEPER_BASE:-}"

curl_json() {
  curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' "$@"
}

echo "▶ /healthz on $API_BASE ..."
curl -fsS "$API_BASE/healthz" | jq -r '"  status=\(.status) postgres=\(.checks.postgres.ok) redis=\(.checks.redis.ok)"' || {
  echo "✗ API /healthz failed" >&2; exit 1; }

for label in dispatcher scheduler sweeper; do
  varname="${label^^}_BASE"
  if [ "$label" = "sweeper" ]; then varname="SWEEPER_BASE"; fi
  url="${!varname:-}"
  [ -z "$url" ] && continue
  echo "▶ /healthz on $url ..."
  curl -fsS "$url/healthz" | jq -r '"  status=\(.status)"' || {
    echo "✗ $label /healthz failed" >&2; exit 1; }
done

echo "▶ ensuring Cron Heartbeat template exists ..."
TPL_ID=$(curl_json "$API_BASE/api/templates" \
  | jq -r '.[] | select(.name=="Cron Heartbeat") | .id' | head -1)
if [ -z "$TPL_ID" ] || [ "$TPL_ID" = "null" ]; then
  echo "✗ Cron Heartbeat template not seeded — run `pnpm --filter @hive/api seed` first" >&2
  exit 1
fi
echo "  templateId=$TPL_ID"

echo "▶ creating sentinel bot ..."
TAG="smoke-cloud-$(date +%s)"
BOT=$(curl_json "$API_BASE/api/bots" -X POST \
  -d "{\"templateId\":\"$TPL_ID\",\"name\":\"$TAG\",\"config\":{}}")
BOT_ID=$(echo "$BOT" | jq -r .id)
echo "  botId=$BOT_ID"

echo "▶ running bot ..."
JOB=$(curl_json "$API_BASE/api/bots/$BOT_ID/run" -X POST -d '{}')
JOB_ID=$(echo "$JOB" | jq -r .id)
echo "  jobId=$JOB_ID"

echo "▶ polling for terminal status (90s max) ..."
deadline=$((SECONDS + 90))
status="queued"
while [ $SECONDS -lt $deadline ]; do
  sleep 3
  status=$(curl_json "$API_BASE/api/jobs/$JOB_ID" | jq -r .status)
  echo "  status=$status"
  case "$status" in
    succeeded|failed|cancelled|unroutable) break ;;
  esac
done

echo "▶ deleting sentinel bot ..."
curl -fsS -X DELETE -H "Authorization: Bearer $AUTH_TOKEN" "$API_BASE/api/bots/$BOT_ID" > /dev/null

if [ "$status" = "succeeded" ]; then
  echo "✓ smoke OK"
  exit 0
fi
echo "✗ job ended in status=$status — investigate" >&2
exit 1
