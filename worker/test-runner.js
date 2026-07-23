import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import sampleReport from './sample-report.json' with { type: 'json' };
import sourceCatalog from './sources.json' with { type: 'json' };
import { createBrowserSourceFetcher } from './browser-fetch.js';
import { buildSingleDingTalkMessage, splitConclusionPoints } from './dingtalk-single-card.js';
import { buildEditorialReport } from './editorial-report.js';
import { buildEditorialReportHtml } from './editorial-report-image.js';
import { renderEditorialReportPng } from '../scripts/render-editorial-report-png.js';
import { buildActionDashboardSvg } from './action-dashboard.js';
import {
  REPORT_MODULES,
  classifyReportItem,
  curateReportQuality,
  curateReportQualityWithAudit,
  summarizeExecutiveReport,
} from './report-quality.js';
import { publishVersionedPng } from './cloudflare-assets.js';
import {
  extractGoogleDecodingParams,
  parseGoogleBatchResponse,
  parseGoogleNewsRss,
} from './google-rss-discovery.js';
import {
  SourceCoverageError,
  assertSourceCoverage,
  calculateSourceCoverage,
  classifyFetchFailure,
  recoverPublicSource,
} from './source-recovery.js';
import {
  evaluateEditorialCandidate,
  inferArticleChinaRelevance,
  inferCandidateModule,
  isEditoriallyUsefulCandidate,
  evaluateSourceOnlyProof,
  buildSourceOnlyAudit,
} from './content-quality.js';
import {
  buildPremiumDingTalkMarkdown,
  selectPremiumEvidenceCards,
  validatePremiumEvidenceCard,
} from './premium-quality.js';
import {
  loadHydratedRecordsFromEnv,
  mergeHydratedCandidates,
  normalizeHydratedRecord,
} from './source-hydration.js';
import {
  buildAuthoritySearchTasks,
  buildAuthoritySearchQueries,
  classifyAuthorityTrust,
  selectAuthorityResolvedCandidates,
} from './authority-resolver.js';
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
  isNavigationTitle,
  parseAnalysisJson,
  validateReport,
  renderFeishuSummary,
  renderDingTalkMarkdown,
  renderDingTalkSummaryCard,
  buildDingTalkWebhookMessages,
  buildDingTalkWebhookUrl,
  sendToDingTalk,
  sendDingTalkMessages,
  notifyReport,
  getDingTalkAccessToken,
  createDingTalkDocument,
  overwriteDingTalkDocument,
  uploadDingTalkImage,
  publishDingTalkDocument,
  requestAiChat,
  deepseekAnalyze,
  deepseekRescueAnalyze,
  selectRescueEvidenceCandidates,
  analyzeReportByModule,
  analyzeReportWithRecovery,
  processAnalyzedReport,
  shouldPublishDecisionMap,
  shouldSkipDuplicateReport,
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
  collectCandidates,
  fetchWithTimeout,
  selectSourcesForWorkerBudget,
  mapWithConcurrency,
  extractPublishedDate,
  extractArticleText,
  hydrateCandidateDetails,
  choosePublishedDate,
  applyEditorialGate,
  sortCandidatesForAnalysis,
  prioritizeCandidatesForAnalysis,
  classifyFreshness,
  filterCandidatesByFreshness,
  runPipeline,
  isArtifactOnlyRun,
} from './index.js';

function testFreshnessGateAcceptsCurrentWeekAndSevenDayBoundary() {
  const period = { start: '2026-07-13', end: '2026-07-19' };
  assert.equal(classifyFreshness({ published_at: '2026-07-19' }, period).status, 'current-week');
  assert.equal(classifyFreshness({ published_at: '2026-07-12' }, period).accepted, true);
  assert.equal(classifyFreshness({ published_at: '2026-07-11' }, period).accepted, false);
}

function testEditorialGateRejectsPromotionalAndServicePages() {
  const rejected = [
    '企业供稿：2027澳门美妆展全面启动全球招展，欢迎合作洽谈',
    '广州化妆品出口印尼双清包税到门，提供一站式代办服务',
    '品牌宣传：新品发布会开启全新美妆体验',
  ];
  for (const title of rejected) {
    const result = evaluateEditorialCandidate({
      title,
      url: 'https://publisher.example/article',
      published_at: '2026-07-19',
      article_text: `${title}\n欢迎报名参展，咨询合作方案。`,
    });
    assert.equal(isEditoriallyUsefulCandidate({
      title,
      url: 'https://publisher.example/article',
      published_at: '2026-07-19',
      article_text: `${title}\n欢迎报名参展，咨询合作方案。`,
    }), false);
    assert.match(result.reason, /promotional|service/);
  }
}

function testEditorialGateRequiresConcreteFactsButKeepsWatch() {
  const generic = evaluateEditorialCandidate({
    title: '美妆行业趋势观察：增长逻辑正在重构',
    url: 'https://publisher.example/opinion',
    published_at: '2026-07-19',
    article_text: '行业人士认为企业应持续关注消费变化，未来竞争将更加激烈。当前市场仍缺少可核验的单一事件、监管动作、具体主体和结果，文章主要讨论宏观方向，没有给出可核验的时间、数量、制度或处理结论。',
  });
  assert.equal(generic.accepted, false);
  assert.equal(generic.reason, 'no-concrete-event');

  const watch = evaluateEditorialCandidate({
    title: '某市监管部门通报一款护肤品抽检不合格',
    url: 'https://publisher.example/notice',
    published_at: '2026-07-19',
    article_text: '某市市场监管局于2026年7月19日通报，抽检发现某护肤品菌落总数超标，责令经营者下架并整改。',
  });
  assert.equal(watch.accepted, true);
  assert.equal(watch.tier, 'watch');
  assert.equal(isEditoriallyUsefulCandidate({
    title: '某市监管部门通报一款护肤品抽检不合格',
    url: 'https://publisher.example/notice',
    published_at: '2026-07-19',
    article_text: '某市市场监管局于2026年7月19日通报，抽检发现某护肤品菌落总数超标，责令经营者下架并整改。',
  }), true);
}

function testEditorialGateRejectsRepublisherSourcesEvenWithConcretePenaltyFacts() {
  const sohuRepost = evaluateEditorialCandidate({
    title: '化妆品“PRO-XYLANE”商标侵权刷单案被罚17万元',
    url: 'https://www.sohu.com/a/900000000_121000000',
    source_name: '搜狐转载',
    source_type: 'industry_media',
    authority_type: 'media',
    published_at: '2026-07-19',
    article_text: '2026年7月19日，某商家未经授权生产带 PRO-XYLANE 商标化妆品21,572盒，销售8,556盒，违法经营额124,700.89元，并因刷单7,521单被市场监管部门合计罚款17万元。',
  });
  assert.equal(sohuRepost.accepted, false);
  assert.equal(sohuRepost.reason, 'non-authoritative-source');
}

function testEditorialModuleUsesArticleFactsAndChinaEvidence() {
  assert.equal(inferCandidateModule({ title: '监管部门发布通知', article_text: '国家药监局发布化妆品备案新规，7月1日起执行。' }), '新规及案例动态');
  assert.equal(inferCandidateModule({ title: '品牌纠纷', article_text: '法院判决某公司侵犯商标权并赔偿50万元。' }), '知识产权动态');
  assert.equal(inferCandidateModule({ title: '市场消息', article_text: '海关公布化妆品进口关税调整，企业需补充报关文件。' }), '进出口动态');
  assert.equal(inferCandidateModule({ title: '产品通报', article_text: '监管部门召回含禁用成分的护肤品，涉及1200件。' }), '产品质量/召回与安全风险');
  assert.equal(inferCandidateModule({ title: '企业公告', article_text: '某公司与经销商签订300万美元化妆品品牌合作合同。' }), '美妆动态');

  assert.equal(inferArticleChinaRelevance({ title: 'China NMPA发布化妆品通知', article_text: 'China NMPA要求企业在中国市场完成备案。' }).relevant, true);
  assert.equal(inferArticleChinaRelevance({ title: '最新欧盟化妆品法规更新', article_text: '欧盟委员会修订附录II，意见征集截止9月6日。' }).relevant, false);
  assert.equal(inferArticleChinaRelevance({ title: 'BPOM披露非法化妆品销售', article_text: '印尼食品药品监督局在雅加达查处线上销售。', source_name: '中文媒体' }).relevant, false);
  assert.equal(inferArticleChinaRelevance({ title: '海外法规动态', article_text: '该规则将影响在中国市场销售的进口化妆品。' }).relevant, true);
}

function testEditorialGateRunsAfterHydrationBeforeAnalysis() {
  const result = applyEditorialGate([
    {
      title: '监管部门通报护肤品抽检不合格',
      url: 'https://publisher.example/notice',
      published_at: '2026-07-19',
      detail_status: 'hydrated',
      snippet: '某市市场监管局于2026年7月19日通报，抽检发现护肤品菌落总数超标，责令下架整改。',
    },
    {
      title: '2027澳门美妆展全球招展',
      url: 'https://publisher.example/expo',
      published_at: '2026-07-19',
      detail_status: 'hydrated',
      snippet: '来源：企业供稿。欢迎报名参展，欢迎合作洽谈。',
    },
  ]);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].editorial_status, 'accepted');
  assert.equal(result.candidates[0].module, '产品质量/召回与安全风险');
  assert.equal(result.audit.rejected, 1);
  assert.equal(result.audit.rejections[0].reason, 'promotional-content');
}

function testSourceOnlyProofRequiresIndependentTwentyTenFour() {
  const base = index => ({
    title: `监管部门通报第${index}款护肤品抽检结果`,
    url: `https://publisher.example/notice-${index}`,
    published_at: '2026-07-19',
    detail_status: 'hydrated',
    editorial_status: 'accepted',
    module: ['产品质量/召回与安全风险', '新规及案例动态', '知识产权动态', '美妆动态'][index % 4],
    china_relevant: index < 10,
    snippet: `某市市场监管局于2026年7月19日通报，第${index}款产品抽检不合格，责令下架整改。`,
  });
  const proof = evaluateSourceOnlyProof([...Array.from({ length: 20 }, (_, index) => base(index)), {
    ...base(0),
    title: '监管部门通报第0款护肤品抽检结果（转载）',
    url: 'https://second.example/repost-0',
  }], { period: { start: '2026-07-13', end: '2026-07-19' } });
  assert.equal(proof.primary_count, 20);
  assert.equal(proof.china_count, 10);
  assert.equal(proof.active_module_count, 4);
  assert.equal(proof.pass, true);
  assert.equal(proof.duplicates, 1);

  const failed = evaluateSourceOnlyProof(Array.from({ length: 19 }, (_, index) => ({ ...base(index), china_relevant: index < 9 })), {
    period: { start: '2026-07-13', end: '2026-07-19' },
  });
  assert.equal(failed.pass, false);
  assert.deepEqual(failed.failure_codes, ['minimum-items', 'minimum-china-items']);
}

function testEditorialGateRejectsIntermediaryAndNavigationUrls() {
  const intermediary = evaluateEditorialCandidate({
    title: '监管部门发布化妆品召回公告',
    url: 'https://news.google.com/rss/articles/opaque',
    published_at: '2026-07-19',
    article_text: '监管部门于2026年7月19日发布召回公告，涉及100件产品。',
  });
  assert.equal(intermediary.accepted, false);
  assert.equal(intermediary.reason, 'non-publisher-url');

  const navigation = evaluateEditorialCandidate({
    title: '产品质量与召回信息源入口',
    url: 'https://publisher.example/quality/entry',
    published_at: '2026-07-19',
    article_text: '首页 导航 登录 注册 联系我们 搜索 产品质量与召回信息源入口',
  });
  assert.equal(navigation.accepted, false);
  assert.equal(navigation.reason, 'navigation-shell');
}

function testSourceOnlyAuditRecordsEveryCandidateReason() {
  const audit = buildSourceOnlyAudit({
    period: { start: '2026-07-13', end: '2026-07-19' },
    candidates: [
      {
        title: '监管部门通报抽检不合格',
        url: 'https://publisher.example/notice',
        published_at: '2026-07-19',
        detail_status: 'hydrated',
        snippet_excerpt: '某市市场监管局于2026年7月19日通报，抽检发现护肤品超标，责令下架整改。',
      },
      {
        title: '展会全球招展',
        url: 'https://publisher.example/expo',
        published_at: '2026-07-19',
        detail_status: 'hydrated',
        snippet_excerpt: '来源：企业供稿，欢迎报名参展和合作洽谈。',
      },
      {
        title: '监管部门通报另一事项',
        url: 'https://publisher.example/failed',
        published_at: '2026-07-19',
        detail_status: 'failed',
        snippet_excerpt: '',
      },
    ],
  });
  assert.equal(audit.counts.input, 3);
  assert.equal(audit.counts.editorial_accepted, 1);
  assert.equal(audit.counts.primary_count, 1);
  assert.equal(audit.items.find(item => item.title === '展会全球招展').reason, 'promotional-content');
  assert.equal(audit.items.find(item => item.title === '监管部门通报另一事项').reason, 'not-hydrated');
}

function testEditorialGateRejectsProductRankingsAndNonBeautyPolicy() {
  const ranking = evaluateEditorialCandidate({
    title: '2026年祛痘去痘印十大产品推荐',
    url: 'https://publisher.example/product-ranking',
    published_at: '2026-07-15',
    article_text: '某行业协会于2026年7月15日发布十大产品实测榜单，盘点高效修护好物并推荐多个品牌购买。',
  });
  assert.equal(ranking.accepted, false);
  assert.equal(ranking.reason, 'promotional-content');

  const taxOpinion = evaluateEditorialCandidate({
    title: '消费税扩围政策讨论',
    url: 'https://publisher.example/tax-policy',
    published_at: '2026-07-13',
    article_text: '某研究中心主任于2026年7月13日讨论含糖饮料、塑料制品和高端医疗服务的消费税扩围路径。',
  });
  assert.equal(taxOpinion.accepted, false);
  assert.equal(taxOpinion.reason, 'not-beauty-industry');
}

function testGoogleRssDiscoveryParsesAndDecodesStructuredData() {
  const rss = `<?xml version="1.0"?><rss><channel><item>
    <title><![CDATA[化妆品抽检通报 - 监管媒体]]></title>
    <link>https://news.google.com/rss/articles/opaque</link>
    <pubDate>Wed, 15 Jul 2026 09:04:22 GMT</pubDate>
    <source url="https://publisher.example">监管媒体</source>
  </item></channel></rss>`;
  const [item] = parseGoogleNewsRss(rss, '产品质量/召回与安全风险');
  assert.equal(item.title, '化妆品抽检通报');
  assert.equal(item.source_name, '监管媒体');
  assert.equal(item.published_at, '2026-07-15');
  assert.equal(item.module, '产品质量/召回与安全风险');

  assert.deepEqual(extractGoogleDecodingParams('<div data-n-a-ts="1784523803" data-n-a-sg="signature"></div>'), {
    timestamp: '1784523803',
    signature: 'signature',
  });
  const response = `)]}'\n\n[["wrb.fr","Fbv4je","[null,\\"https://publisher.example/article\\"]"]]`;
  assert.equal(parseGoogleBatchResponse(response), 'https://publisher.example/article');
}

function testEditorialGateIgnoresPromotionalFooterAfterConcreteLead() {
  const result = evaluateEditorialCandidate({
    title: '市场监管部门通报44批次化妆品抽检不合格',
    url: 'https://publisher.example/regulator-notice',
    published_at: '2026-07-15',
    article_text: [
      '某省药品监督管理局于2026年7月15日通报44批次化妆品抽检不合格，责令相关企业下架整改。',
      '本次抽检涉及防晒、洗护产品，检测结果和企业名单已经公开。',
      '相关企业应按照通知要求完成召回和整改。',
      '页面底部推荐：新品发布，欢迎合作洽谈。',
    ].join('\n'),
  });
  assert.equal(result.accepted, true);
}

function testEditorialGateAcceptsConcreteEnglishRegulatoryEvents() {
  const events = [
    {
      title: 'Korea deploys task force to shield cosmetics industry from new rules',
      article_text: 'The Korean government announced on July 20, 2026 that a task force will implement new halal cosmetics rules affecting K-beauty exporters.',
    },
    {
      title: 'Supreme Court rules on Drugs and Cosmetics Act prosecution',
      article_text: 'The Supreme Court ruled on July 17, 2026 that the limitation period begins when authorities identify the accused under the Drugs and Cosmetics Act.',
    },
    {
      title: 'FDA destroys banned hydroquinone cosmetics',
      article_text: 'The Ghana FDA announced on July 17, 2026 that it destroyed 120 batches of expired and banned hydroquinone cosmetics after an inspection.',
    },
  ];
  for (const [index, event] of events.entries()) {
    const result = evaluateEditorialCandidate({
      ...event,
      url: `https://publisher.example/english-event-${index}`,
      published_at: '2026-07-17',
    });
    assert.equal(result.accepted, true, event.title);
  }
}

function testEditorialGateAcceptsConcreteCompanyLaunchAndAgreement() {
  const result = evaluateEditorialCandidate({
    title: '韩国造纸企业加速多元化发展，美妆领域成新赛道',
    url: 'https://publisher.example/korean-paper-company-beauty-launch',
    published_at: '2026-07-16',
    article_text: '기사입력 2026년07월16일，韩松制纸推出用于化妆品的天然增稠剂Duracle，并与大型化妆品企业签署技术合作谅解备忘录。可绿纳乐则新增美容仪器销售经营范围，正式启动相关业务。',
  });
  assert.equal(result.accepted, true);
}

function testHydrationKeepsTrustedFeedDateWhenBodyDateIsUnrelated() {
  assert.equal(choosePublishedDate('2026-07-17', '2006-05-01'), '2026-07-17');
  assert.equal(choosePublishedDate('2026-07-15', '2026-07-16'), '2026-07-16');
  assert.equal(choosePublishedDate('', '2026-07-16'), '2026-07-16');
}

function testPremiumEvidenceGateRejectsWeakAndKeepsActionableItems() {
  const weak = validatePremiumEvidenceCard({
    title: '美妆行业趋势观察',
    module: '美妆动态',
    source_url: 'https://example.com/trend',
    source_name: '官方来源',
    published_at: '2026-07-20',
    facts: ['2026年7月20日，某品牌发布新品并披露阶段性销售表现。'],
    legal_signal: '该动态不直接新增法定义务，但提示品牌传播方式正在变化。',
    business_impact: '电商和品牌团队需要留意直播脚本是否继续使用同类表达。',
    recommended_action: '持续关注。',
  });
  assert.equal(weak.accepted, false);
  assert.equal(weak.reason, 'generic-action');

  const strong = validatePremiumEvidenceCard({
    title: '国家市场监管总局发布严重违法失信名单新规',
    module: '新法律法规政策',
    source_url: 'https://samr.gov.cn/notice/20260720',
    source_name: '国家市场监管总局',
    published_at: '2026-07-20',
    country: '中国',
    facts: ['2026年7月20日，新规将化妆品非法添加纳入严重违法失信名单管理。'],
    legal_signal: '非法添加行为将触发更高信用惩戒和公开限制。',
    business_impact: '配方、功效宣称和供应商准入需要纳入失信风险排查。',
    recommended_action: '法务牵头更新违法失信筛查清单，质量团队复核高风险原料和代工厂准入记录。',
  });
  assert.equal(strong.accepted, true);
  assert.equal(strong.tier, 'action');
}

function testPremiumEvidenceGateKeepsOfficialWatchEntriesWithConcreteSignals() {
  const watch = validatePremiumEvidenceCard({
    title: '欧盟 Safety Gate 作为非食品消费品危险通报入口，应纳入化妆品召回监测',
    module: '产品质量/召回与安全风险',
    source_url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport',
    source_name: '欧盟 Safety Gate',
    published_at: '2026-07-23',
    country: '欧盟',
    facts: ['Crawl4AI 抓取到欧盟 Safety Gate 页面标题为 EU rapid alert system for dangerous non-food products。'],
    legal_signal: 'Safety Gate 是欧盟危险非食品产品快速预警入口。',
    business_impact: '欧盟渠道、跨境电商和海外经销商需监测同品牌、同供应商、同成分或同包装风险。',
    recommended_action: '质量团队每周检索 Safety Gate 的 cosmetics/perfume/skin care 关键词，法规团队维护欧盟召回模板。',
  });
  assert.equal(watch.accepted, true);
  assert.equal(watch.tier, 'watch');
}

function testPremiumEvidenceGateRejectsRepublisherSourceEvenWhenFactsAreHard() {
  const repost = validatePremiumEvidenceCard({
    title: '两家美妆企业冒用爱马仕商标合计被罚63.5万元',
    module: '知识产权保护或者侵权',
    source_url: 'https://www.sohu.com/a/900000001_121000000',
    source_name: '搜狐转载',
    source_type: 'industry_media',
    authority_type: 'media',
    published_at: '2026-07-19',
    country: '中国',
    facts: ['两家美妆企业因在产品瓶身和包装上冒用 HERMES 商标，合计被罚63.5万元并没收侵权商品33,082件。'],
    legal_signal: '化妆品包装、套盒和传播素材使用奢侈品牌标识会形成商标侵权和行政处罚风险。',
    business_impact: '影响品牌命名、包装设计、达人素材和商标授权链路。',
    recommended_action: '知识产权团队3日内复核在售套盒包装，品牌团队同步下线未经授权的大牌联名表达。',
    hard_facts: {
      penalty_amount: '63.5万元',
      legal_basis: '《商标法》第五十七条',
      involved_party: '两家美妆企业',
      product_or_batch: '涉 HERMES 标识化妆品',
    },
  });
  assert.equal(repost.accepted, false);
  assert.equal(repost.reason, 'non-authoritative-source');
}

