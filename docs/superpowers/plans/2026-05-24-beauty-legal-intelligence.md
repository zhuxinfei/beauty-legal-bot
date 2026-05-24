# Beauty Legal Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or the Superpowers inline plan execution skill to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `beauty-legal-bot` into a weekly cosmetics legal intelligence radar that uses the user's Excel source list, generates a Feishu summary card, and hosts a full HTML report page via Cloudflare Worker.

**Architecture:** Convert the Excel source list into `worker/sources.json`, fetch public official/industry pages into normalized candidates, ask DeepSeek to produce structured JSON, render both Feishu summary and full HTML report, persist the report in KV, and send a weekly Monday-morning Feishu card. Keep DeepSeek as the only implemented LLM provider while isolating it behind a small function boundary for future replacement.

**Tech Stack:** Cloudflare Workers JavaScript module syntax, Workers KV, DeepSeek Chat Completions API, Feishu custom bot webhook, local Python 3 stdlib for Excel conversion and validation scripts.

---

## File Structure

Create/modify these files:

- Create: `scripts/extract_sources.py` — local utility that converts the Excel workbook into `worker/sources.json` using only Python stdlib (`zipfile`, `xml.etree.ElementTree`).
- Create: `worker/sources.json` — structured source catalog derived from Excel, manually adjustable.
- Create: `worker/sample-report.json` — deterministic fixture for render tests and local previews.
- Create: `worker/test-runner.js` — small Node-based smoke tests for pure functions in `worker/index.js`.
- Modify: `worker/index.js` — replace current DeepSeek-only Markdown report with source fetching, candidate normalization, DeepSeek JSON analysis, HTML rendering, report routes, Feishu summary card, and KV persistence.
- Modify: `worker/wrangler.toml` — change cron from daily to weekly Monday 08:00 Beijing (`0 0 * * 1`).
- Modify: `README.md` — document source workflow, weekly schedule, report URLs, and verification commands.
- Modify: `beauty_legal_bot.py` — keep it as a local test helper or simplify it to call the same DeepSeek JSON schema; it does not deploy.

---

### Task 1: Generate Structured Source Catalog

**Files:**
- Create: `scripts/extract_sources.py`
- Create: `worker/sources.json`
- Test: command-line validation in this task

- [ ] **Step 1: Create the extraction script**

Create `scripts/extract_sources.py` as a Python 3 stdlib-only script that:

- Reads the first worksheet from the Excel workbook using `zipfile` and `xml.etree.ElementTree`.
- Reads rows with columns `序号`, `网站名称`, `网址`, `分类`.
- Classifies missing modules by source name and URL keywords.
- Classifies region/country by source name and URL keywords.
- Writes JSON as `{ "sources": [...] }`.

Core classification rules:

```python
MODULE_RULES = [
    ("广告", "广告合规及处罚案例"),
    ("市监", "广告合规及处罚案例"),
    ("市场监督", "广告合规及处罚案例"),
    ("药品监督", "新规及案例动态"),
    ("药监", "新规及案例动态"),
    ("NMPA", "新规及案例动态"),
    ("海关", "进出口动态"),
    ("知识产权", "知识产权动态"),
    ("检察", "新规及案例动态"),
    ("法院", "新规及案例动态"),
    ("化妆品", "美妆动态"),
    ("美妆", "美妆动态"),
]

REGION_RULES = [
    ("中国", "亚洲", "中国"),
    ("国家", "亚洲", "中国"),
    ("上海", "亚洲", "中国"),
    ("杭州", "亚洲", "中国"),
    ("北京", "亚洲", "中国"),
    ("广州", "亚洲", "中国"),
    ("浙江", "亚洲", "中国"),
    ("广东", "亚洲", "中国"),
    ("海关", "亚洲", "中国"),
    ("FDA", "北美", "美国"),
    ("欧盟", "欧洲", "欧盟"),
    ("EU", "欧洲", "欧盟"),
    ("ECHA", "欧洲", "欧盟"),
    ("SCCS", "欧洲", "欧盟"),
    ("BPOM", "亚洲", "印尼"),
    ("印尼", "亚洲", "印尼"),
    ("泰国", "亚洲", "泰国"),
    ("越南", "亚洲", "越南"),
    ("菲律宾", "亚洲", "菲律宾"),
    ("马来西亚", "亚洲", "马来西亚"),
    ("AICIS", "大洋洲", "澳大利亚"),
    ("澳大利亚", "大洋洲", "澳大利亚"),
    ("新西兰", "大洋洲", "新西兰"),
    ("墨西哥", "北美", "墨西哥"),
    ("意大利", "欧洲", "意大利"),
]
```

- [ ] **Step 2: Run the extractor**

