#!/usr/bin/env bash
# Install Hive git hooks. Idempotent — re-running is safe.
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HOOKS_SRC="${ROOT_DIR}/scripts/git-hooks"
HOOKS_DEST="${ROOT_DIR}/.git/hooks"

if [ ! -d "${ROOT_DIR}/.git" ]; then
  echo "✗ not a git repo (no .git/ at ${ROOT_DIR})"
  exit 1
fi

for hook in "${HOOKS_SRC}"/*; do
  [ -f "$hook" ] || continue
  name=$(basename "$hook")
  cp "$hook" "${HOOKS_DEST}/${name}"
  chmod +x "${HOOKS_DEST}/${name}"
  echo "✓ installed ${name}"
done

echo "✓ git hooks installed in .git/hooks/"
