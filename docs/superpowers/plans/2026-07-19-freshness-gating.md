# Freshness Gating Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce reliable seven-day freshness gating with explicit, auditable historical exceptions.

**Architecture:** A shared pure freshness classifier is applied before analysis and again after AI output. Report quality curation rejects stale items unless structured exception evidence exists, while missing dates are limited to watch. Existing report rendering remains unchanged except for freshness labels.

**Tech Stack:** Node.js ES modules, built-in `node:test` assertions via `worker/test-runner.js`.

---

### Task 1: Add failing freshness tests

**Files:**
- Modify: `worker/test-runner.js`

- [ ] Add tests for seven-day boundary, stale ordinary item rejection, future deadline exception, ongoing recall exception, current-week update, and unknown-date watch-only behavior.
- [ ] Run `node worker/test-runner.js`; confirm the new tests fail because no classifier/gate exists.

### Task 2: Implement shared candidate freshness gate

**Files:**
- Modify: `worker/index.js`

- [ ] Add exported pure functions `classifyFreshness` and `filterCandidatesByFreshness` with a supplied reference date.
- [ ] Preserve candidates only when fresh or carrying a structured historical exception; attach `freshness_status` and `freshness_exception`.
- [ ] Use the filtered candidates before AI analysis and include the rules in the prompt.

### Task 3: Enforce report-layer gate

**Files:**
- Modify: `worker/report-quality.js`
- Modify: `worker/index.js`

- [ ] Add a deterministic report classifier that rejects stale items without exception evidence and downgrades unknown-date items to watch.
- [ ] Include freshness rejection counts in the existing audit.
- [ ] Add prompt fields and validation for exception evidence and display status.

### Task 4: Verify and publish test delivery

**Files:**
- Modify: `.github/workflows/weekly.yml` only if needed to prevent accidental formal delivery.

- [ ] Run `node worker/test-runner.js` and any focused tests.
- [ ] Run one pipeline using the test webhook only; verify stale filtering, exception labels, and DingTalk 1/1.
- [ ] Report the test delivery result and wait for explicit approval before restoring/using the formal webhook.
