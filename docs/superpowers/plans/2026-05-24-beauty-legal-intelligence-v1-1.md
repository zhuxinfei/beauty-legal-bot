# Beauty Legal Intelligence v1.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the existing Worker implementation so Excel is treated as a source catalog, WeChat public accounts are lead-only sources, and every report item is a processed legal-intelligence insight rather than unprocessed news.

**Architecture:** Keep the existing Cloudflare Worker, KV, DeepSeek boundary, Feishu card, and HTML report routes. Add source-type classification, candidate/lead separation, type-specific schema validation, quality filtering, module-level limits, and renderers that display legal analysis fields per item type.

**Tech Stack:** Python 3 stdlib for Excel extraction; Cloudflare Workers JavaScript module syntax; Workers KV; DeepSeek Chat Completions API; Node.js smoke tests using `node:assert/strict`.

---

## File Structure

- Modify: `scripts/extract_sources.py` — classify source types as `official_site`, `industry_site`, `rss`, `wechat_public_account`, or `manual_link`; normalize modules to report module names.
- Modify: `worker/sources.json` — regenerated structured source catalog from Excel.
- Modify: `worker/sample-report.json` — fixture using v1.1 type-specific legal analysis fields.
- Modify: `worker/test-runner.js` — tests for source catalog expectations, lead generation, validation, filtering, module limits, HTML rendering, and Feishu summary.
- Modify: `worker/index.js` — candidate/lead collection, prompt update, type-specific schema validation, quality filtering, module limits, HTML and Feishu renderers.
- Modify: `README.md` — document v1.1 source handling and legal-analysis output.

---

### Task 1: Source Catalog Classification

**Files:**
- Modify: `scripts/extract_sources.py`
- Modify: `worker/sources.json`

- [ ] **Step 1: Add source type and module tests manually via validation command**

Run after implementation:

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
python3 - << 'PY'
import json
from collections import Counter
from pathlib import Path
data=json.loads(Path('worker/sources.json').read_text(encoding='utf-8'))
source_counts=Counter(s['source_type'] for s in data['sources'])
module_counts=Counter(s['module'] for s in data['sources'])
print('source_type', source_counts)
print('module', module_counts)
assert len(data['sources']) == 69
assert source_counts['wechat_public_account'] >= 40
assert module_counts['uncategorized'] == 0
assert all(s['module'] in {
  '新规/修订/废止/生效提醒',
  '广告合规及处罚案例',
  '美妆行业动态',
  '知识产权动态',
  '进出口/跨境电商动态',
} for s in data['sources'])
PY
```

Expected output includes `source_type Counter(...)` with at least 40 `wechat_public_account` entries and no assertion errors.

- [ ] **Step 2: Implement classification**

Change `classify_module`, `classify_source_type`, `classify_authority`, and `classify_priority` so:

- `url == "微信公众号"` or name/url contains `公众号`, `微信`, `mp.weixin.qq.com`, `weixin` → `wechat_public_account`.
- `url` containing RSS/Atom/feed → `rss`.
- `url` starting with `http` and using official/government/regulator keywords → `official_site`.
- other HTTP URLs → `industry_site`.
- non-HTTP non-WeChat concrete links → `manual_link` only if they are not empty and not generic labels.
- modules normalize to the five report modules.

- [ ] **Step 3: Regenerate sources and validate**

Run the validation command from Step 1.

- [ ] **Step 4: Commit**

```bash
git add scripts/extract_sources.py worker/sources.json
git commit -m "Classify legal intelligence source catalog"
```

---

### Task 2: Candidates and Leads

**Files:**
- Modify: `worker/index.js`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Write failing tests**

Add tests that import `makeLead` and `splitSources`:

```js
function testSplitSourcesSeparatesWechatLeads() {
  const sources = [
    { name: '化妆品观察', url: '微信公众号', source_type: 'wechat_public_account', module: '美妆行业动态', country: '中国', topics: ['化妆品'] },
    { name: '国家药监局', url: 'https://www.nmpa.gov.cn/', source_type: 'official_site', module: '新规/修订/废止/生效提醒', country: '中国', topics: ['化妆品'] },
  ];
  const split = splitSources(sources);
  assert.equal(split.fetchableSources.length, 1);
  assert.equal(split.leadSources.length, 1);
  assert.equal(makeLead(split.leadSources[0]).name, '化妆品观察');
}
```

Run: `node worker/test-runner.js`
Expected: fails because exports do not exist.

- [ ] **Step 2: Implement lead helpers**

Add:

```js
export function makeLead(source) {
  return {
    name: source.name,
    source_type: source.source_type,
    module: source.module,
    region: source.region,
    country: source.country,
    topics: source.topics || [],
    priority: source.priority,
  };
}

