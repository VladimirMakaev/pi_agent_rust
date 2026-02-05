#!/bin/bash
# Example: Orchestrating 3 scout subagents in parallel with proper workspace setup
#
# This script demonstrates:
# 1. Creating formal workspaces with plan.md and logging-protocol.md
# 2. Spawning non-blocking (background) subagents
# 3. Waiting for completion
# 4. Collecting results

set -e

TASK_ROOT="./research_task"
SKILL_DIR="$HOME/.claude/skills/pi-subagent-orchestration/references"

# ============================================================================
# SETUP
# ============================================================================

echo "=== Setting up orchestration workspace ==="

# Create directory structure
mkdir -p "$TASK_ROOT"/{orchestrator,agents/{scout1,scout2,scout3}/{workspace,output},results}

# Copy logging protocol to each agent workspace
for agent in scout1 scout2 scout3; do
  cp "$SKILL_DIR/logging-protocol.md" "$TASK_ROOT/agents/$agent/"
done

# Record orchestrator decisions
cat > "$TASK_ROOT/orchestrator/decisions.md" << 'EOF'
# Orchestration Decisions

## Execution Mode
- Mode: Non-blocking parallel with join
- Rationale: Scouts are independent, can run concurrently

## Environment Strategy  
- Strategy: Separate directories (no git)
- Rationale: Read-only research, no conflicts possible

## Synthesis Strategy
- Strategy: Orchestrator synthesizes
- Rationale: Need unified summary from diverse findings
EOF

# ============================================================================
# WRITE PLANS
# ============================================================================

echo "=== Writing agent plans ==="

# Scout 1: Research frameworks
cat > "$TASK_ROOT/agents/scout1/plan.md" << 'EOF'
# Plan: Research AI Agent Frameworks

## Agent
- Name: scout1
- Role: scout
- Model: claude-haiku-4-5
- Tools: browser, bash, read, write

## Objective
Research major AI agent frameworks in 2025-2026, documenting capabilities and adoption.

## Scope
### In Scope
- LangChain, AutoGPT, CrewAI, similar frameworks
- Current features and capabilities
- Adoption metrics if available

### Out of Scope
- Deep technical implementation details
- Price comparisons
- Benchmarks (scout3 handles this)

## Success Criteria
- [ ] Visited 2-3 authoritative sources
- [ ] Documented at least 4 major frameworks
- [ ] Captured URLs for all sources
- [ ] Summary in output/findings.md

## Steps

### STEP-01: Initial Research
**Objective**: Find and visit authoritative sources on AI agent frameworks
**Target**: Web search, documentation sites
**Actions**:
1. Search for "AI agent frameworks 2025"
2. Visit top 2-3 results
3. Extract framework names and key features
**Success criteria**: Have list of 4+ frameworks with sources
**Output**: Raw notes in log.md

### STEP-02: Deep Dive
**Objective**: Get details on top frameworks
**Target**: Official docs or reputable reviews
**Actions**:
1. For each framework, note: name, purpose, key features, adoption signals
2. Capture direct quotes where useful
**Success criteria**: Detailed notes on each framework
**Output**: Structured findings

### STEP-03: Final Output
**Objective**: Compile deliverables
**Actions**:
1. Write output/findings.md with structured summary
2. Include all source URLs
3. Ensure log.md is complete
**Output**: output/findings.md

## Logging Requirements
READ `logging-protocol.md` BEFORE STARTING.
Maintain append-only `log.md`. NEVER edit previous entries.
EOF

# Scout 2: Research use cases (similar structure, different focus)
cat > "$TASK_ROOT/agents/scout2/plan.md" << 'EOF'
# Plan: Research AI Agent Use Cases

## Agent
- Name: scout2
- Role: scout
- Model: claude-haiku-4-5
- Tools: browser, bash, read, write

## Objective
Research real production use cases of AI agents in 2025-2026.

## Scope
### In Scope
- Case studies of companies using AI agents
- Production deployments
- Real-world applications

### Out of Scope
- Framework comparisons (scout1 handles)
- Benchmarks (scout3 handles)
- Theoretical capabilities

## Success Criteria
- [ ] Found 3-5 real use cases
- [ ] Each with company name and application
- [ ] Source URLs documented
- [ ] Summary in output/findings.md

## Steps

### STEP-01: Find Case Studies
**Objective**: Locate real production use cases
**Actions**:
1. Search for "AI agents production use cases 2025"
2. Visit enterprise blogs, case studies
**Output**: List of use cases

### STEP-02: Document Details
**Objective**: Get specifics on each use case
**Actions**:
1. For each: company, application, results, scale
**Output**: Detailed notes

### STEP-03: Final Output
**Actions**:
1. Write output/findings.md
2. Complete log.md

## Logging Requirements
READ `logging-protocol.md`. Maintain append-only `log.md`.
EOF

