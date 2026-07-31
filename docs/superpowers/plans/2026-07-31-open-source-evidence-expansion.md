# Open-Source Evidence Expansion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the 14-day candidate pool to support 15-20 premium beauty-legal cards without allowing a single media article, repost, or unsupported AI statement to bypass the existing quality floor.

**Architecture:** Keep discovery permissive and delivery strict. Open-web discovery produces direct article URLs; Crawl4AI hydrates each page; a deterministic evidence correlator groups independent reports into events and promotes only official single-source evidence or independently corroborated multi-source evidence. Existing premium hard-fact, beauty relevance, broken-fragment, navigation-page, and DingTalk rendering gates remain mandatory.

**Tech Stack:** Node.js 22 ESM, Crawl4AI/Python, Google News RSS discovery, existing hard-fact extractor, GitHub Actions, DingTalk Markdown.

---

## Non-Negotiable Invariants

1. Do not remove or weaken `validatePremiumEvidenceCard`, `isSampleGradeCard`, `hasSampleGradeHardFactBundle`, navigation rejection, beauty relevance, date validation, or DingTalk output validation.
2. A single media, newsletter, public-account, aggregator, or repost page is never final evidence.
3. Official regulator, court, customs, official database, platform rule, and first-party recall/policy pages may qualify as a single source only for facts within that publisher's authority.
4. Non-official events require at least two independent publisher hosts and agreement on at least two event anchors, one of which must be a hard anchor: document number, named party, amount, product/batch, deadline, effective date, case number, or disposition.
5. Quantity is a target, not a quota. The pipeline may send fewer than 15 cards when fewer than 15 events pass every gate.
6. Final cards retain one canonical source URL and an internal `supporting_sources` audit trail. Supporting sources are never merged into facts unless their anchors agree.

## Rejected Approaches

- **Delete the media rejection:** Fast volume increase, unacceptable hallucination and repost risk.
- **Require official originals for every event:** Preserves quality but repeats the current quantity bottleneck and discards platform, company, court-database, and well-corroborated industry events.
- **Let the AI decide trust and corroboration:** Non-deterministic and impossible to audit. AI may summarize verified evidence, but deterministic code decides whether the evidence package is eligible.

## File Map

- Create `worker/open-web-discovery.js`: query generation, RSS result normalization, direct-URL discovery audit.
- Create `worker/evidence-corroboration.js`: source tiers, event anchors, event clustering, independence and agreement checks.
- Create `scripts/discover-open-web.js`: Node-only runner using existing Google News URL resolution and writing a discovery artifact.
- Modify `worker/google-rss-discovery.js`: dependency injection for RSS fetch and URL resolution; no quality decisions.
- Modify `worker/source-acquisition.js`: admit direct `discovered_article` records for hydration without treating them as trusted evidence.
- Modify `scripts/crawl4ai-hydrate.js`: hydrate the generated acquisition manifest and preserve discovery metadata.
- Modify `worker/source-hydration.js`: preserve `publisher_host`, discovery provenance, source tier, and supporting evidence metadata.
- Modify `worker/content-quality.js`: allow corroborated records through editorial review while retaining single-media rejection.
- Modify `worker/premium-quality.js`: permit `corroborated_fact_ready` only when deterministic corroboration metadata is valid; leave all content gates intact.
- Modify `worker/index.js`: combine catalog candidates and corroborated discovered events before AI and premium selection.
- Modify `worker/run-local.js`: load the discovery artifact in formal local runs.
- Modify `.github/workflows/weekly.yml`: add discovery and manifest steps before Crawl4AI; add bounded budgets and audit output.
- Modify `worker/test-runner.js` and `worker/premium-hardfacts.test.js`: regression, trust, corroboration, and pipeline integration tests.

---

### Task 1: Freeze The Existing Quality Floor

**Files:**
- Modify: `worker/test-runner.js`
- Modify: `worker/premium-hardfacts.test.js`
- Read: `docs/quality/golden-corpus-2026-07-20.json`

- [ ] **Step 1: Add failing regression tests for prohibited shortcuts**

Add tests asserting that:

```js
assert.equal(evaluateEditorialCandidate(singleMediaCandidate).accepted, false);
assert.equal(selectPremiumEvidenceCards([singleMediaCard], { maxItems: 18 }).length, 0);
assert.equal(selectPremiumEvidenceCards([navigationCard], { maxItems: 18 }).length, 0);
assert.equal(selectPremiumEvidenceCards([fragmentCard], { maxItems: 18 }).length, 0);
```