function testPremiumSelectionPrioritizesQualityBeforeQuantityAndCoreModules() {
  const cards = [
    {
      title: '普通品牌增长新闻',
      module: '美妆动态',
      source_url: 'https://example.com/brand',
      source_name: '行业媒体',
      published_at: '2026-07-20',
      country: '中国',
      facts: ['2026年7月20日，某品牌发布新产品并披露销售增长12%。'],
      legal_signal: '未形成新增监管义务。',
      business_impact: '可作为市场观察，不构成法务行动。',
      recommended_action: '品牌合规团队记录为市场观察，暂不启动专项排查。',
    },
    {
      title: '欧盟更新化妆品禁限用物质清单',
      module: '新法律法规政策',
      source_url: 'https://ec.europa.eu/cosmetics/rule',
      source_name: '欧盟委员会',
      published_at: '2026-07-19',
      country: '欧盟',
      facts: ['2026年7月19日，欧盟更新化妆品禁限用物质清单并设置过渡期。'],
      legal_signal: '出口欧盟产品需要重新核查配方与标签合规。',
      business_impact: '涉及欧盟销售的防晒和护肤产品可能需要配方复核。',
      recommended_action: '法规团队确认受影响 SKU，研发和供应链在过渡期前完成配方替换评估。',
    },
    {
      title: '某地市场监管局处罚虚假功效宣称',
      module: '广告处罚案例',
      source_url: 'https://amr.example.gov.cn/penalty',
      source_name: '地方市场监管局',
      published_at: '2026-07-18',
      country: '中国',
      facts: ['2026年7月18日，监管部门因普通化妆品宣称医疗功效处罚经营者。'],
      legal_signal: '普通化妆品不得通过广告暗示治疗、修复疾病或医疗功效。',
      business_impact: '直播话术、详情页和达人素材存在同类风险。',
      recommended_action: '广告合规团队抽检功效宣称素材，电商团队下线医疗化表达并保留整改记录。',
    },
    {
      title: '欧盟 Safety Gate 作为非食品消费品危险通报入口，应纳入化妆品召回监测',
      module: '产品质量/召回与安全风险',
      source_url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport',
      source_name: '欧盟 Safety Gate',
      published_at: '2026-07-23',
      country: '欧盟',
      facts: ['Crawl4AI 抓取到欧盟 Safety Gate 页面标题为 EU rapid alert system for dangerous non-food products。'],
      legal_signal: 'Safety Gate 是欧盟危险非食品产品快速预警入口。',
      business_impact: '欧盟渠道、跨境电商和海外经销商需监测同品牌、同供应商、同成分或同包装风险。',
      recommended_action: '质量团队每周检索 Safety Gate 的 cosmetics/perfume/skin care 关键词，法规团队维护欧盟召回模板。',
    },
  ];
  const selected = selectPremiumEvidenceCards(cards, { maxItems: 3 });
  assert.deepEqual(selected.map(card => card.module), ['广告处罚案例', '新法律法规政策', '产品质量/召回与安全风险']);
}

function testPremiumDingTalkMarkdownUsesCompactEvidenceCardFormat() {
  const markdown = buildPremiumDingTalkMarkdown({
    period: { start: '2026-07-13', end: '2026-07-20' },
    cards: [{
      title: '某地市场监管局处罚虚假功效宣称',
      module: '广告处罚案例',
      source_url: 'https://amr.example.gov.cn/penalty',
      source_name: '地方市场监管局',
      published_at: '2026-07-18',
      country: '中国',
      facts: ['监管部门因普通化妆品宣称医疗功效处罚经营者。'],
      legal_signal: '普通化妆品不得暗示医疗功效。',
      business_impact: '直播话术、详情页和达人素材存在同类风险。',
      recommended_action: '广告合规团队抽检功效宣称素材，电商团队下线医疗化表达。',
    }],
  });
  assert.match(markdown, /美妆法务资讯精品卡/);
  assert.match(markdown, /广告处罚案例/);
  assert.match(markdown, /法务观察/);
  assert.match(markdown, /下一步观察建议/);
  assert.match(markdown, /\[原文\]\(https:\/\/amr\.example\.gov\.cn\/penalty\)/);
  assert.doesNotMatch(markdown, /建议关注|持续关注|分级：|类型：|建议动作/);
}

function testPremiumDingTalkMarkdownDoesNotExposeRiskTierAndSignalType() {
  const markdown = buildPremiumDingTalkMarkdown({
    period: { start: '2026-07-13', end: '2026-07-20' },
    cards: [{
      title: '地方海关发布化妆品进口申报要素调整提示',
      module: '进出口',
      source_url: 'https://customs.example.cn/rule',
      source_name: '海关总署',
      published_at: '2026-07-18',
      country: '中国',
      facts: ['2026年7月18日，海关发布化妆品进口申报要素调整提示，涉及 HS 编码 3304990010。'],
      legal_signal: '进口化妆品申报应复核商品归类、成分用途描述和单证一致性。',
      business_impact: '影响进口护肤 SKU 的清关、采购报价和到岸成本核算。',
      recommended_action: '关务团队本周复核进口护肤 SKU 申报要素，采购团队同步更新报价模板。',
    }],
  });
  assert.match(markdown, /法务观察/);
  assert.match(markdown, /下一步观察建议/);
  assert.doesNotMatch(markdown, /分级：|类型：|本周排查|新增义务/);
}

function testPremiumDingTalkMarkdownKeepsPolicyPlanningObservationNeutral() {
  const markdown = buildPremiumDingTalkMarkdown({
    period: { start: '2026-07-21', end: '2026-07-23' },
    cards: [{
      title: '国务院常务会议审议通过《知识产权保护和运用“十五五”规划》',
      module: '知识产权保护或者侵权',
      source_url: 'https://www.cnipa.gov.cn/art/2026/7/22/art_55_207319.html',
      source_name: '国家知识产权局',
      published_at: '2026-07-22',
      country: '中国',
      facts: ['CNIPA 首页在 2026-07-22 新闻列表中显示国务院常务会议审议通过该规划。'],
      legal_signal: '知识产权保护和运用继续政策化、体系化。',
      business_impact: '影响新品命名、包装视觉、达人素材授权和海外商标布局。',
      recommended_action: '知识产权团队本周拉取重点品牌商标和外观设计清单，法务团队补齐授权链路。',
    }],
  });
  assert.match(markdown, /法务观察/);
  assert.doesNotMatch(markdown, /分级：|类型：|风险案例|执法趋势|立即处理/);
}

function testPremiumDingTalkMarkdownDoesNotExposeInternalVoiceOrCrawlerName() {
  const markdown = buildPremiumDingTalkMarkdown({
    period: { start: '2026-07-20', end: '2026-07-23' },
    cards: [{
      title: '化妆品标准管理办法征求意见',
      module: '新法律法规政策',
      source_url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260723.html',
      source_name: '国家药监局',
      source_type: 'official_site',
      authority_type: 'regulator',
      published_at: '2026-07-23',
      country: '中国',
      facts: ['Crawl4AI 抓取到《化妆品标准管理办法（征求意见稿）》正文，我们看到过渡期一般不超过2年。'],
      legal_signal: '我们判断该事项涉及标准执行、新旧衔接和企业参与渠道。',
      business_impact: '对我们的标签、备案和标准执行流程形成影响。',
      recommended_action: '法规、研发、质量团队跟踪征求意见稿和反馈渠道。',
      hard_facts: {
        authority: '国家药监局',
        deadline: '2026年8月15日',
        owner_teams: ['法规', '研发', '质量'],
        affected_processes: ['标签', '备案', '标准执行'],
      },
    }],
  });
  assert.doesNotMatch(markdown, /Crawl4AI|我|我们|咱们|本人|本工具|本系统/);
  assert.match(markdown, /过渡期一般不超过2年/);
  assert.match(markdown, /涉及标准执行、新旧衔接和企业参与渠道/);
}

function testPremiumDingTalkMarkdownIncludesThreeCoreModulesWhenAvailable() {
  const markdown = buildPremiumDingTalkMarkdown({
    period: { start: '2026-07-21', end: '2026-07-23' },
    cards: [
      {
        title: '欧盟委员会化妆品专题页维持配方、责任人和上市合规的官方监管入口',
        module: '新法律法规政策',
        source_url: 'https://single-market-economy.ec.europa.eu/sectors/cosmetics/cosmetic-products-specific-topics_en',
        source_name: '欧盟委员会',
        published_at: '2026-07-23',
        country: '欧盟',
        facts: ['Crawl4AI 抓取到欧盟委员会化妆品专题页，页面明确为官方监管入口。'],
        legal_signal: '出口欧盟的化妆品仍应按欧盟化妆品监管框架核查责任人、成分限制和上市前通报义务。',
        business_impact: '影响欧盟在售或拟上市的护肤、彩妆、防晒和洗护 SKU。',
        recommended_action: '法规团队本周建立欧盟 SKU 合规台账。',
      },
      {
        title: '市场监管总局公布十起民生领域违法广告典型案例',
        module: '广告处罚案例',
        source_url: 'https://www.samr.gov.cn/xw/zj/art/2026/art_fa68b35c13f449218736a97ff7f27133.html',
        source_name: '国家市场监督管理总局',
        published_at: '2026-07-21',
        country: '中国',
        facts: ['Crawl4AI 抓取的 SAMR 首页在 2026-07-21 新闻列表中显示该典型案例发布。'],
        legal_signal: '总局以典型案例方式释放执法口径，广告真实性和误导性宣传仍处于高压监管。',
        business_impact: '直播话术、详情页和达人素材存在同类风险。',
        recommended_action: '广告合规团队抽检近 30 天直播脚本、信息流广告和详情页首屏文案。',
      },
      {
        title: '欧盟 Safety Gate 作为非食品消费品危险通报入口，应纳入化妆品召回监测',
        module: '产品质量/召回与安全风险',
        source_url: 'https://ec.europa.eu/safety-gate-alerts/screen/webReport',
        source_name: '欧盟 Safety Gate',
        published_at: '2026-07-23',
        country: '欧盟',
        facts: ['Crawl4AI 抓取到欧盟 Safety Gate 页面标题为 EU rapid alert system for dangerous non-food products。'],
        legal_signal: 'Safety Gate 是欧盟危险非食品产品快速预警入口。',
        business_impact: '欧盟渠道、跨境电商和海外经销商需监测同品牌、同供应商、同成分或同包装风险。',
        recommended_action: '质量团队每周检索 Safety Gate 的 cosmetics/perfume/skin care 关键词。',
      },
    ],
  });
  assert.match(markdown, /新法律法规政策/);
  assert.match(markdown, /广告处罚案例/);
  assert.match(markdown, /产品质量\/召回与安全风险/);
}

function testPremiumDingTalkMarkdownSurfacesHardFieldsInsideExistingSections() {
  const markdown = buildPremiumDingTalkMarkdown({
    period: { start: '2026-07-21', end: '2026-07-23' },
    cards: [{
      title: '市场监管局处罚某公司普通化妆品医疗化宣称',
      module: '广告处罚案例',
      source_url: 'https://amr.example.gov.cn/case/20260723',
      source_name: '上海市市场监督管理局',
      published_at: '2026-07-23',
      country: '中国',
      facts: ['2026年7月23日，监管部门因普通化妆品宣称医疗功效处罚某公司，罚款12万元。'],
      legal_signal: '普通化妆品不得通过直播话术、详情页或达人素材暗示治疗、修复疾病等医疗功效。',
      business_impact: '影响天猫、抖音和小红书渠道的普通护肤 SKU 广告素材、达人脚本和功效证据留存。',
      recommended_action: '广告合规团队3日内抽检近30天直播脚本，电商团队下线医疗化表达并保留整改记录。',
      hard_facts: {
        authority: '上海市市场监督管理局',
        document_number: '沪市监处罚〔2026〕88号',
        penalty_amount: '12万元',
        legal_basis: '《广告法》第二十八条',
        involved_party: '某化妆品有限公司',
        product_or_batch: '普通护肤 SKU',
        affected_processes: ['广告素材', '达人脚本', '功效证据留存'],
        owner_teams: ['广告合规', '电商'],
        action_deadline: '3日内',
        signal_type: '风险案例',
        risk_tier: '立即处理',
      },
    }],
  });
  assert.doesNotMatch(markdown, /立即处理/);
  assert.doesNotMatch(markdown, /风险案例/);
  assert.match(markdown, /沪市监处罚〔2026〕88号/);
  assert.match(markdown, /《广告法》第二十八条/);
  assert.match(markdown, /12万元/);
  assert.match(markdown, /涉及团队：广告合规、电商/);
  assert.match(markdown, /观察窗口：3日内/);
  assert.match(markdown, /下一步观察建议/);
}

function testWebhookMessagesPreferPremiumCardFormatWhenAvailable() {
  const messages = buildDingTalkWebhookMessages({
    premium_delivery: true,
    period: { start: '2026-07-13', end: '2026-07-20' },
    sections: [{
      module: '新规及案例动态',
      items: [{
        type: '法规',
        module: '新规及案例动态',
        title: 'BPOM 更新化妆品清真认证要求',
        source_url: 'https://www.pom.go.id/',
        source_name: 'BPOM',
        published_at: '2026-05-21',
        country: '印尼',
        what_changed: ['2026年5月21日，BPOM 更新化妆品清真认证要求，设置过渡期。'],
        legal_obligation: ['进口化妆品应在过渡期内核查清真认证状态。'],
        affected_business: ['印尼市场进口化妆品的准入、清关和上架节奏。'],
        recommended_actions: ['注册团队导出印尼在售 SKU 清单并标注认证状态，关务团队同步排查清关资料。'],
        core_judgement: '印尼清真认证节点将直接影响进口化妆品准入、清关和上架。',
      }],
    }],
  }, { maxBytes: 5000 });
  assert.equal(messages[0].markdown.startsWith('# 美妆法务资讯精品卡'), true);
  assert.match(messages[0].markdown, /法务观察/);
}

function testFreshnessGateAllowsOnlyStructuredHistoricalExceptions() {
  const period = { start: '2026-07-13', end: '2026-07-19' };
  const stale = { published_at: '2026-05-01', type: '法规' };
  assert.equal(classifyFreshness(stale, period).accepted, false);
  assert.equal(classifyFreshness({ ...stale, effective_date: '2026-08-01', freshness_exception: 'upcoming_deadline' }, period).accepted, true);
  assert.equal(classifyFreshness({ ...stale, type: '召回', freshness_exception: 'ongoing_enforcement', change_evidence: '本周仍在执行召回' }, period).accepted, true);
}

function testFreshnessGateDowngradesUnknownDateToWatch() {
  const result = classifyFreshness({ title: '无法确认日期的行业线索' }, { start: '2026-07-13', end: '2026-07-19' });
  assert.equal(result.accepted, true);
  assert.equal(result.status, 'date-unknown');
  assert.equal(result.allowedTier, 'watch');
  assert.equal(filterCandidatesByFreshness([{ title: '未知日期' }], { start: '2026-07-13', end: '2026-07-19' })[0].freshness_status, 'date-unknown');
}

function testClassifySourceFetchFailures() {
  assert.deepEqual(classifyFetchFailure({ status: 429 }), { retryable: true, terminal: false, reason: 'http-429' });
  assert.deepEqual(classifyFetchFailure({ status: 503 }), { retryable: true, terminal: false, reason: 'http-503' });
  assert.deepEqual(classifyFetchFailure({ status: 401 }), { retryable: false, terminal: true, reason: 'http-401' });
  assert.deepEqual(classifyFetchFailure({ kind: 'captcha' }), { retryable: false, terminal: true, reason: 'captcha' });
  assert.deepEqual(classifyFetchFailure({ kind: 'timeout' }), { retryable: true, terminal: false, reason: 'timeout' });
}

async function testRecoverPublicSourceRetriesAndRecordsAttempts() {
  let calls = 0;
  const result = await recoverPublicSource({ name: '测试监管源', url: 'https://example.com' }, {
    direct: async () => {
      calls += 1;
      if (calls < 3) return { ok: false, status: 503, error: 'upstream unavailable' };
      return { ok: true, status: 200, html: '<h1>化妆品监管公告</h1>', finalUrl: 'https://example.com/notices' };
    },
    sleep: async () => {},
    jitter: () => 0,
  });

  assert.equal(result.status, 'recovered');
  assert.equal(result.recovery_method, 'retry');
  assert.equal(result.finalUrl, 'https://example.com/notices');
  assert.equal(result.attempts.length, 3);
  assert.deepEqual(result.attempts.map(attempt => attempt.status), [503, 503, 200]);
}

async function testRecoverPublicSourceUsesBrowserThenOfficialAlternate() {
  const methods = [];
  const browserRecovered = await recoverPublicSource({ name: '动态监管源', url: 'https://example.com' }, {
    direct: async () => ({ ok: false, status: 403, error: 'forbidden' }),
    browser: async () => {
      methods.push('browser');
      return { ok: true, status: 200, html: '<main>化妆品动态正文</main>', finalUrl: 'https://example.com/dynamic' };
    },
    sleep: async () => {},
    jitter: () => 0,
  });
  assert.equal(browserRecovered.status, 'recovered');
  assert.equal(browserRecovered.recovery_method, 'browser');
  assert.deepEqual(methods, ['browser']);

  const alternateRecovered = await recoverPublicSource({
    name: '备用监管源',
    url: 'https://example.com',
    alternate_urls: ['https://official.example.com/notices'],
  }, {
    direct: async () => ({ ok: false, status: 401, error: 'login required' }),
    alternate: async (_source, url) => ({ ok: true, status: 200, html: '<main>官方备用入口</main>', finalUrl: url }),
    sleep: async () => {},
  });
  assert.equal(alternateRecovered.status, 'recovered');
  assert.equal(alternateRecovered.recovery_method, 'alternate');
  assert.equal(alternateRecovered.finalUrl, 'https://official.example.com/notices');
}

function testSourceCoverageGatesChinaCriticalAndOverallCoverage() {
  const sources = [
    { name: '中国关键一', country: '中国', priority: 'high' },
    { name: '中国关键二', country: '中国', priority: 'high' },
    ...Array.from({ length: 8 }, (_, index) => ({ name: `海外${index + 1}`, country: '美国', priority: 'medium' })),
  ];
  const passingResults = sources.map(source => ({ source, status: 'ok', candidate_count: 1 }));
  const passing = calculateSourceCoverage(sources, passingResults);
  assert.equal(passing.chinaCritical, 1);
  assert.equal(passing.overall, 1);
  assert.equal(assertSourceCoverage(passing), true);

  const missingChina = passingResults.map((result, index) => index === 0 ? { ...result, status: 'failed', candidate_count: 0 } : result);
  assert.throws(() => assertSourceCoverage(calculateSourceCoverage(sources, missingChina)), SourceCoverageError);

  const tenChinaCritical = Array.from({ length: 10 }, (_, index) => ({ name: `中国关键${index + 1}`, country: '中国', priority: 'high' }));
  const ninetyPercentChina = tenChinaCritical.map((source, index) => ({
    source,
    status: index === 0 ? 'failed' : 'ok',
    candidate_count: index === 0 ? 0 : 1,
  }));
  assert.equal(assertSourceCoverage(calculateSourceCoverage(tenChinaCritical, ninetyPercentChina)), true);

  const belowOverall = passingResults.map((result, index) => index >= 7 ? { ...result, status: 'failed', candidate_count: 0 } : result);
  assert.throws(() => assertSourceCoverage(calculateSourceCoverage(sources, belowOverall)), SourceCoverageError);

  const monitored = { name: '中国受控监测源', country: '中国', priority: 'high', monitor_only: true };
  const monitoredCoverage = calculateSourceCoverage(
    [...sources, monitored],
    [...passingResults, { source: monitored, status: 'failed', candidate_count: 0 }]
  );
  assert.equal(monitoredCoverage.overall, 1);
  assert.equal(monitoredCoverage.chinaCritical, 1);
  assert.equal(monitoredCoverage.monitoredTotal, 1);
  assert.deepEqual(monitoredCoverage.monitoredFailedSources, ['中国受控监测源']);
}

async function testBrowserSourceFetcherReusesBrowserAndClosesPages() {
  let launchCalls = 0;
  let browserCloseCalls = 0;
  let pageCloseCalls = 0;
  const chromium = {
    async launch() {
      launchCalls += 1;
      return {
        async newPage() {
          return {
            async setExtraHTTPHeaders() {},
            async goto() { return { status: () => 200 }; },
            async title() { return '化妆品监管公告'; },
            async content() { return '<html><body>公开化妆品监管正文</body></html>'; },
            url() { return 'https://example.com/final'; },
            locator() { return { innerText: async () => '公开化妆品监管正文' }; },
            async close() { pageCloseCalls += 1; },
          };
        },
        async close() { browserCloseCalls += 1; },
      };
    },
  };

  const browserFetcher = await createBrowserSourceFetcher({ chromium });
  const first = await browserFetcher.fetchHtml('https://example.com/a');
  const second = await browserFetcher.fetchHtml('https://example.com/b');
  await browserFetcher.close();

  assert.equal(launchCalls, 1);
  assert.equal(pageCloseCalls, 2);
  assert.equal(browserCloseCalls, 1);
  assert.equal(first.ok, true);
  assert.equal(second.finalUrl, 'https://example.com/final');
}

