import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sampleReport from './sample-report.json' with { type: 'json' };
import sourceCatalog from './sources.json' with { type: 'json' };
import {
  default as worker,
  normalizeUrl,
  htmlToText,
  extractLinks,
  extractImageUrl,
  isLikelyContentImage,
  getSourceStats,
  makeCandidate,
  isRelevantTitle,
  parseAnalysisJson,
  validateReport,
  renderFeishuSummary,
  renderDingTalkMarkdown,
  renderDingTalkSummaryCard,
  buildDingTalkWebhookUrl,
  sendToDingTalk,
  notifyReport,
  getDingTalkAccessToken,
  createDingTalkDocument,
  overwriteDingTalkDocument,
  publishDingTalkDocument,
  requestAiChat,
  dedupeReport,
  extractReportFingerprints,
  makeLead,
  splitSources,
  filterReportQuality,
  limitReportSections,
  buildAnalysisPrompt,
  normalizeReportForValidation,
  makeSourceLeadCandidate,
  normalizeModuleReport,
  enrichReportWithSourceSignals,
  filterReportToObservedSources,
  attachReportImages,
  fetchWithTimeout,
  selectSourcesForWorkerBudget,
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

function testExtractImageUrl() {
  const html = '<meta property="og:image" content="/cover.jpg"><img src="/fallback.jpg">';
  assert.equal(extractImageUrl(html, 'https://site.test/news/a'), 'https://site.test/cover.jpg');
  assert.equal(extractImageUrl('<img src="/fallback.jpg">', 'https://site.test/news/a'), 'https://site.test/fallback.jpg');
  assert.equal(isLikelyContentImage('https://site.test/logo.png'), false);
  assert.equal(isLikelyContentImage('https://site.test/news/cosmetics-recall-cover.jpg'), true);
  assert.equal(extractImageUrl('<meta property="og:image" content="/logo.png"><img src="/news/cosmetics-recall-cover.jpg">', 'https://site.test/news/a'), 'https://site.test/news/cosmetics-recall-cover.jpg');
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
  assert.equal(isRelevantTitle('加强“三品一械”广告监管 新规公开征求意见'), false);
  assert.equal(isRelevantTitle('北京汇爱科技有限公司主动召回部分型号ipoosi牌婴儿床'), false);
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

function testFilterReportQualityKeepsLeadBasedBeautyAndImportSignals() {
  const report = structuredClone(sampleReport);
  const leadItem = {
    type: '动态',
    module: '进出口动态',
    region: '亚洲',
    country: '中国',
    title: '跨境美妆清关行业线索',
    source_name: '青眼资讯',
    source_url: '微信公众号',
    source_type: 'wechat_lead',
    relevance: 'indirect',
    industry_impact: 'medium',
    business_impact: ['跨境清关', '供应链'],
    market_scope: ['中国跨境进口化妆品'],
    risk_level: 'medium',
    why_it_matters: '进口通关规则变化会影响美妆电商上架节奏和履约成本。',
    recommended_actions: ['建议供应链团队在本周核对进口化妆品清关资料和口岸异常反馈。'],
    owner_teams: ['供应链', '法务'],
    confidence: 'low',
    regulatory_signal: ['行业媒体提示近期进口美妆通关和资质核验要求需关注。'],
    compliance_meaning: ['该信息需二次核验，但可以作为跨境清关周度排查线索。'],
    possible_follow_up: ['建议法务团队结合海关总署和口岸通知进一步核验。'],
  };
  report.sections = [{ module: '进出口动态', items: [leadItem] }];
  const filtered = filterReportQuality(report);
  assert.equal(filtered.sections[0].items.length, 1);
}

function testNormalizeReportForValidationFillsDynamicAnalysisFields() {
  const report = structuredClone(sampleReport);
  const dynamicItem = {
    type: '动态',
    module: '美妆动态',
    region: '亚洲',
    country: '中国',
    title: '广州市市场监督管理局关于开展2026年化妆品生产企业质量管理体系自查工作的通知',
    source_name: '广州市市场监督管理局',
    source_url: 'https://scjgj.gz.gov.cn/',
    source_type: 'regulator',
    published_at: '2026-05-24',
    relevance: 'direct',
    industry_impact: 'medium',
    business_impact: ['注册备案', '供应链'],
    market_scope: ['中国化妆品生产企业'],
    risk_level: 'medium',
    why_it_matters: '质量管理体系自查会影响集团供应商准入和生产合规审查。',
    recommended_actions: ['建议供应链团队在本周核对广州相关供应商是否完成质量管理体系自查。'],
    owner_teams: ['供应链', '法务'],
    confidence: 'high',
  };
  report.sections = [{ module: '美妆动态', items: [dynamicItem] }];
  assert.throws(() => validateReport(report), /regulatory_signal/);
  const normalized = normalizeReportForValidation(report);
  assert.equal(validateReport(normalized), true);
  assert.ok(normalized.sections[0].items[0].regulatory_signal[0].includes('广州市市场监督管理局'));
}

function testLimitReportSectionsKeepsEnterpriseModuleDepth() {
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
  assert.equal(caseSection.items.length, 4);
}

function testLimitReportSectionsAcceptsQualityLimit() {
  const report = {
    period: sampleReport.period,
    summary: [],
    risk_alerts: [],
    sections: [{
      module: '广告合规及处罚案例',
      items: Array.from({ length: 10 }, (_, i) => ({ ...sampleReport.sections[1].items[0], title: `案例${i}`, source_url: `https://example.com/${i}` })),
    }],
  };
  const defaultLimited = limitReportSections(report);
  const qualityLimited = limitReportSections(report, 12);
  assert.equal(defaultLimited.sections.find(section => section.module === '广告合规及处罚案例').items.length, 8);
  assert.equal(qualityLimited.sections.find(section => section.module === '广告合规及处罚案例').items.length, 10);
}

function testRenderFeishuSummary() {
  const summary = renderFeishuSummary(sampleReport, 'https://example.com/doc/latest');
  assert.ok(summary.includes('Executive Brief'));
  assert.ok(summary.includes('导读'));
  assert.ok(summary.includes('核心判断'));
  assert.ok(summary.includes('Action Board'));
  assert.ok(summary.includes('Source Evidence'));
  assert.ok(summary.includes('风险提示'));
  assert.ok(summary.includes('Action Board'));
  assert.ok(summary.includes('Source Evidence'));
  assert.ok(summary.includes('查看完整版本'));
  assert.ok(summary.includes('打开完整法务情报周报 →'));
  assert.ok(summary.includes('https://example.com/doc/latest'));
  assert.ok(summary.includes('建议'));
  assert.ok(summary.includes('来源证据'));
  assert.ok(summary.includes('**高风险**') || summary.includes('**中风险**') || summary.includes('**低风险**'));
  assert.ok(summary.includes('[打开完整法务情报周报 →](https://example.com/doc/latest)'));
  assert.ok(/\[[^\]]+\]\(https?:\/\/[^)]+\)/.test(summary));
  assert.equal(/(^|\s)https?:\/\/\S+/.test(summary.replace(/\[[^\]]+\]\(https?:\/\/[^)]+\)/g, '')), false);
  assert.equal(summary.includes('本周报由 DeepSeek 辅助整理'), false);
}

