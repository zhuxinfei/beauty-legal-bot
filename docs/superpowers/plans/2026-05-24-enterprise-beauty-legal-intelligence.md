# Enterprise Beauty Legal Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Worker into an enterprise-grade international beauty legal intelligence weekly report for a global beauty e-commerce group.

**Architecture:** Keep the Cloudflare Worker deployment model, but rebuild the intelligence pipeline around explicit source ingestion, source classification, evidence-backed AI analysis, and a redesigned HTML/Feishu output. Excel `分类` remains the top-level module taxonomy; source coverage expands to international regulator/court/IP/customs/recall authorities and uses country/region metadata.

**Tech Stack:** Cloudflare Workers, KV, JavaScript ES modules, DeepSeek chat completions, Feishu bot webhook, local Node test runner.

---

## Current State And Known Problems

- Current `worker/sources.json` was partially regenerated from the Excel file but is not yet finalized.
- Current `worker/index.js` has partial prompt/UI edits that should be reviewed and either kept or replaced deliberately.
- Existing output quality is unacceptable for enterprise use: weak relevance, insufficient international coverage, sparse legal analysis, and UI that does not match a high-end legal intelligence product.
- The local `out/` folder contains generated validation artifacts and should not be committed.

## Target Information Modules

Use the Excel `分类` column as the only top-level module taxonomy:

1. 广告合规及处罚案例
2. 美妆动态
3. 知识产权动态
4. 新规及案例动态
5. 进出口动态

Rows with blank `分类` inherit the nearest preceding non-empty category from the workbook.

## Target Intelligence Quality

Each selected item must answer:

- Which country/region/continent is affected?
- Is this directly related to beauty, or indirectly relevant to beauty e-commerce?
- Why does this matter to a global beauty e-commerce group?
- Which business teams are affected?
- What is the legal/regulatory/case logic?
- What should the company consider doing next, written as suggestions rather than commands?
- How fresh is it, and why is it included if older than 7 days?

Each top-level module should usually include about 3 selected items. With five modules, the full report should normally contain roughly 12-15 items. Fewer items are acceptable only when the week genuinely lacks high-quality material. More items are acceptable only when the additional items are clearly high-impact and well analyzed.

Every selected item must include a source link and original-source attribution. The report must not copy raw source text as the main content. Each item needs original legal/compliance interpretation: what changed, why it matters, affected business teams, recommended response, and, for cases, facts, reasoning, result, and business lessons.

---

### Task 1: Freeze And Inspect Current Worktree

**Files:**
- Inspect: `worker/index.js`
- Inspect: `worker/sources.json`
- Inspect: `worker/test-runner.js`
- Inspect: `worker/sample-report.json`
- Ignore: `out/`

- [ ] **Step 1: Capture current status**

Run:

```bash
git status --short
git diff --stat
```

Expected:

```text
 M worker/index.js
 M worker/sample-report.json
 M worker/sources.json
 M worker/test-runner.js
?? out/
```

If the exact files differ, inspect the diff and do not overwrite user-created files.

- [ ] **Step 2: Review uncommitted source changes**

Run:

```bash
git diff -- worker/index.js worker/sources.json worker/test-runner.js worker/sample-report.json
```

Expected: visible changes from the in-progress rebuild. Confirm whether each change belongs to this rebuild.

- [ ] **Step 3: Do not commit `out/`**

Run:

```bash
git status --short out
```

Expected:

```text
?? out/
```

Leave it untracked unless the user explicitly asks to preserve validation artifacts.

---

### Task 2: Rebuild Source Catalog From Excel Plus Global Authorities

