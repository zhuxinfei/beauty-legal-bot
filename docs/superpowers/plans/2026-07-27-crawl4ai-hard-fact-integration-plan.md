# Crawl4AI Hard Fact Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan is subordinate to `docs/superpowers/plans/2026-07-27-premium-output-root-cause-and-repair-plan.md`; if the two conflict, the root-cause plan wins.

**Goal:** Upgrade Crawl4AI from a generic page-text hydration helper into the hard-fact evidence collection layer for beauty legal premium DingTalk cards.

**Architecture:** Crawl4AI should run before AI summarization as a deep evidence collector: official source page -> detail links -> attachments -> normalized evidence records -> hard-fact extraction -> candidate grading. LLM summarization only receives `hard_fact_ready` candidates and may not invent missing facts.

**Tech Stack:** Node.js scripts, Python Crawl4AI runtime, existing `worker/source-hydration.js`, `worker/premium-quality.js`, `scripts/crawl4ai-hydrate.js`, GitHub Actions weekly workflow, DingTalk markdown webhook.

---

## Non-Negotiable Shift

The old model is forbidden:

```text
Crawl4AI grabs page text -> pipeline treats text as better candidate evidence -> LLM tries to summarize
```

The new model is required:

```text
Crawl4AI discovers hard evidence -> extracts hard facts -> grades candidates -> only hard_fact_ready candidates can enter premium cards
```

The product target remains the approved premium card sample:

```text
主体：广州赫姿化妆品有限公司、广州尚美生物科技有限公司
违法行为：冒用爱马仕商标
金额：63.5万元
没收/处置：没收大量侵权货品
依据：《商标法》
影响流程：商标授权、包装设计、达人素材、平台店铺
```

---

## Crawl4AI Responsibilities After This Plan

### 1. Deep Discovery

Crawl4AI must treat official source pages as lead pages unless they already contain a hard legal event.

Lead pages include:

```text
homepage
portal page
topic page
column/list page
search result page
generic guidance page
consumer safety page
official regulatory entry page
```

When a lead page is detected, Crawl4AI must extract and rank links to:

```text
行政处罚
处罚决定
典型案例
征求意见
公告
通告
标准
新旧衔接
商标
专利
侵权
海关
进口
出口
HS编码
PDF
XLS/XLSX
DOC/DOCX
附件
```

### 2. Attachment Retrieval

Crawl4AI must not stop at the HTML page when the useful evidence is in attachments.

Attachment types:

```text
PDF
XLS
XLSX
DOC
DOCX
CSV
```

Each attachment should become evidence text with:

```js
{
  attachment_url,
  attachment_type,
  attachment_text,
  extraction_status,
  extraction_error
}
```

### 3. Hard-Fact Extraction

Each hydrated detail page or attachment must be normalized into:

```js
{
  evidence_grade: 'hard_fact_ready' | 'lead_only' | 'attachment_pending' | 'reject',
  evidence_reason,
  hard_facts: {
    authority,
    document_number,
    involved_party,
    violation_behavior,
    penalty_amount,
    confiscation_result,
    legal_basis,
    product_or_batch,
    hs_code,
    effective_date,
    deadline,
    feedback_channel,
    affected_processes
  },
  evidence_quotes: {
    authority,
    document_number,
    involved_party,
    violation_behavior,
    penalty_amount,
    confiscation_result,
    legal_basis,
    product_or_batch,
    hs_code,
    effective_date,
    deadline,
    feedback_channel
  }
}
```

`evidence_quotes` must contain short source snippets supporting extracted fields.

### 4. Candidate Grading

Only this grade may enter the premium card pool:

```text
hard_fact_ready
```

These grades must not enter premium cards:

```text
lead_only
attachment_pending
reject
```

### 5. Reporting Metrics

Formal logs must report:

```text
Crawl4AI lead pages crawled
Crawl4AI detail pages discovered
Crawl4AI detail pages crawled
Crawl4AI attachments discovered
Crawl4AI attachments parsed
hard_fact_ready total
China hard_fact_ready total
lead_only total
attachment_pending total
reject total
```

Do not use `hydrated records` as quality proof.

---

## Files And Responsibilities

### `scripts/crawl4ai-hydrate.js`

