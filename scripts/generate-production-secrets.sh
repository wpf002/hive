#!/usr/bin/env bash
# Generate production secrets for a Hive deploy.
#
#   ./scripts/generate-production-secrets.sh
#
# Prints shell-export-ready secret assignments to STDOUT and NOTHING to disk.
# The operator copies the values into a password manager and into the
# `flyctl secrets set` commands (or an env file consumed by
# deploy/fly/set-secrets.sh).
#
# SECURITY:
#   - This script never writes to a file. Do not redirect it to one.
#   - After copying the values into your password manager + flyctl, CLEAR YOUR
#     TERMINAL SCROLLBACK:  printf '\033c'   (or close the terminal tab).
#   - Treat every line below as live credential material.
set -euo pipefail

if ! command -v openssl >/dev/null 2>&1; then
  echo "✗ openssl not found — install it (brew install openssl) and retry" >&2
  exit 1
fi

# 32 bytes hex = 64 hex chars. Matches the validators in env.ts / @hive/crypto.
hex32() { openssl rand -hex 32; }
# 24 mixed chars, base64 (URL-safe-ish; strip newline).
pw24() { openssl rand -base64 24 | tr -d '\n'; }

cat <<EOF
# ===========================================================================
# Hive production secrets — generated $(date -u '+%Y-%m-%dT%H:%M:%SZ')
# ===========================================================================
# COPY THESE INTO YOUR PASSWORD MANAGER NOW, then clear your scrollback.
# These are NOT saved anywhere. If you lose them, re-run the affected rotation.
#
# HIVE_SECRETS_KEY rotation requires re-wrapping DEKs — do NOT regenerate it
# casually once data exists (see docs/SECRETS.md + kms:rotate).
# ---------------------------------------------------------------------------

# Master encryption key for bot secrets (field-level AEAD + static KEK).
export HIVE_SECRETS_KEY=$(hex32)

# Static bearer token for /api/* (UI server + CLI/scripts).
export API_AUTH_TOKEN=$(hex32)

# Static bearer token for worker heartbeats.
export WORKER_AUTH_TOKEN=$(hex32)

# Reserved for JWT signing (set on control-plane services).
export JWT_SECRET=$(hex32)

# Session signing/entropy seed (set on control-plane services).
export SESSION_SECRET=$(hex32)

# Initial admin password. Change it after first login via /account/password.
export ADMIN_PASSWORD='$(pw24)'

# ---------------------------------------------------------------------------
# Reminders:
#   1) Paste each value into 1Password / Bitwarden.
#   2) Feed them to deploy/fly/set-secrets.sh via a gitignored env file, OR
#      paste directly into flyctl secrets set commands.
#   3) Run:  printf '\033c'   to wipe this output from your terminal.
# ===========================================================================
EOF
