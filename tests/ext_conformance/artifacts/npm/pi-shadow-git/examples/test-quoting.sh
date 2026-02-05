#!/bin/bash
#
# Test that shell quoting works correctly in spawn script
#
# This test verifies that:
# 1. Arguments are not split incorrectly
# 2. Only one session_start event occurs
# 3. Prompts with spaces and special chars work
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_WORKSPACE="/tmp/pi-hook-test-$$"

cleanup() {
    echo "Cleaning up..."
    tmux kill-session -t test-quoting 2>/dev/null || true
    rm -rf "$TEST_WORKSPACE"
}

trap cleanup EXIT

echo "=== Testing Shell Quoting ==="
echo "Workspace: $TEST_WORKSPACE"
echo ""

# Create workspace
mkdir -p "$TEST_WORKSPACE"

# Test with a prompt containing spaces
PROMPT="This is a test prompt with spaces and numbers like 30"

echo "Spawning agent with prompt: $PROMPT"
"$SCRIPT_DIR/spawn-with-logging.sh" "$TEST_WORKSPACE" "test-quoting" "$PROMPT"

echo ""
echo "Waiting for agent to start..."
sleep 5

# Check audit log
AUDIT_FILE="$TEST_WORKSPACE/agents/test-quoting/audit.jsonl"

if [ ! -f "$AUDIT_FILE" ]; then
    echo "FAIL: Audit file not created"
    exit 1
fi

STARTS=$(grep -c '"event":"session_start"' "$AUDIT_FILE" 2>/dev/null || echo 0)
echo "session_start events: $STARTS"

if [ "$STARTS" -eq 1 ]; then
    echo "PASS: Single session_start (no argument splitting)"
else
    echo "FAIL: Expected 1 session_start, got $STARTS"
    echo ""
    echo "Audit log contents:"
    cat "$AUDIT_FILE"
    exit 1
fi

# Kill the agent (don't wait for completion)
tmux kill-session -t test-quoting 2>/dev/null || true

echo ""
echo "=== Test Passed ==="
