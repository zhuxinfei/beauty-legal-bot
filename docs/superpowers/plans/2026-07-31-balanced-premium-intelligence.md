# Balanced Premium Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver 18-22 sample-grade DingTalk cards on every successful run, with all six legal-intelligence modules represented by at least two cards.

**Architecture:** Replace global title-gated discovery with six independent query lanes that retain query provenance and judge relevance after article hydration. Preserve lane identity through AI analysis, then use a quota-aware premium portfolio selector and a pre-delivery contract that rejects incomplete reports without weakening any card-level evidence rule.

**Tech Stack:** Node.js 22, Cloudflare Worker JavaScript, Google News RSS, GDELT, Crawl4AI, GitHub Actions, DingTalk Markdown.

---

### Task 1: Category-Aware Discovery

**Files:**
- Modify: `worker/open-web-discovery.js`
- Modify: `scripts/discover-open-web.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Write failing discovery tests**

Add tests proving that a query-backed result titled `某公司虚假宣传被罚20万元` survives the discovery stage even when its title omits a beauty keyword, while promotional results remain rejected. Add a test proving raw and accepted counts are reported per module and that one module cannot consume another module's `maxPerModule` allowance.

- [ ] **Step 2: Run the discovery tests and verify RED**

Run `node worker/test-runner.js`. Expected: failure because discovery still requires `BEAUTY.test(item.title)` and does not expose per-module accepted counts.

- [ ] **Step 3: Implement query lanes and provenance-aware admission**

Expand each module from two generic queries to a bounded matrix of event, authority, product, and channel queries. Store `discovery_query`, `discovery_module`, and query-backed beauty context on every result. Replace title-only beauty admission with this rule: reject promotion and titles lacking a module-specific legal-event signal; defer beauty relevance to hydrated text when the result came from a beauty-scoped query. Keep URL, date, host, and per-module bounds.

- [ ] **Step 4: Add a 30-day category recovery pass**

Run the 14-day pass first. For modules below `DISCOVERY_MIN_PER_MODULE`, issue only that module's recovery queries with a 30-day window, merge by canonical URL, and preserve actual publication dates. Log `raw`, `resolved`, and `accepted` counts for each module.

- [ ] **Step 5: Verify GREEN**

Run `node worker/test-runner.js` and syntax checks for `worker/open-web-discovery.js` and `scripts/discover-open-web.js`. Expected: all pass.

### Task 2: Category Evidence Budgets

**Files:**
- Modify: `scripts/crawl4ai-hydrate.js`
- Modify: `worker/index.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Write failing budget tests**

Add fixtures containing many regulation candidates and at least five candidates in every other module. Assert hydration selection and analysis batching retain a configured minimum from every module before filling remaining global capacity.

- [ ] **Step 2: Run tests and verify RED**

Run `node worker/test-runner.js`. Expected: regulations consume the global priority list and at least one module receives no selected candidates.

- [ ] **Step 3: Implement balanced hydration selection**

Select up to `CRAWL4AI_MIN_PER_MODULE` candidates from each module first, ordered by source trust and freshness, then fill the remaining hydration budget globally. Do not promote lead-only or unverified media records merely to satisfy a module floor.

- [ ] **Step 4: Preserve module identity through evidence processing**

Carry `discovery_module` and canonical `module` through acquisition-manifest creation, Crawl4AI records, corroboration, candidate merge, main AI materialization, and rescue materialization. Prevent generic signal inference from replacing an explicit valid module.

- [ ] **Step 5: Add module acquisition audit**

Log one structured row per module with discovered, resolved, hydrated, evidence-eligible, AI-accepted, and final counts plus rejection reasons.

- [ ] **Step 6: Verify GREEN**

Run `node worker/test-runner.js`, `node worker/hard-fact-extractor.test.js`, and syntax checks for every modified file. Expected: all pass.

### Task 3: Balanced Premium Portfolio

**Files:**
- Modify: `worker/premium-quality.js`
- Modify: `worker/index.js`
- Test: `worker/premium-hardfacts.test.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Write failing portfolio tests**

Create 24 sample-grade fixtures across all six canonical premium modules. Assert selection first takes two cards per module, then fills to 20 by quality score, never exceeds five cards in one module, and never admits a weak card to meet a quota.

- [ ] **Step 2: Run tests and verify RED**

Run `node worker/premium-hardfacts.test.js`. Expected: current score-only selection permits module dominance and does not expose module counts.

- [ ] **Step 3: Implement quota-aware selection**

After card-level validation and event deduplication, select the top two cards from each canonical module. Fill remaining slots to `PREMIUM_TARGET_ITEMS=20` by score, China relevance, source strength, and freshness while enforcing `PREMIUM_MAX_PER_MODULE=5`. Never select a card rejected by `isSampleGradeCard` or `validatePremiumEvidenceCard`.

- [ ] **Step 4: Extend delivery audit**

Return `finalItemsByModule`, `missingModules`, `underfilledModules`, `targetItems`, and `minimumItems` from `buildPremiumDingTalkDelivery`.

- [ ] **Step 5: Verify GREEN**

Run `node worker/premium-hardfacts.test.js` and `node worker/test-runner.js`. Expected: balanced fixture yields 20 cards and weak fixtures remain rejected.

### Task 4: Delivery Contract And Workflow Configuration

**Files:**
- Modify: `worker/premium-quality.js`
- Modify: `worker/index.js`
- Modify: `.github/workflows/weekly.yml`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Write failing delivery tests**

Assert that 17 cards, any missing module, or any module with fewer than two cards throws a descriptive `Premium portfolio gate failed` error before `notifyReport`. Assert 18-22 cards with all module floors pass.

- [ ] **Step 2: Run tests and verify RED**

Run `node worker/test-runner.js`. Expected: current delivery assertion checks China and sample grade only.

- [ ] **Step 3: Implement the hard portfolio gate**

Add `assertPremiumPortfolioDelivery` with defaults `minimumItems=18`, `maximumItems=22`, `minimumPerModule=2`, and all six canonical modules required. Invoke it immediately after `assertPremiumChinaDelivery` and before report-ready hooks, deduplication, or delivery. An underfilled run must fail without DingTalk delivery.

- [ ] **Step 4: Configure production budgets**

Set workflow variables for target 20, min 18, max 22, min two per module, max five per module, balanced discovery and hydration floors, and the bounded 30-day recovery window. Keep duplicate-debug and no-delivery controls unchanged.

- [ ] **Step 5: Run complete verification**

Run:

```bash
node worker/test-runner.js
node worker/hard-fact-extractor.test.js
node worker/premium-hardfacts.test.js
node --check worker/index.js
node --check worker/open-web-discovery.js
node --check worker/premium-quality.js
node --check scripts/discover-open-web.js
node --check scripts/crawl4ai-hydrate.js
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 6: Commit and push without triggering Actions**

Commit production code, tests, workflow, spec, and plan to `codex/content-quality-runtime`, push the branch, verify the remote SHA, and do not dispatch the workflow. Production success remains unproven until the user's manual run returns 18-22 cards with all six modules.
