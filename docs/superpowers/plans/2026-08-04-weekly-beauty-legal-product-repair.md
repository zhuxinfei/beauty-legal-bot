# Weekly Beauty Legal Product Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the weekly pipeline produce at least 20 distinct, recent, evidence-backed beauty legal items across all six modules without changing the existing item structure.

**Architecture:** Preserve the current discovery, hydration, AI analysis, premium selection, and delivery boundaries. Add module-level supply accounting and recovery, strengthen detail/evidence contracts at the earliest reliable stage, then enforce the same validated portfolio for saved Markdown and delivery. Debug runs may bypass historical deduplication; normal runs cannot.

**Tech Stack:** Node.js 22 ES modules, existing Crawl4AI/Playwright hydration, OpenAI-compatible analysis endpoint, GitHub Actions, existing Node assertion tests.

---

### Task 1: Add A Module Funnel Contract And Diagnostics

**Files:**
- Modify: `worker/content-quality.js`
- Modify: `worker/open-web-discovery.js`
- Modify: `worker/index.js`
- Test: `worker/test-runner.js`

- [x] **Step 1: Write the failing test**

Add a fixture with six modules and assert that the funnel returns one row for every module, including zero values, with keys `discovered`, `resolved_original`, `hydrated_with_substantive_text`, `hard_fact_ready`, `editorial_accepted`, `ai_accepted`, `premium_selectable`, and `final`.

Also assert that a candidate carrying `discovery_module: '知识产权动态'` keeps that module after hydration and editorial acceptance even when its title does not contain a regulation keyword.

- [x] **Step 2: Run the focused test and verify it fails**

Run: `node worker/test-runner.js`

Expected: failure on the new funnel assertion because no shared module funnel is currently emitted and the current global routing can lose module provenance.

- [x] **Step 3: Implement the smallest shared audit helper**

Add an exported helper in `worker/content-quality.js` that returns all six module rows initialized to zero and accepts stage-specific increments. Use it from discovery and pipeline logging; do not change candidate acceptance rules in this task.

Preserve `discovery_module` as the primary routing value in `applyEditorialGate`, `mergeHydratedCandidates`, and module analysis. Only infer a module when provenance is absent.

- [x] **Step 4: Run focused and existing tests**

Run: `node worker/test-runner.js`

Expected: the new funnel/provenance assertions and the existing pure function suite pass.

- [x] **Step 5: Commit**

Run: `git add worker/content-quality.js worker/open-web-discovery.js worker/index.js worker/test-runner.js && git commit -m "feat: audit weekly supply by module"`

### Task 2: Repair Module-Balanced Discovery And Detail Selection

**Files:**
- Modify: `worker/open-web-discovery.js`
- Modify: `scripts/discover-open-web.js`
- Modify: `scripts/crawl4ai-hydrate.js`
- Modify: `.github/workflows/weekly.yml`
- Test: `worker/test-runner.js`
- Test: `scripts/crawl4ai-hydrate.test.js`

- [ ] **Step 1: Write failing supply tests**

Test that discovery does not let regulation results consume the global resolution budget when advertising, IP, platform, import/export, and safety lanes are under their minimum. Test that recovery is invoked only for deficient modules and preserves the module name on returned candidates.

Test that `selectHydrationSources` selects at least the configured per-module floor before filling remaining slots and excludes root/index/list records when an article/detail record is available for that module.

- [ ] **Step 2: Run tests and verify the expected failures**

Run: `node worker/test-runner.js && node scripts/crawl4ai-hydrate.test.js`

Expected: the new per-module budget assertions fail against the current globally pooled behavior.

- [ ] **Step 3: Implement bounded lane budgets**

Expand only the existing `QUERY_GROUPS` with targeted event queries for the three currently empty lanes: advertising enforcement, beauty/platform governance, and IP disputes; add source-specific queries for recall/safety and import/export detail events. Keep the existing maximum total, host, and module limits.

Change `discoverOpenWeb` to resolve a balanced per-module slice first, then use remaining capacity globally. Run the existing recovery pass only for modules below the configured candidate floor, with the 15-day primary period and bounded 30-day recovery period.

Change hydration selection to reserve the module floor and prioritize hard-fact endpoint/detail URLs over list or homepage URLs. Do not make a page successful merely because navigation returned HTTP 200.

- [ ] **Step 4: Add workflow diagnostics without changing delivery format**

Print one compact line per module after discovery and hydration, plus the existing overall totals. Keep the workflow within its current timeout and concurrency limits. Set debug duplicate behavior from the existing `allow_duplicate_debug` input; do not add a second deduplication switch.

- [ ] **Step 5: Run tests and commit**

Run: `node worker/test-runner.js && node scripts/crawl4ai-hydrate.test.js`

Expected: all supply, recovery, selection, and existing tests pass.

Commit: `git add worker/open-web-discovery.js scripts/discover-open-web.js scripts/crawl4ai-hydrate.js .github/workflows/weekly.yml worker/test-runner.js scripts/crawl4ai-hydrate.test.js && git commit -m "feat: preserve balanced module acquisition"`

### Task 3: Enforce Source-Grounded Facts And Chinese Display Text