async function testBrowserSourceFetcherUsesGovernmentSiteCompatibleNavigation() {
  let pageOptions;
  let gotoOptions;
  const chromium = {
    async launch() {
      return {
        async newPage(options) {
          pageOptions = options;
          return {
            async setExtraHTTPHeaders() {},
            async goto(_url, options) {
              gotoOptions = options;
              return { status: () => 200 };
            },
            async title() { return '监管公开信息'; },
            async content() { return '<html><body>化妆品监管公开正文</body></html>'; },
            url() { return 'https://official.example.cn/notices'; },
            locator() { return { innerText: async () => '化妆品监管公开正文' }; },
            async close() {},
          };
        },
        async close() {},
      };
    },
  };

  const browserFetcher = await createBrowserSourceFetcher({ chromium });
  const result = await browserFetcher.fetchHtml('https://official.example.cn/');
  await browserFetcher.close();

  assert.equal(result.ok, true);
  assert.ok(pageOptions.userAgent.includes('Chrome/'));
  assert.equal(pageOptions.userAgent.includes('HeadlessChrome'), false);
  assert.equal(pageOptions.locale, 'zh-CN');
  assert.deepEqual(pageOptions.viewport, { width: 1365, height: 900 });
  assert.equal(gotoOptions.waitUntil, 'commit');
}

async function testBrowserSourceFetcherRejectsAccessControlPages() {
  const chromium = {
    async launch() {
      return {
        async newPage() {
          return {
            async setExtraHTTPHeaders() {},
            async goto() { return { status: () => 200 }; },
            async title() { return 'Sign in'; },
            async content() { return '<html><body>Login required</body></html>'; },
            url() { return 'https://example.com/login'; },
            locator() { return { innerText: async () => 'Login required' }; },
            async close() {},
          };
        },
        async close() {},
      };
    },
  };
  const browserFetcher = await createBrowserSourceFetcher({ chromium });
  const result = await browserFetcher.fetchHtml('https://example.com/private');
  await browserFetcher.close();
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'login');
}

async function testPublishVersionedPngUploadsBeforeHealthCheck() {
  const calls = [];
  const png = new Uint8Array(2048).fill(7);
  const url = await publishVersionedPng({
    accountId: 'account',
    namespaceId: 'namespace',
    apiToken: 'secret-token',
    date: '2026-07-14',
    png,
    assetName: 'editorial-report',
    publicBaseUrl: 'https://worker.test',
    sleepFn: async () => {},
    fetcher: async (href, init = {}) => {
      calls.push({ href: String(href), method: init.method || 'GET', auth: init.headers?.Authorization });
      if ((init.method || 'GET') === 'GET') {
        return new Response(png, { status: 200, headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } });
      }
      return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });

  assert.match(url, /^https:\/\/worker\.test\/assets\/editorial-report\/2026-07-14\.png\?v=[a-f0-9]{16}$/);
  assert.deepEqual(calls.map(call => call.method), ['PUT', 'PUT', 'GET']);
  assert.ok(calls[0].href.includes('/values/asset%3Aeditorial-report%3A2026-07-14.png'));
  assert.ok(calls[1].href.includes('/values/asset%3Aeditorial-report%3Alatest.png'));
  assert.equal(calls[0].auth, 'Bearer secret-token');
  assert.equal(calls[2].auth, undefined);
  assert.ok(calls[2].href.includes('?v='));
}

async function testPipelineSendsNativeMarkdownWithoutImageHooks() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const store = new Map();
  const kv = {
    async get(key) { return store.get(key) || null; },
    async put(key, value) {
      store.set(key, value);
      if (key === 'seen_v3_report_items') calls.push('mark-seen');
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sampleReport) } }] }), { status: 200 });
    }
    if (href.startsWith('https://oapi.dingtalk.com/robot/send')) {
      calls.push('send-dingtalk');
      const payload = JSON.parse(init.body);
      assert.ok(
        payload.markdown.text.includes('- **事实摘要**')
        || payload.markdown.text.includes('# 美妆法务资讯精品卡'),
      );
      assert.ok(
        payload.markdown.text.includes('- **来源链接**')
        || payload.markdown.text.includes('- **来源**'),
      );
      assert.equal(payload.markdown.text.includes('![美妆法务资讯长图]'), false);
      assert.equal(payload.markdown.text.includes('查看高清原图'), false);
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    }
    return new Response(`<html><body><a href="/notice">化妆品监管新规</a><p>${'公开监管正文。'.repeat(8)}</p></body></html>`, { status: 200 });
  };

  try {
    const result = await runPipeline({
      AI_API_KEY: 'test-key',
      DETAIL_FETCH_ENABLED: '0',
      AI_MODEL: 'test-model',
      DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      DINGTALK_MESSAGE_DELAY_MS: 0,
      REPORT_PERIOD_START: sampleReport.period.start,
      REPORT_PERIOD_END: sampleReport.period.end,
      SEEN_NEWS: kv,
      CREATE_EDITORIAL_REPORT_PNG: async () => {
        throw new Error('native Markdown pipeline must not render an image');
      },
      PUBLISH_EDITORIAL_REPORT: async () => {
        throw new Error('native Markdown pipeline must not publish an image');
      },
      ON_REPORT_READY: async ({ report }) => {
        assert.equal(report.sections.length, 6);
        assert.ok(Array.isArray(report.display_sections));
        assert.ok(report.sections.flatMap(section => section.items).every(item => ['action', 'watch'].includes(item.report_tier)));
      },
    });
    assert.equal(result.status, 'done');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, ['send-dingtalk', 'mark-seen']);
}

async function testPipelineIgnoresLegacyEditorialImageHooks() {
  const originalFetch = globalThis.fetch;
  const calls = [];
  const store = new Map();
  const kv = {
    async get(key) { return store.get(key) || null; },
    async put(key, value) {
      store.set(key, value);
      if (key === 'seen_v3_report_items') calls.push('mark-seen');
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sampleReport) } }] }), { status: 200 });
    }
    if (href.startsWith('https://oapi.dingtalk.com/robot/send')) {
      calls.push('send-dingtalk');
      const payload = JSON.parse(init.body);
      assert.ok(
        payload.markdown.text.includes('- **事实摘要**')
        || payload.markdown.text.includes('# 美妆法务资讯精品卡'),
      );
      assert.ok(
        payload.markdown.text.includes('- **来源链接**')
        || payload.markdown.text.includes('- **来源**'),
      );
      assert.ok(
        payload.markdown.text.includes('- **事实摘要**\n  - ')
        || payload.markdown.text.includes('- **事实依据**'),
      );
      assert.equal(payload.markdown.text.includes('![美妆法务资讯长图]'), false);
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    }
    return new Response(`<html><body><a href="/notice">化妆品监管新规</a><p>${'公开监管正文。'.repeat(8)}</p></body></html>`, { status: 200 });
  };

  try {
    const result = await runPipeline({
      AI_API_KEY: 'test-key',
      DETAIL_FETCH_ENABLED: '0',
      AI_MODEL: 'test-model',
      DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      REPORT_PERIOD_START: sampleReport.period.start,
      REPORT_PERIOD_END: sampleReport.period.end,
      SEEN_NEWS: kv,
      CREATE_EDITORIAL_REPORT_PNG: async () => {
        throw new Error('legacy image renderer must not be called');
      },
      PUBLISH_EDITORIAL_REPORT: async () => {
        throw new Error('legacy image publisher must not be called');
      },
    });
    assert.equal(result.status, 'done');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(calls, ['send-dingtalk', 'mark-seen']);
}

async function testPipelineNoUpdateSkipsEmptyDashboardPublication() {
  const originalFetch = globalThis.fetch;
  const emptyReport = {
    period: sampleReport.period,
    summary: [],
    risk_alerts: [],
    sections: REPORT_MODULES.map(module => ({ module, items: [] })),
  };
  let rendered = false;
  let published = false;
  let delivered = false;
  const kv = {
    async get() { return null; },
    async put() {},
  };
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/chat/completions')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(emptyReport) } }],
      }), { status: 200 });
    }
    if (href.startsWith('https://oapi.dingtalk.com/robot/send')) {
      delivered = true;
      const payload = JSON.parse(init.body);
      assert.ok(payload.markdown.text.includes('本期五个重点板块未发现达到准入标准的新事项'));
      assert.equal(payload.markdown.text.includes('![美妆法务资讯长图]'), false);
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    }
    return new Response(`<html><body><a href="/notice">化妆品监管新规</a><p>${'公开监管正文。'.repeat(8)}</p></body></html>`, { status: 200 });
  };

  try {
    const result = await runPipeline({
      AI_API_KEY: 'test-key',
      DETAIL_FETCH_ENABLED: '0',
      AI_MODEL: 'test-model',
      DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      SEEN_NEWS: kv,
      CREATE_EDITORIAL_REPORT_PNG: async () => {
        rendered = true;
        return new Uint8Array(2048).fill(1);
      },
      PUBLISH_EDITORIAL_REPORT: async () => {
        published = true;
        return 'https://worker.test/assets/empty-dashboard.png';
      },
    });
    assert.equal(result.status, 'done');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(rendered, false);
  assert.equal(published, false);
  assert.equal(delivered, true);
}

async function testVersionedDecisionMapRouteUsesImmutableCache() {
  const png = new Uint8Array(2048).fill(3);
  const response = await worker.fetch(
    new Request('https://worker.test/assets/editorial-report/2026-07-14.png'),
    {
      SEEN_NEWS: {
        async get(key, type) {
          assert.equal(key, 'asset:editorial-report:2026-07-14.png');
          assert.equal(type, 'arrayBuffer');
          return png.buffer;
        },
      },
    },
    {}
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'image/png');
  assert.ok(response.headers.get('Cache-Control').includes('immutable'));
  assert.equal((await response.arrayBuffer()).byteLength, png.byteLength);
}

async function testCollectCandidatesReturnsRecoveryEvidenceAndRealCoverage() {
  const sources = [
    {
      name: '直接监管源', url: 'https://direct.test', module: '新规及案例动态',
      country: '中国', region: '亚洲', priority: 'high', source_type: 'official_site', topics: ['化妆品'],
    },
    {
      name: '动态监管源', url: 'https://browser.test', module: '广告合规及处罚案例',
      country: '中国', region: '亚洲', priority: 'high', source_type: 'official_site', topics: ['广告处罚'],
    },
    {
      name: '空白行业源', url: 'https://empty.test', module: '美妆动态',
      country: '美国', region: '北美', priority: 'medium', source_type: 'industry_site', topics: [],
    },
    {
      name: '化妆品观察', url: '微信公众号', module: '知识产权动态',
      country: '中国', region: '亚洲', priority: 'medium', source_type: 'wechat_public_account', authority_type: 'media', topics: ['PRO-XYLANE 商标侵权 刷单 17万'],
    },
  ];
  const result = await collectCandidates(sources, async () => {}, {
    fetcher: async url => {
      if (url === 'https://browser.test') return new Response('forbidden', { status: 403 });
      if (url === 'https://empty.test') return new Response(`<html><body>${'公司招聘和融资信息。'.repeat(8)}</body></html>`, { status: 200 });
      return new Response(`<html><body><a href="/notice">化妆品监督管理新规</a><p>${'官方发布化妆品监督管理政策说明。'.repeat(3)}</p></body></html>`, { status: 200 });
    },
    browserFetcher: async url => ({
      ok: true,
      status: 200,
      html: '<html><body><a href="/case">化妆品广告违法处罚案例</a></body></html>',
      finalUrl: url,
    }),
    sleepFn: async () => {},
    jitter: () => 0,
  });

  assert.equal(result.sourceResults.length, 3);
  assert.equal(result.sourceResults[0].status, 'ok');
  assert.equal(result.sourceResults[1].recovery_method, 'browser');
  assert.equal(result.sourceResults[2].status, 'empty');
  assert.equal(result.sourceResults[2].candidate_count, 0);
  assert.equal(result.coverage.chinaCritical, 1);
  assert.equal(result.coverage.overall, 1);
  assert.deepEqual(result.failures, []);
  assert.ok(result.candidates.some(candidate => candidate.url === 'https://direct.test/notice'));
  assert.ok(result.candidates.some(candidate => candidate.url === 'https://browser.test/case'));
  assert.ok(result.candidates.some(candidate => candidate.title.includes('行业线索')));
  assert.ok(result.authoritySearchTasks.some(task => task.source_name === '化妆品观察' && task.queries.some(query => query.includes('site:gov.cn'))));
}

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

function testExtractArticleTextRemovesPageChromeAndKeepsMetadata() {
  const html = `<!doctype html><html><head><title>化妆品监管新规</title></head><body>
    <header>首页 导航 登录 注册</header><nav>新闻 政务 服务</nav>
    <main><article><h1>化妆品功效宣称监管新规</h1><time>2026-07-16</time>
      <p>${'监管部门要求企业核对备案资料、功效评价证据与对外宣称的一致性。'.repeat(12)}</p>
    </article></main><footer>版权信息 联系我们</footer></body></html>`;

  const article = extractArticleText(html);

  assert.ok(article.text.includes('功效评价证据'));
  assert.ok(article.text.length > 300);
  assert.equal(article.text.includes('首页 导航 登录 注册'), false);
  assert.equal(article.published_at, '2026-07-16');
  assert.ok(article.title.includes('化妆品功效宣称监管新规'));
}

function testExtractArticleTextDoesNotSilentlyTruncateTheOriginalBody() {
  const tailMarker = '原文尾部关键执行口径';
  const html = `<article><h1>化妆品监管公告</h1><p>${'化妆品注册备案要求。'.repeat(4000)}${tailMarker}</p></article>`;

  const article = extractArticleText(html);

  assert.ok(article.text.length > 30000);
  assert.ok(article.text.endsWith(tailMarker));
}

async function testHydrateCandidateDetailsFetchesArticleBodiesWithoutDroppingFailures() {
  const candidates = [
    {
      title: '中国化妆品功效宣称监管新规',
      url: 'https://regulator.example.cn/rule/1',
      snippet: '监管网站首页导航文字',
      source_name: '中国监管机构',
      source_type: 'official_site',
      authority_type: 'regulator',
      module: '新规及案例动态',
      country: '中国',
      region: '亚洲',
      priority: 'high',
    },
    {
      title: '欧盟化妆品行业动态',
      url: 'https://regulator.example.eu/news/2',
      snippet: '原始列表页摘要',
      source_name: '欧盟监管机构',
      source_type: 'official_site',
      authority_type: 'regulator',
      module: '美妆动态',
      country: '欧盟',
      region: '欧洲',
      priority: 'medium',
    },
  ];
  const hydrated = await hydrateCandidateDetails(candidates, {
    detailLimit: 12,
    fetcher: async url => {
      if (String(url).includes('/news/2')) return new Response('blocked', { status: 403 });
      return new Response(`<main><article><h1>中国化妆品功效宣称监管新规</h1><time>2026-07-16</time><p>${'企业需要核对备案资料、功效评价证据、直播话术和商品详情页。'.repeat(15)}</p></article></main>`, { status: 200 });
    },
    timeoutMs: 1000,
  });

  assert.ok(hydrated.candidates[0].snippet.includes('直播话术'));
  assert.equal(hydrated.candidates[0].published_at, '2026-07-16');
  assert.equal(hydrated.candidates[0].detail_status, 'hydrated');
  assert.equal(hydrated.candidates[1].snippet, '原始列表页摘要');
  assert.equal(hydrated.candidates[1].detail_status, 'failed');
  assert.equal(hydrated.audit.hydrated, 1);
  assert.equal(hydrated.audit.failed, 1);
}

function testHydratedRecordsOverrideWeakCandidateText() {
  const record = normalizeHydratedRecord({
    url: 'https://regulator.example.cn/news/20260723',
    final_url: 'https://regulator.example.cn/news/20260723?ref=crwl',
    title: '国家市场监管总局发布化妆品广告新规',
    source_name: '国家市场监管总局',
    published_at: '2026-07-23',
    fit_markdown: '# 国家市场监管总局发布化妆品广告新规\n\n2026年7月23日，监管部门明确普通化妆品不得暗示医疗功效。',
    raw_markdown: 'raw markdown',
    references_markdown: '【1】https://regulator.example.cn/news/20260723',
    metadata: { source_type: 'official_site' },
    extraction: { legal_signal: '普通化妆品不得暗示医疗功效。' },
  });
  const merged = mergeHydratedCandidates([{
    title: '化妆品广告新规',
    url: 'https://regulator.example.cn/news/20260723',
    snippet: '首页 导航 登录 注册',
    source_name: '旧来源',
    module: '广告合规及处罚案例',
    country: '中国',
    region: '亚洲',
    priority: 'high',
    detail_status: 'failed',
    detail_reason: 'page-shell',
  }], [record]);

  assert.equal(merged.candidates[0].detail_status, 'hydrated');
  assert.equal(merged.candidates[0].detail_reason, 'crawl4ai-hydrated');
  assert.equal(merged.candidates[0].url, 'https://regulator.example.cn/news/20260723?ref=crwl');
  assert.equal(merged.candidates[0].source_url, 'https://regulator.example.cn/news/20260723');
  assert.equal(merged.candidates[0].article_text.includes('普通化妆品不得暗示医疗功效'), true);
  assert.equal(merged.candidates[0].source_name, '国家市场监管总局');
  assert.equal(merged.audit.hydrated, 1);
}

function testHydratedRecordExtractsHardLegalFactsFromCrawl4AiText() {
  const record = normalizeHydratedRecord({
    url: 'https://amr.example.gov.cn/case/20260723',
    title: '上海市市场监督管理局行政处罚决定书',
    source_name: '上海市市场监督管理局',
    published_at: '2026-07-23',
    country: '中国',
    module: '广告合规及处罚案例',
    fit_markdown: [
      '行政处罚决定书文号：沪市监处罚〔2026〕88号。',
      '处罚机关：上海市市场监督管理局。',
      '当事人：某化妆品有限公司。',
      '违反《广告法》第二十八条，普通化妆品宣称医疗功效。',
      '罚款12万元。',
      '涉及产品：普通护肤 SKU，批号 B202607。',
    ].join('\n'),
  });
  assert.equal(record.hard_facts.document_number, '沪市监处罚〔2026〕88号');
  assert.equal(record.hard_facts.authority, '上海市市场监督管理局');
  assert.equal(record.hard_facts.involved_party, '某化妆品有限公司');
  assert.equal(record.hard_facts.legal_basis, '《广告法》第二十八条');
  assert.equal(record.hard_facts.penalty_amount, '12万元');
  assert.equal(record.hard_facts.product_or_batch, '普通护肤 SKU，批号 B202607');
  assert.equal(record.hard_facts.signal_type, '风险案例');
  assert.equal(record.hard_facts.risk_tier, '立即处理');
}

function testHydratedRecordExtractsAttachmentLinksForCrawl4AiSecondHop() {
  const record = normalizeHydratedRecord({
    url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260723.html',
    title: '化妆品标准管理办法征求意见',
    source_name: '国家药监局',
    published_at: '2026-07-23',
    country: '中国',
    module: '新规及案例动态',
    fit_markdown: [
      '# 关于公开征求《化妆品标准管理办法（征求意见稿）》意见的通知',
      '[附件1：化妆品标准管理办法（征求意见稿）.pdf](https://www.nmpa.gov.cn/attachments/cosmetic-standard-draft.pdf)',
      '[意见反馈表.docx](/attachments/feedback.docx)',
    ].join('\n'),
  });
  assert.deepEqual(record.attachment_urls, [
    'https://www.nmpa.gov.cn/attachments/cosmetic-standard-draft.pdf',
    'https://www.nmpa.gov.cn/attachments/feedback.docx',
  ]);
}

function testHydratedRecordMergesAttachmentTextForCrawl4AiSecondHopEvidence() {
  const record = normalizeHydratedRecord({
    url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260723.html',
    title: '化妆品标准管理办法征求意见',
    source_name: '国家药监局',
    published_at: '2026-07-23',
    country: '中国',
    module: '新规及案例动态',
    fit_markdown: '关于公开征求《化妆品标准管理办法（征求意见稿）》意见的通知。',
    attachment_records: [{
      url: 'https://www.nmpa.gov.cn/attachments/cosmetic-standard-draft.pdf',
      title: '附件1：化妆品标准管理办法（征求意见稿）',
      article_text: '强制性标准必须执行。过渡期一般不超过2年。企业可提出立项建议、申请起草单位、反馈标准实施问题。',
    }],
  });
  assert.match(record.article_text, /强制性标准必须执行/);
  assert.match(record.article_text, /过渡期一般不超过2年/);
  assert.equal(record.attachment_records.length, 1);
  assert.equal(record.hard_facts.signal_type, '新增义务');
}