Also assert every accepted golden-corpus card still contains the four DingTalk sections and passes the existing sample-grade hard-fact requirements.

- [ ] **Step 2: Run tests and capture the baseline**

Run:

```bash
node worker/test-runner.js
node worker/hard-fact-extractor.test.js
node worker/premium-hardfacts.test.js
```

Expected: existing tests pass; new corroboration-specific tests fail because the correlator does not exist.

- [ ] **Step 3: Commit only the baseline tests**

```bash
git add worker/test-runner.js worker/premium-hardfacts.test.js
git commit -m "test: freeze premium quality floor before source expansion"
```

---

### Task 2: Add Bounded Open-Web Discovery

**Files:**
- Create: `worker/open-web-discovery.js`
- Create: `scripts/discover-open-web.js`
- Modify: `worker/google-rss-discovery.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Add failing discovery tests**

Cover these behaviors:

```js
const result = await discoverOpenWeb({
  period: { start: '2026-07-17', end: '2026-07-31' },
  fetchRss: fakeRss,
  resolveCandidates: fakeResolver,
  maxItems: 120,
});
assert.ok(result.candidates.every(item => /^https?:\/\//.test(item.url)));
assert.ok(result.candidates.every(item => !item.url.includes('news.google.com')));
assert.equal(new Set(result.candidates.map(item => item.url)).size, result.candidates.length);
assert.ok(result.audit.queriesByModule['知识产权动态'] > 0);
```

Reject results outside the period, missing direct publisher URLs, promotional titles, and non-beauty events. Do not reject a result merely because its publisher is media.

- [ ] **Step 2: Implement deterministic module queries**

`buildDiscoveryQueries()` must cover all six modules with beauty anchors and legal-event anchors. Examples:

```js
['化妆品 行政处罚 罚款', '美妆 虚假宣传 直播 处罚'];
['化妆品 商标 侵权 判决', '美妆 不正当竞争 诉讼'];
['化妆品 标准 征求意见 备案', 'cosmetics regulation effective date'];
['化妆品 召回 不合格 批次', 'cosmetics recall contamination'];
['化妆品 海关 进口 出口 扣留', 'cosmetics customs seizure'];
['美妆 平台规则 品牌 公告', 'beauty ecommerce policy'];
```

The output schema is:

```js
{
  title, url, discovery_url, source_name, publisher_url, publisher_host,
  published_at, module, source_scope: 'discovered_article',
  source_type: 'discovered_publisher', authority_type: 'unclassified',
  discovery_provider: 'google_news_rss'
}
```

- [ ] **Step 3: Add the Node runner and artifact**

`scripts/discover-open-web.js` writes:

```json
{
  "period": { "start": "YYYY-MM-DD", "end": "YYYY-MM-DD" },
  "audit": { "queries": 0, "raw": 0, "resolved": 0, "unique": 0 },
  "candidates": []
}
```

The script exits non-zero only for malformed output or total provider failure. A valid zero-result artifact is allowed and must not disable catalog acquisition.

- [ ] **Step 4: Verify and commit**

Run `node worker/test-runner.js` and `node --check scripts/discover-open-web.js`.

```bash
git add worker/open-web-discovery.js worker/google-rss-discovery.js scripts/discover-open-web.js worker/test-runner.js
git commit -m "feat: discover direct beauty legal article candidates"
```

---

### Task 3: Hydrate Discovered Articles Without Trust Promotion

**Files:**
- Modify: `worker/source-acquisition.js`
- Modify: `scripts/crawl4ai-hydrate.js`
- Modify: `worker/source-hydration.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Add failing acquisition tests**

Assert that a direct discovered article is hydratable but not authoritative:

```js
assert.equal(isHydrationAcquisitionSource(discoveredArticle), true);
assert.equal(isHardFactAcquisitionSource(discoveredArticle), false);
assert.equal(classifyAuthorityTrust(discoveredArticle).level, 'unknown');
```

Assert portal URLs, Google redirect URLs, missing dates, and bare homepages remain ineligible.

- [ ] **Step 2: Separate hydration eligibility from evidence trust**

Add `isHydrationAcquisitionSource(source)` with two valid paths:

```js
return isHardFactAcquisitionSource(source)
  || (source.source_scope === 'discovered_article'
    && isDirectDetailUrl(source.url)
    && /^20\d{2}-\d{2}-\d{2}$/.test(source.published_at));
```

Do not change `isHardFactAcquisitionSource()` semantics.

- [ ] **Step 3: Build and hydrate a bounded manifest**

Combine official catalog sources and discovered direct articles, with limits:

```text
official/list sources: existing behavior
discovered articles: at most 120
per publisher host: at most 8
per module: at most 30
attachments per detail: existing limit 2
```

Crawl4AI records must preserve all discovery metadata. Failed pages remain auditable but cannot enter corroboration.

- [ ] **Step 4: Verify and commit**

Run `node worker/test-runner.js`, `node worker/hard-fact-extractor.test.js`, and `node --check scripts/crawl4ai-hydrate.js`.

```bash
git add worker/source-acquisition.js scripts/crawl4ai-hydrate.js worker/source-hydration.js worker/test-runner.js
git commit -m "feat: hydrate bounded open-web article candidates"
```

---

### Task 4: Build Deterministic Event Corroboration

**Files:**
- Create: `worker/evidence-corroboration.js`
- Modify: `worker/authority-resolver.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Add failing source-tier tests**

Expected trust levels:

```js
assert.equal(classifyEvidenceSource(regulator).tier, 'primary');
assert.equal(classifyEvidenceSource(courtDatabase).tier, 'primary');
assert.equal(classifyEvidenceSource(platformRule).tier, 'first_party');
assert.equal(classifyEvidenceSource(brandRecall).tier, 'first_party');
assert.equal(classifyEvidenceSource(reputableMedia).tier, 'secondary');
assert.equal(classifyEvidenceSource(repost).tier, 'lead_only');
```

- [ ] **Step 2: Add failing event-anchor and clustering tests**

`extractEventAnchors(candidate)` returns normalized values for:

```js
{
  parties: [], document_numbers: [], amounts: [], products_or_batches: [],
  dates: [], legal_bases: [], dispositions: [], action_terms: []
}
```

Two records cluster only when they share a named party or document number, or share at least two of amount/product/date/disposition plus a compatible module. Similar generic titles alone never cluster.

- [ ] **Step 3: Implement the promotion rules**

`buildEvidencePackages(records)` returns one package per independent event:

```js
{
  event_id,
  verification_status: 'primary_verified' | 'corroborated' | 'unverified',
  evidence_grade: 'hard_fact_ready' | 'corroborated_fact_ready' | 'lead_only',
  canonical_record,
  supporting_sources: [{ url, host, tier, matched_anchors }],
  agreed_anchors,
  conflicts: []
}
```

Promotion rules:

```text
primary source + existing hard-fact bundle -> hard_fact_ready
first-party source about its own rule/recall + existing hard-fact bundle -> hard_fact_ready
2+ independent secondary/first-party hosts + 2+ agreed anchors including 1 hard anchor -> corroborated_fact_ready
same corporate group, syndicated text, repost chain, or conflicting amount/date/party -> lead_only
```

- [ ] **Step 4: Add conflict tests**

Conflicting penalty amounts, dates, parties, product batches, or disposition outcomes must block promotion unless a primary source resolves the conflict. The canonical record must never silently combine conflicting values.

- [ ] **Step 5: Verify and commit**

Run `node worker/test-runner.js`.

```bash
git add worker/evidence-corroboration.js worker/authority-resolver.js worker/test-runner.js
git commit -m "feat: verify events across independent evidence sources"
```

---

### Task 5: Integrate Corroborated Evidence Without Weakening Gates

**Files:**
- Modify: `worker/content-quality.js`
- Modify: `worker/premium-quality.js`
- Modify: `worker/index.js`
- Modify: `worker/run-local.js`
- Test: `worker/test-runner.js`
- Test: `worker/premium-hardfacts.test.js`

- [ ] **Step 1: Add failing integration tests**

Test four paths:

```text
single media source -> rejected
two independent sources with weak facts -> rejected
two independent sources with agreed hard anchors and complete card fields -> accepted
official source with complete hard facts -> accepted exactly as before
```

- [ ] **Step 2: Add corroboration before editorial and AI analysis**

The pipeline order becomes:

```text
catalog + discovered URLs
-> detail hydration/Crawl4AI
-> clean article evidence
-> hard-fact extraction
-> event clustering and corroboration
-> freshness
-> editorial gate
-> AI structuring
-> premium quality gate
-> DingTalk
```

AI receives only `hard_fact_ready` and `corroborated_fact_ready` candidates plus unverified leads in the separate lead context. AI cannot modify verification metadata.

- [ ] **Step 3: Make media exceptions narrow and explicit**

Replace unconditional media acceptance with this exact condition at editorial and premium boundaries:

```js
const corroborated = candidate.evidence_grade === 'corroborated_fact_ready'
  && candidate.verification_status === 'corroborated'
  && candidate.supporting_sources.length >= 2
  && candidate.agreed_anchors.length >= 2;
if (isNonAuthoritativeRepublisher(candidate) && !corroborated) reject();
```

All existing content checks run after this trust check. Corroboration is necessary but never sufficient.

- [ ] **Step 4: Verify validator diffs**

Run:

```bash
git diff -U0 -- worker/premium-quality.js
node worker/test-runner.js
node worker/hard-fact-extractor.test.js
node worker/premium-hardfacts.test.js
```

Manually confirm no hard-fact counts, required card fields, source URL validation, beauty relevance, navigation rejection, or broken-fragment rejection were removed.

- [ ] **Step 5: Commit**

```bash
git add worker/content-quality.js worker/premium-quality.js worker/index.js worker/run-local.js worker/test-runner.js worker/premium-hardfacts.test.js
git commit -m "feat: admit corroborated evidence through existing premium gates"
```

---

### Task 6: Wire The Formal Workflow And Audits

**Files:**
- Modify: `.github/workflows/weekly.yml`
- Modify: `worker/run-local.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Add failing workflow assertions**

Require these bounded settings:

```yaml
DISCOVERY_ENABLED: 1
DISCOVERY_MAX_ITEMS: 120
DISCOVERY_MAX_PER_HOST: 8
DISCOVERY_MAX_PER_MODULE: 30
REPORT_TARGET_ITEMS: 18
```

- [ ] **Step 2: Add workflow stages**

The formal workflow must run in this order:

```text
discover open web
build acquisition manifest
hydrate manifest with Crawl4AI
probe AI
run pipeline
```

Each stage prints counts for raw results, resolved direct URLs, hydrated pages, event clusters, primary verified, corroborated, conflicts, editorial accepted, and final premium cards.

- [ ] **Step 3: Add failure policy**

Discovery provider failure logs a warning and falls back to existing official acquisition. Malformed artifacts, fabricated source metadata, or a final premium quality failure remain fatal. No discovery outage may disable the current official path.

- [ ] **Step 4: Verify and commit**

Run `node worker/test-runner.js` and inspect the YAML.

```bash
git add .github/workflows/weekly.yml worker/run-local.js worker/test-runner.js
git commit -m "ci: add bounded open-web discovery and evidence audits"
```

---

### Task 7: Replay, Canary, And Release Gate

**Files:**
- No production files unless a verified defect is found.
- Generated artifacts: `out/discovery.json`, `out/hydrated-authority.json`, `out/latest-report.md`, `out/latest-report.json`

- [ ] **Step 1: Run all deterministic tests**

```bash
node worker/test-runner.js
node worker/hard-fact-extractor.test.js
node worker/premium-hardfacts.test.js
node --check worker/index.js
node --check worker/evidence-corroboration.js
node --check worker/open-web-discovery.js
node --check scripts/discover-open-web.js
node --check scripts/crawl4ai-hydrate.js
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run a no-delivery formal canary**

Run the workflow with the feature branch, duplicate delivery disabled, and `NO_DELIVERY=1`. Acceptance criteria:

```text
14-day unique direct candidates >= 80, unless discovery audit proves fewer results
hydrated discovered pages >= 60% of attempted direct URLs
every corroborated event has >= 2 independent hosts and >= 2 agreed anchors
every final card passes the unchanged premium validator
no final line contains Markdown page chrome, broken fragments, or oversized facts
at least 4 active modules when qualified evidence exists
final count targets 15-20 but may be lower; no padding is allowed
```

- [ ] **Step 3: Compare against the current branch baseline**

Produce a compact audit table:

```text
metric | baseline | expanded
candidate URLs
hydrated details
editorial accepted
premium accepted
active modules
single-media accepted (must be 0)
broken output fields (must be 0)
```

Do not release if premium acceptance rises by admitting single-source media, if golden cards regress, or if source conflicts are hidden.

- [ ] **Step 4: Push without triggering delivery**

After all gates pass, push `codex/content-quality-runtime` and report the exact SHA. The user manually triggers the delivery workflow.