export function splitSources(sources = sourceCatalog.sources) {
  const leadSources = sources.filter(source => source.source_type === 'wechat_public_account');
  const fetchableSources = sources.filter(source => source.source_type !== 'wechat_public_account');
  return { fetchableSources, leadSources };
}
```

Update `collectCandidates()` to return `{ candidates, leads, failures }` and never fetch WeChat lead sources.

- [ ] **Step 3: Verify**

Run: `node worker/test-runner.js`
Expected: `worker pure function tests ok`.

- [ ] **Step 4: Commit**

```bash
git add worker/index.js worker/test-runner.js
git commit -m "Separate candidate sources from lead sources"
```

---

### Task 3: v1.1 Legal Analysis Schema

**Files:**
- Modify: `worker/index.js`
- Modify: `worker/sample-report.json`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Write failing tests**

Add tests for `validateReport`, `filterReportQuality`, and `limitReportSections`:

```js
function testValidateReportRequiresRegulationAnalysis() {
  const report = structuredClone(sampleReport);
  assert.equal(validateReport(report), true);
  const broken = structuredClone(sampleReport);
  delete broken.sections[0].items[0].what_changed;
  assert.throws(() => validateReport(broken), /what_changed/);
}

function testFilterReportQualityDropsItemsWithoutSourceUrl() {
  const report = structuredClone(sampleReport);
  report.sections[0].items.push({ ...report.sections[0].items[0], title: '无链接项', source_url: '' });
  const filtered = filterReportQuality(report);
  assert.equal(filtered.sections[0].items.length, 1);
}