function testHydratedRecordDowngradesEmptyHydratedBody() {
  const record = normalizeHydratedRecord({
    url: 'https://www.nmpa.gov.cn/index.html',
    title: '国家药品监督管理局',
    source_name: '国家药监局',
    published_at: '2026-07-23',
    country: '中国',
    module: '新规及案例动态',
    crawl_status: 'hydrated',
    article_text: '',
    quality_flags: [],
  });
  assert.equal(record.crawl_status, 'failed');
  assert.ok(record.quality_flags.includes('empty-hydrated-body'));
}

async function testLoadHydratedRecordsFromEnvReadsFilePayload() {
  const path = '/private/tmp/beauty-legal-bot-hydrated-fixture.json';
  await import('node:fs/promises').then(fs => fs.writeFile(path, JSON.stringify({
    records: [{
      url: 'https://www.samr.gov.cn/example',
      title: '市场监管总局处罚案例',
      source_name: '国家市场监督管理总局',
      published_at: '2026-07-23',
      country: '中国',
      module: '广告合规及处罚案例',
      fit_markdown: '2026年7月23日，市场监管总局发布广告处罚案例，罚款12万元。',
    }],
  }), 'utf8'));
  const records = await loadHydratedRecordsFromEnv({ SOURCE_HYDRATION_FILE: path });
  assert.equal(records.length, 1);
  assert.equal(records[0].source_name, '国家市场监督管理总局');
  assert.equal(records[0].hard_facts.penalty_amount, '12万元');
}

function testAuthorityResolverTurnsMediaLeadIntoOfficialSearchQueries() {
  const queries = buildAuthoritySearchQueries({
    title: '化妆品“PRO-XYLANE”商标侵权刷单案被罚17万元',
    source_name: '搜狐转载',
    source_type: 'industry_media',
    authority_type: 'media',
    snippet: '当事人未经授权生产 PRO-XYLANE 商标化妆品21,572盒，刷单7,521单，合计罚款17万元。',
  });
  assert.ok(queries.some(query => query.includes('PRO-XYLANE') && query.includes('行政处罚决定书')));
  assert.ok(queries.some(query => query.includes('site:gov.cn')));
  assert.ok(queries.some(query => query.includes('市场监督管理局')));
}

function testAuthorityResolverBuildsSearchTasksFromLeadOnlySources() {
  const tasks = buildAuthoritySearchTasks([{
    title: '两家美妆企业冒用爱马仕商标合计被罚63.5万元',
    source_name: '行业媒体',
    source_type: 'wechat_public_account',
    authority_type: 'media',
    module: '知识产权动态',
    snippet: '奢颜名品两家公司因 HERMES 商标侵权被罚，并没收侵权商品33,082件。',
  }]);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].module, '知识产权动态');
  assert.equal(tasks[0].trust.level, 'lead_only');
  assert.ok(tasks[0].queries[0].includes('行政处罚决定书'));
}

function testAuthorityResolverClassifiesFinalSourceTrust() {
  assert.equal(classifyAuthorityTrust({ url: 'https://www.sohu.com/a/900000000_121000000', source_type: 'industry_media', authority_type: 'media' }).level, 'lead_only');
  assert.equal(classifyAuthorityTrust({ url: 'https://www.samr.gov.cn/xw/zj/art/2026/art_1.html', source_name: '国家市场监督管理总局' }).level, 'primary_authority');
  assert.equal(classifyAuthorityTrust({ url: 'https://www.customs.gov.cn/customs/302249/2480148/index.html', source_name: '海关总署' }).level, 'primary_authority');
}

function testAuthorityResolverKeepsOnlyAuthorityResolvedCandidates() {
  const selected = selectAuthorityResolvedCandidates([
    {
      title: 'PRO-XYLANE 商标侵权刷单案被罚17万元',
      url: 'https://www.sohu.com/a/900000000_121000000',
      source_name: '搜狐转载',
      source_type: 'industry_media',
      authority_type: 'media',
      snippet: '转载消息。',
    },
    {
      title: '行政处罚决定书',
      url: 'https://amr.example.gov.cn/penalty/pro-xylane',
      source_name: '地方市场监督管理局',
      authority_type: 'regulator',
      source_type: 'official_site',
      snippet: '当事人 PRO-XYLANE 商标侵权并刷单，合计罚款17万元。',
    },
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, 'https://amr.example.gov.cn/penalty/pro-xylane');
  assert.equal(selected[0].authority_resolution_status, 'resolved');
}

async function testHydrateCandidateDetailsContainsBrowserRecoveryFailures() {
  const candidate = {
    title: '化妆品监管详情',
    url: 'https://blocked.example.cn/detail',
    snippet: '保留的原始摘要',
    source_name: '监管机构',
    module: '新规及案例动态',
    country: '中国',
    region: '亚洲',
    priority: 'high',
  };
  const result = await hydrateCandidateDetails([candidate], {
    fetcher: async () => new Response('blocked', { status: 403 }),
    browserFetcher: async () => { throw new Error('browser timeout'); },
    timeoutMs: 1000,
  });

  assert.equal(result.candidates[0].snippet, '保留的原始摘要');
  assert.equal(result.candidates[0].detail_status, 'failed');
  assert.equal(result.audit.failed, 1);
}

async function testHydrateCandidateDetailsRejectsUnsupportedDocumentsAndPageShells() {
  const baseCandidate = {
    title: '化妆品监管详情',
    snippet: '列表页摘要',
    source_name: '监管机构',
    module: '新规及案例动态',
    country: '中国',
    region: '亚洲',
    priority: 'high',
  };
  const pdf = await hydrateCandidateDetails([{ ...baseCandidate, url: 'https://example.cn/rule.pdf' }], {
    fetcher: async () => new Response(`%PDF-1.7 ${'化妆品监管文字'.repeat(100)}`, {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    }),
    timeoutMs: 1000,
  });
  assert.equal(pdf.candidates[0].detail_status, 'failed');
  assert.equal(pdf.candidates[0].detail_reason, 'unsupported-content-type');
  assert.equal(pdf.audit.reasons['unsupported-content-type'], 1);

  const shell = await hydrateCandidateDetails([{ ...baseCandidate, url: 'https://example.cn/app-shell' }], {
    fetcher: async () => new Response(`<html><body><div>${'首页 政务 服务 站点导航 站点信息 '.repeat(80)}</div></body></html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }),
    timeoutMs: 1000,
  });
  assert.equal(shell.candidates[0].detail_status, 'failed');
  assert.equal(shell.candidates[0].detail_reason, 'page-shell');
  assert.equal(shell.audit.reasons['page-shell'], 1);

  const loginShell = await hydrateCandidateDetails([{ ...baseCandidate, url: 'https://example.cn/login' }], {
    fetcher: async () => new Response(`<html><body><main><h1>Sign in</h1><p>${'Login required. Please sign in to continue. '.repeat(20)}</p><p>Forgot password?</p></main></body></html>`, {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }),
    timeoutMs: 1000,
  });
  assert.equal(loginShell.candidates[0].detail_status, 'failed');
  assert.equal(loginShell.candidates[0].detail_reason, 'access-or-error-page');
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
  assert.equal(isRelevantTitle('化妆品商标侵权处罚决定书'), true);
  assert.equal(isRelevantTitle('公司融资发布会'), false);
  assert.equal(isRelevantTitle('加强“三品一械”广告监管 新规公开征求意见'), false);
  assert.equal(isRelevantTitle('北京汇爱科技有限公司主动召回部分型号ipoosi牌婴儿床'), false);
  assert.equal(isNavigationTitle('欢迎访问中华商标网'), true);
  assert.equal(isNavigationTitle('网站首页'), true);
  assert.equal(isNavigationTitle('登录'), true);
  assert.equal(isNavigationTitle('站点导航'), true);
  assert.equal(isNavigationTitle('化妆品商标侵权处罚决定书'), false);
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
  for (const field of ['fact_summary', 'facts', 'what_changed', 'penalty_or_result', 'market_access_change', 'dispute_focus', 'regulatory_signal', 'core_judgement']) {
    delete broken.sections[0].items[0][field];
  }
  assert.throws(() => validateReport(broken), /fact_summary/);
}

function testValidateReportRequiresExplicitCoreJudgement() {
  const objective = structuredClone(sampleReport);
  delete objective.sections[0].items[0].core_judgement;
  assert.equal(validateReport(objective), true);
}

function testValidateReportRejectsAiAssignedInternalDeadlines() {
  const report = structuredClone(sampleReport);
  report.sections[0].items[0].next_observation = ['跟踪正式生效日期和后续执行口径。'];
  report.sections[0].items[0].recommended_actions = [];
  assert.equal(validateReport(report), true);
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
    core_judgement: '该跨境清关线索可能影响进口资料和上架节奏，但在官方原文核验前不能作为确定规则执行。',
    why_it_matters: '进口通关规则变化会影响美妆电商上架节奏和履约成本。',
    recommended_actions: ['建议供应链团队核对进口化妆品清关资料和口岸异常反馈。'],
    owner_teams: ['供应链', '法务'],
    confidence: 'low',
    regulatory_signal: ['行业媒体提示近期进口美妆通关和资质核验要求需关注。'],
    compliance_meaning: ['该信息需二次核验，但可以作为跨境清关周度排查线索。'],
    possible_follow_up: ['建议法务团队结合海关总署和口岸通知进一步核验。'],
  };
  report.sections = [{ module: '进出口动态', items: [leadItem] }];
  const filtered = filterReportQuality(report);
  assert.equal(filtered.sections[0].items.length, 0);
}

function highQualityActionItem(overrides = {}) {
  return {
    ...structuredClone(sampleReport.sections[0].items[0]),
    module: '新规及案例动态',
    country: '中国',
    source_type: 'regulator',
    confidence: 'high',
    relevance: 'direct',
    published_at: sampleReport.period.end,
    core_judgement: '中国监管要求强化化妆品功效证据与备案资料的一致性审查，将直接影响集团新品备案、直播话术和上架放行流程。',
    why_it_matters: '该要求连接备案证据、营销内容和渠道放行，任何一处不一致都可能形成处罚或下架风险。',
    recommended_actions: ['建议注册、市场和电商团队按销量排序核对重点 SKU 的备案证据、直播话术与商品详情页。'],
    business_impact: ['注册备案', '功效宣称', '直播电商'],
    market_scope: ['中国市场重点 SKU'],
    ...overrides,
  };
}

function highQualityWatchItem(overrides = {}) {
  return {
    ...structuredClone(sampleReport.sections[1].items[0]),
    type: '动态',
    module: '美妆动态',
    country: '中国',
    source_type: 'industry_media',
    confidence: 'medium',
    relevance: 'indirect',
    published_at: sampleReport.period.end,
    core_judgement: '头部平台正在测试新的美妆内容治理机制，尚未形成正式规则，但可能改变品牌投放和达人合作审核方式。',
    why_it_matters: '平台治理机制会影响美妆品牌的投放效率、达人准入和内容审核成本。',
    recommended_actions: [],
    business_impact: ['广告投放', '直播电商', '平台运营'],
    market_scope: ['中国电商渠道'],
    watch_value: '该变化可能提前反映平台对功效宣称和达人内容治理的下一轮政策方向。',
    next_watch_signal: '观察平台正式规则、商家后台通知以及头部品牌投放政策是否同步调整。',
    ...overrides,
  };
}

function highQualityFixtureReport() {
  return {
    ...structuredClone(sampleReport),
    sections: [
      { module: '新规及案例动态', items: [highQualityActionItem()] },
      { module: '美妆动态', items: [highQualityWatchItem()] },
    ],
  };
}

function testReportQualitySeparatesActionWatchAndRejectedItems() {
  const action = classifyReportItem(highQualityActionItem(), sampleReport.period);
  const watch = classifyReportItem(highQualityWatchItem(), sampleReport.period);
  const rejected = classifyReportItem(highQualityWatchItem({
    source_url: '',
    watch_value: '',
    next_watch_signal: '',
  }), sampleReport.period);

  assert.equal(action.tier, 'action');
  assert.ok(action.score >= 8);
  assert.equal(watch.tier, 'watch');
  assert.ok(watch.score >= 7);
  assert.equal(rejected.tier, 'reject');
}

function testReportQualityUsesOriginalEvidenceTitleForBeautyRelevance() {
  const item = {
    title: '《第42号公告》',
    evidence_title: '化妆品商标侵权行政处罚决定书',
    evidence_excerpt: '涉案商品为面霜、精华液等化妆品，包装使用了他人注册商标。',
    type: 'IP',
    module: '知识产权动态',
    country: '中国',
    region: '亚洲',
    source_name: '地方市场监管局',
    source_url: 'https://official.example.gov.cn/notices/42',
    source_type: 'regulator',
    confidence: 'high',
    relevance: 'direct',
    industry_impact: 'medium',
    published_at: sampleReport.period.end,
    report_tier: 'watch',
    fact_summary: ['监管部门认定涉案主体未经许可在面霜和精华液包装上使用注册商标，并作出行政处罚。'],
    next_observation: ['观察行政复议、诉讼或后续执行结果是否公开。'],
  };

  assert.equal(classifyReportItem(item, sampleReport.period).tier, 'watch');

  const irrelevantBody = {
    ...item,
    title: '化妆品行业整治动态',
    evidence_title: '化妆品监管公告',
    evidence_excerpt: '机关食堂采购厨房设备，并公布供应商和中标金额。',
    fact_summary: ['采购人完成机关食堂厨房设备采购，并公布供应商和中标金额。'],
    next_observation: ['观察合同履行和设备验收结果。'],
  };
  assert.equal(classifyReportItem(irrelevantBody, sampleReport.period).tier, 'reject');
}

function testCurateReportQualityKeepsSixModulesButDropsEmptyDisplaySections() {
  const curated = curateReportQuality(highQualityFixtureReport());
  assert.equal(curated.sections.length, 6);
  assert.equal(curated.display_sections.length, 1);
  assert.equal(curated.display_sections[0].module, '新规及案例动态');
  assert.equal(curated.sections.flatMap(section => section.items).length, 2);
}

function testCurateReportQualityAuditExplainsRejectedItems() {
  const rejected = highQualityWatchItem({
    title: '无证据行业传闻',
    source_url: '',
    watch_value: '',
    next_watch_signal: '',
  });
  const input = highQualityFixtureReport();
  input.sections[1].items.push(rejected);

  const { report, audit } = curateReportQualityWithAudit(input);

  assert.equal(audit.inputItems, 3);
  assert.equal(audit.acceptedItems, 2);
  assert.equal(audit.rejectedItems, 1);
  assert.ok(audit.reasons.evidence >= 1);
  assert.equal(report.sections.flatMap(section => section.items).length, 2);
}

async function testAnalyzeReportWithRecoveryUsesOneRescuePass() {
  const primary = {
    period: sampleReport.period,
    summary: [],
    risk_alerts: [],
    sections: REPORT_MODULES.map(module => ({ module, items: [] })),
  };
  const rescue = highQualityFixtureReport();
  const observedUrls = rescue.sections.flatMap(section => section.items.map(item => ({
    url: item.source_url,
    source_url: item.source_url,
  })));
  let rescueCalls = 0;

  const result = await analyzeReportWithRecovery({
    candidates: observedUrls,
    leads: [],
    sources: [],
    period: sampleReport.period,
    itemsPerModule: 12,
    analyzePrimary: async () => primary,
    analyzeRescue: async () => {
      rescueCalls += 1;
      return rescue;
    },
    logger: { info() {}, warn() {} },
  });

  assert.equal(rescueCalls, 1);
  assert.equal(result.mode, 'rescue');
  assert.equal(result.audit.acceptedItems, 2);
  assert.equal(result.report.sections.flatMap(section => section.items).length, 2);
}

async function testAnalyzeReportWithRecoverySupplementsSparseWatchOnlyReport() {
  const primary = {
    ...structuredClone(sampleReport),
    sections: [{ module: '美妆动态', items: [highQualityWatchItem({
      report_tier: 'watch',
      possible_follow_up: ['观察平台正式规则、商家后台通知以及头部品牌投放政策是否同步调整。'],
    })] }],
  };
  const supplement = {
    ...structuredClone(sampleReport),
    sections: [{ module: '新规及案例动态', items: [highQualityActionItem()] }],
  };
  const observedUrls = [...primary.sections, ...supplement.sections]
    .flatMap(section => section.items.map(item => ({ url: item.source_url })));
  let rescueCalls = 0;

  const result = await analyzeReportWithRecovery({
    candidates: observedUrls,
    leads: [],
    sources: [],
    period: sampleReport.period,
    itemsPerModule: 12,
    analyzePrimary: async () => primary,
    analyzeRescue: async () => {
      rescueCalls += 1;
      return supplement;
    },
    logger: { info() {}, warn() {} },
  });

  const items = result.report.sections.flatMap(section => section.items);
  assert.equal(rescueCalls, 1);
  assert.equal(result.mode, 'supplemented');
  assert.ok(items.some(item => item.report_tier === 'watch'));
  assert.ok(items.some(item => item.report_tier === 'action'));
}

async function testAnalyzeReportWithRecoveryContinuesBelowEightQualityItems() {
  const modules = REPORT_MODULES.slice(0, 4);
  const primary = {
    ...structuredClone(sampleReport),
    sections: modules.map((module, index) => ({
      module,
      items: [highQualityActionItem({
        module,
        title: `${module}高价值事项${index + 1}`,
        source_url: `https://official.example.cn/item/${index + 1}`,
      })],
    })),
  };
  let rescueCalls = 0;
  const result = await analyzeReportWithRecovery({
    candidates: primary.sections.flatMap(section => section.items.map(item => ({ url: item.source_url }))),
    sources: [],
    period: sampleReport.period,
    analyzePrimary: async () => primary,
    analyzeRescue: async () => {
      rescueCalls += 1;
      return { period: sampleReport.period, summary: [], risk_alerts: [], sections: [] };
    },
    logger: { info() {}, warn() {} },
  });

  assert.equal(result.audit.acceptedItems, 4);
  assert.equal(rescueCalls, 1);
}

async function testAnalyzeReportWithRecoveryRejectsTechnicalCollapse() {
  const primary = highQualityFixtureReport();
  const emptyRescue = {
    period: sampleReport.period,
    summary: [],
    risk_alerts: [],
    sections: REPORT_MODULES.map(module => ({ module, items: [] })),
  };

  await assert.rejects(
    () => analyzeReportWithRecovery({
      candidates: [{ url: 'https://different.example/source' }],
      leads: [],
      sources: [],
      period: sampleReport.period,
      analyzePrimary: async () => primary,
      analyzeRescue: async () => emptyRescue,
      logger: { info() {}, warn() {} },
    }),
    /technical collapse/i,
  );
}

async function testDeepseekRescueAnalyzeUsesObservedCandidateIdentity() {
  const candidate = {
    title: '中国化妆品功效宣称监管通报',
    url: 'https://samr.example.gov.cn/notices/2026-05-22',
    source_name: '中国市场监管机构',
    source_type: 'official_site',
    authority_type: 'regulator',
    module: '广告合规及处罚案例',
    country: '中国',
    region: '亚洲',
    published_at: '2026-05-22',
    priority: 'high',
    snippet: '监管通报要求化妆品功效宣称与备案证据保持一致。',
  };
  const response = {
    reviewed_candidates: [{ candidate_index: 0, decision: 'include', reason: '正文直接涉及化妆品功效宣称' }],
    items: [{
      candidate_index: 0,
      report_tier: 'action',
      fact_summary: ['中国监管通报要求化妆品功效宣称与备案证据保持一致。'],
      next_observation: ['跟踪同类化妆品功效宣称通报和后续处罚公开。'],
      relevance: 'direct',
      industry_impact: 'high',
      confidence: 'high',
    }],
  };

  const report = await deepseekRescueAnalyze({
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    model: 'gpt-5.6-sol',
    candidates: [candidate],
    leads: [],
    period: sampleReport.period,
    fetcher: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(response) } }],
    }), { status: 200 }),
  });

  const item = report.sections.find(section => section.module === candidate.module).items[0];
  assert.equal(item.source_url, candidate.url);
  assert.equal(item.source_name, candidate.source_name);
  assert.equal(item.evidence_title, candidate.title);
  assert.equal(item.confidence, 'high');
  const processed = processAnalyzedReport(report, { candidates: [candidate], sources: [] });
  assert.equal(processed.audit.acceptedItems, 1);
}

async function testDeepseekRescueAnalyzeRejectsIncompleteCandidateDecisions() {
  const candidates = [0, 1].map(index => ({
    title: `化妆品监管公告 ${index + 1}`,
    url: `https://official.example.cn/notices/${index + 1}`,
    source_name: '监管机构',
    source_type: 'official_site',
    authority_type: 'regulator',
    module: '美妆动态',
    country: '中国',
    region: '亚洲',
    published_at: '2026-07-18',
    snippet: '化妆品监管公告全文。'.repeat(40),
  }));
  await assert.rejects(() => deepseekRescueAnalyze({
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    model: 'gpt-5.5',
    candidates,
    period: { start: '2026-07-13', end: '2026-07-19' },
    fetcher: async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      reviewed_candidates: [{ candidate_index: 0, decision: 'exclude', reason: '正文无新事项' }],
      items: [],
    }) } }] }), { status: 200 }),
  }), /review incomplete/i);
}

