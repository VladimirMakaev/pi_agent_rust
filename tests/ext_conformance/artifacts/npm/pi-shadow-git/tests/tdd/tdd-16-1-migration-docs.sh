#!/bin/bash
# TDD-16-1: Migration should be documented
set -e
REPO_ROOT="${REPO_ROOT:-/tmp/pi-hook-logging-shitty-state}"

if grep -qi "migration\|migrate\|upgrade" "$REPO_ROOT/README.md"; then
  echo "PASS: Migration documented"
  exit 0
else
  echo "FAIL: Migration not documented"
  exit 1
fi
