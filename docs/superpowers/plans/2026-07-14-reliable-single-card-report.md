# Reliable Single-Card Weekly Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a source-recovering weekly pipeline that publishes a readable Chinese action dashboard first and then sends exactly one DingTalk Markdown report within 18,000 UTF-8 bytes.

**Architecture:** Keep `worker/index.js` as the pipeline entry point, but move recovery orchestration, single-card rendering, and dashboard SVG generation into focused pure modules. The Node-only GitHub Actions runtime supplies Playwright browser recovery and Cloudflare KV asset publishing through injected callbacks, so the Cloudflare Worker bundle never imports Playwright. Delivery remains transactional: coverage gate, report validation, versioned image publication, image health check, one webhook send, and only then dedupe state.

**Tech Stack:** Node.js 22 ESM, Cloudflare Workers/KV, GitHub Actions, Playwright Chromium, Sharp, SVG, DingTalk custom robot webhook.

---

## File Map

- Create `worker/source-recovery.js`: retry classification, attempt records, recovery sequencing, and coverage gates.
- Create `worker/dingtalk-single-card.js`: one-message renderer and deterministic UTF-8 byte budgeting.
- Create `worker/action-dashboard.js`: pure 1080 × 1440 action-dashboard SVG builder.
- Create `worker/browser-fetch.js`: Node-only Playwright adapter for public JavaScript pages.
- Create `worker/cloudflare-assets.js`: Node-only versioned KV upload and public image health check.
- Modify `worker/index.js`: integrate the new modules and enforce transactional phase order.
- Modify `worker/run-local.js`: initialize/close browser fallback, publish image before notification, and expose final metrics.
- Modify `worker/test-runner.js`: characterization, recovery, coverage, single-card, SVG, asset-order, and failure-state tests.
- Modify `worker/sources.json`: add verified official alternate URLs only for sources that need them.
- Modify `.github/workflows/weekly.yml`: install Chromium/CJK fonts, deploy routes before pipeline, and remove post-send image publication.
- Modify `package.json` and `package-lock.json`: add Playwright as a Node-only development dependency.
- Modify `README.md` and `docs/DINGTALK_SETUP.md`: document coverage gates, one-card behavior, and image publication order.

## Invariants

- Existing AI source-observation filtering, six module names, China-first ordering, 30-day dedupe, retryable DingTalk errors, and terminal DingTalk business errors remain behaviorally intact.
- No login, CAPTCHA, paywall, IP allowlist, or access-control bypass is added.
- Playwright is imported only by `run-local.js` through `worker/browser-fetch.js`; `worker/index.js` remains deployable to Cloudflare Workers.
- `master`, knowledge-base APIs, and the formal customer webhook remain outside scope.

### Task 1: Characterize Current Failures and Define Source Recovery

**Files:**
- Create: `worker/source-recovery.js`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Add failing recovery classification tests**

Add tests that import these not-yet-existing exports:

```js
import {
  classifyFetchFailure,
  recoverPublicSource,
  calculateSourceCoverage,
  assertSourceCoverage,
} from './source-recovery.js';

assert.equal(classifyFetchFailure({ status: 429 }).retryable, true);
assert.equal(classifyFetchFailure({ status: 503 }).retryable, true);
assert.equal(classifyFetchFailure({ status: 401 }).retryable, false);
assert.equal(classifyFetchFailure({ kind: 'captcha' }).retryable, false);
```

Add a recovery test whose direct attempts fail twice and then succeed, and assert that `attempts.length === 3`, `status === 'recovered'`, and the final method is `retry`.

- [ ] **Step 2: Run tests and verify RED**

Run: `node worker/test-runner.js`

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `worker/source-recovery.js`.

- [ ] **Step 3: Implement recovery orchestration**

Implement the public contract:

