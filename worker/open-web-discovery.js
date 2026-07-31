import { parseGoogleNewsRss } from './google-rss-discovery.js';

const QUERY_GROUPS = Object.freeze({
  '广告合规及处罚案例': ['化妆品 行政处罚 罚款', '美妆 虚假宣传 直播 处罚'],
  '知识产权动态': ['化妆品 商标 侵权 判决', '美妆 不正当竞争 诉讼'],
  '新规及案例动态': ['化妆品 标准 征求意见 备案', 'cosmetics regulation effective date'],
  '产品质量/召回与安全风险': ['化妆品 召回 不合格 批次', 'cosmetics recall contamination'],
  '进出口动态': ['化妆品 海关 进口 出口 扣留', 'cosmetics customs seizure'],
  '美妆动态': ['美妆 平台规则 品牌 公告', 'beauty ecommerce policy'],
});

const BEAUTY = /化妆品|美妆|护肤|彩妆|香水|防晒|染发|洗护|cosmetic|beauty|skincare/i;
const LEGAL_EVENT = /处罚|罚款|召回|不合格|标准|征求意见|备案|注册|规则|公告|通告|商标|侵权|判决|诉讼|海关|进口|出口|扣留|policy|regulation|recall|penalty|lawsuit|customs/i;
const PROMOTION = /招商|加盟|新品上市|品牌推荐|十大|排行榜|促销|折扣|代购|选购指南/i;

export function buildDiscoveryQueries() {
  return Object.entries(QUERY_GROUPS).flatMap(([module, queries]) => queries.map(query => ({ module, query })));
}

export async function discoverOpenWeb({ period = {}, fetchRss, fetchSecondary, resolveCandidates, maxItems = 120, maxPerHost = 8, maxPerModule = 30 } = {}) {
  const queryRows = buildDiscoveryQueries();
  const raw = [];
  const queryCounts = {};
  const queryResults = await Promise.all(queryRows.map(async row => {
    queryCounts[row.module] = (queryCounts[row.module] || 0) + 1;
    try { return parseGoogleNewsRss(await fetchRss(row.query, row.module), row.module); } catch { return []; }
  }));
  raw.push(...queryResults.flat());
  const resolutionInput = raw.slice(0, Math.min(Math.max(1, maxItems), 120));
  const googleResolved = await resolveCandidates(resolutionInput);
  const secondaryResults = typeof fetchSecondary === 'function'
    ? (await Promise.all(queryRows.map(async row => {
      try { return await fetchSecondary(row.query, row.module); } catch { return []; }
    }))).flat()
    : [];
  const resolved = [...googleResolved, ...secondaryResults];
  const seen = new Set();
  const hostCounts = new Map();
  const moduleCounts = new Map();
  const candidates = [];
  for (const item of resolved) {
    if (item.resolution_status !== 'resolved' || !/^https?:\/\//i.test(item.url) || /news\.google\.com/i.test(item.url)) continue;
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(item.published_at) || item.published_at < period.start || item.published_at > period.end) continue;
    if (!BEAUTY.test(item.title) || !LEGAL_EVENT.test(item.title) || PROMOTION.test(item.title)) continue;
    let host = '';
    try { host = new URL(item.url).hostname.replace(/^www\./, '').toLowerCase(); } catch { continue; }
    if (seen.has(item.url) || (hostCounts.get(host) || 0) >= maxPerHost || (moduleCounts.get(item.module) || 0) >= maxPerModule) continue;
    seen.add(item.url);
    hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
    moduleCounts.set(item.module, (moduleCounts.get(item.module) || 0) + 1);
    candidates.push({
      ...item,
      publisher_host: host,
      source_scope: 'discovered_article',
      source_type: 'discovered_publisher',
      authority_type: 'unclassified',
      discovery_provider: item.discovery_provider || 'google_news_rss',
      country: item.country || '未知',
      region: item.region || '未知',
      priority: 'medium',
      topics: [item.module, '化妆品'],
      name: item.source_name || host,
    });
    if (candidates.length >= maxItems) break;
  }
  return { candidates, audit: { queries: queryRows.length, queriesByModule: queryCounts, raw: raw.length + secondaryResults.length, googleRaw: raw.length, secondaryRaw: secondaryResults.length, resolved: resolved.filter(item => item.resolution_status === 'resolved').length, unique: candidates.length } };
}
