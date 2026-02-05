#!/bin/bash
# TDD-07-1: Mission Control should read manifest.json if it exists
set -e

# Check if mission-control.ts reads manifest
MC_FILE="${MC_FILE:-/tmp/pi-hook-logging-shitty-state/src/mission-control.ts}"

if grep -q "manifest" "$MC_FILE"; then
  echo "PASS: Mission Control references manifest"
  exit 0
else
  echo "FAIL: Mission Control doesn't use manifest"
  exit 1
fi