Responsibilities:

```text
Run Crawl4AI.
Prioritize China official/legal sources.
Identify lead pages.
Extract detail links and attachment links.
Crawl details within strict budgets.
Emit normalized hydration records with evidence grades and hard facts.
```

### `worker/source-hydration.js`

Responsibilities:

```text
Normalize hydrated records into candidates.
Preserve evidence_grade, evidence_reason, hard_facts, evidence_quotes, attachment metadata.
Do not mark a record as premium-ready just because it has article_text.
```

### `worker/content-quality.js`

Responsibilities:

```text
Treat hard_fact_ready as primary evidence.
Keep lead_only as discovery evidence only.
Reject or demote attachment_pending and reject grades.
```

### `worker/premium-quality.js`

Responsibilities:

```text
Allow premium candidate fallback only from hard_fact_ready records.
Require sample-grade hard facts before final markdown.
Reject portal/topic/generic pages even if official.
```

### `worker/index.js`

Responsibilities:

```text
Log Crawl4AI evidence-grade metrics.
Fail before sending when hard_fact_ready count is insufficient.
Save and send the same final markdown.
```

### `worker/premium-hardfacts.test.js`

Responsibilities:

```text
Lock manual-sample quality.
Test Crawl4AI-derived candidates with extracted hard facts.
Test portal pages cannot become premium cards.
```

### `worker/test-runner.js`

Responsibilities:

```text
Prove formal pipeline sends only verified premium markdown.
Prove final payload uses hard_fact_ready records, not lead_only records.
```

---

## Evidence Grade Definitions

### `hard_fact_ready`

Required:

```text
official or primary source
not a portal/topic/generic page
at least 2 objective hard facts
hard legal event present
beauty/legal relevance present
source URL points to detail page or attachment-backed detail
```

Examples:

```text
行政处罚决定书 with party + amount
征求意见通知 with document title + feedback deadline
海关公告 with document number + HS code/import declaration detail
商标侵权 case with party + penalty/disposition/legal basis
```

### `lead_only`

Use when:

```text
official page has relevant links but does not itself contain hard facts
homepage/column page lists candidate detail pages
topic page is useful only for discovery
```

### `attachment_pending`

Use when:

```text
HTML page indicates useful attachment exists
attachment cannot be parsed in the current run
hard facts are likely inside the attachment
```

### `reject`

Use when:

```text
generic safety use page
consumer education page
search page without relevant result
source page without beauty/legal relevance
republished media article
overseas explainer page without direct duty/enforcement event
```

---

## Source-Specific Strategy

### NMPA / 药监

Prioritize:

```text
征求意见
公告
标准
化妆品备案/注册
新旧衔接
过渡期
附件
```

Extract:

```text
authority
document_number
deadline
feedback_channel
effective_date
affected_processes: 配方开发, 标签备案, 执行标准选择, 存量SKU过渡期管理
```

### 市监局 / 市监总局

Prioritize:

```text
行政处罚
处罚决定
典型案例
广告违法
虚假宣传
反不正当竞争
商标侵权
刷单/虚假交易
```

Extract:

```text
authority
involved_party
violation_behavior
penalty_amount
confiscation_result
legal_basis
product_or_batch
affected_processes: 广告宣传, 达人素材, 平台店铺, 商标授权, 包装设计
```

### 海关

Prioritize:

```text
公告
税则
进口申报
通关
检验检疫
HS编码
附件
```

Extract:

```text
authority
document_number
hs_code
product_or_batch
effective_date
legal_basis
affected_processes: 进口申报, 清关, 原产地文件, 中文标签, 供应链履约
```

### CNIPA / 法院

Prioritize:

```text
商标
专利
著作权
侵权
判决
裁定
典型案例
保护规划 only when there is concrete obligation or action entry
```

Extract:

```text
authority
involved_party
violation_behavior
legal_basis
penalty_amount or result
product_or_batch
affected_processes: 商标授权, 包装设计, 达人素材, 平台店铺, 新品命名
```

---

## Implementation Tasks

### Task 1: Add Evidence Grade Schema