function testRenderDingTalkMarkdownUsesModuleRegionCountryStructure() {
  const markdown = renderDingTalkMarkdown(sampleReport, { decisionMapUrl: 'https://worker.test/assets/decision-map.svg' });
  assert.ok(markdown.includes('# 美妆法务资讯完整周报'));
  assert.ok(markdown.includes('## 目录'));
  assert.equal(markdown.includes('](#'), false);
  assert.ok(markdown.includes('1. 本周摘要'));
  assert.ok(markdown.includes('2. AI 洞察与思考'));
  assert.ok(markdown.includes('3. 风险提示'));
  assert.ok(markdown.includes('4. 本周美妆法务风险雷达'));
  assert.ok(markdown.includes('5. M1 广告合规及处罚案例'));
  assert.ok(markdown.includes('快速定位：钉钉文档内搜索 `M1`-`M6` 可直达对应模块。'));
  assert.ok(markdown.includes('## 本周摘要'));
  assert.ok(markdown.includes('## 本周美妆法务风险雷达'));
  assert.ok(markdown.includes('![本周美妆法务风险雷达](https://worker.test/assets/decision-map.svg)'));
  assert.ok(markdown.includes('**链路 1｜'));
  assert.ok(markdown.includes('| 信号 | 风险 | 影响 | 动作归口 |'));
  assert.ok(markdown.includes('## AI 洞察与思考'));
  assert.equal(markdown.includes('## 六大板块'), false);
  assert.ok(markdown.includes('## M4 新规及案例动态'));
  assert.ok(markdown.includes('## M2 美妆动态'));
  assert.ok(markdown.includes('## M3 知识产权动态'));
  assert.ok(markdown.includes('## M5 进出口动态'));
  assert.ok(markdown.includes('## M6 产品质量/召回与安全风险'));
  assert.ok(markdown.includes('### 亚洲'));
  assert.ok(markdown.includes('#### 印尼'));
  assert.ok(markdown.includes('**发生了什么**'));
  assert.ok(markdown.includes('**为什么重要**'));
  assert.ok(markdown.includes('**对我们的影响**'));
  assert.ok(markdown.includes('**建议动作**'));
  assert.ok(markdown.includes('[查看原文](https://www.pom.go.id/)'));
  assert.ok(markdown.includes('## Action Board'));
  assert.ok(markdown.includes('| 优先级 | 动作 | 责任团队 | 触发/截止 | 来源事项 |'));
  assert.ok(markdown.includes('## 来源证据索引'));
  assert.ok(markdown.indexOf('## 风险提示') < markdown.indexOf('## 本周美妆法务风险雷达'));
  assert.ok(markdown.lastIndexOf('## 来源证据索引') > markdown.lastIndexOf('## Action Board'));
}

