import assert from 'node:assert/strict';
import sampleReport from './sample-report.json' with { type: 'json' };
import {
  default as worker,
  normalizeUrl,
  htmlToText,
  extractLinks,
  getSourceStats,
  makeCandidate,
  isRelevantTitle,
  parseAnalysisJson,
  validateReport,
  renderReportHtml,
  renderFeishuSummary,
  reportKeyForDate,
  latestReportKey,
  dedupeReport,
  extractReportFingerprints,
  makeLead,
  splitSources,
  filterReportQuality,
  limitReportSections,
  buildAnalysisPrompt,
  fetchWithTimeout,
  mapWithConcurrency,
  extractPublishedDate,
  sortCandidatesForAnalysis,
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

function testParseAnalysisJson() {
  const parsed = parseAnalysisJson('```json\n{"summary":["a"],"risk_alerts":[],"sections":[],"period":{"start":"2026-05-18","end":"2026-05-24"}}\n```');
  assert.deepEqual(parsed.summary, ['a']);
}

function testValidateReport() {
  assert.equal(validateReport(sampleReport), true);
}

function testValidateReportRequiresRegulationAnalysis() {
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
  const report = {
    period: sampleReport.period,
    summary: [],
    risk_alerts: [],
    sections: [{
      module: '广告合规及处罚案例',
      items: Array.from({ length: 4 }, (_, i) => ({ ...sampleReport.sections[1].items[0], title: `案例${i}`, source_url: `https://example.com/${i}` })),
    }],
  };
  const limited = limitReportSections(report);
  const caseSection = limited.sections.find(section => section.module === '广告合规及处罚案例');
  assert.equal(caseSection.items.length, 3);
}

function testRenderReportHtml() {
  const html = renderReportHtml(sampleReport, { generatedAt: '2026-05-24T00:00:00.000Z', failures: [] });
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('美妆法务周报'));
  assert.ok(html.includes('https://www.pom.go.id/'));
  assert.ok(html.includes('变化点'));
  assert.ok(html.includes('法务拆解'));
  assert.ok(html.includes('违法逻辑'));
  assert.ok(html.includes('合规动作'));
}

function testRenderFeishuSummary() {
  const summary = renderFeishuSummary(sampleReport, 'https://example.com/report/latest');
  assert.ok(summary.includes('查看完整周报'));
  assert.ok(summary.includes('https://example.com/report/latest'));
  assert.ok(summary.includes('建议：'));
}

function testBuildAnalysisPromptIncludesLeads() {
  const prompt = buildAnalysisPrompt({
    candidates: [{ title: '法规候选', url: 'https://example.com/a', source_name: '官方源' }],
    leads: [{ name: '化妆品观察', source_type: 'wechat_public_account', topics: ['化妆品'] }],
    sources: [],
    period: { start: '2026-05-18', end: '2026-05-24' },
  });
  assert.ok(prompt.includes('leads'));
  assert.ok(prompt.includes('公众号线索不是事实来源'));
  assert.ok(prompt.includes('不要输出未加工新闻'));
  assert.ok(prompt.includes('过去 7 天'));
  assert.ok(prompt.includes('行业影响力'));
}

function testCandidateFreshnessAndInfluenceRanking() {
  assert.equal(extractPublishedDate('2026年5月23日 化妆品通知'), '2026-05-23');
  assert.equal(extractPublishedDate('https://example.com/2026/05/20/a.html'), '2026-05-20');

  const ranked = sortCandidatesForAnalysis([
    { title: '旧普通信息', published_at: '2026-04-01', priority: 'low', authority_type: 'media', source_type: 'media' },
    { title: '近期监管信息', published_at: '2026-05-22', priority: 'high', authority_type: 'regulator', source_type: 'official_site' },
    { title: '旧高影响规则', published_at: '2026-05-01', priority: 'high', authority_type: 'regulator', source_type: 'official_site' },
  ], new Date('2026-05-24T00:00:00Z'));

  assert.equal(ranked[0].title, '近期监管信息');
  assert.equal(ranked[1].title, '旧高影响规则');
}

async function testFetchWithTimeoutAbortsSlowFetch() {
  const slowFetch = (_url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    setTimeout(() => resolve(new Response('late')), 50);
  });
  await assert.rejects(
    () => fetchWithTimeout('https://example.com', {}, 1, slowFetch),
    /timed out|Abort/
  );
}

async function testManualTestRouteAwaitsPipeline() {
  let waitUntilCalled = false;
  let pipelineStarted = false;
  const response = await worker.fetch(
    new Request('https://example.com/test'),
    {
      DEEPSEEK_API_KEY: 'test-key',
      FEISHU_WEBHOOK_URL: 'https://example.com/webhook',
      SEEN_NEWS: {
        async get() { return null; },
        async put() {},
      },
      __TEST_RUN_PIPELINE__: async () => { pipelineStarted = true; },
    },
    {
      waitUntil(promise) {
        waitUntilCalled = true;
        return promise;
      },
    }
  );

  const text = await response.text();
  assert.equal(waitUntilCalled, false);
  assert.equal(pipelineStarted, true);
  assert.ok(text.includes('weekly pipeline finished'));
  assert.ok(text.includes('status: done'));
  assert.ok(text.includes('/report/latest'));
}

