#!/usr/bin/env bash
# Set every production secret on every Fly app, per deploy/fly/secrets-manifest.yaml.
#
#   ./deploy/fly/set-secrets.sh ./deploy/fly/.secrets.env
#
# The env file (gitignored — name it `.secrets.env`) holds the PASSTHROUGH
# secret values, one per line, KEY=VALUE or `export KEY=VALUE`. Produce its
# random values with scripts/generate-production-secrets.sh and add the
# provider keys (ANTHROPIC_API_KEY, ODDS_API_KEY, RESEND_API_KEY, the Tigris
# AWS_* pair, etc.) by hand.
#
# Each app gets ONE `flyctl secrets set` call (batched) so we trigger at most
# one redeploy per app instead of one per secret. Use --stage to defer the
# redeploy entirely; this script stages and you deploy in deploy-production.sh.
#
# Requires `yq` (mikefarah/yq, the Go one): brew install yq
set -euo pipefail

ENV_FILE="${1:?usage: set-secrets.sh <path-to-env-file>}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="$SCRIPT_DIR/secrets-manifest.yaml"

command -v yq >/dev/null 2>&1 || { echo "✗ yq not found — brew install yq" >&2; exit 1; }
command -v flyctl >/dev/null 2>&1 || { echo "✗ flyctl not found" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "✗ env file not found: $ENV_FILE" >&2; exit 1; }
[ -f "$MANIFEST" ] || { echo "✗ manifest not found: $MANIFEST" >&2; exit 1; }

# Load the env file into this shell. `set -a` auto-exports; we strip a leading
# `export ` so both styles work.
set -a
# shellcheck disable=SC1090
source <(sed -E 's/^[[:space:]]*export[[:space:]]+//' "$ENV_FILE")
set +a

# Pull a list ($2) for a service ($1) from the manifest, tolerating missing keys.
manifest_list() { yq -r "(.services.\"$1\".$2 // []) | .[]" "$MANIFEST" 2>/dev/null; }
common_list()   { yq -r "(.common.$1 // []) | .[]" "$MANIFEST" 2>/dev/null; }

FAILED=0
SERVICES=$(yq -r '.services | keys | .[]' "$MANIFEST")

for svc in $SERVICES; do
  pairs=()
  missing=()

  # --- passthrough names: value taken from the env file ---
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    val="${!name-__UNSET__}"
    if [ "$val" = "__UNSET__" ]; then
      missing+=("$name")
    else
      pairs+=("$name=$val")
    fi
  done < <( { common_list passthrough; manifest_list "$svc" passthrough; manifest_list "$svc" passthrough_extra; } | sort -u )

  # --- literal NAME=VALUE config baked into the manifest ---
  while IFS= read -r kv; do
    [ -z "$kv" ] && continue
    pairs+=("$kv")
  done < <( { manifest_list "$svc" literal; manifest_list "$svc" literal_extra; } )

  if [ "${#missing[@]}" -gt 0 ]; then
    for m in "${missing[@]}"; do
      echo "✗ $svc: missing secret '$m' in $ENV_FILE" >&2
      FAILED=1
    done
    echo "  → skipping $svc (fix the env file and re-run; safe to repeat)" >&2
    continue
  fi

  if [ "${#pairs[@]}" -eq 0 ]; then
    echo "= $svc: nothing to set"
    continue
  fi

  echo "▶ $svc: setting ${#pairs[@]} secrets (single batched call) ..."
  # --stage defers the redeploy; deploy-production.sh ships the new versions.
  if ! flyctl secrets set --app "$svc" --stage "${pairs[@]}" >/dev/null; then
    echo "✗ $svc: flyctl secrets set failed" >&2
    FAILED=1
  fi
done

if [ "$FAILED" -ne 0 ]; then
  echo "✗ one or more services had missing secrets or failed — see above" >&2
  exit 1
fi
echo "✓ all secrets staged. Run deploy/fly/deploy-production.sh to ship them."
