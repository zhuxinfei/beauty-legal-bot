# China-First Beauty Brief Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Increase useful report volume and Chinese-market coverage while preserving full-text, freshness, beauty relevance, original-link, and deduplication gates.

**Architecture:** Keep the existing collection and full-text evidence pipeline. Add deterministic title-noise rejection before hydration, deterministic China-first candidate batching before AI calls, and a prompt contract that includes factual medium-impact briefs as `watch` rather than dropping them. Keep Chinese display translation separate from immutable evidence URLs and dates.

**Tech Stack:** Node.js ES modules, OpenAI-compatible chat API, DingTalk Markdown webhook, custom `worker/test-runner.js` suite.

---

### Task 1: Reject non-news entry titles

**Files:**
- Modify: `worker/index.js`
- Test: `worker/test-runner.js`

- [ ] Add failing assertions that `欢迎访问中华商标网`, `网站首页`, `登录`, and `站点导航` are not relevant titles while a concrete trademark/cosmetics notice remains relevant.
- [ ] Run `node worker/test-runner.js` and confirm the new assertions fail before implementation.
- [ ] Add an exported entry-title predicate and call it before keyword relevance checks and detail hydration.
- [ ] Run the full test suite and confirm the title tests pass.

### Task 2: Prioritize Chinese evidence inside AI batches

**Files:**
- Modify: `worker/index.js`
- Test: `worker/test-runner.js`

- [ ] Add a failing test where a medium-priority Chinese candidate must sort ahead of a high-priority overseas candidate.
- [ ] Add `prioritizeCandidatesForAnalysis()` and use it before splitting each module into four-candidate batches.
- [ ] Add batch audit fields for Chinese/overseas input, included, and excluded counts.
- [ ] Run the full test suite and verify existing no-limit and deduplication tests still pass.

### Task 3: Include useful medium-impact briefs

**Files:**
- Modify: `worker/index.js`
- Test: `worker/test-runner.js`

- [ ] Add prompt assertions requiring all full-text, fresh, beauty-relevant factual items to be included even when not major.
- [ ] Require lower-impact but concrete information to use `report_tier=watch`; continue rejecting generic, homepage-only, stale, duplicated, and non-beauty content.
- [ ] Give Chinese candidates equal quality thresholds but prevent overseas impact from displacing qualified Chinese items.
- [ ] Run the full test suite.

### Task 4: Chinese display translation

**Files:**
- Modify: `worker/index.js`
- Test: `worker/test-runner.js`

- [ ] Require `display_title_zh`/`source_name_zh` plus Chinese fact summaries and observations in primary and rescue prompts.
- [ ] Use translated display strings while locking source URL, market, and dates to fetched evidence.
- [ ] Keep brand names, agency abbreviations, regulation numbers, product names, and URLs in their original form where useful.
- [ ] Run `node worker/test-runner.js`, `node --check worker/index.js`, and `git diff --check`.

### Task 5: Remote test delivery

**Files:**
- Verify: `.github/workflows/weekly.yml`

- [ ] Commit and push `codex/schedule-test` without changing the DingTalk secret.
- [ ] Trigger `Beauty Legal Weekly Report` with `workflow_dispatch` on `codex/schedule-test`.
- [ ] Verify full-text counts, China/overseas batch counts, final accepted count, and `DingTalk 1/1` in Actions logs.
- [ ] Do not call the formal webhook without explicit user approval.