**Files:**
- Modify: `worker/sources.json`
- Add: `worker/source-builder.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Add source catalog tests first**

Add imports to `worker/test-runner.js`:

```js
import sourceCatalog from './sources.json' with { type: 'json' };
```

Add this test before the final invocation block:

```js
function testSourceCatalogUsesWorkbookModulesAndGlobalMarkets() {
  const sources = sourceCatalog.sources;
  const modules = new Set(sources.map(source => source.module));
  assert.deepEqual([...modules].sort(), [
    '广告合规及处罚案例',
    '新规及案例动态',
    '知识产权动态',
    '美妆动态',
    '进出口动态',
  ].sort());

  const countries = new Set(sources.map(source => source.country));
  for (const country of ['中国', '欧盟', '美国', '日本', '韩国', '泰国', '越南', '印尼', '墨西哥', '意大利']) {
    assert.ok(countries.has(country), `missing country ${country}`);
  }

  const regions = new Set(sources.map(source => source.region));
  for (const region of ['亚洲', '欧洲', '北美洲']) {
    assert.ok(regions.has(region), `missing region ${region}`);
  }

  const bpom = sources.find(source => source.name.includes('BPOM'));
  assert.equal(bpom.country, '印尼');
  assert.equal(bpom.module, '新规及案例动态');
  assert.equal(bpom.priority, 'high');
}
```

Add this invocation near the bottom:

```js
testSourceCatalogUsesWorkbookModulesAndGlobalMarkets();
```

- [ ] **Step 2: Run the failing test**

Run:

```bash
node worker/test-runner.js
```

Expected: FAIL if the source catalog does not yet contain all required global markets and module mapping.

- [ ] **Step 3: Create a repeatable source builder**

Create `worker/source-builder.js`. It must parse the workbook directly instead of hard-coding workbook rows, so the catalog is reproducible when the Excel file changes:

```js
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');

const workbookPath = process.env.SOURCE_WORKBOOK || '/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx';

function loadWorkbookRows() {
  const script = `
import zipfile, xml.etree.ElementTree as ET, re, json
p=${JSON.stringify('${workbookPath}')}
ns={'a':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
with zipfile.ZipFile(p) as z:
  shared=[]
  if 'xl/sharedStrings.xml' in z.namelist():
    root=ET.fromstring(z.read('xl/sharedStrings.xml'))
    for si in root.findall('a:si', ns):
      shared.append(''.join(t.text or '' for t in si.findall('.//a:t', ns)))
  sheet=ET.fromstring(z.read('xl/worksheets/sheet1.xml'))
  rows=[]
  for row in sheet.findall('.//a:row', ns):
    cells={}
    for c in row.findall('a:c', ns):
      ref=c.attrib.get('r','')
      m=re.match(r'[A-Z]+', ref)
      if not m: continue
      v=c.find('a:v', ns)
      val=''
      if v is not None:
        val=v.text or ''
        if c.attrib.get('t')=='s': val=shared[int(val)]
      cells[m.group(0)]=val.strip()
    rows.append(cells)
print(json.dumps(rows, ensure_ascii=False))
`;
  const output = childProcess.execFileSync('python3', ['-c', script], { encoding: 'utf8' });
  return JSON.parse(output);
}

function classifyWorkbookRows(rows) {
  let currentModule = '';
  return rows.slice(1).flatMap(row => {
    const no = row.A || '';
    const name = row.B || '';
    const url = row.C || '';
    if (!name || !url) return [];
    currentModule = row.D || currentModule;
    const sourceType = url === '微信公众号' || url.includes('公众号') ? 'wechat_public_account' : 'official_site';
    const authorityType = sourceType === 'wechat_public_account' ? 'media' : (/(政府|药品监督|市场监督|市场监管|知识产权局|商标局|检察院|司法部|人大|海关|网信办)/.test(name) ? 'regulator' : 'industry');
    return [{
      id: `xlsx-${String(no).padStart(3, '0')}`,
      name,
      url,
      module: currentModule,
      region: '亚洲',
      country: '中国',
      source_type: sourceType,
      authority_type: authorityType,
      priority: authorityType === 'regulator' ? 'high' : 'medium',
      topics: [currentModule, name],
    }];
  });
}