**Files:**
- Modify: `worker/source-hydration.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Write failing normalization test**

Add a test that normalizes a hydrated record with hard facts:

```js
const record = normalizeHydratedRecord({
  source_url: 'https://amr.example.gov.cn/case/1',
  title: '广州妍瑟化妆品有限公司侵权玻色因商标并刷单，被罚17万元',
  article_text: '当事人广州妍瑟化妆品有限公司侵权使用玻色因相关商标，同时存在刷单行为，罚款17万元。',
  evidence_grade: 'hard_fact_ready',
  evidence_reason: 'party+violation+amount',
  hard_facts: {
    authority: '市场监督管理局',
    involved_party: '广州妍瑟化妆品有限公司',
    violation_behavior: '侵权使用玻色因相关商标，同时存在刷单行为',
    penalty_amount: '17万元'
  },
  evidence_quotes: {
    involved_party: '当事人广州妍瑟化妆品有限公司',
    penalty_amount: '罚款17万元'
  }
});

assert.equal(record.evidence_grade, 'hard_fact_ready');
assert.equal(record.hard_facts.involved_party, '广州妍瑟化妆品有限公司');
assert.equal(record.evidence_quotes.penalty_amount, '罚款17万元');
```

- [ ] **Step 2: Implement normalization**

Ensure output preserves:

```js
evidence_grade
evidence_reason
hard_facts
evidence_quotes
attachment_urls
attachment_records
```

- [ ] **Step 3: Run test**

Run:

```bash
node worker/test-runner.js
```

Expected:

```text
New evidence-grade normalization test passes.
Existing unrelated source-budget assertion may still fail at the end.
```

### Task 2: Add Hard-Fact Extractor

**Files:**
- Create: `worker/hard-fact-extractor.js`
- Test: `worker/hard-fact-extractor.test.js`

- [ ] **Step 1: Write extractor tests**

Create tests for penalty, policy, customs, and IP cases:

```js
import assert from 'node:assert/strict';
import { extractHardFacts, gradeEvidence } from './hard-fact-extractor.js';

const penaltyText = '当事人广州妍瑟化妆品有限公司侵权使用玻色因相关商标，同时存在刷单行为，罚款17万元。依据《商标法》《反不正当竞争法》。';
const penalty = extractHardFacts(penaltyText, { source_name: '广州市市场监督管理局', module: '知识产权动态' });
assert.equal(penalty.involved_party, '广州妍瑟化妆品有限公司');
assert.equal(penalty.penalty_amount, '17万元');
assert.match(penalty.violation_behavior, /玻色因/);
assert.equal(gradeEvidence({ text: penaltyText, hard_facts: penalty, source_url: 'https://amr.example.gov.cn/case/1' }).evidence_grade, 'hard_fact_ready');
```

- [ ] **Step 2: Implement extractor**

Export:

```js
export function extractHardFacts(text, context = {}) {}
export function gradeEvidence({ text, hard_facts, source_url, title, source_name, country }) {}
```

Extractor must capture:

```text
authority
document_number
involved_party
violation_behavior
penalty_amount
confiscation_result
legal_basis
product_or_batch
hs_code
effective_date
deadline
feedback_channel
affected_processes
```

- [ ] **Step 3: Run extractor test**

Run:

```bash
node worker/hard-fact-extractor.test.js
```

Expected:

```text
All extractor tests pass.
```

### Task 3: Upgrade Crawl4AI Hydration Records

**Files:**
- Modify: `scripts/crawl4ai-hydrate.js`
- Modify: `worker/source-hydration.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Add grade and hard facts to each Crawl4AI record**

For each crawled page, build:

```js
const hardFacts = extractHardFacts(articleText, {
  title,
  source_name,
  source_url,
  module,
  country,
});
const evidence = gradeEvidence({
  text: articleText,
  hard_facts: hardFacts,
  source_url,
  title,
  source_name,
  country,
});
```

- [ ] **Step 2: Emit grade fields**

Record shape must include:

```js
{
  evidence_grade: evidence.evidence_grade,
  evidence_reason: evidence.evidence_reason,
  hard_facts: hardFacts,
  evidence_quotes: evidence.evidence_quotes || {}
}
```

- [ ] **Step 3: Log grade metrics**

Log:

```text
hard_fact_ready=<n>, china_hard_fact_ready=<n>, lead_only=<n>, attachment_pending=<n>, reject=<n>
```

