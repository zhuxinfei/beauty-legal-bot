import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  annotateHydratedRecords,
  buildPythonScript,
  hydrationEvidenceStats,
  selectHydrationSources,
} from './crawl4ai-hydrate.js';

function testAnnotatesHydratedRecordsWithEvidenceGrades() {
  const records = annotateHydratedRecords([{
    source_url: 'https://amr.example.gov.cn/case/pro-xylane-20260724',
    title: '广州妍瑟化妆品有限公司侵权玻色因商标并刷单，被罚17万元',
    source_name: '广州市市场监督管理局',
    country: '中国',
    module: '知识产权保护或者侵权',
    article_text: '当事人广州妍瑟化妆品有限公司侵权使用玻色因相关商标，同时存在刷单行为，依据《商标法》《反不正当竞争法》处罚金额17万元。',
  }, {
    source_url: 'https://example.org/topic/cosmetics-brand',
    title: '欢迎访问中华商标网',
    source_name: '中华商标协会',
    country: '中国',
    module: '知识产权保护或者侵权',
    article_text: '欢迎访问中华商标网。化妆品产业专业委员会拟建立品牌指数和商标品牌价值评估体系。',
  }]);

  assert.equal(records[0].evidence_grade, 'hard_fact_ready');
  assert.equal(records[0].hard_facts.involved_party, '广州妍瑟化妆品有限公司');
  assert.match(records[0].evidence_quotes.penalty_amount, /17万元/);
  assert.equal(records[1].evidence_grade, 'lead_only');
}

function testEvidenceStatsExposeChinaHardFactReady() {
  const stats = hydrationEvidenceStats([
    { country: '中国', evidence_grade: 'hard_fact_ready' },
    { country: '中国', evidence_grade: 'lead_only' },
    { country: '美国', evidence_grade: 'reject' },
    { country: '中国', evidence_grade: 'attachment_pending' },
  ]);

  assert.equal(stats.hardFactReady, 1);
  assert.equal(stats.chinaHardFactReady, 1);
  assert.equal(stats.leadOnly, 1);
  assert.equal(stats.attachmentPending, 1);
  assert.equal(stats.reject, 1);
}

function testCrawl4AiScriptDiscoversHardDetailLinksFromLeadPages() {
  const source = readFileSync(new URL('./crawl4ai-hydrate.js', import.meta.url), 'utf8');
  assert.match(source, /extract_detail_urls/);
  for (const keyword of ['行政处罚', '处罚决定', '征求意见', '商标', '海关', '进口', 'HS', '化妆品', '功效宣称', '备案', '标签']) {
    assert.ok(source.includes(keyword), `missing hard detail keyword: ${keyword}`);
  }
  assert.match(source, /CRAWL4AI_DETAIL_LINK_LIMIT/);
}

function testManualWorkflowHydratesEnoughChinaAuthoritySources() {
  const hydrateSource = readFileSync(new URL('./crawl4ai-hydrate.js', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/weekly.yml', import.meta.url), 'utf8');

  assert.match(hydrateSource, /CRAWL4AI_PREVIEW_LIMIT \|\| 72/);
  assert.match(hydrateSource, /CRAWL4AI_DETAIL_LINK_LIMIT", "12"/);
  assert.match(workflow, /CRAWL4AI_DETAIL_LINK_LIMIT:\s*12/);
  assert.match(workflow, /--limit 72/);
}

function testHydrationPrefersEventEndpointOverAuthorityListPage() {
  const listPage = {
    url: 'https://official.example.gov.cn/xxgk/index.html',
    module: '知识产权动态',
    source_scope: 'hard_fact_list',
    country: '中国',
    authority_type: 'regulator',
    source_type: 'official_site',
    priority: 'high',
  };
  const eventPage = {
    url: 'https://official.example.gov.cn/xxgk/penalty-2026.html',
    module: '知识产权动态',
    source_scope: 'hard_fact_endpoint',
    country: '中国',
    authority_type: 'regulator',
    source_type: 'official_site',
    priority: 'medium',
  };
  const selected = selectHydrationSources([listPage, eventPage], {
    limit: 1,
    minimumPerModule: 1,
    modules: ['知识产权动态'],
  });
  assert.deepEqual(selected, [eventPage]);
}

function testHydrationUsesBoundedConcurrentRequestBudget() {
  const runner = buildPythonScript([{ url: 'https://official.example.gov.cn/case/1' }]);
  const workflow = readFileSync(new URL('../.github/workflows/weekly.yml', import.meta.url), 'utf8');

  assert.match(runner, /asyncio\.Semaphore\(crawl_concurrency\)/);
  assert.match(runner, /asyncio\.create_task\(crawl_one/);
  assert.match(runner, /CRAWL4AI_REQUEST_LIMIT/);
  assert.match(workflow, /CRAWL4AI_CONCURRENCY:\s*6/);
  assert.match(workflow, /CRAWL4AI_REQUEST_LIMIT:\s*96/);
}

testAnnotatesHydratedRecordsWithEvidenceGrades();
testEvidenceStatsExposeChinaHardFactReady();
testCrawl4AiScriptDiscoversHardDetailLinksFromLeadPages();
testManualWorkflowHydratesEnoughChinaAuthoritySources();
testHydrationPrefersEventEndpointOverAuthorityListPage();
testHydrationUsesBoundedConcurrentRequestBudget();

console.log('crawl4ai hydrate tests passed');