function testRescueEvidenceCandidatesPreserveModuleDiversity() {
  const crowded = Array.from({ length: 24 }, (_, index) => ({
    title: `中国广告监管候选 ${index}`,
    url: `https://samr.example.gov.cn/ads/${index}`,
    source_name: '中国市场监管机构',
    source_type: 'official_site',
    authority_type: 'regulator',
    module: '广告合规及处罚案例',
    country: '中国',
    region: '亚洲',
    published_at: '2026-07-17',
    priority: 'high',
    snippet: '化妆品广告监管信息。',
  }));
  const otherModules = REPORT_MODULES.slice(1).map((module, index) => ({
    title: `${module}代表候选`,
    url: `https://official-${index}.example.gov.cn/notice`,
    source_name: `${module}监管来源`,
    source_type: 'official_site',
    authority_type: 'regulator',
    module,
    country: index % 2 === 0 ? '中国' : '欧盟',
    region: index % 2 === 0 ? '亚洲' : '欧洲',
    published_at: '2026-07-16',
    priority: 'medium',
    snippet: `${module}的实质监管信息。`,
  }));

  const selected = selectRescueEvidenceCandidates([...crowded, ...otherModules]);
  const modules = new Set(selected.map(candidate => candidate.module));

  assert.equal(modules.size, REPORT_MODULES.length);
  assert.ok(selected.length >= REPORT_MODULES.length);
  assert.ok(selected.filter(candidate => candidate.source_name === '中国市场监管机构').length <= 3);

  const lead = { title: '公众号线索', url: 'https://wechat.example.com/account', source_name: '公众号', module: '美妆动态' };
  const withoutLeads = selectRescueEvidenceCandidates(otherModules, [lead]);
  assert.equal(withoutLeads.some(candidate => candidate.url === lead.url), false);
}

function testExecutiveSummaryCapsJudgementsAndActionsAtThree() {
  const report = {
    ...structuredClone(sampleReport),
    sections: [{
      module: '新规及案例动态',
      items: Array.from({ length: 5 }, (_, index) => highQualityActionItem({
        title: `高价值事项 ${index + 1}`,
        source_url: `https://official.example/${index + 1}`,
        core_judgement: `核心判断 ${index + 1}：中国监管变化将直接影响集团美妆产品的备案、上架和营销审核流程。`,
        recommended_actions: [`建议责任团队完成第 ${index + 1} 项备案证据、上架材料和营销内容一致性核验。`],
      })),
    }],
  };

  const summary = summarizeExecutiveReport(curateReportQuality(report));
  assert.equal(summary.judgements.length, 3);
  assert.equal(summary.actions.length, 3);
}

function testExecutiveSummaryAvoidsRepeatedJudgementsAndActions() {
  const repeated = Array.from({ length: 3 }, (_, index) => highQualityActionItem({
    title: `同类监管事项 ${index + 1}`,
    source_url: `https://official.example/repeated-${index + 1}`,
    core_judgement: '相同监管结论会影响集团中国市场的备案、上架和营销审核流程。',
    recommended_actions: ['建议注册和市场团队核对备案证据与对外功效宣称的一致性。'],
  }));
  const distinct = highQualityActionItem({
    title: '独立进口监管事项',
    source_url: 'https://official.example/distinct',
    core_judgement: '进口认证要求变化将影响集团跨境产品的清关资料和上架节奏。',
    recommended_actions: ['建议供应链和法务团队核对在途批次的认证文件与清关资料。'],
  });
  const report = curateReportQuality({
    ...structuredClone(sampleReport),
    sections: [{ module: '新规及案例动态', items: [...repeated, distinct] }],
  });

  const summary = summarizeExecutiveReport(report);
  assert.equal(summary.judgements.length, 2);
  assert.equal(summary.actions.length, 2);
}