# Scout 3: Research benchmarks
cat > "$TASK_ROOT/agents/scout3/plan.md" << 'EOF'
# Plan: Research AI Agent Benchmarks

## Agent
- Name: scout3
- Role: scout
- Model: claude-haiku-4-5
- Tools: browser, bash, read, write

## Objective
Research AI agent benchmarks and evaluation methods in 2025-2026.

## Scope
### In Scope
- Benchmark suites for AI agents
- Evaluation methodologies
- Performance metrics

### Out of Scope
- Framework features (scout1)
- Use cases (scout2)

## Success Criteria
- [ ] Found 2-3 benchmark approaches
- [ ] Documented evaluation methods
- [ ] Source URLs included
- [ ] Summary in output/findings.md

## Steps

### STEP-01: Find Benchmarks
**Objective**: Locate agent benchmark information
**Actions**:
1. Search for "AI agent benchmarks evaluation 2025"
2. Visit academic or industry sources
**Output**: List of benchmarks

### STEP-02: Document Methods
**Objective**: Detail evaluation approaches
**Actions**:
1. For each: name, what it measures, methodology
**Output**: Structured notes

### STEP-03: Final Output
**Actions**:
1. Write output/findings.md
2. Complete log.md

## Logging Requirements
READ `logging-protocol.md`. Maintain append-only `log.md`.
EOF

# ============================================================================
# SPAWN AGENTS
# ============================================================================

echo "=== Spawning subagents ==="

# Initialize orchestrator log
cat > "$TASK_ROOT/orchestrator/log.md" << EOF
# Orchestrator Log

## STEP-01: Spawn Research Scouts
### Pre-Execution
Objective: Launch 3 scouts in parallel for comprehensive research
Agents: scout1 (frameworks), scout2 (use cases), scout3 (benchmarks)
Mode: Non-blocking parallel

### Execution
$(date "+%Y-%m-%d %H:%M:%S") - Spawning agents...
EOF

# Spawn each agent
for agent in scout1 scout2 scout3; do
  echo "Spawning $agent..."
  (
    cd "$TASK_ROOT/agents/$agent"
    pi \
      --model claude-haiku-4-5 \
      --tools browser,bash,read,write \
      --max-turns 15 \
      --no-input \
      --print-last \
      "You are a research scout. 
      
FIRST: Read logging-protocol.md completely.
THEN: Read plan.md completely.
THEN: Execute the plan step by step.

Create log.md and maintain it as append-only throughout execution.
Write final output to output/findings.md.

BEGIN." \
      2>&1 | tee output/run.log
  ) &
  echo $! > "$TASK_ROOT/agents/$agent/pid"
  echo "  PID: $(cat "$TASK_ROOT/agents/$agent/pid")"
  
  # Log to orchestrator
  echo "- $agent spawned, PID=$(cat "$TASK_ROOT/agents/$agent/pid")" >> "$TASK_ROOT/orchestrator/log.md"
done

echo ""
echo "=== All agents spawned ==="
echo "PIDs:"
for agent in scout1 scout2 scout3; do
  echo "  $agent: $(cat "$TASK_ROOT/agents/$agent/pid")"
done

# ============================================================================
# WAIT FOR COMPLETION
# ============================================================================

echo ""
echo "=== Waiting for agents to complete ==="

for agent in scout1 scout2 scout3; do
  pid=$(cat "$TASK_ROOT/agents/$agent/pid")
  echo "Waiting for $agent (PID $pid)..."
  wait $pid
  exit_code=$?
  echo "  $agent completed with exit code $exit_code"
  echo "- $agent completed, exit=$exit_code" >> "$TASK_ROOT/orchestrator/log.md"
done

# Complete orchestrator step
cat >> "$TASK_ROOT/orchestrator/log.md" << EOF

### Post-Execution
Outcome: PASS - all agents completed
$(date "+%Y-%m-%d %H:%M:%S") - Ready for synthesis

---

## STEP-02: Synthesize Results
### Pre-Execution
Objective: Combine findings from all scouts
EOF

# ============================================================================
# COLLECT RESULTS
# ============================================================================

echo ""
echo "=== Collecting results ==="

# Copy outputs to results directory
for agent in scout1 scout2 scout3; do
  if [ -f "$TASK_ROOT/agents/$agent/output/findings.md" ]; then
    cp "$TASK_ROOT/agents/$agent/output/findings.md" "$TASK_ROOT/results/${agent}_findings.md"
    echo "Collected $agent findings"
  else
    echo "WARNING: $agent did not produce findings.md"
  fi
done

echo ""
echo "=== Orchestration complete ==="
echo "Results in: $TASK_ROOT/results/"
echo "Agent logs in: $TASK_ROOT/agents/*/log.md"
echo "Orchestrator log: $TASK_ROOT/orchestrator/log.md"
echo ""
echo "Next step: Synthesize results (manually or spawn synthesis agent)"
