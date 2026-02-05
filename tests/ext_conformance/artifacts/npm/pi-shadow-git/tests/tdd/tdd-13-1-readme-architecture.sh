#!/bin/bash
# TDD-13-1: README should document new architecture
set -e
REPO_ROOT="${REPO_ROOT:-/tmp/pi-hook-logging-shitty-state}"

if grep -q "per-agent" "$REPO_ROOT/README.md" && grep -qi "per.turn\|turn-level\|Turn-level" "$REPO_ROOT/README.md"; then
  echo "PASS: README documents new architecture"
  exit 0
else
  echo "FAIL: README missing architecture docs"
  exit 1
fi
