#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
ARTIFACT_DIR="${E2E_ARTIFACT_DIR:-$PROJECT_ROOT/tests/e2e_results/runtime-risk-telemetry/$STAMP}"
mkdir -p "$ARTIFACT_DIR"

export CI_CORRELATION_ID="${CI_CORRELATION_ID:-runtime-risk-telemetry-$STAMP}"
export TEST_LOG_JSONL_PATH="$ARTIFACT_DIR/test-log.jsonl"
export TEST_ARTIFACT_INDEX_PATH="$ARTIFACT_DIR/artifact-index.jsonl"

cargo test --test e2e_runtime_risk_telemetry -- --nocapture

echo "Runtime-risk telemetry E2E completed"
echo "Artifacts: $ARTIFACT_DIR"