function testRenderDingTalkMarkdownShowsAllModulesWhenEmpty() {
  const markdown = renderDingTalkMarkdown({
    period: { start: '2026-06-01', end: '2026-06-07' },
    summary: [],
    risk_alerts: [],
    sections: [],
  });
  assert.ok(markdown.includes('本期没有形成可核验的高价值链路'));
  assert.ok(markdown.includes('| 待补充 | 待判断 | 待判断 | 法务 |'));
  assert.ok(markdown.includes('## M1 广告合规及处罚案例'));
  assert.ok(markdown.includes('## M2 美妆动态'));
  assert.ok(markdown.includes('## M3 知识产权动态'));
  assert.ok(markdown.includes('## M4 新规及案例动态'));
  assert.ok(markdown.includes('## M5 进出口动态'));
  assert.ok(markdown.includes('## M6 产品质量/召回与安全风险'));
  assert.equal((markdown.match(/本周无高价值更新/g) || []).length, 6);
}

function testRenderDingTalkSummaryCardIsConciseAndIncludesKeyword() {
  const markdown = renderDingTalkSummaryCard(sampleReport, 'https://example.com/doc/latest', { decisionMapUrl: 'https://worker.test/assets/decision-map.svg' });
  assert.ok(markdown.includes('# 美妆法务资讯'));
  assert.ok(markdown.includes('## 本周最值得看'));
  assert.ok(markdown.includes('## 模块概览'));
  assert.ok(markdown.includes('## 关系图'));
  assert.ok(markdown.includes('![本周美妆法务风险雷达](https://worker.test/assets/decision-map.svg)'));
  assert.ok(markdown.includes('[查看完整版本](https://example.com/doc/latest)'));
  assert.ok(markdown.includes('[原文](https://www.pom.go.id/)'));
  assert.ok(markdown.length < renderDingTalkMarkdown(sampleReport).length);
  assert.equal(markdown.includes('#### 印尼'), false);
  assert.equal(markdown.includes('**为什么值得关注**'), false);
}

async function testBuildDingTalkWebhookUrlSignsSecret() {
  const url = await buildDingTalkWebhookUrl('https://oapi.dingtalk.com/robot/send?access_token=abc', 'secret', 1700000000000);
  assert.ok(url.startsWith('https://oapi.dingtalk.com/robot/send?access_token=abc&timestamp=1700000000000&sign='));
  assert.ok(url.includes('%3D') || url.includes('%2B') || url.includes('%2F'));
}

async function testSendToDingTalkPostsMarkdownPayload() {
  let calledUrl = '';
  let payload = null;
  const ok = await sendToDingTalk({
    webhookUrl: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
    secret: '',
    title: '测试标题',
    markdown: '# 测试内容',
    fetcher: async (url, init) => {
      calledUrl = url;
      payload = JSON.parse(init.body);
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    },
  });
  assert.equal(ok, true);
  assert.equal(calledUrl, 'https://oapi.dingtalk.com/robot/send?access_token=abc');
  assert.deepEqual(payload, {
    msgtype: 'markdown',
    markdown: { title: '测试标题', text: '# 测试内容' },
  });
}