async function testMapWithConcurrencyLimitsParallelWork() {
  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async value => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active -= 1;
    return value * 2;
  });

  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maxActive, 2);
}

async function testScheduledPipelineSavesReportThenSendsFeishu() {
  const originalFetch = globalThis.fetch;
  const store = new Map();
  const kv = {
    async get(key) {
      return store.get(key) || null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
  let feishuSent = false;
  let reportExistedBeforeFeishu = false;

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('api.deepseek.com')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(sampleReport) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href === 'https://example.com/webhook') {
      feishuSent = true;
      reportExistedBeforeFeishu = store.has('report:latest');
      const body = JSON.parse(init.body);
      assert.equal(body.msg_type, 'interactive');
      assert.ok(JSON.stringify(body.card).includes('查看完整周报'));
      return new Response(JSON.stringify({ code: 0 }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response('<a href="/cosmetic-rule">化妆品安全评估技术导则征求意见</a>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  };

  try {
    await worker.scheduled({}, {
      DEEPSEEK_API_KEY: 'test-key',
      FEISHU_WEBHOOK_URL: 'https://example.com/webhook',
      DEEPSEEK_MODEL: 'deepseek-chat',
      SEEN_NEWS: kv,
    }, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.ok(store.has('report:latest'));
  assert.ok(store.has(`report:${sampleReport.period.end}`));
  assert.ok(store.get('report:latest').includes('美妆法务周报'));
  assert.equal(feishuSent, true);
  assert.equal(reportExistedBeforeFeishu, true);
}

async function testManualTestRouteRecordsFailure() {
  const store = new Map();
  const response = await worker.fetch(
    new Request('https://example.com/test'),
    {
      SEEN_NEWS: {
        async get(key) { return store.get(key) || null; },
        async put(key, value) { store.set(key, value); },
      },
      __TEST_RUN_PIPELINE__: async () => {
        throw new Error('boom');
      },
    },
    { waitUntil() {} }
  );

  const text = await response.text();
  const lastRun = JSON.parse(store.get('run:last'));
  assert.equal(response.status, 500);
  assert.ok(text.includes('boom'));
  assert.equal(lastRun.trigger, 'manual');
  assert.equal(lastRun.status, 'failed');
  assert.ok(lastRun.error.includes('boom'));
}

function testReportKeys() {
  assert.equal(reportKeyForDate('2026-05-24'), 'report:2026-05-24');
  assert.equal(latestReportKey(), 'report:latest');
}

function testDedupeReportRemovesRepeatedItems() {
  const duplicate = structuredClone(sampleReport);
  duplicate.sections[0].items = [
    sampleReport.sections[0].items[0],
    { ...sampleReport.sections[0].items[0], source_name: '转载来源' },
  ];
  const deduped = dedupeReport(duplicate);
  assert.equal(deduped.sections[0].items.length, 1);
}

function testExtractReportFingerprintsUsesItems() {
  const fingerprints = extractReportFingerprints(sampleReport);
  assert.deepEqual(fingerprints, [
    '法规|亚洲|印尼|BPOM 更新化妆品清真认证要求|https://www.pom.go.id/',
    '案例|亚洲|中国|直播功效宣称与备案资料不一致被处罚|https://scjgj.sh.gov.cn/',
  ]);
}

function testSplitSourcesSeparatesWechatLeads() {
  const sources = [
    { name: '化妆品观察', url: '微信公众号', source_type: 'wechat_public_account', module: '美妆行业动态', region: '亚洲', country: '中国', topics: ['化妆品'], priority: 'low' },
    { name: '国家药监局', url: 'https://www.nmpa.gov.cn/', source_type: 'official_site', module: '新规/修订/废止/生效提醒', region: '亚洲', country: '中国', topics: ['化妆品'], priority: 'high' },
  ];
  const split = splitSources(sources);
  assert.equal(split.fetchableSources.length, 1);
  assert.equal(split.leadSources.length, 1);
  assert.equal(makeLead(split.leadSources[0]).name, '化妆品观察');
}

await testFetchWithTimeoutAbortsSlowFetch();
await testManualTestRouteAwaitsPipeline();
await testMapWithConcurrencyLimitsParallelWork();
await testScheduledPipelineSavesReportThenSendsFeishu();
await testManualTestRouteRecordsFailure();
testNormalizeUrl();
testHtmlToText();
testExtractLinks();
testGetSourceStats();
testIsRelevantTitle();
testMakeCandidate();
testParseAnalysisJson();
testValidateReport();
testValidateReportRequiresRegulationAnalysis();
testFilterReportQualityDropsItemsWithoutSourceUrl();
testLimitReportSectionsCapsNonRegulatoryModules();
testRenderReportHtml();
testRenderFeishuSummary();
testBuildAnalysisPromptIncludesLeads();
testCandidateFreshnessAndInfluenceRanking();
testReportKeys();
testDedupeReportRemovesRepeatedItems();
testExtractReportFingerprintsUsesItems();
testSplitSourcesSeparatesWechatLeads();
console.log('worker pure function tests ok');