function testNormalizeReportForValidationFillsDynamicAnalysisFields() {
  const report = structuredClone(sampleReport);
  const dynamicItem = {
    type: '动态',
    module: '美妆动态',
    region: '亚洲',
    country: '中国',
    title: '广州市市场监督管理局关于开展2026年化妆品生产企业质量管理体系自查工作的通知',
    fact_summary: ['广州市市场监督管理局通知化妆品生产企业开展质量管理体系自查。'],
    next_observation: ['跟踪自查结果报送和后续监管通报。'],
    source_name: '广州市市场监督管理局',
    source_url: 'https://scjgj.gz.gov.cn/',
    source_type: 'regulator',
    published_at: '2026-05-24',
    relevance: 'direct',
    industry_impact: 'medium',
    business_impact: ['注册备案', '供应链'],
    market_scope: ['中国化妆品生产企业'],
    risk_level: 'medium',
    core_judgement: '广州化妆品生产企业自查要求会影响供应商准入和生产质量审查。',
    why_it_matters: '质量管理体系自查会影响集团供应商准入和生产合规审查。',
    recommended_actions: ['建议供应链团队核对广州相关供应商是否完成质量管理体系自查。'],
    owner_teams: ['供应链', '法务'],
    confidence: 'high',
  };
  report.sections = [{ module: '美妆动态', items: [dynamicItem] }];
  assert.equal(validateReport(report), true);
  const normalized = normalizeReportForValidation(report);
  assert.equal(validateReport(normalized), true);
  assert.ok(normalized.sections[0].items[0].fact_summary.length >= 1);
  assert.ok(normalized.sections[0].items[0].next_observation.length >= 1);
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
  assert.equal(defaultLimited.sections.find(section => section.module === '广告合规及处罚案例').items.length, 10);
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
  assert.ok(markdown.includes('| 优先级 | 动作 | 责任团队 | 内部完成时间 | 来源事项 |'));
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

function testRenderDingTalkMarkdownLeavesInternalCompletionTimeToLeader() {
  const markdown = renderDingTalkMarkdown(sampleReport);
  assert.ok(markdown.includes('由责任领导确定'));
  assert.equal(markdown.includes('本周内核验'), false);
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

function testBuildDingTalkWebhookMessagesUsesOneCardWithSixModules() {
  const messages = buildDingTalkWebhookMessages(sampleReport, { maxBytes: 18000 });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].id, 'weekly-report');
  assert.ok(messages[0].title.includes('美妆法务资讯'));
  assert.ok(messages[0].markdown.includes('直播功效宣称与备案资料不一致被处罚'));
  assert.ok(messages[0].markdown.includes('### 广告合规及处罚案例'));
  assert.ok(messages[0].markdown.includes('### 新规及案例动态'));
  assert.equal(/## M[1-6]/.test(messages[0].markdown), false);
  assert.equal(messages[0].markdown.includes('## 知识产权动态'), false);
  assert.ok(messages.every(message => new TextEncoder().encode(message.markdown).length <= 18000));
}

function testBuildSingleDingTalkMessageContainsWholeReportInOneCard() {
  const chinaItem = structuredClone(sampleReport.sections[1].items[0]);
  chinaItem.title = '中国监管事项';
  chinaItem.country = '中国';
  chinaItem.source_url = 'https://example.com/china';
  const overseasItem = structuredClone(sampleReport.sections[0].items[0]);
  overseasItem.title = '海外监管事项';
  overseasItem.country = '美国';
  overseasItem.source_url = 'https://example.com/overseas';
  const report = structuredClone(sampleReport);
  report.sections[0].items = [overseasItem, chinaItem];

  const message = buildSingleDingTalkMessage(report, {
    imageUrl: 'https://worker.test/assets/decision-map/2026-07-14.png',
    coverage: { overall: 0.95, chinaCritical: 1, failedSources: ['失败源'] },
    maxBytes: 18000,
  });

  assert.equal(message.id, 'weekly-report');
  assert.ok(message.title.includes('美妆法务资讯'));
  for (const hiddenMetric of ['来源覆盖：', '中国关键源：', '受限监测源：', '正式条目：']) {
    assert.equal(message.markdown.includes(hiddenMetric), false);
  }
  assert.ok(message.markdown.includes('- **事实摘要**'));
  assert.ok(message.markdown.includes('- **下一步观察建议**'));
  assert.ok(message.markdown.includes('- **来源链接**'));
  assert.equal(message.markdown.includes('![美妆法务资讯长图]'), false);
  assert.ok(message.markdown.indexOf('中国监管事项') < message.markdown.indexOf('海外监管事项'));
  assert.ok(message.markdown.includes('[上海市监局]'));
  assert.equal(/## M[1-6]/.test(message.markdown), false);
  assert.equal(message.bytes, new TextEncoder().encode(message.markdown).length);
  assert.ok(message.bytes <= 18000);
}

function testSingleCardUsesFourTopicFactObservationSourceStructure() {
  const message = buildSingleDingTalkMessage(highQualityFixtureReport());
  for (const field of ['事实摘要', '下一步观察建议', '来源链接']) assert.ok(message.markdown.includes(`- **${field}**`));
  for (const removed of ['管理层摘要', '核心判断', '法务研判', '处理结果', '业务影响', '责任岗位', '本期结论']) {
    assert.equal(message.markdown.includes(removed), false, `should remove ${removed}`);
  }
}

function objectiveBriefFixture() {
  const period = { start: '2026-07-06', end: '2026-07-12' };
  const item = (overrides = {}) => ({
    type: '动态', module: '美妆动态', region: '亚洲', country: '中国',
    title: '化妆品行业客观资讯', source_name: '官方来源', source_url: 'https://official.example.gov.cn/news/1',
    source_type: 'regulator', published_at: '2026-07-10', relevance: 'direct', industry_impact: 'medium',
    report_tier: 'action', confidence: 'high',
    fact_summary: ['监管部门发布与化妆品生产经营直接相关的公开信息，明确了适用对象和具体事项。'],
    next_observation: ['跟踪正式文件、生效日期或后续公开执行口径。'],
    ...overrides,
  });
  return {
    period, summary: [], risk_alerts: [],
    sections: [
      { module: '新规及案例动态', items: [item({ type: '征求意见', module: '新规及案例动态', title: '《化妆品标准管理办法（征求意见稿）》公开征求意见', source_url: 'https://official.example.gov.cn/rules/standard-draft', fact_summary: ['征求意见稿明确化妆品强制性标准必须执行，被法规引用的推荐性标准内容同样必须执行。', '化妆品新标准过渡期一般不超过2年，实施前可选择执行新标准或原标准。'], next_observation: ['跟踪反馈截止日期、正式稿及新旧标准衔接安排。'] })] },
      { module: '广告合规及处罚案例', items: [item({ type: '案例', module: '广告合规及处罚案例', title: '化妆品直播功效宣称与备案资料不一致被处罚', source_url: 'https://official.example.gov.cn/penalties/ad-1', fact_summary: ['监管部门认定直播功效宣称与备案资料不一致，责令停止相关宣传并处以罚款。'], next_observation: ['关注同类化妆品直播宣传案件的后续处罚公开。'] })] },
      { module: '知识产权动态', items: [
        item({ type: 'IP', module: '知识产权动态', title: '“PRO-XYLANE”化妆品商标侵权及刷单案被罚17万元', source_url: 'https://official.example.gov.cn/penalties/pro-xylane', fact_summary: ['当事人未经授权生产相关化妆品21,572盒，监管部门没收涉案商品并罚款15万元。', '当事人另通过刷单虚构销售和评价，被追加罚款2万元。'], next_observation: ['关注该案行政复议、诉讼及同类案件后续公开。'] }),
        item({ type: 'IP', module: '知识产权动态', title: '两家化妆品企业冒用爱马仕商标合计被罚63.5万元', source_url: 'https://official.example.gov.cn/penalties/hermes', fact_summary: ['两家化妆品企业因在产品瓶身、包装和礼盒上使用爱马仕文字及图形商标，分别被罚33.5万元和30万元。', '监管部门同时没收侵权商品33,082件。'], next_observation: ['跟踪处罚执行、行政救济及同类商标侵权案件公开。'] }),
      ] },
      { module: '进出口动态', items: [item({ type: '进出口', module: '进出口动态', title: '进口化妆品清关资料要求更新', source_url: 'https://customs.example.gov.cn/cosmetics/import-1', fact_summary: ['海关更新进口化妆品申报资料要求，明确适用品类和申报字段。'], next_observation: ['跟踪口岸执行口径和配套申报说明。'] })] },
      { module: '美妆动态', items: [item({ module: '美妆动态', title: '平台发布美妆商品信息治理简讯', source_name: '行业媒体', source_url: 'https://industry.example.com/beauty/platform-1', source_type: 'industry_media', confidence: 'medium', report_tier: 'watch', fact_summary: ['平台公布美妆商品信息治理安排，涉及功效描述和商品详情页展示。'], next_observation: ['跟踪平台正式规则及商家后台通知。'] })] },
    ],
  };
}

function testObjectiveBriefUsesFiveSectionsAndNoAnalysisCopy() {
  const message = buildSingleDingTalkMessage(curateReportQuality(objectiveBriefFixture()));
  for (const section of ['新法律法规政策', '广告处罚案例', '知识产权保护与侵权', '进出口', '行业新闻简讯']) assert.ok(message.markdown.includes(`### ${section}`));
  for (const field of ['事实摘要', '下一步观察建议', '来源链接']) assert.ok(message.markdown.includes(`- **${field}**`));
  for (const forbidden of ['核心判断', '法务研判', '管理层摘要', '风险等级', '业务影响', '责任岗位', '本期结论']) assert.equal(message.markdown.includes(forbidden), false);
}

function testObjectiveBriefRejectsGenericNonBeautyContent() {
  const report = objectiveBriefFixture();
  report.sections = [{ module: '知识产权动态', items: [{
    ...report.sections[2].items[0],
    title: '一般软件著作权纠纷案件',
    fact_summary: ['法院审理软件企业之间的著作权许可合同纠纷并作出判决。'],
    source_url: 'https://court.example.gov.cn/cases/software-1',
  }] }];
  assert.equal(curateReportQuality(report).sections.flatMap(section => section.items).length, 0);
}

function testObjectiveBriefDeduplicatesSameEventAcrossSources() {
  const report = objectiveBriefFixture();
  const original = report.sections[2].items[0];
  report.sections[2].items.push({ ...original, title: '化妆品“PRO XYLANE”商标侵权刷单案处罚17万元', source_name: '转载媒体', source_type: 'industry_media', confidence: 'medium', source_url: 'https://media.example.com/repost/pro-xylane' });
  const editorial = buildEditorialReport(curateReportQuality(report));
  const ipItems = editorial.sections.find(section => section.module === '知识产权保护与侵权').items;
  assert.equal(ipItems.length, 2);
  assert.equal(ipItems.find(item => item.title.includes('PRO-XYLANE')).source_name, '官方来源');
}

function testObjectiveBriefSplitsWithoutOmittingAcceptedItems() {
  const report = objectiveBriefFixture();
  const base = report.sections[0].items[0];
  const topics = ['防晒剂限用浓度', '面膜微生物抽检', '香水过敏原标签', '口红重金属检测', '儿童面霜备案', '牙膏功效宣称', '染发剂原料目录', '洗发水标签规则', '精华液安全评估', '气垫霜包装标识', '祛斑产品注册', '进口香氛认证', '眼影色素要求', '卸妆油质量标准', '护手霜生产许可', '睫毛膏召回程序', '腮红广告规范', '唇釉备案流程', '身体乳成分限制', '洁面乳执行标准', '美容仪配套凝胶', '化妆水抽样检验', '粉底液净含量', '发膜功效评价'];
  report.sections[0].items = Array.from({ length: 24 }, (_, index) => ({ ...base, title: topics[index], source_url: `https://official.example.gov.cn/rules/${index + 1}`, fact_summary: [`${topics[index]}相关化妆品规则明确适用对象、执行内容和法定时间节点。`] }));
  const curated = curateReportQuality(report);
  const messages = buildDingTalkWebhookMessages(curated, { maxBytes: 2200 });
  assert.ok(messages.length > 1);
  const combined = messages.map(message => message.markdown).join('\n');
  for (let index = 1; index <= 24; index += 1) assert.ok(combined.includes(`https://official.example.gov.cn/rules/${index}`));
  assert.equal(messages.reduce((sum, message) => sum + message.displayedItemCount, 0), 29);
}

async function testModuleMergeDoesNotCapAcceptedItemsAtThree() {
  const items = Array.from({ length: 7 }, (_, index) => ({ ...objectiveBriefFixture().sections[0].items[0], title: `化妆品法规完整事项 ${index + 1}`, source_url: `https://official.example.gov.cn/full/${index + 1}` }));
  const report = await analyzeReportByModule({
    modules: ['新规及案例动态'], candidates: [], leads: [], sources: [], period: objectiveBriefFixture().period,
    analyze: async () => ({ period: objectiveBriefFixture().period, summary: [], risk_alerts: [], sections: [{ module: '新规及案例动态', items }] }),
  });
  assert.equal(report.sections[0].items.length, 7);
}

function testObjectiveBriefDoesNotRecycleCoreJudgementAsFact() {
  const report = objectiveBriefFixture();
  const item = { ...report.sections[0].items[0], fact_summary: [], what_changed: [], core_judgement: '核心判断：存在业务风险并应立即分派法务整改。' };
  report.sections = [{ module: '新规及案例动态', items: [item] }];
  assert.equal(curateReportQuality(report).sections.flatMap(section => section.items).length, 0);
}

function testObjectiveBriefRejectsGenericIngredientContent() {
  const report = objectiveBriefFixture();
  report.sections = [{ module: '新规及案例动态', items: [{ ...report.sections[0].items[0], title: '食品原料成分标准发布', fact_summary: ['主管部门发布食品原料成分标准，明确食品生产企业执行要求。'], source_url: 'https://food.example.gov.cn/standards/1' }] }];
  assert.equal(curateReportQuality(report).sections.flatMap(section => section.items).length, 0);
}

function testAdvertisingRulesRouteToLawSectionInsteadOfPenaltySection() {
  const report = objectiveBriefFixture();
  report.sections = [{ module: '广告合规及处罚案例', items: [{ ...report.sections[1].items[0], type: '法规', title: '化妆品广告发布规则公开征求意见', fact_summary: ['监管部门就化妆品广告发布规则公开征求意见。'], source_url: 'https://official.example.gov.cn/rules/beauty-ad-draft' }] }];
  const editorial = buildEditorialReport(curateReportQuality(report));
  assert.equal(editorial.sections[0].module, '新法律法规政策');
  assert.equal(editorial.sections.some(section => section.module === '广告处罚案例'), false);
}

function testOrdinaryBeautyCaseInMixedModuleRoutesToNewsBrief() {
  const report = objectiveBriefFixture();
  report.sections = [{ module: '新规及案例动态', items: [{ ...report.sections[1].items[0], module: '新规及案例动态', type: '案例', title: '化妆品消费者合同纠纷判决公开', fact_summary: ['法院公开一宗化妆品消费者合同纠纷判决。'], source_url: 'https://court.example.gov.cn/beauty/case-1' }] }];
  const editorial = buildEditorialReport(curateReportQuality(report));
  assert.equal(editorial.sections[0].module, '行业新闻简讯');
}

function testPipelineRequiresFullTextByDefaultAndUsesSplitPreview() {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.ok(source.includes("hydrateDetails: env.DETAIL_FETCH_ENABLED !== '0'"));
  assert.ok(source.includes("const requireFullText = env.DETAIL_FETCH_ENABLED !== '0'"));
  assert.ok(source.includes(".filter(candidate => candidate.detail_status === 'hydrated')"));
  assert.equal(source.includes("hydrateDetails: env.DETAIL_FETCH_ENABLED === '1'"), false);
  assert.equal(source.includes('.slice(0, linkLimit)'), false);
  assert.ok(source.includes('const previewMessages = buildDingTalkWebhookMessages'));
  assert.equal(source.includes('const markdown = buildSingleDingTalkMessage(report).markdown'), false);
}

function testEditorialReportPreservesLegalDepthAndStatutoryDates() {
  const report = structuredClone(sampleReport);
  const editorial = buildEditorialReport(report);
  const caseItem = editorial.sections
    .flatMap(section => section.items)
    .find(item => item.type === '案例');
  const regulationItem = editorial.sections
    .flatMap(section => section.items)
    .find(item => item.type === '法规');

  assert.deepEqual(caseItem.facts, report.sections[1].items[0].facts);
  assert.deepEqual(caseItem.legal_analysis, report.sections[1].items[0].violation_logic);
  assert.deepEqual(caseItem.results, report.sections[1].items[0].penalty_or_result);
  assert.deepEqual(regulationItem.facts, report.sections[0].items[0].what_changed);
  assert.deepEqual(regulationItem.legal_analysis, report.sections[0].items[0].legal_obligation);
  assert.equal(regulationItem.statutory_date, '2026-10-17');
  assert.equal(regulationItem.source_url, 'https://www.pom.go.id/');
  assert.equal(editorial.sections.length, 2);
  assert.equal(editorial.management_conclusions.length, 2);
  assert.notEqual(editorial.final_synthesis, editorial.management_conclusions[0]);
  assert.ok(editorial.final_synthesis.includes('由责任领导确定'));
  assert.equal(caseItem.practical_label, '业务启示');
  assert.equal(regulationItem.practical_label, '影响范围');
}

function testEditorialReportOrdersChinaFirstAndDeduplicatesWithinReport() {
  const china = structuredClone(sampleReport.sections[1].items[0]);
  const overseas = structuredClone(sampleReport.sections[0].items[0]);
  const duplicateChina = structuredClone(china);
  duplicateChina.source_url = `${china.source_url}?utm_source=duplicate#section`;
  const report = {
    ...structuredClone(sampleReport),
    sections: [
      { module: '新规及案例动态', items: [overseas] },
      { module: '广告合规及处罚案例', items: [china, duplicateChina] },
    ],
  };

  const editorial = buildEditorialReport(report);
  const items = editorial.sections.flatMap(section => section.items);
  assert.equal(items.length, 2);
  assert.equal(items[0].country, '中国');
  assert.equal(items[0].number, 1);
  assert.equal(items[1].country, '印尼');
  assert.equal(items[1].number, 2);
  assert.deepEqual(editorial.sections.map(section => section.module), [
    '广告处罚案例',
    '新法律法规政策',
  ]);
}

function testEditorialReportKeepsDifferentItemsFromTheSameSourceHomepage() {
  const report = {
    ...structuredClone(sampleReport),
    sections: [{
      module: '新规及案例动态',
      items: [
        highQualityActionItem({ title: '化妆品防晒剂限量规定', source_url: 'https://regulator.example.cn/notices/a' }),
        highQualityActionItem({ title: '口红重金属抽检通报', source_url: 'https://regulator.example.cn/notices/b' }),
      ],
    }],
  };

  const editorial = buildEditorialReport(curateReportQuality(report));
  assert.equal(editorial.item_count, 2);
}

function testSingleCardAlwaysUsesCopyableNativeMarkdown() {
  const message = buildSingleDingTalkMessage(sampleReport, {
    imageUrl: 'https://worker.test/assets/editorial-report/2026-05-24.png?v=abc',
  });

  assert.ok(message.markdown.includes('## 资讯正文'));
  assert.ok(message.markdown.includes('- **核心判断**\n  - '));
  assert.ok(message.markdown.includes('直接**处罚风险**'));
  assert.ok(message.markdown.includes('- **事实摘要**\n  - '));
  assert.ok(message.markdown.includes('- **法务研判**\n  - '));
  assert.ok(message.markdown.includes('- **来源**\n  - [上海市监局]'));
  assert.ok(message.markdown.includes('[上海市监局]'));
  assert.ok(message.markdown.includes('[BPOM]'));
  assert.equal(message.markdown.includes('![美妆法务资讯长图]'), false);
  assert.equal(message.markdown.includes('[查看高清原图]'), false);
  assert.equal(message.markdown.includes('## 来源索引'), false);
  assert.equal(message.markdown.includes('行动看板'), false);
  assert.equal(message.markdown.includes('重点事项'), false);
  assert.equal(message.markdown.includes('来源覆盖：'), false);
}

function testSingleCardFallbackPreservesTypeSpecificLegalDetail() {
  const message = buildSingleDingTalkMessage(sampleReport, { imageUrl: '' });

  for (const expected of [
    '## 资讯正文',
    '- **事实摘要**\n  - 直播间使用功效宣称吸引消费者购买',
    '- **法务研判**\n  - 监管以直播录屏、详情页文案和备案资料不一致作为认定依据',
    '- **处理结果**\n  - **责令停止**相关宣传',
    '- **法定节点**\n  - **2026-10-17**',
    '- **建议动作**\n  - 电商团队抽查 Top 20 SKU 直播脚本',
  ]) {
    assert.ok(message.markdown.includes(expected), `fallback should include ${expected}`);
  }
  assert.equal(message.markdown.includes('行动看板'), false);
  assert.equal(message.displayedItemCount, 2);
}

function testSingleCardDoesNotCapUsefulWatchItemsAtThree() {
  const titles = ['美妆平台功效描述治理', '化妆品原料目录更新', '防晒产品标签抽查', '香水过敏原行业简讯', '面膜微生物召回动态'];
  const report = {
    ...structuredClone(sampleReport),
    sections: [{
      module: '美妆动态',
      items: Array.from({ length: 5 }, (_, index) => highQualityWatchItem({
        title: titles[index],
        source_name: `行业来源 ${index + 1}`,
        source_url: `https://industry.example.com/watch/${index + 1}`,
      })),
    }],
  };
  const message = buildSingleDingTalkMessage(curateReportQuality(report), { maxBytes: 18000 });

  for (const title of titles) assert.ok(message.markdown.includes(title));
  assert.equal(message.displayedItemCount, 5);
  assert.equal(message.omittedItemCount, 0);
}

function testSingleCardRendersFinalSynthesisAsReadableBullets() {
  const message = buildSingleDingTalkMessage(sampleReport);
  const conclusion = message.markdown.split('## 本期结论\n')[1].split('\n\n>')[0];
  const lines = conclusion.split('\n').filter(Boolean);

  assert.ok(lines.length >= 2, 'multi-clause conclusion should use multiple bullets');
  assert.ok(lines.every(line => line.startsWith('- ')), 'every conclusion point should be a bullet');
  assert.equal(lines.some(line => !line.startsWith('- ') && line.length >= 200), false);
  assert.ok(lines.some(line => line.startsWith('- 先核验')));
  assert.ok(lines.some(line => line.startsWith('- 更新')));
  assert.equal(lines.some(line => line.includes('并更新相应审核')), false);
  assert.ok(lines.some(line => line.includes('由责任领导确定')));
}

function testEmptySingleCardRendersEachConclusionSentenceAsABullet() {
  const report = { ...structuredClone(sampleReport), sections: [] };
  const message = buildSingleDingTalkMessage(report);
  const conclusion = message.markdown.split('## 本期结论\n')[1].split('\n\n>')[0];
  const lines = conclusion.split('\n');

  assert.equal(lines.length, 2);
  assert.ok(lines.every(line => line.startsWith('- ')));
}

function testSingleSentenceConclusionRendersAsOneBullet() {
  assert.deepEqual(splitConclusionPoints('本期暂未发现需要立即处理的重大事项。'), [
    '本期暂未发现需要立即处理的重大事项。',
  ]);
}

function testEditorialReportHtmlIsReadableDenseAndComplete() {
  const html = buildEditorialReportHtml(sampleReport, {
    generatedAt: '2026-07-17T12:00:00+08:00',
  });

  for (const expected of [
    '--page-width: 1080px',
    'font-size: 36px',
    '国际美妆法务资讯周报',
    '管理层摘要',
    '广告合规及处罚案例',
    '新规及案例动态',
    '01',
    '02',
    '事实摘要',
    '法务研判',
    '处理结果',
    '业务启示',
    '影响范围',
    '法定节点',
    '由责任领导确定',
    '本期结论',
  ]) {
    assert.ok(html.includes(expected), `image HTML should include ${expected}`);
  }
  assert.ok(html.indexOf('直播功效宣称与备案资料不一致被处罚') < html.indexOf('BPOM 更新化妆品清真认证要求'));
  for (const forbidden of ['行动看板', '来源覆盖：', '中国关键源：', '受限监测源：', '正式条目：']) {
    assert.equal(html.includes(forbidden), false, `image HTML should omit ${forbidden}`);
  }
}

async function testEditorialPngRendererUsesHighResolutionFullPageCapture() {
  let contextOptions = null;
  let screenshotOptions = null;
  let renderedHtml = '';
  let closed = 0;
  const browserType = {
    async launch() {
      return {
        async newContext(options) {
          contextOptions = options;
          return {
            async newPage() {
              return {
                async setContent(html) { renderedHtml = html; },
                async evaluate() {},
                async screenshot(options) {
                  screenshotOptions = options;
                  return new Uint8Array([137, 80, 78, 71]);
                },
              };
            },
            async close() { closed += 1; },
          };
        },
        async close() { closed += 1; },
      };
    },
  };

  const png = await renderEditorialReportPng({ report: sampleReport, browserType });
  assert.deepEqual(contextOptions.viewport, { width: 1080, height: 1600 });
  assert.equal(contextOptions.deviceScaleFactor, 2);
  assert.equal(screenshotOptions.fullPage, true);
  assert.equal(screenshotOptions.type, 'png');
  assert.ok(renderedHtml.includes('国际美妆法务资讯周报'));
  assert.deepEqual([...png], [137, 80, 78, 71]);
  assert.equal(closed, 2);
}

function testBuildSingleDingTalkMessagePrefersExplicitCoreJudgement() {
  const report = structuredClone(sampleReport);
  const item = report.sections[0].items[0];
  item.core_judgement = '独立核心判断：该规则直接改变中国市场的产品准入决策。';
  item.what_changed = ['旧变化点不应覆盖独立核心判断。'];

  const message = buildSingleDingTalkMessage(report, { maxBytes: 18000 });

  assert.ok(message.markdown.includes('- **核心判断**\n  - 独立核心判断：该规则直接改变中国市场的产品准入决策。'));
  assert.equal(message.markdown.includes('- **核心判断**\n  - 旧变化点不应覆盖独立核心判断。'), false);
}

function testSingleCardHighlightsOnlyHighSignalTermsInsideBullets() {
  const report = structuredClone(sampleReport);
  const item = report.sections[0].items[0];
  item.core_judgement = '企业必须在2026-10-17前完成整改，逾期可能被处以50万元罚款。';
  item.legal_obligation = ['普通背景说明，不构成新的操作要求。'];

  const message = buildSingleDingTalkMessage(report, { maxBytes: 18000 });

  assert.ok(message.markdown.includes('企业**必须**在**2026-10-17**前完成整改，逾期可能被处以**50万元**罚款。'));
  assert.ok(message.markdown.includes('> 印尼｜**高风险**｜行动事项'));
  assert.equal(message.markdown.includes('**普通背景说明**'), false);
  assert.ok(message.markdown.includes('[BPOM](https://www.pom.go.id/)'));
}

function testSingleCardUsesExecutiveBriefAndOnlyActiveModules() {
  const curated = curateReportQuality(highQualityFixtureReport());
  const message = buildSingleDingTalkMessage(curated, {
    imageUrl: 'https://worker.test/assets/action-dashboard.png',
    maxBytes: 18000,
  });

  assert.ok(message.markdown.includes('## 管理层摘要'));
  assert.ok(message.markdown.includes('## 资讯正文'));
  assert.equal(message.markdown.includes('![美妆法务资讯长图]'), false);
  assert.equal(message.markdown.includes('## 来源索引'), false);
  assert.ok(message.markdown.includes('中国监管要求强化化妆品功效证据'));
  assert.ok(message.markdown.includes('https://scjgj.sh.gov.cn/'));
  assert.ok(message.markdown.includes('- **责任岗位**\n  - '));
  assert.equal(message.markdown.includes('## 重点事项'), false);
  assert.equal(message.markdown.includes('行动看板'), false);
  assert.equal(/## M[1-6]/.test(message.markdown), false);
  assert.equal(message.markdown.includes('本周无高价值更新'), false);
}

function testSingleCardRendersWatchItemAsCompactObservation() {
  const report = highQualityFixtureReport();
  report.sections = report.sections.filter(section => section.module === '美妆动态');
  const message = buildSingleDingTalkMessage(curateReportQuality(report));

  assert.ok(message.markdown.includes('## 资讯正文'));
  assert.ok(message.markdown.includes('持续观察'));
  assert.ok(message.markdown.includes('- **关注价值**\n  - '));
  assert.ok(message.markdown.includes('- **下一观察点**\n  - '));
  assert.equal(message.markdown.includes('建议持续关注'), false);
}

function testBuildSingleDingTalkMessageCompactsOversizedReportWithoutSplitting() {
  const base = structuredClone(sampleReport.sections[0].items[0]);
  const report = structuredClone(sampleReport);
  report.sections[0].items = Array.from({ length: 24 }, (_, index) => ({
    ...structuredClone(base),
    title: `超长监管事项 ${index + 1}`,
    country: index % 3 === 0 ? '中国' : '美国',
    source_url: `https://example.com/item-${index + 1}`,
    why_it_matters: `这是一段需要压缩的业务影响说明 ${index + 1}。`.repeat(16),
    recommended_actions: [`立即完成第 ${index + 1} 项合规核验。`.repeat(8)],
  }));

  const message = buildSingleDingTalkMessage(report, { maxBytes: 2200 });
  assert.equal(Array.isArray(message), false);
  assert.ok(message.bytes <= 2200);
  assert.ok(message.markdown.includes('## 管理层摘要'));
  assert.ok(message.markdown.includes('## 资讯正文'));
  assert.ok(message.markdown.includes('https://'));
  assert.ok(message.markdown.includes('已省略'));
  assert.ok(message.omittedItemCount > 0);
}

function testActionDashboardUsesReadableChineseManagementLayout() {
  const report = curateReportQuality(highQualityFixtureReport());
  const items = report.sections.flatMap(section => section.items || []);
  const svg = buildActionDashboardSvg(items, {
    period: report.period,
    coverage: { overall: 0.95, chinaCritical: 1, failedSources: ['失败源'] },
    generatedAt: '2026-07-16T08:00:00.000Z',
  });

  assert.ok(svg.includes('width="1080" height="1440"'));
  assert.ok(svg.includes('font-family="Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif"'));
  assert.ok(svg.includes('>行动看板</text>'));
  assert.ok(svg.includes('本周核心判断'));
  assert.ok(svg.includes('优先行动'));
  assert.ok(svg.includes('<text x="72" y="490" font-size="34"'));
  assert.ok(svg.includes('由责任领导确定'));
  assert.ok(svg.includes('中国监管要求强化化妆品功效证据'));
  for (const removed of ['正式情报', '来源覆盖', '官方来源', '六模块风险分布', '门槛失败', '受限监测']) {
    assert.equal(svg.includes(removed), false, `dashboard should omit ${removed}`);
  }

  for (const match of svg.matchAll(/<rect[^>]*\sy="([\d.]+)"[^>]*\sheight="([\d.]+)"/g)) {
    assert.ok(Number(match[1]) + Number(match[2]) <= 1440, `rect outside canvas: ${match[0]}`);
  }
}

function testBuildDingTalkWebhookMessagesPutsChinaFirstWithinModule() {
  const chinaItem = structuredClone(sampleReport.sections[1].items[0]);
  chinaItem.title = '中国事项';
  chinaItem.country = '中国';
  chinaItem.source_url = 'https://example.com/china';

  const overseasItem = structuredClone(sampleReport.sections[0].items[0]);
  overseasItem.title = '海外事项';
  overseasItem.module = '广告合规及处罚案例';
  overseasItem.source_url = 'https://example.com/overseas';

  const report = {
    period: sampleReport.period,
    summary: sampleReport.summary,
    risk_alerts: sampleReport.risk_alerts,
    sections: [{ module: '广告合规及处罚案例', items: [overseasItem, chinaItem] }],
  };
  const [message] = buildDingTalkWebhookMessages(report);
  const advertisingSection = message.markdown.slice(message.markdown.indexOf('### 广告合规及处罚案例'));
  assert.ok(advertisingSection.indexOf('中国事项') < advertisingSection.indexOf('海外事项'));
}

function testBuildDingTalkWebhookMessagesCompactsOversizedModulesWithoutSplitting() {
  const baseItem = sampleReport.sections[1].items[0];
  const items = Array.from({ length: 6 }, (_, index) => ({
    ...structuredClone(baseItem),
    title: `长内容事项${index + 1}`,
    source_url: `https://example.com/long-${index + 1}`,
    why_it_matters: `业务影响说明${index + 1}`.repeat(12),
  }));
  const report = {
    period: sampleReport.period,
    summary: sampleReport.summary,
    risk_alerts: sampleReport.risk_alerts,
    sections: [{ module: '广告合规及处罚案例', items }],
  };
  const maxBytes = 1800;
  const messages = buildDingTalkWebhookMessages(report, { maxBytes });
  assert.equal(messages.length, 1);
  assert.ok(new TextEncoder().encode(messages[0].markdown).length <= maxBytes);
  assert.ok(messages[0].markdown.includes('### 广告合规及处罚案例'));
  assert.equal(/## M[1-6]/.test(messages[0].markdown), false);
}

function testBuildDingTalkWebhookMessagesKeepsOversizedItemSourceInOneCard() {
  const item = structuredClone(sampleReport.sections[1].items[0]);
  item.title = '单条超长事项';
  item.source_url = 'https://example.com/oversized-item';
  item.violation_logic = [Array.from({ length: 120 }, (_, index) => `拆解点${index + 1}`).join('；')];
  const report = {
    period: sampleReport.period,
    summary: [],
    risk_alerts: [],
    sections: [{ module: '广告合规及处罚案例', items: [item] }],
  };
  const maxBytes = 1800;
  const [message] = buildDingTalkWebhookMessages(report, { maxBytes });
  assert.ok(new TextEncoder().encode(message.markdown).length <= maxBytes);
  assert.ok(message.markdown.includes('单条超长事项'));
  assert.ok(message.markdown.includes('https://example.com/oversized-item'));
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

async function testSendDingTalkMessagesRetriesTransientFailuresInOrder() {
  const messages = [
    { id: 'overview', title: '总览', markdown: '# 总览' },
    { id: 'm1-1', title: '模块一', markdown: '# 模块一' },
  ];
  const calls = [];
  let overviewAttempts = 0;
  const result = await sendDingTalkMessages({
    messages,
    maxAttempts: 3,
    sleepFn: async () => {},
    sendMessage: async message => {
      calls.push(message.id);
      if (message.id === 'overview' && overviewAttempts++ === 0) {
        return { ok: false, retryable: true, error: 'timeout' };
      }
      return { ok: true, retryable: false };
    },
  });

  assert.deepEqual(calls, ['overview', 'overview', 'm1-1']);
  assert.deepEqual(result, {
    ok: true,
    sent: 2,
    total: 2,
    retries: 1,
    failedMessageId: '',
    error: '',
  });
}

async function testSendDingTalkMessagesThrottlesBetweenSuccessfulSegments() {
  const waits = [];
  const result = await sendDingTalkMessages({
    messages: [
      { id: 'overview', title: '总览', markdown: '# 总览' },
      { id: 'm1-1', title: '模块一', markdown: '# 模块一' },
    ],
    interMessageDelayMs: 3100,
    sleepFn: async delay => { waits.push(delay); },
    sendMessage: async () => ({ ok: true, retryable: false }),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(waits, [3100]);
}

async function testSendDingTalkMessagesStopsAfterTerminalFailure() {
  const calls = [];
  const result = await sendDingTalkMessages({
    messages: [
      { id: 'overview', title: '总览', markdown: '# 总览' },
      { id: 'm1-1', title: '模块一', markdown: '# 模块一' },
    ],
    sleepFn: async () => {},
    sendMessage: async message => {
      calls.push(message.id);
      return { ok: false, retryable: false, error: 'invalid signature' };
    },
  });

  assert.deepEqual(calls, ['overview']);
  assert.equal(result.ok, false);
  assert.equal(result.sent, 0);
  assert.equal(result.total, 2);
  assert.equal(result.retries, 0);
  assert.equal(result.failedMessageId, 'overview');
  assert.equal(result.error, 'invalid signature');
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
      DINGTALK_MESSAGE_DELAY_MS: 0,
      REPORT_PERIOD_START: sampleReport.period.start,
      REPORT_PERIOD_END: sampleReport.period.end,
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
  assert.equal(ok.ok, true);
  assert.equal(ok.sent, 1);
  assert.equal(ok.total, 1);
  assert.ok(sentTitle.includes('美妆法务资讯'));
  assert.ok(sentMarkdown.includes('事实摘要') || sentMarkdown.includes('法务观察'));
  assert.ok(sentMarkdown.includes('下一步观察建议') || sentMarkdown.includes('业务影响'));
  assert.ok(sentMarkdown.includes('来源链接') || sentMarkdown.includes('来源'));
  assert.equal(sentMarkdown.includes('管理层摘要'), false);
  assert.equal(sentMarkdown.includes('产品质量/召回与安全风险'), false);
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

async function testRequestAiChatEnablesHighReasoningForSolModel() {
  let payload = null;
  await requestAiChat({
    apiKey: 'test-key',
    baseUrl: 'https://hk.testvideo.site/v1',
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'review' }],
    reasoningEffort: 'high',
    fetcher: async (_url, init) => {
      payload = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    },
  });

  assert.equal(payload.model, 'gpt-5.6-sol');
  assert.equal(payload.reasoning_effort, 'high');
}

async function testRequestAiChatRetriesHeadersTimeout() {
  let attempts = 0;
  const sleeps = [];
  const content = await requestAiChat({
    apiKey: 'test-key',
    baseUrl: 'https://hk.testvideo.site/v1',
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'retry' }],
    timeoutMs: 20,
    maxAttempts: 2,
    sleepFn: async (delayMs) => { sleeps.push(delayMs); },
    fetcher: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('fetch failed');
        error.cause = { code: 'UND_ERR_HEADERS_TIMEOUT' };
        throw error;
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    },
  });

  assert.equal(content, '{"ok":true}');
  assert.equal(attempts, 2);
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 0);
}

function testBuildAnalysisPromptUsesConfigurableInputLimits() {
  const candidates = Array.from({ length: 5 }, (_, i) => ({
    title: `候选${i}`,
    url: `https://example.com/${i}`,
    source_name: '官方源',
    module: '新规及案例动态',
    snippet: i === 0 ? `${'有效正文'.repeat(800)}截断后内容不应进入模型` : '',
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
  assert.ok(prompt.includes('有效正文'));
  assert.ok(prompt.includes('截断后内容不应进入模型'));
  assert.ok(prompt.includes('候选2'));
  assert.ok(prompt.includes('线索0'));
  assert.ok(prompt.includes('线索2'));
  assert.ok(prompt.includes('线索3'));
}

function testBuildAnalysisPromptRequiresCoreJudgementWithoutInternalDeadlines() {
  const prompt = buildAnalysisPrompt({
    candidates: [],
    leads: [],
    sources: sourceCatalog.sources,
    period: { start: '2026-07-06', end: '2026-07-12' },
  });

  assert.ok(prompt.includes('"fact_summary"'));
  assert.ok(prompt.includes('"next_observation"'));
  assert.ok(prompt.includes('只负责提取、分类、去重和压缩公开事实'));
  assert.equal(prompt.includes('"core_judgement"'), false);
  assert.equal(prompt.includes('"recommended_actions"'), false);
  for (const statutoryField of ['"effective_date"', '"feedback_deadline"', '"next_deadline"']) {
    assert.ok(prompt.includes(statutoryField));
  }
}

function testAnalysisPromptSupportsWatchItemsWithoutForcedModuleFilling() {
  const prompt = buildAnalysisPrompt({
    candidates: [],
    leads: [],
    sources: sourceCatalog.sources,
    period: { start: '2026-07-06', end: '2026-07-12' },
    targetModule: '美妆动态',
  });

  assert.ok(prompt.includes('"report_tier": "action|watch"'));
  assert.ok(prompt.includes('"fact_summary"'));
  assert.ok(prompt.includes('"next_observation"'));
  assert.ok(prompt.includes('返回所有符合准入规则的条目'));
  assert.equal(prompt.includes('至少输出 2 条'), false);
}

async function testModuleAnalysisFailureReturnsEmptySectionWithoutPlaceholder() {
  const report = await analyzeReportByModule({
    modules: ['美妆动态'],
    candidates: [{ module: '美妆动态', title: '行业线索', url: 'https://example.com/news' }],
    leads: [],
    sources: [],
    period: { start: '2026-07-06', end: '2026-07-12' },
    analyze: async () => { throw new Error('timeout'); },
    logger: { warn() {} },
  });
  assert.equal(report.sections.length, 1);
  assert.equal(report.sections[0].module, '美妆动态');
  assert.deepEqual(report.sections[0].items, []);
}

function reportWithCoreJudgements(prefix) {
  const report = structuredClone(sampleReport);
  report.sections = report.sections.map(section => ({
    ...section,
    items: section.items.map((item, index) => ({
      ...item,
      core_judgement: `${prefix}${index + 1}`,
    })),
  }));
  return report;
}

async function testDeepseekAnalyzeUsesValidatedEvidenceReview() {
  const originalFetch = globalThis.fetch;
  const draft = reportWithCoreJudgements('首轮判断');
  const reviewed = reportWithCoreJudgements('复核判断');
  const candidates = draft.sections.flatMap(section => section.items.map(item => ({
    title: item.title,
    url: item.source_url,
    source_name: item.source_name,
    snippet: '与报告条目对应的公开原文摘要。',
  })));
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    const content = calls === 1 ? draft : reviewed;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), { status: 200 });
  };

  try {
    const result = await deepseekAnalyze({
      apiKey: 'test-key',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-5.6-sol',
      candidates,
      sources: [],
      period: draft.period,
    });
    assert.equal(calls, 2);
    assert.ok(result.sections[0].items[0].core_judgement.startsWith('复核判断'));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testDeepseekAnalyzeFallsBackWhenEvidenceReviewFails() {
  const originalFetch = globalThis.fetch;
  const draft = reportWithCoreJudgements('首轮保留');
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(draft) } }] }), { status: 200 });
    }
    return new Response('review unavailable', { status: 503 });
  };

  try {
    const result = await deepseekAnalyze({
      apiKey: 'test-key',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-5.6-sol',
      candidates: [],
      sources: [],
      period: draft.period,
      logger: { warn() {} },
    });
    assert.equal(calls, 3);
    assert.ok(result.sections[0].items[0].core_judgement.startsWith('首轮保留'));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

async function testDeepseekAnalyzeFallsBackWhenEvidenceReviewIsMalformed() {
  const originalFetch = globalThis.fetch;
  const draft = reportWithCoreJudgements('畸形复核前判断');
  let calls = 0;

  globalThis.fetch = async () => {
    calls += 1;
    const content = calls === 1 ? JSON.stringify(draft) : '{not-valid-json';
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  };

  try {
    const result = await deepseekAnalyze({
      apiKey: 'test-key',
      baseUrl: 'https://example.com/v1',
      model: 'gpt-5.6-sol',
      candidates: [],
      sources: [],
      period: draft.period,
      logger: { warn() {} },
    });
    assert.equal(calls, 2);
    assert.ok(result.sections[0].items[0].core_judgement.startsWith('畸形复核前判断'));
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function testCheckedInModelDefaultsUseGpt55() {
  const expected = 'gpt-5.5';
  for (const relativePath of [
    './index.js',
    './run-local.js',
    './wrangler.toml',
    '../.github/workflows/weekly.yml',
    '../README.md',
  ]) {
    const content = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    assert.ok(content.includes(expected), `${relativePath} should configure ${expected}`);
  }
}

function testActiveWorkerDoesNotUseDeprecatedDeepseekCredentials() {
  const deprecated = [
    'deepseek-v4-pro',
    'DEEPSEEK_API_KEY',
    'DEEPSEEK_API_BASE_URL',
    'DEEPSEEK_MODEL',
    'DEEPSEEK_WORKER_MODEL',
    'https://api.deepseek.com/v1',
  ];
  for (const relativePath of [
    './index.js',
    './run-local.js',
    './wrangler.toml',
    '../.github/workflows/weekly.yml',
    '../README.md',
  ]) {
    const content = readFileSync(new URL(relativePath, import.meta.url), 'utf8');
    for (const value of deprecated) {
      assert.equal(content.includes(value), false, `${relativePath} should not use deprecated ${value}`);
    }
  }
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

async function testUploadDingTalkImageReturnsMediaId() {
  let calledUrl = '';
  let method = '';
  const mediaId = await uploadDingTalkImage({
    accessToken: 'token',
    image: new Uint8Array([1, 2, 3]),
    fetcher: async (url, init) => {
      calledUrl = String(url);
      method = init.method;
      assert.ok(init.body instanceof FormData);
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok', media_id: '@media-id' }), { status: 200 });
    },
  });
  assert.equal(mediaId, '@media-id');
  assert.ok(calledUrl.includes('/media/upload'));
  assert.ok(calledUrl.includes('type=image'));
  assert.equal(method, 'POST');
}

function testBuildAnalysisPromptIncludesLeads() {
  const prompt = buildAnalysisPrompt({
    candidates: [{ title: '法规候选', url: 'https://example.com/a', source_name: '官方源' }],
    leads: [{ name: '化妆品观察', source_type: 'wechat_public_account', topics: ['化妆品'] }],
    sources: [],
    period: { start: '2026-05-18', end: '2026-05-24' },
  });
  assert.ok(prompt.includes('leads'));
  assert.ok(prompt.includes('只能用于发现选题'));
  assert.ok(prompt.includes('客观资讯编辑'));
  assert.ok(prompt.includes('过去 7 天'));
  assert.ok(prompt.includes('正文内容与美妆行业有实质关系'));
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
  assert.ok(prompt.includes('返回所有符合准入规则的条目'));
  assert.ok(prompt.includes('具体原文 URL'));
  assert.ok(prompt.includes('candidate_index'));
  assert.ok(prompt.includes('reviewed_candidates'));
  assert.ok(prompt.includes('display_title_zh'));
  assert.ok(prompt.includes('source_name_zh'));
  assert.ok(prompt.includes('所有可见的标题'));
  assert.ok(prompt.includes('中国候选优先'));
  assert.ok(prompt.includes('不够重大'));
  assert.ok(prompt.includes('report_tier=watch'));
  assert.ok(prompt.includes('主体 + 具体事项或结果'));
  assert.ok(prompt.includes('不要逐词直译'));
  assert.ok(prompt.includes('无通行中文译名'));
}

async function testModuleAnalysisRequiresARecordedDecisionForEveryCandidate() {
  const period = { start: '2026-07-13', end: '2026-07-19' };
  const candidates = [
    { candidate_index: 0, title: '化妆品标签新规', url: 'https://official.example.cn/rules/label', source_name: '监管机构', source_type: 'official_site', authority_type: 'regulator', module: '新规及案例动态', region: '亚洲', country: '中国', snippet: '化妆品标签新规全文。'.repeat(80) },
    { candidate_index: 1, title: '普通食品安全新闻', url: 'https://official.example.cn/news/food', source_name: '监管机构', source_type: 'official_site', authority_type: 'regulator', module: '新规及案例动态', region: '亚洲', country: '中国', published_at: '2026-07-18', snippet: '食品安全新闻全文。'.repeat(80) },
  ];
  const includedItem = {
    ...objectiveBriefFixture().sections[0].items[0],
    candidate_index: 0,
    display_title_zh: '化妆品标签监管新规',
    source_name_zh: '中国监管机构',
    title: '被 AI 改写的标题',
    source_name: '被 AI 改写的来源',
    source_url: 'https://fabricated.example.com/not-original',
    published_at: '2026-07-18',
  };
  const responseFor = reviewedCandidates => ({
    period,
    summary: [],
    risk_alerts: [],
    reviewed_candidates: reviewedCandidates,
    sections: [{ module: '新规及案例动态', items: [includedItem] }],
  });
  let calls = 0;
  const result = await deepseekAnalyze({
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    model: 'gpt-5.5',
    candidates,
    sources: [],
    period,
    targetModule: '新规及案例动态',
    review: false,
    requireCandidateCoverage: true,
    fetcher: async () => {
      calls += 1;
      const reviewed = calls === 1
        ? [{ candidate_index: 0, decision: 'include', reason: '与化妆品直接相关' }]
        : [
          { candidate_index: 0, decision: 'include', reason: '与化妆品直接相关' },
          { candidate_index: 1, decision: 'exclude', reason: '正文仅涉及食品' },
        ];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(responseFor(reviewed)) } }] }), { status: 200 });
    },
  });

  assert.equal(calls, 2);
  const item = result.sections[0].items[0];
  assert.equal(item.title, candidates[0].title);
  assert.equal(item.source_name, candidates[0].source_name);
  assert.equal(item.evidence_source_name, candidates[0].source_name);
  assert.equal(item.source_url, candidates[0].url);
  assert.equal(item.evidence_title, candidates[0].title);
  assert.equal(item.published_at, '未知');
  assert.equal(item.updated_at, '未知');
}