async function testNotifyReportPrefersDingTalkWhenConfigured() {
  let dingTalkCalls = 0;
  let feishuCalls = 0;
  let sentTitle = '';
  let sentMarkdown = '';
  const ok = await notifyReport({
    report: sampleReport,
    reportUrl: 'https://example.com/doc/latest',
    env: {
      DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=abc',
      DINGTALK_DOC_URL: 'https://example.com/doc/latest',
      FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/test',
    },
    sendDingTalk: async ({ title, markdown }) => {
      dingTalkCalls += 1;
      sentTitle = title;
      sentMarkdown = markdown;
      return true;
    },
    sendFeishu: async () => { feishuCalls += 1; return true; },
  });
  assert.equal(ok.channel, 'dingtalk');
  assert.equal(dingTalkCalls, 1);
  assert.equal(feishuCalls, 0);
  assert.ok(sentTitle.includes('美妆法务资讯'));
  assert.ok(sentMarkdown.includes('## 本周最值得看'));
  assert.ok(sentMarkdown.includes('[查看完整版本](https://example.com/doc/latest)'));
  assert.equal(sentMarkdown.includes('#### 印尼'), false);
}

async function testRequestAiChatUsesOpenAiCompatibleBaseUrl() {
  let calledUrl = '';
  let payload = null;
  const content = await requestAiChat({
    apiKey: 'test-key',
    baseUrl: 'https://hk.testvideo.site/v1',
    model: 'codex-mini-latest',
    messages: [{ role: 'user', content: 'hello' }],
    fetcher: async (url, init) => {
      calledUrl = url;
      payload = JSON.parse(init.body);
      assert.equal(init.headers.Authorization, 'Bearer test-key');
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    },
  });
  assert.equal(calledUrl, 'https://hk.testvideo.site/v1/chat/completions');
  assert.equal(payload.model, 'codex-mini-latest');
  assert.equal(content, '{"ok":true}');
}

function testBuildAnalysisPromptUsesConfigurableInputLimits() {
  const candidates = Array.from({ length: 5 }, (_, i) => ({
    title: `候选${i}`,
    url: `https://example.com/${i}`,
    source_name: '官方源',
    module: '新规及案例动态',
  }));
  const leads = Array.from({ length: 5 }, (_, i) => ({
    title: `线索${i}`,
    url: '微信公众号',
    source_name: `公众号${i}`,
    module: '美妆动态',
  }));
  const prompt = buildAnalysisPrompt({
    candidates,
    leads,
    sources: sourceCatalog.sources,
    period: { start: '2026-06-01', end: '2026-06-07' },
    candidateLimit: 2,
    leadLimit: 3,
  });
  assert.ok(prompt.includes('候选0'));
  assert.ok(prompt.includes('候选1'));
  assert.equal(prompt.includes('候选2'), false);
  assert.ok(prompt.includes('线索0'));
  assert.ok(prompt.includes('线索2'));
  assert.equal(prompt.includes('线索3'), false);
}