**Files:**
- Modify: `worker/article-evidence.js`
- Modify: `worker/hard-fact-extractor.js`
- Modify: `worker/premium-quality.js`
- Modify: `worker/index.js`
- Test: `worker/premium-hardfacts.test.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Write failing evidence tests**

Add cases for:

```js
{ violation_behavior: '的，按照相关法律、行政法规的规定处理' }
```

an invalid date such as `2014-21-11`, an English OPSS title/body, a food-only punishment page, and a generic recall index page. Assert that each is rejected or that only a source-grounded Chinese summary survives.

Add one valid fixture for each of the six module fact bundles and assert that the existing output fields remain exactly `标题`, `来源`, `事实依据`, `法务观察`, `业务影响`, and `下一步观察建议`.

- [ ] **Step 2: Run tests and verify failures**

Run: `node worker/premium-hardfacts.test.js && node worker/test-runner.js`

Expected: the new missing-field, localization, and module-bundle assertions fail before implementation.

- [ ] **Step 3: Implement deterministic evidence normalization**

Use the existing article cleaning helpers before hard-fact extraction. Treat shell fragments, navigation text, malformed dates, and document/list-page titles as empty evidence. Require a source quote or source-text match for every hard fact used in a premium card.

Use the existing AI analysis fields for source-grounded Chinese display text. Preserve original proper names in parentheses where useful; never translate URLs, document numbers, or legal citations into invented values. A source-only fallback with English-only substantive fields is rejected unless the existing deterministic localization mapping covers the complete displayed meaning; do not use a partial phrase dictionary as if it were a full translation.

Keep the current Markdown field names and order unchanged.

- [ ] **Step 4: Run focused tests, then the full pure-function suite**

Run: `node worker/premium-hardfacts.test.js && node worker/test-runner.js`

Expected: all six fact-bundle fixtures pass and all invalid fixtures are rejected.

- [ ] **Step 5: Commit**

Run: `git add worker/article-evidence.js worker/hard-fact-extractor.js worker/premium-quality.js worker/index.js worker/premium-hardfacts.test.js worker/test-runner.js && git commit -m "feat: require source-grounded bilingual hard facts"`

### Task 4: Enforce A 20-Item Balanced Portfolio And Explicit Debug Deduplication

**Files:**
- Modify: `worker/premium-quality.js`
- Modify: `worker/index.js`
- Modify: `worker/run-local.js`
- Modify: `.github/workflows/weekly.yml`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Write failing portfolio tests**

Create 24 valid fixture cards, four per module, and assert that selection returns at least 20, all six modules have at least two, no module exceeds five, and duplicate event identities are removed within the report.

Create an underfilled fixture and assert that `assertPremiumPortfolioDelivery` reports `finalItems`, `missingModules`, and `underfilledModules` without allowing delivery. Assert that debug mode bypasses only historical duplicate blocking and never bypasses item quality or module/quantity gates.

- [ ] **Step 2: Run tests and verify expected failures**

Run: `node worker/test-runner.js`

Expected: the current selector or gate fails the new 20-item and debug-vs-normal assertions.

- [ ] **Step 3: Implement balanced selection and gate behavior**

Keep the current two-round per-module selection strategy, but make it operate on the final selectable premium cards after source validation and event deduplication. Fill remaining slots by score while preserving the per-module cap. Set production minimum to 20 and operational maximum to 24 in the workflow.

Make `FORCE_DELIVERY=1` bypass only historical KV duplicate skipping. It must not bypass `assertPremiumChinaDelivery`, `assertPremiumPortfolioDelivery`, Markdown quality checks, or source-grounded hard-fact validation. Mark historical fingerprints only after successful delivery.

- [ ] **Step 4: Verify exact payload identity**

Extend the existing notification tests to assert that the Markdown passed to the DingTalk sender equals the Markdown written by `ON_REPORT_READY`, including the debug path.

- [ ] **Step 5: Run tests and commit**

Run: `node worker/test-runner.js && node worker/premium-hardfacts.test.js`

Commit: `git add worker/premium-quality.js worker/index.js worker/run-local.js .github/workflows/weekly.yml worker/test-runner.js && git commit -m "feat: gate balanced twenty-item delivery"`

### Task 5: Validate The Real Workflow Before Claiming Completion

**Files:**
- Modify only if diagnostics expose a concrete defect: `.github/workflows/weekly.yml`, `worker/index.js`, `worker/premium-quality.js`, or `scripts/*.js`
- Artifact: `out/latest-report.md`, `out/latest-report.json`, and the workflow log

- [ ] **Step 1: Run local static and unit verification**

Run:

```bash
node worker/test-runner.js
node worker/premium-hardfacts.test.js
node scripts/crawl4ai-hydrate.test.js
node --check worker/index.js
node --check worker/premium-quality.js
node --check worker/content-quality.js
node --check worker/open-web-discovery.js
node --check scripts/discover-open-web.js
```

Expected: every command exits 0.

- [ ] **Step 2: Trigger one no-delivery debug workflow**

Run: `gh workflow run weekly.yml --repo zhuxinfei/beauty-legal-bot --ref codex/content-quality-runtime -f no_delivery=true -f allow_duplicate_debug=true`

Inspect only the compact module funnel, premium gate, final item count, final Markdown, and rejection reasons. Do not send DingTalk and do not reset historical state.

- [ ] **Step 3: Verify the artifact against the product contract**

Check all six module headings, at least 20 final items, two per module, no module over five, no malformed dates/fragments/English-only fields, no duplicate event fingerprints, and unchanged field order. A successful process exit alone is insufficient.

- [ ] **Step 4: Repeat on two separate collection runs**

Run the same no-delivery debug workflow on two later collection dates. Record the three-run result and per-module funnel. This step remains pending after today's implementation run; do not substitute repeated same-day runs or claim cross-week stability until all three dates meet the contract.

- [ ] **Step 5: Final verification and branch handoff**

Run `git status --short --branch`, `git log --oneline -8`, and the complete local test suite. Push all implementation commits to `codex/content-quality-runtime`. Report any external source that remains blocked separately from actual product failures.