```js
export function classifyFetchFailure({ status = 0, kind = 'network', message = '' } = {}) {
  const terminal = status === 401 || /login|captcha|paywall|allowlist/i.test(`${kind} ${message}`);
  return { retryable: !terminal && (!status || status === 429 || status >= 500), terminal };
}

export async function recoverPublicSource(source, {
  direct,
  browser,
  alternate,
  maxAttempts = 3,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  now = Date.now,
} = {}) {
  // Return { status, source, html, finalUrl, attempts, recovery_method,
  // candidate_count, final_error }. Never throw for one source.
}
```

Use bounded exponential delays of 1.5 and 4 seconds plus injected jitter. Call browser only after retryable direct exhaustion or an empty JavaScript shell. Call official alternates last. Record every attempt.

- [ ] **Step 4: Add and pass coverage-gate tests**

Test 100% China high-priority coverage and 90% overall coverage. Assert that a missing China high-priority source throws `SourceCoverageError`, while one recovered through an official alternate counts as covered.

Run: `node worker/test-runner.js`

Expected: `worker pure function tests ok`.

- [ ] **Step 5: Commit recovery primitives**

```bash
git add worker/source-recovery.js worker/test-runner.js
git commit -m "feat: add auditable source recovery"
```

### Task 2: Integrate Recovery Into Candidate Collection

**Files:**
- Modify: `worker/index.js`
- Modify: `worker/sources.json`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Add failing collection-result tests**

Change the expected result contract from name-only failures to:

```js
{
  candidates: [],
  leads: [],
  sourceResults: [{ source_name, status, attempts, candidate_count, final_error }],
  coverage: { overall, chinaCritical, covered, total, failedSources },
}
```

Assert that lead placeholders do not count as coverage and that recovered HTML is parsed through the same `extractLinks`, relevance, image, and candidate logic as direct HTML.

- [ ] **Step 2: Run tests and verify RED**

Run: `node worker/test-runner.js`

Expected: FAIL because `collectCandidates` does not return `sourceResults` or `coverage`.

- [ ] **Step 3: Separate transport from HTML parsing**

Extract the current successful response parsing into:

```js
function extractSourceCandidatesFromHtml(source, html, finalUrl = source.url) {
  // Preserve existing link limits, snippets, image extraction, source-page
  // candidate rules, and source metadata.
}
```

Change `fetchSourceCandidates(source, options)` to call `recoverPublicSource`, parse the recovered HTML once, set `candidate_count`, and return the structured source result.

- [ ] **Step 4: Thread recovery metrics through every pipeline entry**

Update `collectCandidates`, batch storage, `runAnalysisPhase`, `runFinalizePhase`, and `runPipeline` so source results and coverage survive direct local runs and staged Worker runs. Run `assertSourceCoverage` before AI analysis and before final delivery.

- [ ] **Step 5: Add only verified official alternates**

For failing official sources, add optional `alternate_urls` values only after direct GET/browser verification. Keep the same organization as owner; do not use news mirrors or search-result pages.

- [ ] **Step 6: Run focused and full tests**

Run: `node worker/test-runner.js`

Expected: all recovery, collection, existing quality, and delivery tests pass.

- [ ] **Step 7: Commit pipeline integration**

```bash
git add worker/index.js worker/sources.json worker/test-runner.js
git commit -m "feat: enforce source coverage gates"
```

### Task 3: Add the Node Browser Recovery Adapter

**Files:**
- Create: `worker/browser-fetch.js`
- Modify: `worker/run-local.js`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `.github/workflows/weekly.yml`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Add a failing lifecycle test**

Inject a fake browser factory and assert one browser is reused for multiple fallback sources, per-page errors are recorded, and `close()` runs in `finally` on pipeline success and failure.

- [ ] **Step 2: Run tests and verify RED**

Run: `node worker/test-runner.js`

Expected: FAIL because `createBrowserSourceFetcher` does not exist.

- [ ] **Step 3: Implement the Node-only adapter**

Create this contract without importing it from `worker/index.js`:

```js
export async function createBrowserSourceFetcher({ chromium, launchOptions = {} } = {}) {
  const browser = await chromium.launch({ headless: true, ...launchOptions });
  return {
    async fetchHtml(url, { timeoutMs = 45000 } = {}) {
      // New page, browser-compatible headers, goto domcontentloaded,
      // bounded wait for document text, return { html, finalUrl, status }.
    },
    async close() { await browser.close(); },
  };
}
```

Reject login/CAPTCHA/paywall pages using visible title/body signals. Do not interact with those controls.

- [ ] **Step 4: Inject and clean up the adapter**

In `run-local.js`, initialize Playwright once, set `env.BROWSER_FETCH_HTML`, execute the pipeline inside `try/finally`, and close the browser in the `finally` block.

- [ ] **Step 5: Install deterministic runtime dependencies**

Add Playwright to dev dependencies. In the workflow, after `npm ci`, run:

```yaml
- name: Install browser and Chinese fonts
  run: |
    sudo apt-get update
    sudo apt-get install -y fonts-noto-cjk
    npx playwright install --with-deps chromium
    fc-match "Noto Sans CJK SC"
```

- [ ] **Step 6: Verify Node and Worker boundaries**

Run:

```bash
npm ci
node worker/test-runner.js
cd worker && npx wrangler deploy --dry-run
```

Expected: tests pass and the Worker dry run does not bundle Playwright.

- [ ] **Step 7: Commit browser recovery**

```bash
git add worker/browser-fetch.js worker/run-local.js package.json package-lock.json .github/workflows/weekly.yml worker/test-runner.js
git commit -m "feat: recover public sources with browser rendering"
```

### Task 4: Replace Seven Cards With One Byte-Budgeted Message

**Files:**
- Create: `worker/dingtalk-single-card.js`
- Modify: `worker/index.js`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Add failing one-card tests**

Test that `buildSingleDingTalkMessage(report, options)` returns one object, keeps all six module headings, places China first, includes the dashboard URL and every retained source URL, and remains at or below 18,000 UTF-8 bytes.

Add an oversized fixture that forces full → compact → index-only tiers. Assert the output remains one message and contains an explicit omitted-count note if low-score items must be removed.

- [ ] **Step 2: Run tests and verify RED**

Run: `node worker/test-runner.js`

Expected: FAIL because the new builder is missing and existing code returns seven messages.

- [ ] **Step 3: Implement deterministic rendering tiers**

Create:

```js
export function buildSingleDingTalkMessage(report, {
  imageUrl = '',
  coverage,
  maxBytes = 18000,
} = {}) {
  // Return { id: 'weekly-report', title, markdown, bytes, itemCount,
  // displayedItemCount, omittedItemCount }.
}
```

Render China/high-risk items in full, other items compactly, then index-only. Recompute UTF-8 bytes after each deterministic reduction. Preserve module headings and source URLs until the final low-score omission tier.

- [ ] **Step 4: Integrate exactly one send**

Replace `buildDingTalkWebhookMessages` use in `notifyReport` with the single builder. Keep `sendDingTalkMessages` for its retry and error semantics, but assert `messages.length === 1`; set inter-message delay to zero because there is no second message.

- [ ] **Step 5: Update delivery tests and pass full suite**

Run: `node worker/test-runner.js`

Expected: one DingTalk call, correct byte count, retry behavior preserved, terminal errors still stop immediately, and failed delivery still does not mark dedupe state.

- [ ] **Step 6: Commit single-card delivery**

```bash
git add worker/dingtalk-single-card.js worker/index.js worker/test-runner.js
git commit -m "feat: deliver weekly report in one dingtalk card"
```

### Task 5: Replace the Radial Map With an Action Dashboard

**Files:**
- Create: `worker/action-dashboard.js`
- Modify: `worker/index.js`
- Modify: `worker/run-local.js`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Add failing dashboard tests**

Assert SVG width/height are `1080`/`1440`, the declared font stack starts with `Noto Sans CJK SC`, all counts use the full verified report, China Top 3 precedes other markets, six module bars exist, Top 5 actions include owners, and every calculated box stays within the viewBox.