async function testModuleAnalysisFallsBackFromGenericChineseDisplayText() {
  const candidate = {
    title: '某品牌眼霜商标侵权处罚决定书',
    url: 'https://official.example.cn/penalties/trademark-1',
    source_name: '上海市市场监督管理局',
    source_type: 'official_site',
    authority_type: 'regulator',
    module: '知识产权动态',
    region: '亚洲',
    country: '中国',
    published_at: '2026-07-18',
    snippet: `${'一般背景说明。'.repeat(2500)}涉案商品为眼霜，监管部门认定其未经许可使用注册商标并作出处罚。`,
  };
  const aiItem = {
    ...objectiveBriefFixture().sections[0].items[0],
    candidate_index: 0,
    display_title_zh: '最新动态',
    source_name_zh: '中国监管机构',
    fact_summary: ['监管部门认定涉案主体未经许可在眼霜包装上使用注册商标，并作出行政处罚。'],
  };
  const response = {
    period: { start: '2026-07-13', end: '2026-07-19' },
    summary: [],
    risk_alerts: [],
    reviewed_candidates: [{ candidate_index: 0, decision: 'include', reason: '正文直接涉及化妆品商标侵权处罚' }],
    sections: [{ module: '知识产权动态', items: [aiItem] }],
  };

  const report = await deepseekAnalyze({
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    model: 'gpt-5.5',
    candidates: [candidate],
    sources: [],
    period: response.period,
    targetModule: '知识产权动态',
    review: false,
    requireCandidateCoverage: true,
    fetcher: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(response) } }],
    }), { status: 200 }),
  });

  const item = report.sections[0].items[0];
  assert.equal(item.title, candidate.title);
  assert.equal(item.source_name, candidate.source_name);
  assert.equal(item.evidence_title, candidate.title);
  assert.equal(item.evidence_source_name, candidate.source_name);
  assert.ok(item.evidence_excerpt.includes('涉案商品为眼霜'));
  assert.equal(processAnalyzedReport(report, { candidates: [candidate], sources: [] }).audit.acceptedItems, 1);
}

async function testModuleAnalysisRejectsMismatchedForeignTitleAndSourceTranslation() {
  const candidate = {
    title: 'FDA Announces Recall of Cosmetic Eye Cream',
    url: 'https://www.fda.gov/safety/recalls/eye-cream',
    source_name: 'U.S. Food and Drug Administration',
    source_type: 'official_site',
    authority_type: 'regulator',
    module: '产品质量/召回与安全风险',
    region: '北美洲',
    country: '美国',
    published_at: '2026-07-18',
    snippet: 'FDA announced a recall of a cosmetic eye cream after microbial contamination was detected.',
  };
  const aiItem = {
    ...objectiveBriefFixture().sections[0].items[0],
    candidate_index: 0,
    display_title_zh: '国家药监局发布化妆品召回公告',
    source_name_zh: '中国国家药品监督管理局',
  };
  const response = {
    period: { start: '2026-07-13', end: '2026-07-19' },
    summary: [],
    risk_alerts: [],
    reviewed_candidates: [{ candidate_index: 0, decision: 'include', reason: '正文涉及化妆品召回' }],
    sections: [{ module: candidate.module, items: [aiItem] }],
  };

  const report = await deepseekAnalyze({
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    model: 'gpt-5.5',
    candidates: [candidate],
    sources: [],
    period: response.period,
    targetModule: candidate.module,
    review: false,
    requireCandidateCoverage: true,
    fetcher: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(response) } }],
    }), { status: 200 }),
  });

  const item = report.sections[0].items[0];
  assert.equal(item.title, candidate.title);
  assert.equal(item.source_name, candidate.source_name);
}

async function testModuleAnalysisKeepsAnchoredChineseTranslationWithoutEveryNumber() {
  const candidate = {
    title: 'FDA Recalls 1,000 Cosmetic Eye Creams in 2026',
    url: 'https://www.fda.gov/safety/recalls/eye-cream-2026',
    source_name: 'FDA',
    source_type: 'official_site',
    authority_type: 'regulator',
    module: '产品质量/召回与安全风险',
    region: '北美洲',
    country: '美国',
    published_at: '2026-07-18',
    snippet: 'FDA recalled cosmetic eye creams after microbial contamination was detected.',
  };
  const translatedTitle = '美国 FDA 召回受微生物污染的化妆品眼霜';
  const response = {
    period: { start: '2026-07-13', end: '2026-07-19' },
    summary: [],
    risk_alerts: [],
    reviewed_candidates: [{ candidate_index: 0, decision: 'include', reason: '正文涉及化妆品眼霜召回' }],
    sections: [{ module: candidate.module, items: [{
      ...objectiveBriefFixture().sections[0].items[0],
      candidate_index: 0,
      display_title_zh: translatedTitle,
      source_name_zh: '美国食品药品监督管理局（FDA）',
    }] }],
  };

  const report = await deepseekAnalyze({
    apiKey: 'test-key',
    baseUrl: 'https://example.com/v1',
    model: 'gpt-5.5',
    candidates: [candidate],
    sources: [],
    period: response.period,
    targetModule: candidate.module,
    review: false,
    requireCandidateCoverage: true,
    fetcher: async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(response) } }],
    }), { status: 200 }),
  });

  assert.equal(report.sections[0].items[0].title, translatedTitle);
  assert.equal(report.sections[0].items[0].source_name, candidate.source_name);
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

function testFilterReportToObservedSourcesKeepsCanonicalUrlVariants() {
  const report = structuredClone(sampleReport);
  const originalUrl = report.sections[0].items[0].source_url;
  report.sections[0].items[0].source_url = `${originalUrl}?utm_source=weekly#details`;

  const filtered = filterReportToObservedSources(report, {
    candidates: [{ url: originalUrl }],
    sources: [],
  });

  assert.equal(filtered.sections[0].items.length, 1);
  assert.equal(filtered.sections[0].items[0].source_url, originalUrl);
}

function testEmptySingleCardIsExplicitAndNeverShowsDashboard() {
  const report = {
    period: { start: '2026-07-10', end: '2026-07-16' },
    summary: [],
    risk_alerts: [],
    sections: REPORT_MODULES.map(module => ({ module, items: [] })),
  };

  const message = buildSingleDingTalkMessage(report, {
    imageUrl: 'https://worker.test/assets/empty-dashboard.png',
  });

  assert.equal(message.itemCount, 0);
  assert.ok(message.markdown.includes('本期五个重点板块未发现达到准入标准的新事项'));
  assert.equal(message.markdown.includes('![行动看板]'), false);
  assert.equal(message.markdown.includes('本周无通过质量门槛的核心判断'), false);
}

function testDecisionMapRequiresAtLeastOneActionItem() {
  const watchOnly = highQualityFixtureReport();
  watchOnly.sections = watchOnly.sections.filter(section => section.module === '美妆动态');
  const actionOnly = highQualityFixtureReport();
  actionOnly.sections = actionOnly.sections.filter(section => section.module === '新规及案例动态');

  assert.equal(shouldPublishDecisionMap(curateReportQuality(watchOnly)), false);
  assert.equal(shouldPublishDecisionMap(curateReportQuality(actionOnly)), true);
}

function testManualForceDeliveryBypassesDuplicateSkip() {
  assert.equal(shouldSkipDuplicateReport(true, false), true);
  assert.equal(shouldSkipDuplicateReport(true, true), false);
  assert.equal(shouldSkipDuplicateReport(false, false), false);
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
  assert.ok(prompt.includes('美妆行业客观资讯编辑'));
  assert.ok(prompt.includes('国家/区域监管机构'));
  assert.ok(prompt.includes('必须结合详情页'));
  assert.ok(prompt.includes('industry_impact'));
  assert.ok(prompt.includes('fact_summary'));
  assert.ok(prompt.includes('next_observation'));
  assert.ok(prompt.includes('旧分析字段必须为空'));
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

function testPrioritizeCandidatesForAnalysisPutsChinaEvidenceFirst() {
  const ranked = prioritizeCandidatesForAnalysis([
    { title: '海外高影响事项', country: '美国', priority: 'high', published_at: '2026-07-18' },
    { title: '中国直接相关事项', country: '中国', priority: 'medium', published_at: '2026-07-17' },
  ]);
  assert.equal(ranked[0].country, '中国');
}

function testAnalysisPromptKeepsChinaEvidenceFirst() {
  const prompt = buildAnalysisPrompt({
    candidates: [
      { title: '海外高影响事项', country: '美国', priority: 'high', published_at: '2026-07-18' },
      { title: '中国中等影响简讯', country: '中国', priority: 'medium', published_at: '2026-07-17' },
    ],
    leads: [],
    sources: [],
    period: { start: '2026-07-13', end: '2026-07-19' },
  });

  assert.ok(prompt.indexOf('中国中等影响简讯') < prompt.indexOf('海外高影响事项'));
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
      AI_API_KEY: 'test-key',
      DETAIL_FETCH_ENABLED: '0',
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
  assert.ok(text.includes('delivery: DingTalk webhook'));
  assert.equal(text.includes('DingTalk document'), false);
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
    if (href.includes('/chat/completions')) {
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
      AI_API_KEY: 'test-key',
      DETAIL_FETCH_ENABLED: '0',
      FEISHU_WEBHOOK_URL: 'https://example.com/webhook',
      AI_MODEL: 'gpt-5.6-sol',
      REPORT_PERIOD_START: sampleReport.period.start,
      REPORT_PERIOD_END: sampleReport.period.end,
      SEEN_NEWS: kv,
    }, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(store.has('report:latest'), false);
  assert.equal([...store.keys()].some(key => /^report:\d{4}-\d{2}-\d{2}$/.test(key)), false);
  assert.equal(store.has('asset:decision-map:latest'), false);
  assert.equal(feishuSent, true);
}

async function testScheduledPipelineSendsDingTalkWithoutDocumentCredentials() {
  const originalFetch = globalThis.fetch;
  const store = new Map();
  const kv = {
    async get(key) { return store.get(key) || null; },
    async put(key, value) { store.set(key, value); },
  };
  let dingTalkMessages = 0;
  let dingTalkDocumentCalls = 0;

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (href.includes('/chat/completions')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(sampleReport) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.startsWith('https://oapi.dingtalk.com/robot/send')) {
      dingTalkMessages += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.msgtype, 'markdown');
      assert.ok(body.markdown.title.includes('美妆法务资讯'));
      assert.ok(body.markdown.text.startsWith('# 美妆法务资讯'));
      return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 });
    }
    if (href.includes('api.dingtalk.com') || href.includes('/media/upload')) {
      dingTalkDocumentCalls += 1;
      return new Response(JSON.stringify({ code: 'should-not-be-called' }), { status: 500 });
    }
    return new Response('<a href="/cosmetic-rule">化妆品安全评估技术导则征求意见</a>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  };

  try {
    await worker.scheduled({}, {
      AI_API_KEY: 'test-key',
      DETAIL_FETCH_ENABLED: '0',
      DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      DINGTALK_MESSAGE_DELAY_MS: 0,
      REPORT_PERIOD_START: sampleReport.period.start,
      REPORT_PERIOD_END: sampleReport.period.end,
      DINGTALK_CLIENT_ID: 'legacy-client',
      DINGTALK_CLIENT_SECRET: 'legacy-secret',
      DINGTALK_OPERATOR_ID: 'legacy-operator',
      DINGTALK_WORKSPACE_ID: 'legacy-workspace',
      AI_MODEL: 'test-model',
      SEEN_NEWS: kv,
    }, {});
  } finally {
    globalThis.fetch = originalFetch;
  }

  const lastRun = JSON.parse(store.get('run:last'));
  assert.equal(dingTalkMessages, 1);
  assert.equal(dingTalkDocumentCalls, 0);
  assert.equal(lastRun.status, 'done');
  assert.equal(lastRun.stage, 'dingtalk');
}