Run:

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
```

Expected output:

```text
Wrote 69 sources to worker/sources.json
```

- [ ] **Step 3: Validate generated source schema**

Run:

```bash
python3 - << 'PY'
import json
from pathlib import Path
p = Path('worker/sources.json')
data = json.loads(p.read_text(encoding='utf-8'))
required = {'id','name','url','module','region','country','source_type','authority_type','priority','topics'}
assert isinstance(data.get('sources'), list)
assert len(data['sources']) == 69
for s in data['sources']:
    missing = required - set(s)
    assert not missing, (s.get('name'), missing)
    assert isinstance(s['topics'], list) and s['topics']
print('sources schema ok')
PY
```

Expected output:

```text
sources schema ok
```

- [ ] **Step 4: Commit source catalog work**

```bash
git add scripts/extract_sources.py worker/sources.json
git commit -m "Add structured legal intelligence sources"
```

---

### Task 2: Add Worker Pure Function Tests and Source Utilities

**Files:**
- Modify: `worker/index.js`
- Create: `worker/test-runner.js`

- [ ] **Step 1: Create smoke tests**

Create `worker/test-runner.js`:

```js
import assert from 'node:assert/strict';
import {
  normalizeUrl,
  htmlToText,
  extractLinks,
  getSourceStats,
} from './index.js';

function testNormalizeUrl() {
  assert.equal(normalizeUrl('/path', 'https://example.com/base'), 'https://example.com/path');
  assert.equal(normalizeUrl('https://a.com/x', 'https://example.com'), 'https://a.com/x');
  assert.equal(normalizeUrl('', 'https://example.com'), '');
}

function testHtmlToText() {
  const text = htmlToText('<html><body><h1>标题</h1><script>x</script><p>正文&nbsp;内容</p></body></html>');
  assert.ok(text.includes('标题'));
  assert.ok(text.includes('正文 内容'));
  assert.ok(!text.includes('script'));
}

function testExtractLinks() {
  const links = extractLinks('<a href="/a">法规通知</a><a href="https://b.test/x">案例通报</a>', 'https://site.test/root');
  assert.deepEqual(links, [
    { title: '法规通知', url: 'https://site.test/a' },
    { title: '案例通报', url: 'https://b.test/x' },
  ]);
}

function testGetSourceStats() {
  const stats = getSourceStats([
    { module: '新规及案例动态', country: '中国' },
    { module: '新规及案例动态', country: '美国' },
    { module: '进出口动态', country: '中国' },
  ]);
  assert.equal(stats.total, 3);
  assert.equal(stats.byModule['新规及案例动态'], 2);
  assert.equal(stats.byCountry['中国'], 2);
}

testNormalizeUrl();
testHtmlToText();
testExtractLinks();
testGetSourceStats();
console.log('worker pure function tests ok');
```

- [ ] **Step 2: Add source utilities**

In `worker/index.js`, import the source catalog:

```js
import sourceCatalog from './sources.json' assert { type: 'json' };
```

Add exported helpers:

```js
export function normalizeUrl(href, baseUrl) {
  if (!href) return '';
  try { return new URL(href, baseUrl).toString(); } catch { return ''; }
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html || ''))) !== null) {
    const url = normalizeUrl(match[1], baseUrl);
    const title = htmlToText(match[2]);
    if (url && title) links.push({ title, url });
  }
  return links;
}

export function getSourceStats(sources = sourceCatalog.sources) {
  const byModule = {};
  const byCountry = {};
  for (const source of sources) {
    byModule[source.module] = (byModule[source.module] || 0) + 1;
    byCountry[source.country] = (byCountry[source.country] || 0) + 1;
  }
  return { total: sources.length, byModule, byCountry };
}
```

- [ ] **Step 3: Run tests**

```bash
node worker/test-runner.js
```

Expected output:

```text
worker pure function tests ok
```

- [ ] **Step 4: Commit**

```bash
git add worker/index.js worker/test-runner.js
git commit -m "Add worker source utility tests"
```

---

### Task 3: Candidate Fetching and Normalization

**Files:**
- Modify: `worker/index.js`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Add tests**

Append tests for `isRelevantTitle` and `makeCandidate`:

```js
import { makeCandidate, isRelevantTitle } from './index.js';

function testIsRelevantTitle() {
  assert.equal(isRelevantTitle('化妆品安全评估技术导则征求意见'), true);
  assert.equal(isRelevantTitle('直播带货虚假宣传处罚案例'), true);
  assert.equal(isRelevantTitle('公司融资发布会'), false);
}

