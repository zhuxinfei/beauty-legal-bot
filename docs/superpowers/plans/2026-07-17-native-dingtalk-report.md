# Native DingTalk Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make one complete, copyable DingTalk Markdown report the only delivery format, with clickable source links and no editorial image dependency.

**Architecture:** Keep the existing report curation, China-first ordering, deduplication, byte budgeting, and DingTalk retry path. Remove the image-vs-fallback rendering branch so every report uses the same native Markdown body, and stop invoking image render/publication hooks in the pipeline.

**Tech Stack:** Node.js 22, Cloudflare Worker APIs, DingTalk robot Markdown, built-in assertion test runner.

---

### Task 1: Lock the native Markdown contract with failing tests

**Files:**
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Replace the image-card assertion with a native-body assertion**

Call `buildSingleDingTalkMessage(sampleReport, { imageUrl: 'https://worker.test/legacy.png' })` and assert that the result contains `## 资讯正文`, type-specific legal detail, and clickable source links, while excluding `![美妆法务资讯长图]`, `查看高清原图`, and `## 来源索引`.

- [ ] **Step 2: Change the pipeline image test into a no-image-hook test**

Provide `CREATE_EDITORIAL_REPORT_PNG` and `PUBLISH_EDITORIAL_REPORT` spies that throw if called. Assert the DingTalk payload contains the complete native body and that the call sequence is exactly `send-dingtalk`, then `mark-seen`.

- [ ] **Step 3: Run the tests and verify the new contract fails**

Run: `node worker/test-runner.js`

Expected: failure because the current implementation still chooses the image/source-index branch and invokes the image hooks.

### Task 2: Make native Markdown the only report path

**Files:**
- Modify: `worker/dingtalk-single-card.js`
- Modify: `worker/index.js`
- Modify: `worker/run-local.js`

- [ ] **Step 1: Remove the image branch from the message builder**

Make `renderMessage` always append `renderFallbackBody(editorial, tiers, removed)`. Keep management summary, final synthesis, source links, byte compaction, empty-report handling, China-first omission order, and the single-message return shape unchanged.

- [ ] **Step 2: Stop rendering and publishing editorial images in both pipeline paths**

In `runPipeline` and `runFinalizePhase`, build Markdown directly with `buildSingleDingTalkMessage(report)`, pass no `EDITORIAL_REPORT_URL`, and update stage logging to describe native Markdown generation.

- [ ] **Step 3: Remove unused image setup from the local runner**

Delete the editorial renderer/publication imports, the `CREATE_EDITORIAL_REPORT_PNG` and `PUBLISH_EDITORIAL_REPORT` assignments, and the generated PNG output handling. Preserve Playwright Chromium because source recovery still depends on it.

- [ ] **Step 4: Run the test suite**

Run: `node worker/test-runner.js`

Expected: all tests pass.

### Task 3: Verify delivery constraints and repository integrity

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Update the delivery documentation**

Document that the production output is one native Markdown message, all text is copyable, sources are clickable, and low-priority items are compacted only when the byte budget requires it. Remove instructions that describe PNG publication as part of the delivery sequence.

- [ ] **Step 2: Run syntax and behavior verification**

Run: `node --check worker/index.js`

Expected: exit code 0.

Run: `node --check worker/dingtalk-single-card.js`

Expected: exit code 0.

Run: `node worker/test-runner.js`

Expected: all tests pass with zero failures.

- [ ] **Step 3: Commit the implementation**

Stage only the native Markdown implementation, tests, and documentation. Commit with message `feat: deliver native dingtalk markdown report`.