- [ ] **Step 2: Run tests and verify RED**

Run: `node worker/test-runner.js`

Expected: FAIL because current SVG is 1600 × 1180, uses a radial graph, truncates to ten items, and has no explicit CJK font.

- [ ] **Step 3: Implement the pure dashboard builder**

Create:

```js
export function buildActionDashboardSvg(items, {
  period,
  coverage,
  generatedAt,
} = {}) {
  // Return a 1080 × 1440 SVG with header KPIs, China Top 3,
  // six module bars, Top 5 actions, and coverage footer.
}
```

Use measured CJK-aware wrapping, minimum 28-pixel body text, stable row heights, semantic risk labels, and no central hub or decorative relationship lines.

- [ ] **Step 4: Render at intrinsic dimensions**

Change Sharp generation to:

```js
await sharp(Buffer.from(svg)).png().toFile('out/decision-map.png');
```

Do not set density to 180. Assert PNG metadata is exactly 1080 × 1440.

- [ ] **Step 5: Run visual checks**

Generate a fixture with real Chinese text, render PNG, inspect it at 1080 pixels and a 720-pixel resized preview, and verify no hex boxes, clipping, overlap, or unreadable labels.

- [ ] **Step 6: Commit dashboard replacement**

```bash
git add worker/action-dashboard.js worker/index.js worker/run-local.js worker/test-runner.js
git commit -m "feat: render readable legal action dashboard"
```

### Task 6: Publish Versioned Images Before Sending

**Files:**
- Create: `worker/cloudflare-assets.js`
- Modify: `worker/index.js`
- Modify: `worker/run-local.js`
- Modify: `worker/wrangler.toml`
- Modify: `.github/workflows/weekly.yml`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Add a failing phase-order test**

Record calls in an array and assert the required order:

```js
assert.deepEqual(calls, [
  'render-image',
  'publish-versioned-image',
  'health-check-image',
  'send-dingtalk',
  'mark-seen',
]);
```

Assert a publish or health-check failure prevents DingTalk and `markSeen` calls.

- [ ] **Step 2: Run tests and verify RED**

Run: `node worker/test-runner.js`

Expected: FAIL because current workflow sends DingTalk before remote KV publication.

- [ ] **Step 3: Add versioned Worker asset storage and route**

Store both `asset:decision-map:<date>.png` and `asset:decision-map:latest.png`. Add `/assets/decision-map/<YYYY-MM-DD>.png` with `Content-Type: image/png` and immutable cache headers; keep `/latest` for diagnostics only.

- [ ] **Step 4: Implement Node-side remote publication**

Create:

```js
export async function publishVersionedPng({
  accountId,
  namespaceId,
  apiToken,
  date,
  png,
  publicBaseUrl,
  fetcher = fetch,
}) {
  // PUT versioned and latest KV values, GET the versioned URL,
  // verify 200, image/png, Content-Length/minimum bytes, return URL.
}
```

Do not log the API token. Retry only network, 429, and 5xx responses.

- [ ] **Step 5: Inject publication before notification**

Add an `env.PUBLISH_DECISION_MAP` hook after PNG generation and before `notifyReport`. Use its returned versioned URL in the single card. For a Cloudflare scheduled run without the hook, save the versioned key directly to bound KV before notification.

- [ ] **Step 6: Reorder GitHub Actions**

Deploy Worker routes before `Run pipeline`. Remove the post-send `Publish decision map asset` step. Provide non-secret account/namespace IDs as workflow environment variables and keep the token in `CLOUDFLARE_API_TOKEN`.

- [ ] **Step 7: Pass phase-order and full tests**

Run: `node worker/test-runner.js`

Expected: exact publication order, no send on stale-image risk, and all prior tests pass.

- [ ] **Step 8: Commit transactional image delivery**

```bash
git add worker/cloudflare-assets.js worker/index.js worker/run-local.js worker/wrangler.toml .github/workflows/weekly.yml worker/test-runner.js
git commit -m "fix: publish dashboard before dingtalk delivery"
```