async function testScheduledPipelineRejectsDingTalkFailureWithoutMarkingSeen() {
  const originalFetch = globalThis.fetch;
  const store = new Map();
  const kv = {
    async get(key) { return store.get(key) || null; },
    async put(key, value) { store.set(key, value); },
  };
  let dingTalkAttempts = 0;

  globalThis.fetch = async url => {
    const href = String(url);
    if (href.includes('/chat/completions')) {
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify(sampleReport) } }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (href.startsWith('https://oapi.dingtalk.com/robot/send')) {
      dingTalkAttempts += 1;
      return new Response(JSON.stringify({ errcode: 310000, errmsg: 'keywords not in content' }), { status: 200 });
    }
    return new Response('<a href="/cosmetic-rule">化妆品安全评估技术导则征求意见</a>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
  };

  try {
    await assert.rejects(
      worker.scheduled({}, {
        AI_API_KEY: 'test-key',
        DETAIL_FETCH_ENABLED: '0',
        DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=test',
        DINGTALK_MESSAGE_DELAY_MS: 0,
        AI_MODEL: 'test-model',
        REPORT_PERIOD_START: sampleReport.period.start,
        REPORT_PERIOD_END: sampleReport.period.end,
        SEEN_NEWS: kv,
      }, {}),
      /DingTalk delivery failed/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  const lastRun = JSON.parse(store.get('run:last'));
  assert.equal(dingTalkAttempts, 1);
  assert.equal(lastRun.status, 'failed');
  assert.equal(store.has('seen_v3_report_items'), false);
}

async function testScheduledPipelineRejectsMissingAiKey() {
  const store = new Map();
  const kv = {
    async get(key) { return store.get(key) || null; },
    async put(key, value) { store.set(key, value); },
  };
  await assert.rejects(
    worker.scheduled({}, {
      DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=test',
      SEEN_NEWS: kv,
    }, {}),
    /AI_API_KEY is required/
  );
  assert.equal(JSON.parse(store.get('run:last')).status, 'failed');
}

function testRunLocalPropagatesPipelineFailure() {
  const source = readFileSync(new URL('./run-local.js', import.meta.url), 'utf8');
  assert.ok(source.includes('result = await runPipeline'));
  assert.ok(source.includes("result.status === 'failed'"));
  assert.ok(source.includes('await browserSourceFetcher.close()'));
  assert.equal(source.includes("process.env.DINGTALK_WEBHOOK_URL ? 'DingTalk webhook was called.'"), false);
  assert.ok(source.includes('SOURCE_HYDRATION_JSON: process.env.SOURCE_HYDRATION_JSON'));
  assert.ok(source.includes('SOURCE_HYDRATION_FILE: process.env.SOURCE_HYDRATION_FILE'));
  assert.ok(source.includes('SOURCE_HYDRATION_URL: process.env.SOURCE_HYDRATION_URL'));
}

function testArtifactOnlyModeIsDeliveryFree() {
  assert.equal(isArtifactOnlyRun({ ARTIFACT_ONLY: '1' }), true);
  assert.equal(isArtifactOnlyRun({ ARTIFACT_ONLY: '0' }), false);
  assert.equal(isArtifactOnlyRun({}), false);
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(source, /const artifactOnly = isArtifactOnlyRun\(env\);/);
  assert.match(source, /if \(artifactOnly\)/);
  assert.match(source, /stage: 'artifact-only',\s*status: 'done'/);
  const localSource = readFileSync(new URL('./run-local.js', import.meta.url), 'utf8');
  assert.match(localSource, /ARTIFACT_ONLY: process\.env\.ARTIFACT_ONLY/);
  assert.match(localSource, /SOURCE_ONLY_PROOF_REQUIRED: process\.env\.SOURCE_ONLY_PROOF_REQUIRED/);
}

async function testArtifactOnlyPipelineSkipsDelivery() {
  const originalFetch = globalThis.fetch;
  const writes = [];
  const kv = {
    async get() { return null; },
    async put(key) { writes.push(key); },
  };
  let artifactReady = false;
  globalThis.fetch = async (url) => {
    const href = String(url);
    if (href.includes('oapi.dingtalk.com') || href.includes('open.feishu.cn')) {
      throw new Error('artifact-only attempted delivery');
    }
    if (href.includes('/chat/completions')) {
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sampleReport) } }] }), { status: 200 });
    }
    return new Response('<html><body><a href="/notice">化妆品监管新规</a><p>公开监管正文。公开监管正文。公开监管正文。公开监管正文。公开监管正文。</p></body></html>', { status: 200 });
  };
  try {
    const result = await runPipeline({
      AI_API_KEY: 'test-key',
      AI_MODEL: 'test-model',
      ARTIFACT_ONLY: '1',
      SOURCE_ONLY_PROOF_REQUIRED: '0',
      DETAIL_FETCH_ENABLED: '0',
      DINGTALK_WEBHOOK_URL: 'https://oapi.dingtalk.com/robot/send?access_token=should-not-call',
      FEISHU_WEBHOOK_URL: 'https://open.feishu.cn/test/should-not-call',
      SEEN_NEWS: kv,
      ON_REPORT_READY: async () => { artifactReady = true; },
    });
    assert.equal(result.stage, 'artifact-only');
    assert.equal(result.status, 'done');
    assert.equal(artifactReady, true);
    assert.deepEqual(writes, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
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

  const monitoredSources = sources.filter(source => source.monitor_only);
  assert.ok(monitoredSources.length >= 12);
  assert.ok(monitoredSources.filter(source => source.country === '中国' && source.priority === 'high').length >= 9);
  assert.ok(monitoredSources.every(source => source.monitor_reason && /^\d{4}-\d{2}-\d{2}$/.test(source.monitor_reviewed_at)));
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

function testWeeklyWorkflowRunsLocalReportPipelineWithoutWorkerDeploy() {
  const workflow = readFileSync(new URL('../.github/workflows/weekly.yml', import.meta.url), 'utf8');
  assert.ok(workflow.includes('node worker/run-local.js'));
  assert.equal(workflow.includes('node run-local.js'), false);
  assert.ok(workflow.includes("cron: '17 0 * * 1'"));
  assert.equal(workflow.includes("cron: '52 23 * * 0'"), false);
  assert.equal(workflow.includes('npx wrangler deploy'), false);
  assert.equal(workflow.includes('Deploy worker routes'), false);
  assert.ok(workflow.includes('vars.AI_API_BASE_URL'));
  assert.ok(workflow.includes('vars.AI_MODEL'));
  assert.ok(workflow.includes("MIN_CHINA_CRITICAL_COVERAGE || '0.9'"));
  assert.ok(workflow.includes('npx playwright install --with-deps chromium'));
  assert.ok(workflow.includes('actions/setup-python@v5'));
  assert.ok(workflow.includes('python -m pip install crawl4ai'));
  assert.ok(workflow.includes('SOURCE_HYDRATION_FILE: out/hydrated-authority.json'));
  assert.ok(workflow.includes('node scripts/crawl4ai-hydrate.js'));
  assert.ok(workflow.indexOf('node scripts/crawl4ai-hydrate.js') < workflow.indexOf('node worker/run-local.js'));
  assert.ok(workflow.includes('DETAIL_FETCH_ENABLED: 1'));
  assert.ok(workflow.includes('DETAIL_CANDIDATE_LIMIT: 48'));
  assert.ok(workflow.includes('REPORT_TARGET_ITEMS: 8'));
  assert.ok(workflow.includes('fonts-noto-cjk'));
  assert.ok(workflow.includes('node worker/probe-ai.js'));
  assert.ok(workflow.indexOf('node worker/probe-ai.js') < workflow.indexOf('node worker/run-local.js'));
  assert.ok(workflow.includes('CLOUDFLARE_KV_NAMESPACE_ID'));
  assert.equal(workflow.includes('wrangler kv key put'), false);
  assert.ok(workflow.includes('DINGTALK_WEBHOOK_URL: ${{ secrets.DINGTALK_WEBHOOK_URL }}'));
  assert.ok(workflow.includes('DINGTALK_SECRET: ${{ secrets.DINGTALK_SECRET }}'));
  assert.ok(workflow.includes("FORCE_DELIVERY: ${{ github.event_name == 'workflow_dispatch' && '1' || '0' }}"));
  for (const documentSetting of [
    'DINGTALK_DOC_URL',
    'DINGTALK_CLIENT_ID',
    'DINGTALK_CLIENT_SECRET',
    'DINGTALK_OPERATOR_ID',
    'DINGTALK_WORKSPACE_ID',
  ]) {
    assert.equal(workflow.includes(documentSetting), false, `workflow should not require ${documentSetting}`);
  }
}

function testDecisionMapPublicUrlCanOverrideWorkerAssetUrl() {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.ok(source.includes('env.DECISION_MAP_PUBLIC_URL || env.DECISION_MAP_URL'));
}

testClassifySourceFetchFailures();
await testRecoverPublicSourceRetriesAndRecordsAttempts();
await testRecoverPublicSourceUsesBrowserThenOfficialAlternate();
testSourceCoverageGatesChinaCriticalAndOverallCoverage();
await testBrowserSourceFetcherReusesBrowserAndClosesPages();
await testBrowserSourceFetcherUsesGovernmentSiteCompatibleNavigation();
await testBrowserSourceFetcherRejectsAccessControlPages();
await testPublishVersionedPngUploadsBeforeHealthCheck();
await testCollectCandidatesReturnsRecoveryEvidenceAndRealCoverage();
await testPipelineSendsNativeMarkdownWithoutImageHooks();
await testPipelineIgnoresLegacyEditorialImageHooks();
await testPipelineNoUpdateSkipsEmptyDashboardPublication();
await testVersionedDecisionMapRouteUsesImmutableCache();
await testFetchWithTimeoutAbortsSlowFetch();
await testManualTestRouteAwaitsPipeline();
await testMapWithConcurrencyLimitsParallelWork();
await testScheduledPipelineSendsFeishuWithoutHtmlReport();
await testScheduledPipelineSendsDingTalkWithoutDocumentCredentials();
await testScheduledPipelineRejectsDingTalkFailureWithoutMarkingSeen();
await testScheduledPipelineRejectsMissingAiKey();
await testManualTestRouteRecordsFailure();
testNormalizeUrl();
testHtmlToText();
testExtractLinks();
testExtractImageUrl();
testExtractArticleTextRemovesPageChromeAndKeepsMetadata();
testExtractArticleTextDoesNotSilentlyTruncateTheOriginalBody();
await testHydrateCandidateDetailsFetchesArticleBodiesWithoutDroppingFailures();
testHydratedRecordsOverrideWeakCandidateText();
testHydratedRecordExtractsHardLegalFactsFromCrawl4AiText();
testHydratedRecordExtractsAttachmentLinksForCrawl4AiSecondHop();
testHydratedRecordMergesAttachmentTextForCrawl4AiSecondHopEvidence();
testHydratedRecordDowngradesEmptyHydratedBody();
await testLoadHydratedRecordsFromEnvReadsFilePayload();
testAuthorityResolverTurnsMediaLeadIntoOfficialSearchQueries();
testAuthorityResolverBuildsSearchTasksFromLeadOnlySources();
testAuthorityResolverClassifiesFinalSourceTrust();
testAuthorityResolverKeepsOnlyAuthorityResolvedCandidates();
await testHydrateCandidateDetailsContainsBrowserRecoveryFailures();
await testHydrateCandidateDetailsRejectsUnsupportedDocumentsAndPageShells();
testGetSourceStats();
testIsRelevantTitle();
testMakeCandidate();
testParseAnalysisJson();
testValidateReport();
testValidateReportRequiresRegulationAnalysis();
testValidateReportRequiresExplicitCoreJudgement();
testValidateReportRejectsAiAssignedInternalDeadlines();
testFilterReportQualityDropsItemsWithoutSourceUrl();
testFilterReportQualityKeepsLeadBasedBeautyAndImportSignals();
testReportQualitySeparatesActionWatchAndRejectedItems();
testReportQualityUsesOriginalEvidenceTitleForBeautyRelevance();
testCurateReportQualityKeepsSixModulesButDropsEmptyDisplaySections();
testCurateReportQualityAuditExplainsRejectedItems();
await testAnalyzeReportWithRecoveryUsesOneRescuePass();
await testAnalyzeReportWithRecoverySupplementsSparseWatchOnlyReport();
await testAnalyzeReportWithRecoveryContinuesBelowEightQualityItems();
await testAnalyzeReportWithRecoveryRejectsTechnicalCollapse();
await testDeepseekRescueAnalyzeUsesObservedCandidateIdentity();
await testDeepseekRescueAnalyzeRejectsIncompleteCandidateDecisions();
testRescueEvidenceCandidatesPreserveModuleDiversity();
testExecutiveSummaryCapsJudgementsAndActionsAtThree();
testExecutiveSummaryAvoidsRepeatedJudgementsAndActions();
testNormalizeReportForValidationFillsDynamicAnalysisFields();
testLimitReportSectionsKeepsEnterpriseModuleDepth();
testLimitReportSectionsAcceptsQualityLimit();
testRenderFeishuSummary();
testRenderDingTalkMarkdownUsesModuleRegionCountryStructure();
testRenderDingTalkMarkdownShowsAllModulesWhenEmpty();
testRenderDingTalkMarkdownLeavesInternalCompletionTimeToLeader();
testRenderDingTalkSummaryCardIsConciseAndIncludesKeyword();
testBuildSingleDingTalkMessageContainsWholeReportInOneCard();
testSingleCardUsesFourTopicFactObservationSourceStructure();
testObjectiveBriefUsesFiveSectionsAndNoAnalysisCopy();
testObjectiveBriefRejectsGenericNonBeautyContent();
testObjectiveBriefDeduplicatesSameEventAcrossSources();
testObjectiveBriefSplitsWithoutOmittingAcceptedItems();
await testModuleMergeDoesNotCapAcceptedItemsAtThree();
testObjectiveBriefDoesNotRecycleCoreJudgementAsFact();
testObjectiveBriefRejectsGenericIngredientContent();
testAdvertisingRulesRouteToLawSectionInsteadOfPenaltySection();
testOrdinaryBeautyCaseInMixedModuleRoutesToNewsBrief();
testPipelineRequiresFullTextByDefaultAndUsesSplitPreview();
testEditorialReportOrdersChinaFirstAndDeduplicatesWithinReport();
testEditorialReportKeepsDifferentItemsFromTheSameSourceHomepage();
testSingleCardDoesNotCapUsefulWatchItemsAtThree();
await testBuildDingTalkWebhookUrlSignsSecret();
await testSendToDingTalkPostsMarkdownPayload();
await testSendDingTalkMessagesRetriesTransientFailuresInOrder();
await testSendDingTalkMessagesThrottlesBetweenSuccessfulSegments();
await testSendDingTalkMessagesStopsAfterTerminalFailure();
await testNotifyReportPrefersDingTalkWhenConfigured();
await testRequestAiChatUsesOpenAiCompatibleBaseUrl();
await testRequestAiChatEnablesHighReasoningForSolModel();
await testRequestAiChatRetriesHeadersTimeout();
testBuildAnalysisPromptUsesConfigurableInputLimits();
testBuildAnalysisPromptRequiresCoreJudgementWithoutInternalDeadlines();
testAnalysisPromptSupportsWatchItemsWithoutForcedModuleFilling();
await testModuleAnalysisFailureReturnsEmptySectionWithoutPlaceholder();
await testDeepseekAnalyzeUsesValidatedEvidenceReview();
await testDeepseekAnalyzeFallsBackWhenEvidenceReviewFails();
await testDeepseekAnalyzeFallsBackWhenEvidenceReviewIsMalformed();
testCheckedInModelDefaultsUseGpt55();
testActiveWorkerDoesNotUseDeprecatedDeepseekCredentials();
await testDingTalkDocumentPublishCreatesAndWritesMarkdown();
await testUploadDingTalkImageReturnsMediaId();
testBuildAnalysisPromptIncludesLeads();
testBuildAnalysisPromptUsesModuleTarget();
await testModuleAnalysisRequiresARecordedDecisionForEveryCandidate();
await testModuleAnalysisFallsBackFromGenericChineseDisplayText();
await testModuleAnalysisRejectsMismatchedForeignTitleAndSourceTranslation();
await testModuleAnalysisKeepsAnchoredChineseTranslationWithoutEveryNumber();
testNormalizeModuleReportForcesTargetWorkbookModule();
testFilterReportToObservedSourcesDropsFabricatedUrls();
testFilterReportToObservedSourcesKeepsCanonicalUrlVariants();
testEmptySingleCardIsExplicitAndNeverShowsDashboard();
testDecisionMapRequiresAtLeastOneActionItem();
testManualForceDeliveryBypassesDuplicateSkip();
testAttachReportImagesUsesObservedCandidateImages();
testEnterprisePromptRequiresGlobalLegalIntelligence();
testCandidateFreshnessAndInfluenceRanking();
testPrioritizeCandidatesForAnalysisPutsChinaEvidenceFirst();
testAnalysisPromptKeepsChinaEvidenceFirst();
testFreshnessGateAcceptsCurrentWeekAndSevenDayBoundary();
testFreshnessGateAllowsOnlyStructuredHistoricalExceptions();
testFreshnessGateDowngradesUnknownDateToWatch();
testDedupeReportRemovesRepeatedItems();
testExtractReportFingerprintsUsesItems();
testSplitSourcesSeparatesWechatLeads();
testSourceLeadCandidateKeepsWeaklyFetchableModulesAnalyzable();
testSourceCatalogUsesWorkbookModulesAndGlobalMarkets();
testSelectSourcesForWorkerBudgetKeepsImportantCoverageUnderLimit();
testPromptIncludesProductQualityRecallModule();
testWeeklyWorkflowRunsLocalReportPipelineWithoutWorkerDeploy();
testDecisionMapPublicUrlCanOverrideWorkerAssetUrl();
testRunLocalPropagatesPipelineFailure();
testArtifactOnlyModeIsDeliveryFree();
await testArtifactOnlyPipelineSkipsDelivery();
testEditorialGateRejectsPromotionalAndServicePages();
testEditorialGateRequiresConcreteFactsButKeepsWatch();
testEditorialGateRejectsRepublisherSourcesEvenWithConcretePenaltyFacts();
testEditorialModuleUsesArticleFactsAndChinaEvidence();
testEditorialGateRunsAfterHydrationBeforeAnalysis();
testSourceOnlyProofRequiresIndependentTwentyTenFour();
testEditorialGateRejectsIntermediaryAndNavigationUrls();
testSourceOnlyAuditRecordsEveryCandidateReason();
testEditorialGateRejectsProductRankingsAndNonBeautyPolicy();
testGoogleRssDiscoveryParsesAndDecodesStructuredData();
testEditorialGateIgnoresPromotionalFooterAfterConcreteLead();
testEditorialGateAcceptsConcreteEnglishRegulatoryEvents();
testEditorialGateAcceptsConcreteCompanyLaunchAndAgreement();
testHydrationKeepsTrustedFeedDateWhenBodyDateIsUnrelated();
testPremiumEvidenceGateRejectsWeakAndKeepsActionableItems();
testPremiumEvidenceGateKeepsOfficialWatchEntriesWithConcreteSignals();
testPremiumEvidenceGateRejectsRepublisherSourceEvenWhenFactsAreHard();
testPremiumSelectionPrioritizesQualityBeforeQuantityAndCoreModules();
testPremiumDingTalkMarkdownUsesCompactEvidenceCardFormat();
testPremiumDingTalkMarkdownDoesNotExposeRiskTierAndSignalType();
testPremiumDingTalkMarkdownKeepsPolicyPlanningObservationNeutral();
testPremiumDingTalkMarkdownDoesNotExposeInternalVoiceOrCrawlerName();
testPremiumDingTalkMarkdownIncludesThreeCoreModulesWhenAvailable();
testPremiumDingTalkMarkdownSurfacesHardFieldsInsideExistingSections();
testWebhookMessagesPreferPremiumCardFormatWhenAvailable();
console.log('worker pure function tests ok');
