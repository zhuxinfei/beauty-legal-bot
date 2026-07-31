# Premium Seed Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent formal quality runs from stopping after the initial hard-fact cards while preserving those cards in the final premium delivery.

**Architecture:** Keep the existing common premium delivery builder and candidate merge. Change only the direct-mode decision so that direct delivery requires explicit opt-in; normal quality mode proceeds to AI analysis and then passes the same hard-fact candidates into the common final builder.

**Tech Stack:** Node.js ES modules, existing pure-function tests, GitHub Actions workflow.

---

### Task 1: Lock Direct-Mode Semantics

**Files:**
- Modify: `worker/index.js`
- Test: `worker/test-runner.js`

- [ ] Add a failing source-level regression assertion that quality mode cannot implicitly enable direct delivery and explicit `HARD_FACT_DIRECT_DELIVERY=1` remains supported.
- [ ] Run `node worker/test-runner.js` and confirm the new assertion fails on the current implicit quality-mode expression.
- [ ] Change direct mode to `env.HARD_FACT_DIRECT_DELIVERY === '1'`.
- [ ] Update the stale policy-card fixture with a concrete `product_or_batch`, keeping the stricter production rule intact.
- [ ] Run `node worker/test-runner.js` and confirm the complete suite passes.

### Task 2: Verify Premium Output Contract

**Files:**
- Test: `worker/premium-hardfacts.test.js`
- Test: `worker/test-runner.js`

- [ ] Run `node worker/premium-hardfacts.test.js`.
- [ ] Run syntax checks for modified JavaScript files and `git diff --check`.
- [ ] Inspect the diff to confirm no quality gate or source rule was relaxed.

### Task 3: Publish For Manual Formal Run

**Files:**
- Modify: none beyond Tasks 1 and 2.

- [ ] Commit only the design, plan, implementation, and tests.
- [ ] Push `codex/content-quality-runtime`.
- [ ] Report the exact commit SHA for the user's manual workflow trigger.