function testMakeCandidate() {
  const source = {
    name: '国家药品监督管理局',
    module: '新规及案例动态',
    region: '亚洲',
    country: '中国',
    source_type: 'website',
    authority_type: 'official',
    priority: 'high',
    topics: ['化妆品', '备案'],
  };
  const candidate = makeCandidate(source, {
    title: '化妆品安全评估技术导则征求意见',
    url: 'https://example.com/a',
    snippet: '正文摘要',
  });
  assert.equal(candidate.source_name, '国家药品监督管理局');
  assert.equal(candidate.country, '中国');
  assert.equal(candidate.url, 'https://example.com/a');
  assert.equal(candidate.module, '新规及案例动态');
}

testIsRelevantTitle();
testMakeCandidate();
```

- [ ] **Step 2: Implement candidate helpers and fetchers**

Add to `worker/index.js`:

```js
const RELEVANT_KEYWORDS = [
  '化妆品', '美妆', '护肤', '彩妆', '香水', '防晒', '洗护', '功效宣称', '备案', '注册',
  '标签', '广告', '虚假宣传', '处罚', '召回', '禁用', '限用', '进出口', '跨境', '清真',
  'cosmetic', 'cosmetics', 'beauty', 'skincare', 'sunscreen', 'MoCRA', 'BPOM', 'AICIS',
];

const NOISE_KEYWORDS = ['融资', '发布会', '新品上市', '代言', '财报', '招聘'];

export function isRelevantTitle(title) {
  const text = String(title || '').toLowerCase();
  if (!text) return false;
  if (NOISE_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()))) return false;
  return RELEVANT_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
}

export function makeCandidate(source, item) {
  return {
    title: item.title,
    url: item.url,
    snippet: item.snippet || '',
    source_name: source.name,
    module: source.module,
    region: source.region,
    country: source.country,
    source_type: source.source_type,
    authority_type: source.authority_type,
    priority: source.priority,
    topics: source.topics || [],
    fetched_at: new Date().toISOString(),
  };
}