### Task 7: Documentation and Local Release Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/DINGTALK_SETUP.md`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Document the operational contract**

Document one webhook message, 18,000-byte budget, 100% China critical/90% overall coverage gates, browser recovery limits, versioned image order, and the meaning of a degraded collection alert.

- [ ] **Step 2: Run fresh verification**

Run:

```bash
npm ci
node worker/test-runner.js
git diff --check
cd worker && npx wrangler deploy --dry-run
```

Expected: every command exits zero; tests end with `worker pure function tests ok`; the dry run excludes Playwright from the Worker bundle.

- [ ] **Step 3: Render and inspect fixture artifacts**

Run a fixture renderer to create `out/decision-map.png` and one-card Markdown. Verify PNG metadata, 720-pixel preview readability, Markdown byte count, one image URL, six module headings, and China-first order.

- [ ] **Step 4: Commit documentation and verification fixtures**

```bash
git add README.md docs/DINGTALK_SETUP.md worker/test-runner.js
git commit -m "docs: describe reliable single-card operations"
```

### Task 8: Remote Test-Branch Run and Acceptance Checklist

**Files:**
- No additional production files unless verification exposes a root cause.

- [ ] **Step 1: Confirm branch isolation and clean state**

Run:

```bash
git status --short --branch
git log --oneline --decorate -12
```

Expected: clean `codex/dingtalk-webhook-reliability`; no `master` mutation.

- [ ] **Step 2: Update the remote test branch**

Use the authenticated GitHub surface to update only `codex/dingtalk-webhook-reliability`. Confirm the remote workflow file contains checkout/setup-node v5, font/browser installation, deploy-before-pipeline, and no post-send asset upload.

- [ ] **Step 3: Trigger one real workflow dispatch**

Run `Beauty Legal Weekly Report` on the test branch using existing repository Secrets and the authorized test webhook. Do not send a sample payload and do not trigger a second run unless the first run fails before DingTalk delivery.

- [ ] **Step 4: Verify collection evidence**

Record total fetchable sources, direct successes, retry recoveries, browser recoveries, alternate recoveries, final failures, China critical coverage, and overall coverage. A normal report requires 100%/90% gates.

- [ ] **Step 5: Verify content and delivery evidence**

Record AI module count, formal item count, China-first ordering, DingTalk calls `1/1`, Markdown byte count, retries, versioned image URL, and workflow final status.

- [ ] **Step 6: Verify image evidence**

Open the versioned PNG and inspect natural dimensions plus a chat-width preview. Confirm readable Chinese glyphs, no crop/overlap, correct full-report counts, and visible China Top 3/action Top 5.

- [ ] **Step 7: Report residual failures honestly**

If any source remains unavailable, list the exact source, all attempted public methods, terminal reason, and whether the coverage gate blocked normal delivery. Do not describe a blocked or degraded run as successful.

## Final Acceptance Checklist

- [ ] All local tests pass from a clean install.
- [ ] Worker dry-run deployment succeeds without Playwright in the bundle.
- [ ] China high-priority source coverage is 100%.
- [ ] Overall fetchable-source coverage is at least 90%.
- [ ] Failed and recovered sources have structured attempt logs.
- [ ] AI output contains exactly six modules and source-verified items.
- [ ] China items appear first in image, overview, and every module.
- [ ] Dashboard PNG is 1080 × 1440 with readable Chinese and no clipping.
- [ ] Versioned image is published and health-checked before webhook send.
- [ ] DingTalk receives exactly one Markdown message.
- [ ] Markdown body is at most 18,000 UTF-8 bytes.
- [ ] Source links and empty-module states are preserved.
- [ ] Retryable delivery failures retry; terminal business errors stop immediately.
- [ ] Dedupe state is written only after image and webhook success.
- [ ] GitHub Actions finishes with a truthful success/failure state.
- [ ] Only the test branch and authorized test webhook are used.
