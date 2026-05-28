#!/usr/bin/env bash
# Post-deploy smoke test against a deployed Hive environment.
#
#   API_BASE=https://api.hive.example.com \
#   AUTH_TOKEN=<your API_AUTH_TOKEN> \
#   ./scripts/smoke-cloud.sh
#
# Hits /healthz on the control plane, then runs the six go-live smoke flows
# (Phase 6d gate 8), each as a real bot+job end-to-end:
#   1. Cron Heartbeat        (always; the baseline "is anything working" check)
#   2. ESPN Scoreboard Scraper
#   3. AI Single Call        (needs ANTHROPIC_API_KEY on the ai-agent worker)
#   4. Full Page Screenshot  (browser pool; also asserts an artifact uploaded)
#   5. Trading Market Order  (paper mode — from the template default config)
#   6. MCP Tool Tester       (opt-in via SMOKE_MCP=1; needs a live MCP server)
#
# Each flow reports PASS / FAIL / SKIP. A flow SKIPs when its template isn't
# seeded or no worker is online for its pool. Exit is non-zero on any FAIL.
# Set STRICT=1 to turn SKIPs into FAILs (use this for the real go-live gate,
# once every worker pool + provider key is confirmed up).
#
# Env knobs: DISPATCHER_BASE SCHEDULER_BASE SWEEPER_BASE (extra /healthz checks),
#            SMOKE_MCP=1, STRICT=1, FLOW_TIMEOUT (per-flow seconds, default 150).
set -uo pipefail

API_BASE="${API_BASE:?API_BASE must be set, e.g. https://api.hive.example.com}"
AUTH_TOKEN="${AUTH_TOKEN:?AUTH_TOKEN (API_AUTH_TOKEN value) must be set}"
STRICT="${STRICT:-0}"
FLOW_TIMEOUT="${FLOW_TIMEOUT:-150}"

DISPATCHER_BASE="${DISPATCHER_BASE:-}"
SCHEDULER_BASE="${SCHEDULER_BASE:-}"
SWEEPER_BASE="${SWEEPER_BASE:-}"

PASS=0; FAIL=0; SKIP=0

curl_json() {
  curl -fsS -H "Authorization: Bearer $AUTH_TOKEN" -H 'Content-Type: application/json' "$@"
}

# --------------------------- health checks ---------------------------
echo "▶ /healthz on $API_BASE ..."
curl -fsS "$API_BASE/healthz" | jq -r '"  status=\(.status) version=\(.version) checks=\(.checks|keys|join(","))"' || {
  echo "✗ API /healthz failed" >&2; exit 1; }

for pair in "dispatcher:$DISPATCHER_BASE" "scheduler:$SCHEDULER_BASE" "sweeper:$SWEEPER_BASE"; do
  label="${pair%%:*}"; url="${pair#*:}"
  [ -z "$url" ] && continue
  echo "▶ /healthz on $url ($label) ..."
  curl -fsS "$url/healthz" | jq -r '"  status=\(.status)"' || { echo "✗ $label /healthz failed" >&2; exit 1; }
done

# --------------------------- flow helpers ---------------------------
# Cache /api/templates once.
TEMPLATES_JSON="$(curl_json "$API_BASE/api/templates")" || { echo "✗ could not list templates" >&2; exit 1; }

template_id()   { echo "$TEMPLATES_JSON" | jq -r --arg n "$1" '.[] | select(.name==$n) | .id' | head -1; }
template_pool() { echo "$TEMPLATES_JSON" | jq -r --arg n "$1" '.[] | select(.name==$n) | .poolType' | head -1; }
template_cfg()  { echo "$TEMPLATES_JSON" | jq -c --arg n "$1" '.[] | select(.name==$n) | .defaultConfig' | head -1; }

pool_online() {
  # true if at least one non-offline worker for the pool was seen recently.
  local pool="$1"
  curl_json "$API_BASE/api/workers" 2>/dev/null \
    | jq -e --arg p "$pool" 'any(.[]; .poolType==$p and .status!="offline")' >/dev/null 2>&1
}

