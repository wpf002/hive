#!/bin/bash
# Install Python deps for each Python worker pool
set -e

PYTHON_POOLS=(base browser scraper rpa_desktop discord telegram monitor ci_agent task_runner)
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
done

echo "✓ All Python workers installed"
