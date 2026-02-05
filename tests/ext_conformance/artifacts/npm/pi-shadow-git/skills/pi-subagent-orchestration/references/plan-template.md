# Plan: {TASK_NAME}

## Agent
- Name: {AGENT_NAME}
- Role: {scout|planner|worker|reviewer|synthesizer}
- Model: {MODEL}
- Tools: {TOOLS}

## Objective
{One sentence describing what this agent must accomplish. Be specific and measurable.}

## Scope
### In Scope
- {Explicit boundary 1}
- {Explicit boundary 2}

### Out of Scope
- {What this agent should NOT do}
- {Adjacent work to flag for orchestrator}

## Success Criteria
- [ ] {Measurable criterion 1}
- [ ] {Measurable criterion 2}
- [ ] {Measurable criterion 3}

---

## Steps

### STEP-01: {Title}
**Objective**: {What to accomplish in this step}
**Target**: {Files, URLs, or resources to examine/modify}
**Actions**:
1. {Specific action}
2. {Specific action}
**Success criteria**: {How to know this step is done}
**Output**: {What this step produces}

### STEP-02: {Title}
**Objective**: {What to accomplish}
**Target**: {Files/resources}
**Actions**:
1. {Specific action}
2. {Specific action}
**Success criteria**: {How to know done}
**Output**: {What this produces}

### STEP-03: {Title}
...

### STEP-NN: Final Output
**Objective**: Compile deliverables and signal completion
**Actions**:
1. Compile all findings/work into `output/` directory
2. Ensure `log.md` has Post-Execution for all steps
3. Write `output/summary.md` with key results
4. Signal completion to orchestrator

---

## Dependencies
### Requires (inputs)
- {Input from another agent or orchestrator}
- {File or resource that must exist}

### Blocks (outputs needed by)
- {What depends on this agent's completion}

---

## Boundaries
- Do NOT exceed scope — flag adjacent findings for orchestrator
- Do NOT make implementation decisions outside this plan — log ambiguity, choose simplest
- All outputs MUST go to `output/` directory
- If blocked, log the blocker and continue with other steps if possible

---

## Logging Requirements

**READ `logging-protocol.md` BEFORE STARTING.**

Maintain append-only `log.md` with:
- Pre-Execution: objective, beliefs, assumptions, hypotheses, questions
- Execution: findings, progress, snippets, updated beliefs
- Post-Execution: outcome (PASS/PARTIAL/FAIL), belief updates

**NEVER edit previous log entries. Fix forward only.**