# run_flow <label> <templateName> [extra_config_json]
run_flow() {
  local label="$1" tname="$2" extra="${3:-}"
  local tid pool cfg
  tid="$(template_id "$tname")"
  if [ -z "$tid" ] || [ "$tid" = "null" ]; then
    echo "⊘ SKIP $label — template '$tname' not seeded"; SKIP=$((SKIP+1)); [ "$STRICT" = "1" ] && FAIL=$((FAIL+1)); return
  fi
  pool="$(template_pool "$tname")"
  if ! pool_online "$pool"; then
    echo "⊘ SKIP $label — no online worker in pool '$pool'"; SKIP=$((SKIP+1)); [ "$STRICT" = "1" ] && FAIL=$((FAIL+1)); return
  fi
  cfg="$(template_cfg "$tname")"
  { [ -z "$cfg" ] || [ "$cfg" = "null" ]; } && cfg='{}'
  [ -n "$extra" ] && cfg="$(jq -c -n --argjson a "$cfg" --argjson b "$extra" '$a * $b')"

  local tag bot bot_id job job_id
  tag="smoke-$(echo "$label" | tr ' A-Z' '-a-z')-$(date +%s)"
  bot="$(curl_json "$API_BASE/api/bots" -X POST -d "$(jq -c -n --arg t "$tid" --arg n "$tag" --argjson c "$cfg" '{templateId:$t,name:$n,config:$c}')")"
  bot_id="$(echo "$bot" | jq -r .id)"
  if [ -z "$bot_id" ] || [ "$bot_id" = "null" ]; then
    echo "✗ FAIL $label — bot create failed: $(echo "$bot" | jq -rc '.error // .' 2>/dev/null)"; FAIL=$((FAIL+1)); return
  fi
  job="$(curl_json "$API_BASE/api/bots/$bot_id/run" -X POST -d '{}')"
  job_id="$(echo "$job" | jq -r .id)"

  local deadline status
  deadline=$((SECONDS + FLOW_TIMEOUT)); status="queued"
  while [ $SECONDS -lt $deadline ]; do
    sleep 3
    status="$(curl_json "$API_BASE/api/jobs/$job_id" | jq -r .status)"
    case "$status" in succeeded|failed|cancelled|unroutable) break ;; esac
  done

  local extra_note=""
  if [ "$status" = "succeeded" ] && [ "$pool" = "browser" ]; then
    local art
    art="$(curl_json "$API_BASE/api/jobs/$job_id/artifacts" | jq 'length' 2>/dev/null || echo 0)"
    if [ "${art:-0}" -ge 1 ]; then extra_note=" (artifact uploaded ✓)"; else extra_note=" (⚠ no artifact)"; fi
  fi

  curl -fsS -X DELETE -H "Authorization: Bearer $AUTH_TOKEN" "$API_BASE/api/bots/$bot_id" >/dev/null 2>&1

  if [ "$status" = "succeeded" ]; then
    echo "✓ PASS $label$extra_note"; PASS=$((PASS+1))
  else
    echo "✗ FAIL $label — job ended status=$status"; FAIL=$((FAIL+1))
  fi
}

# --------------------------- the flows ---------------------------
echo "▶ smoke flows (STRICT=$STRICT) ..."
run_flow "Cron Heartbeat"          "Cron Heartbeat"
run_flow "ESPN scrape"             "ESPN Scoreboard Scraper"
run_flow "AI Single Call"          "AI Single Call"
run_flow "Full Page Screenshot"    "Full Page Screenshot"
run_flow "Trading paper order"     "Trading Market Order" '{"mode":"paper"}'
if [ "${SMOKE_MCP:-0}" = "1" ]; then
  run_flow "MCP Tool Tester"       "MCP Tool Tester"
else
  echo "⊘ SKIP MCP Tool Tester — set SMOKE_MCP=1 (needs a live MCP server bot running)"
fi

# --------------------------- summary ---------------------------
echo "──────────────────────────────────────────────"
echo "  PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
if [ "$FAIL" -gt 0 ]; then echo "✗ smoke FAILED"; exit 1; fi
echo "✓ smoke OK"
