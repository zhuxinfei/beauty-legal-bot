import assert from 'node:assert/strict';
import sampleReport from './sample-report.json' with { type: 'json' };
import {
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
  const report = {
    period: { start: '2026-05-18', end: '2026-05-24' },
    summary: ['风险'],
    risk_alerts: [{ level: 'high', text: '测试' }],
    sections: [{ module: '新规/修订/废止', items: [] }],
  };
  assert.equal(validateReport(report), true);
}

function testRenderReportHtml() {
  const html = renderReportHtml(sampleReport, { generatedAt: '2026-05-24T00:00:00.000Z', failures: [] });
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('美妆法务周报'));
  assert.ok(html.includes('https://www.pom.go.id/'));
}

function testRenderFeishuSummary() {
  const summary = renderFeishuSummary(sampleReport, 'https://example.com/report/latest');
  assert.ok(summary.includes('打开完整周报'));
  assert.ok(summary.includes('https://example.com/report/latest'));
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
  assert.deepEqual(fingerprints, ['法规|亚洲|印尼|BPOM 更新化妆品清真认证要求|https://www.pom.go.id/']);
}

testNormalizeUrl();
testHtmlToText();
testExtractLinks();
testGetSourceStats();
testIsRelevantTitle();
testMakeCandidate();
testParseAnalysisJson();
testValidateReport();
testRenderReportHtml();
testRenderFeishuSummary();
testReportKeys();
testDedupeReportRemovesRepeatedItems();
testExtractReportFingerprintsUsesItems();
console.log('worker pure function tests ok');
