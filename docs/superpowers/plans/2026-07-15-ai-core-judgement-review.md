# AI Core Judgement Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Generate an explicit evidence-aware `core_judgement`, review it without adding a new pipeline failure mode, remove AI-generated internal deadlines, and run the pipeline with `gpt-5.6-sol`.

**Architecture:** Keep the existing single-file AI boundary in `worker/index.js`. Add a focused review prompt and reviewer function after the first validated AI result; only accept a reviewed report after the same quality and schema validation, otherwise retain the first result. Keep the DingTalk renderer backward compatible while requiring the new field for newly validated reports.

**Tech Stack:** Cloudflare Worker JavaScript, OpenAI-compatible chat completions, Node.js assertions, GitHub Actions, Wrangler.

---

### Task 1: Define The New Report Contract

**Files:**
- Modify: `worker/test-runner.js`
- Modify: `worker/sample-report.json`
- Modify: `worker/index.js`

- [x] **Step 1: Write the failing schema and prompt tests**

Add assertions that deleting `core_judgement` makes `validateReport` fail, and that `buildAnalysisPrompt` contains the field plus the internal-time prohibition while retaining statutory date fields.

- [x] **Step 2: Run the worker tests and confirm RED**

Run: `node worker/test-runner.js`

Expected: failure because `core_judgement` is not required and the prompt does not contain the new rules.

- [x] **Step 3: Implement the minimal report contract**

Add `core_judgement` to required fields and the output schema. Change the action instruction from “who does what by when” to “which team does what”, explicitly prohibit invented internal deadlines, and retain `effective_date`, `feedback_deadline`, and `next_deadline` for source-backed dates.

- [x] **Step 4: Update the fixture and run tests GREEN**

Add concise `core_judgement` values to each fixture item and run `node worker/test-runner.js`.

### Task 2: Make The Card Use The Explicit Judgement

**Files:**
- Modify: `worker/test-runner.js`
- Modify: `worker/dingtalk-single-card.js`

- [x] **Step 1: Write the failing renderer test**

Set `core_judgement` to a unique sentence while leaving `what_changed` populated, then assert the DingTalk Markdown shows the unique sentence as “核心判断”.

- [x] **Step 2: Run the test and confirm RED**

Run: `node worker/test-runner.js`

Expected: failure because `itemJudgement` currently selects `what_changed` first.

- [x] **Step 3: Implement the renderer priority**

Place `item.core_judgement` first in `itemJudgement`. Keep the existing fields as fallbacks so historical reports remain renderable.

- [x] **Step 4: Run the tests GREEN**

Run: `node worker/test-runner.js`

### Task 3: Add A Resilient Evidence Review Pass

**Files:**
- Modify: `worker/test-runner.js`
- Modify: `worker/index.js`

- [x] **Step 1: Write failing review success and fallback tests**

Test a two-response AI stub where the second valid response replaces `core_judgement`. Test reviewer network failure and malformed JSON, asserting the first validated report is returned.

- [x] **Step 2: Run the tests and confirm RED**

Run: `node worker/test-runner.js`

Expected: failure because the current analysis path makes no review request.

- [x] **Step 3: Implement evidence selection and review**

Build review evidence only from candidate URLs referenced by the draft. Ask the reviewer to correct or remove unsupported claims, forbid new items and internal dates, and return JSON. Accept only a parsed, quality-filtered, validated result; catch reviewer errors, log one warning, and return the original draft.

- [x] **Step 4: Run the tests GREEN**

Run: `node worker/test-runner.js`

### Task 4: Switch The Model Defaults

**Files:**
- Modify: `worker/test-runner.js`
- Modify: `worker/index.js`
- Modify: `worker/run-local.js`
- Modify: `worker/wrangler.toml`
- Modify: `.github/workflows/weekly.yml`
- Modify: `README.md`

- [x] **Step 1: Write the failing request-body test**

Call `requestAiChat` with `gpt-5.6-sol` and assert the body contains the requested model and `reasoning_effort: "high"`.

- [x] **Step 2: Run the test and confirm RED**

Run: `node worker/test-runner.js`

Expected: failure because `gpt-5.6-sol` does not yet receive high reasoning effort.

- [x] **Step 3: Update code and checked-in configuration**

Use `gpt-5.6-sol` as the default in the request boundary, both pipeline entry points, local runner, Wrangler variables, GitHub Actions environment, and README example. Enable high reasoning effort for the Sol model and remove the deprecated `deepseek-v4-pro` and `DEEPSEEK_*` compatibility paths.

- [x] **Step 4: Run the tests GREEN**

Run: `node worker/test-runner.js`

### Task 5: Full Verification

**Files:**
- Verify all modified files

- [x] **Step 1: Run full behavior tests**

Run: `node worker/test-runner.js`

Expected final line: `worker pure function tests ok`.

- [x] **Step 2: Run syntax and whitespace checks**

Run: `node --check worker/index.js`

Run: `node --check worker/dingtalk-single-card.js`

Run: `git diff --check`

- [x] **Step 3: Inspect the final diff**

Confirm source collection, coverage gates, China-first ordering, statutory dates, one-card byte limits, scheduling, and webhook configuration are unchanged.

- [x] **Step 4: Commit and synchronize**

Commit the implementation with a focused message and synchronize the changed files to `codex/dingtalk-webhook-reliability` without triggering the weekly workflow or DingTalk delivery.
