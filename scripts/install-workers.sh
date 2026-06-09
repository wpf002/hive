#!/bin/bash
# Install Python deps for each Python worker pool
set -e

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

for pool in "${PYTHON_POOLS[@]}"; do
  echo "📦 Installing workers/${pool}..."
  cd "${ROOT_DIR}/workers/${pool}"
  python3 -m venv .venv
  ./.venv/bin/pip install --upgrade pip
  if [ "$pool" != "base" ]; then
    ./.venv/bin/pip install -e "${ROOT_DIR}/workers/base"
  fi
  ./.venv/bin/pip install -e .

  # Phase 4b: the browser pool needs Playwright's Chromium build.
  if [ "$pool" = "browser" ]; then
    echo "  ↪ playwright install chromium (this can take a minute)"
    ./.venv/bin/python -m playwright install chromium
  fi
done

echo "✓ All Python workers installed"