async function fetchSourceCandidates(source) {
  if (source.source_type === 'wechat_public_account') return [];
  if (!source.url || !source.url.startsWith('http')) return [];
  try {
    const response = await fetch(source.url, {
      headers: {
        'User-Agent': 'beauty-legal-bot/1.0 (+legal intelligence monitor)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) return [];
    const html = await response.text();
    const links = extractLinks(html, source.url).filter(link => isRelevantTitle(link.title)).slice(0, 8);
    const pageText = htmlToText(html).slice(0, 500);
    return links.map(link => makeCandidate(source, { ...link, snippet: pageText }));
  } catch (error) {
    console.warn(`fetch failed: ${source.name} ${error.message}`);
    return [];
  }
}

async function collectCandidates(sources = sourceCatalog.sources) {
  const candidates = [];
  const failures = [];
  for (const source of sources) {
    const items = await fetchSourceCandidates(source);
    if (!items.length && source.source_type !== 'wechat_public_account') failures.push(source.name);
    candidates.push(...items);
  }
  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = item.url || `${item.title}:${item.source_name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  return { candidates: unique, failures };
}
```

- [ ] **Step 3: Run tests**

```bash
node worker/test-runner.js
```

Expected output:

```text
worker pure function tests ok
```

- [ ] **Step 4: Commit**

```bash
git add worker/index.js worker/test-runner.js
git commit -m "Add source candidate collection"
```

---

### Task 4: DeepSeek Structured JSON Analysis

**Files:**
- Modify: `worker/index.js`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Add JSON tests**

Append:

```js
import { parseAnalysisJson, validateReport } from './index.js';

function testParseAnalysisJson() {
  const parsed = parseAnalysisJson('```json\n{"summary":["a"],"risk_alerts":[],"sections":[],"period":{"start":"2026-05-18","end":"2026-05-24"}}\n```');
  assert.deepEqual(parsed.summary, ['a']);
}

function testValidateReport() {
  const report = {
    period: { start: '2026-05-18', end: '2026-05-24' },
    summary: ['风险'],
    risk_alerts: [{ level: 'high', text: '测试' }],
    sections: [{ module: '新规/修订/废止', items: [] }],
  };
  assert.equal(validateReport(report), true);
}

testParseAnalysisJson();
testValidateReport();
```

- [ ] **Step 2: Add parser, validator, and DeepSeek boundary**

Implement:

```js
export function parseAnalysisJson(text) {
  const cleaned = String(text || '').replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

export function validateReport(report) {
  if (!report || typeof report !== 'object') throw new Error('report must be object');
  if (!report.period || !report.period.start || !report.period.end) throw new Error('period missing');
  if (!Array.isArray(report.summary)) throw new Error('summary must be array');
  if (!Array.isArray(report.risk_alerts)) throw new Error('risk_alerts must be array');
  if (!Array.isArray(report.sections)) throw new Error('sections must be array');
  for (const section of report.sections) {
    if (!section.module) throw new Error('section.module missing');
    if (!Array.isArray(section.items)) throw new Error('section.items must be array');
    for (const item of section.items) {
      if (!item.title || !item.type || !item.source_name || !item.source_url) throw new Error(`item missing required fields: ${item.title || 'unknown'}`);
    }
  }
  return true;
}
```

Also add `getPeriod`, `buildAnalysisPrompt`, and `deepseekAnalyze` as described in the design spec: candidates in, structured JSON out, strict `source_url` requirement.

- [ ] **Step 3: Run tests**

```bash
node worker/test-runner.js
```

Expected output:

```text
worker pure function tests ok
```

- [ ] **Step 4: Commit**

```bash
git add worker/index.js worker/test-runner.js
git commit -m "Add DeepSeek structured analysis boundary"
```

---

### Task 5: HTML Report and Feishu Summary Rendering

**Files:**
- Create: `worker/sample-report.json`
- Modify: `worker/index.js`
- Modify: `worker/test-runner.js`

- [ ] **Step 1: Add sample report fixture**

Create `worker/sample-report.json` with one regulation item for BPOM including `source_url`, `content`, `impact_scope`, `analysis`, and `action`.

- [ ] **Step 2: Add render tests**

Add tests that assert:

- HTML includes `<!doctype html>`.
- HTML includes `美妆法务周报`.
- HTML includes the sample source link.
- Feishu summary includes `打开完整周报`.

- [ ] **Step 3: Implement `escapeHtml`, `renderReportHtml`, and `renderFeishuSummary`**

Use the UI design from the spec:

- background `#F8FAFC`
- primary `#1E3A5F`
- accessible 16px mobile body text
- white cards with border and light shadow
- clear source links with `target="_blank" rel="noopener noreferrer"`

- [ ] **Step 4: Run tests**

```bash
node worker/test-runner.js
```

Expected output:

```text
worker pure function tests ok
```

- [ ] **Step 5: Commit**

```bash
git add worker/index.js worker/test-runner.js worker/sample-report.json
git commit -m "Add legal report renderers"
```

---

### Task 6: Report Storage, Routes, Weekly Pipeline, and Deployment

**Files:**
- Modify: `worker/index.js`
- Modify: `worker/wrangler.toml`
- Modify: `README.md`

- [ ] **Step 1: Update cron**

Change `worker/wrangler.toml`:

```toml
[triggers]
crons = ["0 0 * * 1"]
```

- [ ] **Step 2: Add report KV helpers and routes**

Add:

```js
export function reportKeyForDate(date) { return `report:${date}`; }
export function latestReportKey() { return 'report:latest'; }
```

Implement:

- `/report/latest`
- `/report/YYYY-MM-DD`
- `/test`

- [ ] **Step 3: Integrate weekly pipeline**

Pipeline order:

1. `collectCandidates(sourceCatalog.sources)`
2. `deepseekAnalyze({ apiKey, model, candidates, sources, period })`
3. `renderReportHtml(report, { generatedAt, failures })`
4. store dated and latest report in KV
5. `renderFeishuSummary(report, reportUrl)`
6. send Feishu card

- [ ] **Step 4: Update README**

Document:

- `worker/sources.json`
- weekly Monday schedule
- `/report/latest`
- local verification commands
- `wrangler deploy`

- [ ] **Step 5: Run final checks**

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
node worker/test-runner.js
node --check worker/index.js
```

Expected output includes:

```text
Wrote 69 sources to worker/sources.json
worker pure function tests ok
```

- [ ] **Step 6: Deploy**

```bash
npx wrangler deploy
```

Expected output includes:

```text
Deployed beauty-legal-bot triggers
schedule: 0 0 * * 1
```

- [ ] **Step 7: Commit final implementation**

```bash
git add README.md worker/index.js worker/wrangler.toml worker/sources.json scripts/extract_sources.py worker/test-runner.js worker/sample-report.json
git commit -m "Implement weekly legal intelligence reports"
```

---

## Self-Review

Spec coverage:

- Excel source conversion: Task 1.
- Source fetching and normalization: Tasks 2-3.
- DeepSeek as only engine with replaceable boundary: Task 4.
- Original source links required: Tasks 3-5 validation and schema.
- Feishu summary card + full page: Tasks 5-6.
- Weekly Monday schedule: Task 6.
- KV persistence and report routes: Task 6.
- Verification: Task 6.

Placeholder scan: no TBD or TODO markers. A few implementation steps reference functions by name after defining their expected behavior in the same task.

Type consistency: `source_url`, `source_name`, `period`, `summary`, `risk_alerts`, and `sections` are consistently used across schema, renderer, validator, and Feishu summary.