function testLimitReportSectionsCapsNonRegulatoryModules() {
  const report = { period: sampleReport.period, summary: [], risk_alerts: [], sections: [{ module: '广告合规及处罚案例', items: Array.from({ length: 4 }, (_, i) => ({ ...sampleReport.sections[1].items[0], title: `案例${i}`, source_url: `https://example.com/${i}` })) }] };
  const limited = limitReportSections(report);
  assert.equal(limited.sections[0].items.length, 3);
}
```

Run: `node worker/test-runner.js`
Expected: fails because functions/fields are missing.

- [ ] **Step 2: Update sample report**

Add at least one regulation item and one case item using required v1.1 fields:

- regulation: `what_changed`, `legal_obligation`, `affected_business`, `recommended_actions`, `owner_teams`, `risk_level`, `why_it_matters`, `confidence`, `effective_date`, `feedback_deadline`, `regulatory_area`, `next_deadline`.
- case: `facts`, `violation_logic`, `penalty_or_result`, `risk_pattern`, `business_lessons`, `recommended_actions`, `owner_teams`, `risk_level`, `why_it_matters`, `confidence`.

- [ ] **Step 3: Implement validation and quality filtering**

Add exported functions:

- `getRequiredFields(item)`
- `hasSpecificActions(item)`
- `filterReportQuality(report)`
- `limitReportSections(report)`
- update `validateReport(report)` to enforce type-specific required fields.

- [ ] **Step 4: Integrate pipeline**

After `deepseekAnalyze`, run:

```js
const report = limitReportSections(filterReportQuality(dedupeReport(rawReport)));
validateReport(report);
```

- [ ] **Step 5: Verify**

Run: `node worker/test-runner.js`
Expected: `worker pure function tests ok`.

- [ ] **Step 6: Commit**

```bash
git add worker/index.js worker/test-runner.js worker/sample-report.json
git commit -m "Enforce legal analysis report schema"
```

---

### Task 4: Prompt, HTML, and Feishu Output

**Files:**
- Modify: `worker/index.js`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Write tests**

Add tests that assert:

- `buildAnalysisPromptForTest()` includes `leads` and says leads are not facts.
- HTML includes `变化点`, `法务拆解`, `违法逻辑`, `合规动作`.
- Feishu summary includes `动作：`.

- [ ] **Step 2: Export prompt builder for tests**

Rename/export `buildAnalysisPrompt` as `buildAnalysisPromptForTest` or export the existing function.

- [ ] **Step 3: Update prompt**

Prompt must state:

- User is a beauty-company legal/compliance professional.
- Do not output unprocessed news.
- WeChat leads are topic leads only, not fact sources.
- Final items require public `source_url`.
- Regulations and cases require legal analysis fields.
- Empty advice like “建议关注” is forbidden.

- [ ] **Step 4: Update renderers**

HTML should render by item type:

- Regulation labels: `变化点`, `法务拆解`, `影响范围`, `合规动作`, `截止节点`.
- Case labels: `案情`, `违法逻辑`, `处罚/结果`, `业务启示`, `排查动作`.
- IP and import/export use their type-specific fields.

Feishu should show:

```text
[类型][国家] 标题
动作：第一条 recommended_actions
```

- [ ] **Step 5: Verify**

Run: `node worker/test-runner.js`
Expected: `worker pure function tests ok`.

- [ ] **Step 6: Commit**

```bash
git add worker/index.js worker/test-runner.js
git commit -m "Render legal analysis report details"
```

---

### Task 5: Documentation and Final Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/PROJECT_TASK_BRIEF.md` if implementation details change

- [ ] **Step 1: Update README**

Document:

- Excel is source catalog only.
- WeChat public accounts are leads only.
- Final report is organized by modules.
- Each item is legal analysis with actions.
- No high-quality item means no filler.

- [ ] **Step 2: Run final verification**

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
node worker/test-runner.js
node --check worker/index.js
python3 - << 'PY'
import json
from collections import Counter
from pathlib import Path
data=json.loads(Path('worker/sources.json').read_text(encoding='utf-8'))
print(Counter(s['source_type'] for s in data['sources']))
print(Counter(s['module'] for s in data['sources']))
assert len(data['sources']) == 69
assert sum(1 for s in data['sources'] if s['source_type']=='wechat_public_account') >= 40
assert all(s['module'] != 'uncategorized' for s in data['sources'])
PY
```

Expected output includes:

```text
Wrote 69 sources to worker/sources.json
worker pure function tests ok
```

- [ ] **Step 3: Commit**

```bash
git add README.md docs/PROJECT_TASK_BRIEF.md worker/sources.json scripts/extract_sources.py worker/index.js worker/test-runner.js worker/sample-report.json
git commit -m "Implement legal intelligence v1.1"
```

---

## Self-Review

Spec coverage:

- Excel source catalog: Task 1.
- WeChat as leads only: Tasks 1-2 and Task 4 prompt.
- Candidate/lead split: Task 2.
- Type-specific legal analysis schema: Task 3.
- Quality filtering and module limits: Task 3.
- HTML and Feishu legal-analysis display: Task 4.
- Documentation and verification: Task 5.

Placeholder scan: no TBD/TODO placeholders remain in actionable steps.

Type consistency: source types, module names, report fields, and function names are defined before use and reused consistently across tasks.
