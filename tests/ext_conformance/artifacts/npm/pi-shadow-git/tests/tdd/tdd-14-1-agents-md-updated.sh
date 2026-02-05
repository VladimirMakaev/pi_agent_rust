#!/bin/bash
# TDD-14-1: AGENTS.md should document workspace structure
set -e
REPO_ROOT="${REPO_ROOT:-/tmp/pi-hook-logging-shitty-state}"

if grep -q "agents/{name}/.git" "$REPO_ROOT/AGENTS.md" || grep -q "per-agent" "$REPO_ROOT/AGENTS.md"; then
  echo "PASS: AGENTS.md documents workspace structure"
  exit 0
else
  echo "FAIL: AGENTS.md missing workspace docs"
  exit 1
fi
