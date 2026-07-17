# DingTalk Editorial Legal Intelligence Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one leadership-ready DingTalk legal-intelligence card with a high-resolution editorial long image, clickable sources, and a complete text fallback.

**Architecture:** Add a pure editorial model between AI output and presentation. Both the Markdown renderer and a Node-only Playwright image renderer consume that model. The pipeline treats image rendering/publication as optional and always retains a one-message Markdown fallback.

**Tech Stack:** Node.js 22, ECMAScript modules, Cloudflare Worker/KV, Playwright Chromium, DingTalk Markdown webhook, existing pure-function test runner.

---

## File Map

- Create `worker/editorial-report.js`: normalize, deduplicate, order, and preserve type-specific legal detail.
- Create `worker/editorial-report-image.js`: pure HTML/CSS document builder for the long report image.
- Create `scripts/render-editorial-report-png.js`: Playwright screenshot helper and CLI fixture renderer.
- Modify `worker/dingtalk-single-card.js`: hybrid card plus complete Markdown fallback and source index.
- Modify `worker/cloudflare-assets.js`: publish a named versioned PNG asset instead of a dashboard-only asset.
- Modify `worker/index.js`: optional editorial-image stage, new asset route, and one-card delivery wiring.
- Modify `worker/run-local.js`: render and publish the long image without making it a delivery prerequisite.
- Modify `worker/test-runner.js`: regression, integration, publication, and fallback tests.
- Modify `.github/workflows/weekly.yml`, `README.md`, and `docs/DINGTALK_SETUP.md`: describe the final production path.

### Task 1: Freeze The Editorial Contract

- [ ] Add a failing test showing regulation, case, watch, action, source, and statutory-date fields survive normalization.
- [ ] Add failing tests for global China-first ordering and within-report deduplication.
- [ ] Run `node worker/test-runner.js` and confirm the new assertions fail because the editorial builder does not exist.
- [ ] Implement `buildEditorialReport(report)` as a pure function.
- [ ] Re-run `node worker/test-runner.js` and require the editorial tests to pass.

### Task 2: Rebuild The One-Card Renderer

- [ ] Add failing tests proving the card has management conclusions, one image, a matching source index, and no action dashboard.
- [ ] Add a failing test proving four or more watch items are retained.
- [ ] Add a failing test proving the no-image fallback preserves type-specific detail and stays within the byte budget.
- [ ] Implement hybrid and fallback rendering in `worker/dingtalk-single-card.js`.
- [ ] Re-run the focused test runner and require one-card, ordering, source, and byte-budget assertions to pass.

### Task 3: Render The Editorial Long Image

- [ ] Add failing HTML tests for 1080-pixel layout, minimum body size, active modules, item numbering, conclusion band, and absence of telemetry/dashboard wording.
- [ ] Implement the pure HTML/CSS builder.
- [ ] Implement the Playwright PNG renderer with full-page capture and Chinese font readiness.
- [ ] Render 8-, 10-, and 12-item fixtures to `out/`.
- [ ] Use Sharp metadata and image inspection to verify width, nonblank pixels, dynamic height, and no clipping or overlap.

### Task 4: Publish Without Making The Image A Single Point Of Failure

- [ ] Add failing tests for named asset keys, versioned URLs, health checks, and retry behavior.
- [ ] Generalize `publishVersionedPng` with an `assetName` option while preserving decision-map compatibility until callers migrate.
- [ ] Add an editorial-report PNG route backed by dated and latest KV keys.
- [ ] Add pipeline tests showing image success uses the hybrid card and image failure uses the full Markdown fallback.
- [ ] Ensure both paths send exactly one DingTalk message and only successful delivery updates dedupe state.

### Task 5: Remove The Action Dashboard Path

- [ ] Replace dashboard creation/publication wiring with editorial-image wiring.
- [ ] Remove dashboard expectations from tests and documentation.
- [ ] Keep legacy asset routes only if required for backward compatibility; they must not be used by the weekly report.
- [ ] Update workflow defaults and local output filenames.

### Task 6: Verify The Finished Chain

- [ ] Run `node worker/test-runner.js` and require exit code 0.
- [ ] Run `node --check` on every changed JavaScript module.
- [ ] Render the 12-item fixture and verify PNG metadata and visible layout.
- [ ] Search the generated card and image HTML for forbidden telemetry and `行动看板`.
- [ ] Confirm `git diff --check` exits 0 and review the full diff against the design acceptance criteria.
- [ ] Run one formal GitHub Actions workflow after the code is available on GitHub, then verify collection audit, AI admission, image publication or fallback, and DingTalk `1/1` delivery.