async function testDingTalkDocumentPublishCreatesAndWritesMarkdown() {
  const calls = [];
  const result = await publishDingTalkDocument({
    env: {
      DINGTALK_CLIENT_ID: 'app-key',
      DINGTALK_CLIENT_SECRET: 'app-secret',
      DINGTALK_OPERATOR_ID: 'operator-union-id',
      DINGTALK_WORKSPACE_ID: 'workspace-id',
    },
    title: '2026-06-07 美妆法务资讯周报',
    markdown: '# 美妆法务资讯完整周报',
    fetcher: async (url, init) => {
      calls.push({ url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers });
      if (String(url).endsWith('/v1.0/oauth2/accessToken')) {
        return new Response(JSON.stringify({ accessToken: 'token', expireIn: 7200 }), { status: 200 });
      }
      if (String(url).endsWith('/v1.0/doc/workspaces/workspace-id/docs')) {
        return new Response(JSON.stringify({ docKey: 'doc-key', url: 'https://alidocs.dingtalk.com/i/nodes/doc-node' }), { status: 200 });
      }
      if (String(url).endsWith('/v1.0/doc/suites/documents/doc-key/overwriteContent')) {
        return new Response(JSON.stringify({ success: true, result: {} }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    },
  });
  assert.equal(result.url, 'https://alidocs.dingtalk.com/i/nodes/doc-node');
  assert.equal(calls[0].body.appKey, 'app-key');
  assert.equal(calls[1].body.name, '2026-06-07 美妆法务资讯周报');
  assert.equal(calls[1].body.operatorId, 'operator-union-id');
  assert.equal(calls[2].body.content, '# 美妆法务资讯完整周报');
  assert.equal(calls[2].body.contentType, 'markdown');
}

function testBuildAnalysisPromptIncludesLeads() {
  const prompt = buildAnalysisPrompt({
    candidates: [{ title: '法规候选', url: 'https://example.com/a', source_name: '官方源' }],
    leads: [{ name: '化妆品观察', source_type: 'wechat_public_account', topics: ['化妆品'] }],
    sources: [],
    period: { start: '2026-05-18', end: '2026-05-24' },
  });
  assert.ok(prompt.includes('leads'));
  assert.ok(prompt.includes('公众号可以作为强线索'));
  assert.ok(prompt.includes('不要输出未加工新闻'));
  assert.ok(prompt.includes('过去 7 天'));
  assert.ok(prompt.includes('行业影响力'));
}

function testBuildAnalysisPromptUsesModuleTarget() {
  const prompt = buildAnalysisPrompt({
    candidates: [{ title: '青眼资讯：进出口动态行业线索', url: '微信公众号', source_name: '青眼资讯', module: '进出口动态' }],
    leads: [{ name: '青眼资讯', source_type: 'wechat_public_account', module: '进出口动态', topics: ['进口化妆品'] }],
    sources: [],
    period: { start: '2026-05-18', end: '2026-05-24' },
    targetModule: '进出口动态',
  });
  assert.ok(prompt.includes('当前只分析模块：进出口动态'));
  assert.ok(prompt.includes('不要返回空数组'));
  assert.ok(prompt.includes('待核验'));
}

function testNormalizeModuleReportForcesTargetWorkbookModule() {
  const report = structuredClone(sampleReport);
  report.sections = [{
    module: '行业动态',
    items: [{ ...sampleReport.sections[0].items[0], module: '行业动态', title: '美妆平台治理趋势' }],
  }];

  const normalized = normalizeModuleReport(report, '美妆动态');
  assert.deepEqual(normalized.sections.map(section => section.module), ['美妆动态']);
  assert.equal(normalized.sections[0].items[0].module, '美妆动态');
  assert.equal(normalized.sections[0].items[0].title, '美妆平台治理趋势');
}

function testEnrichReportWithSourceSignalsFillsSparseWorkbookModules() {
  const sparse = {
    period: sampleReport.period,
    summary: [],
    risk_alerts: [],
    sections: [
      { module: '广告合规及处罚案例', items: [] },
      { module: '美妆动态', items: [] },
      { module: '知识产权动态', items: [] },
      { module: '新规及案例动态', items: [] },
      { module: '进出口动态', items: [] },
    ],
  };
  const candidates = [
    makeSourceLeadCandidate({
      name: '化妆品观察',
      url: '微信公众号',
      source_type: 'wechat_public_account',
      module: '美妆动态',
      region: '亚洲',
      country: '中国',
      authority_type: 'media',
      priority: 'medium',
      topics: ['美妆行业监管', '功效宣称'],
    }),
    makeSourceLeadCandidate({
      name: '海关发布',
      url: '微信公众号',
      source_type: 'wechat_public_account',
      module: '进出口动态',
      region: '亚洲',
      country: '中国',
      authority_type: 'media',
      priority: 'medium',
      topics: ['进口化妆品', '跨境清关'],
    }),
  ];

  const enriched = enrichReportWithSourceSignals(sparse, { candidates, sources: [] });
  assert.ok(enriched.sections.find(section => section.module === '美妆动态').items.length >= 1);
  assert.ok(enriched.sections.find(section => section.module === '进出口动态').items.length >= 1);
  assert.equal(validateReport(enriched), true);
}

function testFilterReportToObservedSourcesDropsFabricatedUrls() {
  const report = structuredClone(sampleReport);
  report.sections[0].items.push({
    ...sampleReport.sections[0].items[0],
    title: '疑似伪链接法规',
    source_url: 'https://ec.europa.eu/commission/presscorner/detail/en/ip_26_xxx',
  });

  const filtered = filterReportToObservedSources(report, {
    candidates: [{ url: sampleReport.sections[0].items[0].source_url }],
    sources: [{ url: sampleReport.sections[1].items[0].source_url }],
  });

  assert.equal(filtered.sections[0].items.length, 1);
  assert.equal(filtered.sections[0].items[0].title, sampleReport.sections[0].items[0].title);
}

function testAttachReportImagesUsesObservedCandidateImages() {
  const report = structuredClone(sampleReport);
  const sourceUrl = report.sections[0].items[0].source_url;
  const withImages = attachReportImages(report, {
    candidates: [{ url: sourceUrl, image_url: 'https://example.com/source.jpg' }],
  });
  assert.equal(withImages.sections[0].items[0].image_url, 'https://example.com/source.jpg');
}

function testEnterprisePromptRequiresGlobalLegalIntelligence() {
  const prompt = buildAnalysisPrompt({
    candidates: [{ title: 'BPOM 化妆品清真认证更新', url: 'https://www.pom.go.id/', source_name: '印度尼西亚 BPOM', country: '印尼', region: '亚洲' }],
    leads: [{ name: '化妆品观察', source_type: 'wechat_public_account', topics: ['化妆品'] }],
    sources: sourceCatalog.sources,
    period: { start: '2026-05-18', end: '2026-05-24' },
  });
  assert.ok(prompt.includes('国际化美妆电商集团'));
  assert.ok(prompt.includes('国家/区域监管机构'));
  assert.ok(prompt.includes('直接/间接相关'));
  assert.ok(prompt.includes('industry_impact'));
  assert.ok(prompt.includes('business_impact'));
  assert.ok(prompt.includes('案例必须拆解'));
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
  assert.ok(text.includes('full_version: DingTalk document'));
  assert.equal(text.includes('/report/latest'), false);
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

async function testScheduledPipelineSendsFeishuWithoutHtmlReport() {
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

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('api.deepseek.com')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(sampleReport) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href === 'https://example.com/webhook') {
      feishuSent = true;
      const body = JSON.parse(init.body);
      assert.equal(body.msg_type, 'interactive');
      assert.ok(JSON.stringify(body.card).includes('Executive Brief'));
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

  assert.equal(store.has('report:latest'), false);
  assert.equal([...store.keys()].some(key => /^report:\d{4}-\d{2}-\d{2}$/.test(key)), false);
  assert.ok(store.has('asset:decision-map:latest'));
  assert.equal(feishuSent, true);
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
    { name: '化妆品观察', url: '微信公众号', source_type: 'wechat_public_account', module: '美妆动态', region: '亚洲', country: '中国', topics: ['化妆品'], priority: 'low' },
    { name: '国家药监局', url: 'https://www.nmpa.gov.cn/', source_type: 'official_site', module: '新规及案例动态', region: '亚洲', country: '中国', topics: ['化妆品'], priority: 'high' },
  ];
  const split = splitSources(sources);
  assert.equal(split.fetchableSources.length, 1);
  assert.equal(split.leadSources.length, 1);
  assert.equal(makeLead(split.leadSources[0]).name, '化妆品观察');
}

function testSourceLeadCandidateKeepsWeaklyFetchableModulesAnalyzable() {
  const lead = makeSourceLeadCandidate({
    name: '青眼资讯',
    url: '微信公众号',
    source_type: 'wechat_public_account',
    module: '进出口动态',
    region: '亚洲',
    country: '中国',
    authority_type: 'media',
    priority: 'medium',
    topics: ['进口化妆品', '跨境电商', '清关'],
  });

  assert.equal(lead.module, '进出口动态');
  assert.equal(lead.source_type, 'wechat_public_account');
  assert.equal(lead.source_name, '青眼资讯');
  assert.equal(lead.url, '微信公众号');
  assert.ok(lead.title.includes('进出口动态'));
  assert.ok(lead.snippet.includes('进口化妆品'));
}

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

function testPromptIncludesProductQualityRecallModule() {
  const prompt = buildAnalysisPrompt({
    candidates: [],
    leads: [],
    sources: sourceCatalog.sources,
    period: { start: '2026-06-01', end: '2026-06-07' },
  });
  assert.ok(prompt.includes('产品质量/召回与安全风险'));
  assert.ok(prompt.includes('产品安全、抽检不合格、召回、禁限用成分、质量投诉'));
}

function testSelectSourcesForWorkerBudgetKeepsImportantCoverageUnderLimit() {
  const selected = selectSourcesForWorkerBudget(sourceCatalog.sources, 16);
  const fetchable = selected.filter(source => source.source_type !== 'wechat_public_account');
  assert.ok(fetchable.length <= 16);
  assert.ok(selected.some(source => source.source_type === 'wechat_public_account'));
  assert.ok(selected.some(source => source.name.includes('国家市场监督管理总局')));
  assert.ok(selected.some(source => source.name.includes('国家知识产权局')));
  assert.ok(selected.some(source => source.name.includes('美国 FDA')));
  for (const country of ['欧盟', '印尼', '泰国', '越南', '日本', '韩国', '墨西哥', '意大利']) {
    assert.ok(fetchable.some(source => source.country === country), `missing country ${country}`);
  }
  for (const module of ['广告合规及处罚案例', '知识产权动态', '新规及案例动态', '进出口动态']) {
    assert.ok(fetchable.some(source => source.module === module), `missing fetchable module ${module}`);
  }
}

function testWeeklyWorkflowRunsWorkerScriptAndPublishesDecisionMap() {
  const workflow = readFileSync(new URL('../.github/workflows/weekly.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('node worker/run-local.js'));
  assert.equal(workflow.includes('node run-local.js'), false);
  assert.ok(workflow.includes('npx wrangler deploy'));
  assert.ok(workflow.includes('"asset:decision-map:latest.png"'));
  assert.ok(workflow.includes('--path ../out/decision-map.png'));
}

function testDecisionMapPublicUrlCanOverrideWorkerAssetUrl() {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.ok(source.includes('env.DECISION_MAP_PUBLIC_URL || env.DECISION_MAP_URL'));
}

await testFetchWithTimeoutAbortsSlowFetch();
await testManualTestRouteAwaitsPipeline();
await testMapWithConcurrencyLimitsParallelWork();
await testScheduledPipelineSendsFeishuWithoutHtmlReport();
await testManualTestRouteRecordsFailure();
testNormalizeUrl();
testHtmlToText();
testExtractLinks();
testExtractImageUrl();
testGetSourceStats();
testIsRelevantTitle();
testMakeCandidate();
testParseAnalysisJson();
testValidateReport();
testValidateReportRequiresRegulationAnalysis();
testFilterReportQualityDropsItemsWithoutSourceUrl();
testFilterReportQualityKeepsLeadBasedBeautyAndImportSignals();
testNormalizeReportForValidationFillsDynamicAnalysisFields();
testLimitReportSectionsKeepsEnterpriseModuleDepth();
testLimitReportSectionsAcceptsQualityLimit();
testRenderFeishuSummary();
testRenderDingTalkMarkdownUsesModuleRegionCountryStructure();
testRenderDingTalkMarkdownShowsAllModulesWhenEmpty();
testRenderDingTalkSummaryCardIsConciseAndIncludesKeyword();
await testBuildDingTalkWebhookUrlSignsSecret();
await testSendToDingTalkPostsMarkdownPayload();
await testNotifyReportPrefersDingTalkWhenConfigured();
await testRequestAiChatUsesOpenAiCompatibleBaseUrl();
testBuildAnalysisPromptUsesConfigurableInputLimits();
await testDingTalkDocumentPublishCreatesAndWritesMarkdown();
testBuildAnalysisPromptIncludesLeads();
testBuildAnalysisPromptUsesModuleTarget();
testNormalizeModuleReportForcesTargetWorkbookModule();
testEnrichReportWithSourceSignalsFillsSparseWorkbookModules();
testFilterReportToObservedSourcesDropsFabricatedUrls();
testAttachReportImagesUsesObservedCandidateImages();
testEnterprisePromptRequiresGlobalLegalIntelligence();
testCandidateFreshnessAndInfluenceRanking();
testDedupeReportRemovesRepeatedItems();
testExtractReportFingerprintsUsesItems();
testSplitSourcesSeparatesWechatLeads();
testSourceLeadCandidateKeepsWeaklyFetchableModulesAnalyzable();
testSourceCatalogUsesWorkbookModulesAndGlobalMarkets();
testSelectSourcesForWorkerBudgetKeepsImportantCoverageUnderLimit();
testPromptIncludesProductQualityRecallModule();
testWeeklyWorkflowRunsWorkerScriptAndPublishesDecisionMap();
testDecisionMapPublicUrlCanOverrideWorkerAssetUrl();
console.log('worker pure function tests ok');
