# Logging Protocol

**APPEND-ONLY EXECUTION LOG — MISSION CRITICAL**

You MUST maintain `log.md` as an append-only ledger. Never edit previous entries. Never.

---

## Why Append-Only

- **Multi-agent handoffs**: Next agent reads linearly, no cross-references
- **No cognitive overhead**: Just append, don't restructure
- **History preserved**: What happened at STEP-03 stays at STEP-03, even if wrong
- **Backtracking = new step**: STEP-05 reveals STEP-03 bug? STEP-06 fixes it. Forward only.

---

## The Unit: Before → During → After

Each step is atomic. Three phases. Append to each in order. Move on.

```
STEP-XX
├── Pre-Execution   ← beliefs, assumptions, objectives, hypotheses, questions
├── Execution       ← findings, questions, answers, insights, code snippets, updated beliefs
└── Post-Execution  ← outcomes, belief updates, mark complete
```

Once Post-Execution is written, that step is **SEALED**. Never touch it again.

---

## Log Structure

```markdown
# STATE

## Current
step_id: STEP-XX
status: IN_PROGRESS | COMPLETE
objective: [current objective]

## Decisions (append-only)
- STEP-01: [decision made]
- STEP-04: [decision made]

## Blockers (append-only, mark resolved inline)
- STEP-03: [blocker] → RESOLVED: [how]

---

# STEP LOG (append-only)

## STEP-01
### Pre-Execution
Objective: [what to accomplish]
Target files: [files to examine/modify]
Beliefs: [what I believe to be true]
Assumptions: [what I'm assuming]
Hypotheses: [what I expect to find]
Questions: [what I need to answer]

### Execution
- [x] [action taken]
- [x] [action taken]
- [ ] [action pending]

Finding: [what I discovered]
Answer: [answer to a question]
Snippet:
  ```ts
  // relevant code
  ```
Updated belief: [if changed]

### Post-Execution
Outcome: PASS | PARTIAL | FAIL
Belief updates: [any changed beliefs]
New hypotheses: [if any]

---

## STEP-02
...
```

---

## Backtracking Protocol

**Situation**: At STEP-05, you realize STEP-03 introduced a bug.

**WRONG** ❌:
- Go back to STEP-03
- Edit the findings
- Change the outcome

**RIGHT** ✓:
- Stay at current position
- Create STEP-06: "Fix: [describe STEP-03 issue]"
- In Pre-Execution: "Triggered by: STEP-05 finding that STEP-03 was incomplete"
- Fix forward
- Complete STEP-06
- Move on

The original STEP-03 remains untouched. Historical record.

---

## Rules

| Rule | Description |
|------|-------------|
| Never edit previous steps | History is immutable |
| Forward only | Backtrack = new step that fixes |
| Sealed on Post-Execution | Once written, step is done |
| Decisions append-only | Changed mind? New entry: "Override STEP-03 decision because..." |
| Blockers resolve forward | Don't delete; append "→ RESOLVED: [how]" |

---

## Uncertainty Protocol

When you face uncertainty and must make a decision not in the plan:

1. PAUSE
2. Add to log.md:
   ```
   UNCERTAINTY: [describe the ambiguity]
   OPTIONS:
   - A: [option and tradeoffs]
   - B: [option and tradeoffs]
   DECISION: [chosen option]
   RATIONALE: [why — prefer simplest approach]
   ```
3. Proceed with chosen approach
4. Continue logging

Good engineering is boring and simple. When uncertain, choose the simplest option.

---

## Handoff Protocol

When another agent takes over:

1. They read `log.md` top-to-bottom
2. Find the last sealed step (has Post-Execution)
3. Continue from next step
4. Append their work
5. Pass to next agent

No graph traversal. No cross-references. Linear reading only.