const globalAuthoritySources = [
  { name: '欧盟委员会化妆品法规', url: 'https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-products-specific-topics_en', module: '新规及案例动态', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['欧盟', '化妆品法规', '禁限用成分', 'SCCS'] },
  { name: '欧盟 SCCS 科学委员会', url: 'https://health.ec.europa.eu/scientific-committees/scientific-committee-consumer-safety-sccs_en', module: '新规及案例动态', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['SCCS', '成分安全', '意见稿'] },
  { name: '欧盟 Safety Gate', url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport', module: '广告合规及处罚案例', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['Safety Gate', '召回', '化妆品'] },
  { name: '美国 FDA Cosmetics', url: 'https://www.fda.gov/cosmetics', module: '新规及案例动态', region: '北美洲', country: '美国', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['MoCRA', 'FDA', '化妆品注册', '不良事件'] },
  { name: '美国 FTC Advertising', url: 'https://www.ftc.gov/news-events/news/press-releases', module: '广告合规及处罚案例', region: '北美洲', country: '美国', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['广告', 'FTC', '虚假宣传'] },
  { name: '印度尼西亚 BPOM', url: 'https://www.pom.go.id/', module: '新规及案例动态', region: '亚洲', country: '印尼', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['BPOM', '清真', '化妆品注册'] },
  { name: '泰国 FDA Cosmetics', url: 'https://www.fda.moph.go.th/', module: '新规及案例动态', region: '亚洲', country: '泰国', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['泰国', 'FDA', '化妆品'] },
  { name: '越南 DAV 化妆品', url: 'https://dav.gov.vn/', module: '新规及案例动态', region: '亚洲', country: '越南', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['越南', '化妆品', '注册'] },
  { name: '日本厚生劳动省 化妆品', url: 'https://www.mhlw.go.jp/english/policy/health-medical/pharmaceuticals/index.html', module: '新规及案例动态', region: '亚洲', country: '日本', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['日本', '化妆品', '医药部外品'] },
  { name: '韩国 MFDS Cosmetics', url: 'https://www.mfds.go.kr/eng/index.do', module: '新规及案例动态', region: '亚洲', country: '韩国', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['韩国', 'MFDS', '化妆品'] },
  { name: '墨西哥 COFEPRIS', url: 'https://www.gob.mx/cofepris', module: '新规及案例动态', region: '北美洲', country: '墨西哥', source_type: 'official_site', authority_type: 'regulator', priority: 'high', topics: ['墨西哥', 'COFEPRIS', '化妆品'] },
  { name: '意大利卫生部 Cosmetics', url: 'https://www.salute.gov.it/portale/temi/p2_4.jsp?lingua=english&area=cosmetici', module: '新规及案例动态', region: '欧洲', country: '意大利', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['意大利', '化妆品', '欧盟'] },
  { name: 'WIPO', url: 'https://www.wipo.int/portal/en/index.html', module: '知识产权动态', region: '全球', country: '全球', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['WIPO', '商标', '外观设计'] },
  { name: 'EUIPO', url: 'https://www.euipo.europa.eu/en', module: '知识产权动态', region: '欧洲', country: '欧盟', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['EUIPO', '商标', '外观设计'] },
  { name: '美国 CBP', url: 'https://www.cbp.gov/newsroom', module: '进出口动态', region: '北美洲', country: '美国', source_type: 'official_site', authority_type: 'regulator', priority: 'medium', topics: ['进口', '海关', 'CBP'] },
];

const sources = [...classifyWorkbookRows(loadWorkbookRows()), ...globalAuthoritySources];
writeFileSync(new URL('./sources.json', import.meta.url), JSON.stringify({ sources }, null, 2) + '\n');
console.log(`wrote ${sources.length} sources`);
```

- [ ] **Step 4: Run builder and tests**

Run:

```bash
node worker/source-builder.js
node worker/test-runner.js
```

Expected: source catalog test passes; normal tests pass.

- [ ] **Step 5: Commit source catalog rebuild**

Run:

```bash
git add worker/source-builder.js worker/sources.json worker/test-runner.js
git commit -m "Rebuild enterprise legal intelligence sources"
```

---

### Task 3: Rebuild DeepSeek Prompt And Validation Model

**Files:**
- Modify: `worker/index.js`
- Modify: `worker/test-runner.js`
- Modify: `worker/sample-report.json`

- [ ] **Step 1: Add prompt coverage test**

Add to `worker/test-runner.js`:

```js
function testEnterprisePromptRequiresGlobalLegalIntelligence() {
  const prompt = buildAnalysisPrompt({
    candidates: [{ title: 'BPOM 化妆品清真认证更新', url: 'https://www.pom.go.id/', source_name: '印度尼西亚 BPOM', country: '印尼', region: '亚洲' }],
    leads: [{ name: '化妆品观察', source_type: 'wechat_public_account', topics: ['化妆品'] }],
    sources: sourceCatalog.sources,
    period: { start: '2026-05-18', end: '2026-05-24' },
  });
  assert.ok(prompt.includes('国际化美妆电商集团'));
  assert.ok(prompt.includes('国家/区域监管机构'));
  assert.ok(prompt.includes('直接|间接'));
  assert.ok(prompt.includes('industry_impact'));
  assert.ok(prompt.includes('business_impact'));
  assert.ok(prompt.includes('案例必须拆解'));
}
```

Invoke it near the other prompt tests:

```js
testEnterprisePromptRequiresGlobalLegalIntelligence();
```

- [ ] **Step 2: Run failing prompt test**

Run:

```bash
node worker/test-runner.js
```

Expected: FAIL until the prompt includes the enterprise-grade requirements.

- [ ] **Step 3: Replace `buildAnalysisPrompt`**

In `worker/index.js`, replace `buildAnalysisPrompt` with a prompt that requires:

```js
export function buildAnalysisPrompt({ candidates, leads = [], sources, period }) {
  return `你是国际化美妆电商集团的高级法务情报分析员。用户是集团法务、合规、注册备案、跨境供应链、品牌/IP、市场投放、电商平台运营团队。不要输出未加工新闻，必须输出可用于业务判断的法务情报。

集团业务背景：
- 国际化美妆电商集团，关注中国、欧盟、美国、日本、韩国、泰国、越南、印尼、墨西哥、意大利等市场。
- 业务覆盖护肤、彩妆、防晒、香水、洗护、跨境进口、直播电商、平台销售、自有品牌和第三方品牌。
- 需要直接相关法规，也需要间接影响业务的广告、消费者保护、平台规则、知识产权、进出口、数据合规、召回案例。

来源和质量规则：
- candidates 来自可抓取网页；leads 来自公众号或不可抓来源。公众号可以作为强线索，但最终必须标注 source_type 和 confidence。
- 优先国家/区域监管机构、法院、知识产权机构、海关、产品安全召回平台、行业权威媒体。
- 可以基于 leads 做选题归纳，但不能把传闻当事实；无法找到公开原文时，source_url 可填来源主页，confidence 必须为 medium 或 low，并说明待核验。
- 每条信息要解释美妆电商集团的业务影响；解释不了就丢弃。

时间和影响力规则：
- 周报优先过去 7 天发布或更新的信息。
- 7 天之外的信息只有在行业影响力高时保留，例如国家级监管规则、成分禁限用、标签/功效宣称规则、重点处罚、召回、跨境准入、代表性 IP 案例、平台治理口径。
- 未来 90 天生效、反馈截止、过渡期、认证节点可以入选。

模块必须使用以下 5 个，来自用户 Excel 的“分类”列：广告合规及处罚案例、美妆动态、知识产权动态、新规及案例动态、进出口动态。

输出要求：
- 输出合法 JSON，不要 Markdown，不要解释。
- 至少覆盖 3 个模块；如果某模块确实无高价值信息，items 为空。
- 每个模块通常输出 3 条左右；全部模块总量通常为 12-15 条。不要为了凑数输出低价值内容。
- 每条信息要有国家/大洲、直接/间接相关、行业影响力、业务影响面、建议动作。
- 每条必须有源链接和来源名称；正文必须是拆解、解读、分析和建议，不能原文搬运。
- 案例必须拆解事实、认定逻辑、处罚/结果、业务启发。
- 建议动作必须是“建议...”口吻，不能是命令。

JSON 结构字段必须包含：period, summary, risk_alerts, sections[].module, sections[].items[].type, module, region, country, title, source_name, source_url, source_type, published_at, relevance, industry_impact, business_impact, market_scope, risk_level, why_it_matters, recommended_actions, owner_teams, confidence。法规补充 status/effective_date/feedback_deadline/regulatory_area/what_changed/legal_obligation/affected_business/next_deadline；案例/召回补充 case_type/parties/facts/violation_logic/penalty_or_result/risk_pattern/business_lessons。

信息源统计：${JSON.stringify(getSourceStats(sources))}
候选信息 candidates：${JSON.stringify(sortCandidatesForAnalysis(candidates).slice(0, 140))}
线索 leads：${JSON.stringify(leads.slice(0, 120))}`;
}
```

- [ ] **Step 4: Relax validation only where appropriate**

Update `getRequiredFields(item)` so every item requires:

```js
const ENTERPRISE_REQUIRED_FIELDS = ['relevance', 'industry_impact', 'business_impact'];
```

Then return:

```js
export function getRequiredFields(item) {
  return [
    ...(TYPE_REQUIRED_FIELDS[item.type] || ['recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence']),
    ...ENTERPRISE_REQUIRED_FIELDS,
  ];
}
```

- [ ] **Step 5: Update sample report**

Add to every item in `worker/sample-report.json`:

```json
"relevance": "direct",
"industry_impact": "high",
"business_impact": ["注册备案", "标签"],
"market_scope": ["印尼市场 SKU"]
```

Use appropriate values for each item.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
node worker/test-runner.js
node --check worker/index.js
```

Expected: both pass.

Commit:

```bash
git add worker/index.js worker/test-runner.js worker/sample-report.json
git commit -m "Rebuild enterprise intelligence prompt"
```

---

### Task 4: Rebuild HTML Report UI

**Files:**
- Modify: `worker/index.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Add UI output test**

Add to `testRenderReportHtml()`:

```js
assert.ok(html.includes('Global Beauty Legal Intelligence'));
assert.ok(html.includes('市场覆盖'));
assert.ok(html.includes('业务影响'));
assert.ok(html.includes('直接相关') || html.includes('间接相关'));
assert.ok(html.includes('行业影响力'));
assert.ok(html.includes('模块导航'));
```

- [ ] **Step 2: Run failing test**

Run:

```bash
node worker/test-runner.js
```

Expected: FAIL until HTML template is rebuilt.

- [ ] **Step 3: Rebuild `renderReportHtml`**

Replace the current HTML template with a dashboard-style layout:

- Header: `Global Beauty Legal Intelligence` and period.
- Metrics: item count, high impact count, direct relevance count, country count.
- Market strip: countries/regions covered.
- Module nav: five Excel modules with counts.
- Executive summary panel.
- Risk radar panel.
- Module sections grouped by country/region if feasible.
- Item card fields: type, country, region, published_at, relevance, industry_impact, risk_level, source, confidence.
- Analysis blocks: why it matters, business impact, legal/case breakdown, suggested actions.

Use restrained enterprise styling:

```css
:root { --bg:#F6F7F9; --panel:#FFFFFF; --ink:#172033; --muted:#667085; --line:#D9DEE7; --blue:#2557A7; --rose:#B42318; --gold:#B7791F; --green:#287D3C; }
```

Keep border radii at `8px` or less.

- [ ] **Step 4: Run tests and inspect generated HTML**

Run:

```bash
node worker/test-runner.js
DEEPSEEK_API_KEY="$DEEPSEEK_API_KEY" FEISHU_WEBHOOK_URL="https://example.com/skip-feishu" node worker/run-local.js
```

Expected: tests pass, `out/latest-report.html` is generated. If local network fails, run the local command with approved escalation.

- [ ] **Step 5: Commit HTML rebuild**

Run:

```bash
git add worker/index.js worker/test-runner.js
git commit -m "Rebuild enterprise report interface"
```

---

### Task 5: Improve Feishu Card For Executive Use

**Files:**
- Modify: `worker/index.js`
- Test: `worker/test-runner.js`

- [ ] **Step 1: Add Feishu card tests**

Update `testRenderFeishuSummary()`:

```js
assert.ok(summary.includes('本周概览'));
assert.ok(summary.includes('风险提示'));
assert.ok(summary.includes('建议优先查看'));
assert.ok(summary.includes('查看完整周报'));
assert.ok(summary.includes('建议：'));
```

- [ ] **Step 2: Update card copy**

In `renderFeishuSummary`, format as:

```text
**美妆法务情报周报｜YYYY-MM-DD**

📌 本周概览
...

⚠️ 风险提示
...

📝 建议优先查看
**类型｜国家｜影响力**
标题
建议：...

🔎 完整版网页
[查看完整周报](...)
```

- [ ] **Step 3: Run tests and commit**

Run:

```bash
node worker/test-runner.js
```

Commit:

```bash
git add worker/index.js worker/test-runner.js
git commit -m "Polish executive Feishu intelligence card"
```

---

### Task 6: Real Pipeline Quality Gate

**Files:**
- Use: `worker/run-local.js`
- Output: `out/latest-report.html`

- [ ] **Step 1: Run full real pipeline locally**

Run with real credentials:

```bash
DEEPSEEK_API_KEY='sk-255518b8aa8c450e8973ccc7dd174bea' FEISHU_WEBHOOK_URL='https://open.feishu.cn/open-apis/bot/v2/hook/b69fabf6-5922-4460-9055-c73322301316' DEEPSEEK_WORKER_MODEL='deepseek-chat' node worker/run-local.js
```

Expected console stages:

```text
[stage 1/5] 完成，候选 ... 条，线索 ... 条，失败源 ... 个
[stage 2/5] 完成，模块 5 个，去重后 ... 条
[stage 3/5] 已保存 /report/... 和 /report/latest
飞书推送成功
Generated out/latest-report.html
```

- [ ] **Step 2: Quality review generated report**

Run:

```bash
grep -o "<h3>[^<]*" out/latest-report.html
```

Accept only if:

- Around 12-15 meaningful items overall, unless the week genuinely lacks activity.
- Each populated module has about 3 items.
- At least 4 modules have content, unless there is a documented reason.
- At least 3 countries/markets appear, or the summary explains why only one market had material updates.
- No obvious non-beauty weak items such as unrelated furniture recalls.
- At least one item has direct beauty relevance.
- Case items include facts, logic, result, and business lessons.
- Every item has a visible source link.
- Every item includes interpretation and suggested response, not just copied source text.

- [ ] **Step 3: Upload validated report to remote KV**

Run:

```bash
npx wrangler kv key put --remote --binding SEEN_NEWS report:latest --path ../out/latest-report.html
npx wrangler kv key put --remote --binding SEEN_NEWS report:$(date +%F) --path ../out/latest-report.html
```

Expected: both commands write to remote KV successfully.

---

### Task 7: Deploy Weekly Automation

**Files:**
- Modify if needed: `worker/wrangler.toml`

- [ ] **Step 1: Confirm weekly cron**

Run:

```bash
grep -n "crons" worker/wrangler.toml
```

Expected:

```text
crons = ["0 0 * * 1"]
```

- [ ] **Step 2: Run final tests**

Run:

```bash
node worker/test-runner.js
node --check worker/index.js
node --check worker/run-local.js
```

Expected: all pass.

- [ ] **Step 3: Deploy**

Run:

```bash
npx wrangler deploy
```

Expected: deploy succeeds and reports schedule `0 0 * * 1`.

- [ ] **Step 4: Commit final deployment-ready state**

Run:

```bash
git status --short
```

Expected: only `?? out/` may remain untracked. If code files are modified, commit them before final response.

---

## Validation Summary Required Before Completion

Do not declare completion until these are true:

- `node worker/test-runner.js` passes.
- `node --check worker/index.js` passes.
- Real local pipeline has generated `out/latest-report.html`.
- Feishu test push has succeeded.
- Remote KV contains `report:latest`.
- Worker deployed with weekly cron `0 0 * * 1`.
- Final report quality passes the criteria in Task 6.