### Task 4: Deep Link Discovery

**Files:**
- Modify: `scripts/crawl4ai-hydrate.js`
- Test: `worker/test-runner.js` or create `scripts/crawl4ai-hydrate.test.js`

- [ ] **Step 1: Extract candidate detail links from lead pages**

Implement a link scorer with keywords:

```js
const HARD_DETAIL_LINK_PATTERN = /行政处罚|处罚决定|典型案例|征求意见|公告|通告|标准|商标|专利|侵权|海关|进口|出口|HS\s*编码|附件|pdf|xlsx?/i;
```

- [ ] **Step 2: Crawl top detail links**

Per source:

```text
maxDetailLinksPerSource = 3
China high-priority sources first
Do not crawl arbitrary infinite links
```

- [ ] **Step 3: Preserve parent-child relationship**

Record fields:

```js
{
  parent_source_url,
  source_url,
  discovery_reason,
  discovery_rank
}
```

### Task 5: Attachment Parsing

**Files:**
- Modify: `scripts/crawl4ai-hydrate.js`
- Test: `scripts/crawl4ai-hydrate.test.js`

- [ ] **Step 1: Identify attachment URLs**

Accept:

```text
.pdf
.xls
.xlsx
.doc
.docx
.csv
```

- [ ] **Step 2: Parse attachments within budget**

Budget:

```text
maxAttachmentsPerSource = 2
timeout per attachment = 15000ms
```

- [ ] **Step 3: Merge attachment text into evidence**

Use:

```js
article_text = [pageText, ...attachmentTexts].filter(Boolean).join('\n\n--- ATTACHMENT ---\n\n');
```

### Task 6: Gate Premium Cards On `hard_fact_ready`

**Files:**
- Modify: `worker/premium-quality.js`
- Test: `worker/premium-hardfacts.test.js`

- [ ] **Step 1: Reject fallback candidates that are not hard fact ready**

In candidate fallback:

```js
.filter(candidate => candidate.evidence_grade === 'hard_fact_ready' || objectiveHardFactCount(candidate.hard_facts || {}) >= 2)
```

- [ ] **Step 2: Add failing test for lead-only portal page**

Test:

```js
const delivery = buildPremiumDingTalkDelivery(reportWithOnlyForeignItems, {
  candidates: [{
    title: '欢迎访问中华商标网',
    country: '中国',
    evidence_grade: 'lead_only',
    article_text: '中华商标网首页提供商标服务入口。',
    hard_facts: {}
  }]
});
assert.equal(delivery.audit.finalChinaItems, 0);
assert.throws(() => assertPremiumChinaDelivery(delivery.audit), /China|hard-fact/);
```

### Task 7: Local Preview Without Push

**Files:**
- Read: `out/latest-report.md`
- Read: `out/latest-report.json`

- [ ] **Step 1: Generate artifact-only preview**

Run:

```bash
ARTIFACT_ONLY=1 FORCE_DELIVERY=0 node worker/run-local.js
```

Expected:

```text
No DingTalk webhook call.
out/latest-report.md written.
```

- [ ] **Step 2: Inspect forbidden terms**

Run:

```bash
rg -n "Crawl4AI|建议动作|法务判断|事实摘要|来源链接|管理层摘要|欢迎访问|专题页|入口页|安全使用" out/latest-report.md
```

Expected:

```text
No matches.
```

- [ ] **Step 3: Show preview to user**

Action:

```text
Paste final markdown in chat.
Do not push to DingTalk.
```

---

## Acceptance Criteria

This plan is complete only when:

```text
1. Crawl4AI logs hard_fact_ready counts, not only hydrated record counts.
2. China hard_fact_ready count is visible before AI analysis.
3. Final premium cards only use hard_fact_ready or equivalent sample-grade records.
4. Portal/topic/generic pages cannot enter final premium cards.
5. Final markdown contains no forbidden old wording.
6. Final markdown is shown locally before any DingTalk push.
```

---

## Current Execution Rule

Until this plan is implemented:

```text
Do not trigger a DingTalk push.
Do not call a workflow success a content success.
Do not increase quantity.
Do not ask LLM to compensate for missing hard facts.
```
