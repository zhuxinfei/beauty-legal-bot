import { parseGoogleNewsRss } from './google-rss-discovery.js';

// 查询词一律两个词。2026-09-11 实测：45 条长查询里 27 条返回 0（60%），
// 换成两个词后 50 条里只有 1 条返回 0（2%）。Google News RSS 对长查询
// 是「全词都要命中」，词一多必然空手而归。
// 选词依据同一轮实测的命中数（总/美妆/美妆+电商），例如：
//   化妆品 电商 46/25/7、化妆品 网店 30/25/5、化妆品 平台 31/26/7、
//   化妆品 假冒 27/25/5、化妆品 处罚 20/11/3、化妆品 虚假宣传 22/15/0。
const QUERY_GROUPS = Object.freeze({
  '广告合规及处罚案例': [
    '化妆品 处罚', '化妆品 虚假宣传', '化妆品 网售', '化妆品 直播', '美妆 罚款',
    // site: 只在 Google News RSS 上生效（GDELT 要用 domain:），见 queryProviders
    '化妆品 处罚 site:gov.cn', '化妆品 功效宣称 site:gov.cn', '化妆品 广告 site:gov.cn',
  ],
  '知识产权动态': [
    '化妆品 假冒', '化妆品 商标', '化妆品 专利', '美妆 仿冒',
    '化妆品 商标 site:gov.cn',
  ],
  '新规及案例动态': [
    '化妆品 法规', '化妆品 备案', '化妆品 公告', '化妆品 新规',
    '化妆品 征求意见 site:nmpa.gov.cn',
  ],
  '产品质量/召回与安全风险': [
    '化妆品 通报', '化妆品 不合格', '化妆品 召回', '化妆品 抽检',
    '化妆品 抽检 site:gov.cn', '化妆品 召回 site:gov.cn',
  ],
  '进出口动态': [
    '化妆品 进口', '跨境电商 化妆品', '化妆品 出口', '化妆品 海关',
    '化妆品 海关 site:customs.gov.cn',
  ],
  '美妆动态': [
    // 电商/平台渠道的法律合规动态（非财经新闻：IPO/破产/并购 一律不采）
    '美妆 电商', '化妆品 电商', '化妆品 网店', '化妆品 平台',
    '化妆品 网络销售', '美妆 带货',
  ],
});

const BEAUTY = /化妆品|美妆|护肤|彩妆|香水|防晒|染发|洗护|cosmetic|beauty|skincare/i;
const PROMOTION = /招商|加盟|新品上市|品牌推荐|十大|排行榜|促销|折扣|代购|选购指南/i;
const MODULE_EVENT = Object.freeze({
  // 打假词（假冒/制假/售假/造假）2026-09-11 补：词表原先只有「仿冒」，漏掉本周
  // 最大的一批供给——「化妆品制假售假」系列 20 条全被 missing-module-event 打掉，
  // 知识产权模块因此归零。制假售假同时落在知产（假冒商标）、质量（假货安全）、
  // 电商（网店售假）三类事件里，故三处都补。
  '广告合规及处罚案例': /处罚|罚款|没收|虚假宣传|广告违法|功效宣称|刷单|反不正当竞争|查处|责令|典型案例|行政处罚|制假|售假|假货|penalty|fine|advertising/i,
  '知识产权动态': /商标|专利|著作权|侵权|仿冒|假冒|制假|售假|造假|假货|山寨|包装装潢|不正当竞争|判决|诉讼|赔偿|恶意抢注|地理标志|商业秘密|trademark|patent|infringement|lawsuit/i,
  '新规及案例动态': /法规|办法|条例|标准|征求意见|备案|注册|指导原则|公告|通告|通知|实施|印发|发布|修订|试点|清单|目录|技术要求|检验方法|标签|说明书|policy|regulation|standard|guidance/i,
  '产品质量/召回与安全风险': /召回|不合格|抽检|检出|禁用|批次|质量安全|风险通报|污染|警示|停止经营|约谈|监督抽检|核查|假冒|制假|售假|假货|recall|contamination|safety alert/i,
  '进出口动态': /海关|进口|出口|清关|扣留|退运|通关|跨境|进口预警|报关|原产地|检验检疫|关税|customs|import|export|seizure|import alert/i,
  '美妆动态': /平台规则|平台治理|公告|通知|合规|下架|禁售|调整|新规|执法|调查|整改|数据泄露|停产|停业|许可证|电商|网售|网络销售|直播|店铺|商家|质量抽检|不合格|整治|规范|监管|检查|通报|假冒|制假|售假|假货|policy|rule|enforcement|investigation|compliance|ecommerce/i,
});

function increment(map, key, amount = 1) {
  map[key] = (map[key] || 0) + amount;
}

function hasModuleEvent(item) {
  return (MODULE_EVENT[item.discovery_module || item.module] || /处罚|规则|公告|召回|侵权|海关/i).test(item.title || '');
}

function takeBalancedByModule(items = [], limit = items.length) {
  const groups = new Map();
  for (const item of items) {
    const module = item.discovery_module || item.module || '';
    if (!groups.has(module)) groups.set(module, []);
    groups.get(module).push(item);
  }
  const result = [];
  for (let round = 0; result.length < limit; round += 1) {
    let added = false;
    for (const group of groups.values()) {
      if (group[round] && result.length < limit) {
        result.push(group[round]);
        added = true;
      }
    }
    if (!added) break;
  }
  return result;
}

export const PROVIDER_GOOGLE_NEWS_RSS = 'google_news_rss';
export const PROVIDER_GDELT = 'gdelt';

// GDELT DOC API 已下线（2026-09-11 实测结论）：
//   · 中文关键词永远检索不到——索引里是机器翻译的英文正文；
//   · 英文关键词 + sourcelang:zho + domain: 过滤，14 天窗口只捞回 0–1 条，
//     且唯一命中与美妆无关（「上海睡莲」），因为匹配发生在译文的正文词上；
//   · 限流很硬：7 秒间隔仍被拒（"Please limit requests to one every 5 seconds"），
//     而并发跑正是触发它的原因——旧管线 51 条查询并发打过去必然被罚。
// 通道保留，置 DISCOVERY_ENABLE_GDELT=1 可重新启用（启用后按英文关键词 +
// sourcelang:zho 构造查询，并串行限流）。
const GDELT_ENABLED = /^(?:1|true|yes)$/i.test(String(process.env.DISCOVERY_ENABLE_GDELT || ''));
const GDELT_SOURCE_LANG = process.env.DISCOVERY_GDELT_SOURCELANG || 'zho';
// 中文查询 -> GDELT 英文检索词。GDELT 的 zho 流合并简繁、且夹带内容农场，
// 所以再叠一层大陆域名过滤。
const GDELT_ENGLISH_QUERY = Object.freeze({
  '广告合规及处罚案例': 'cosmetics advertising penalty',
  '知识产权动态': 'cosmetics trademark infringement',
  '新规及案例动态': 'cosmetics regulation',
  '产品质量/召回与安全风险': 'cosmetics recall safety',
  '进出口动态': 'cosmetics import customs',
  '美妆动态': 'cosmetics e-commerce',
});
const GDELT_DOMAIN_FILTER = process.env.DISCOVERY_GDELT_DOMAINS || 'domain:gov.cn';

function queryProviders(query) {
  // site: 只在 Google News RSS 上生效；发给 GDELT 是白跑（那边要用 domain:）。
  if (/site:/i.test(query)) return [PROVIDER_GOOGLE_NEWS_RSS];
  return GDELT_ENABLED ? [PROVIDER_GOOGLE_NEWS_RSS, PROVIDER_GDELT] : [PROVIDER_GOOGLE_NEWS_RSS];
}

export function gdeltQueryFor(row) {
  const english = GDELT_ENGLISH_QUERY[row.module] || 'cosmetics';
  return `${english} ${GDELT_DOMAIN_FILTER} sourcelang:${GDELT_SOURCE_LANG}`;
}

export function buildDiscoveryQueries({ modules } = {}) {
  const selectedModules = Array.isArray(modules) && modules.length ? new Set(modules) : null;
  return Object.entries(QUERY_GROUPS)
    .filter(([module]) => !selectedModules || selectedModules.has(module))
    .flatMap(([module, queries]) => queries.map(query => ({
    module,
    query,
    beautyScoped: true,
    providers: queryProviders(query),
  })));
}

// 分块执行：块与块之间可以被 signal 打断，已完成的结果留在调用方的 accumulator 里。
// 原先所有查询一次性铺开（Promise.all），任何一处超时都会让整轮颗粒无收。
async function forEachChunk(items, size, worker, signal) {
  for (let index = 0; index < items.length; index += size) {
    if (signal?.aborted) return;
    await worker(items.slice(index, index + size));
  }
}

// 候选选择：对「累计已解析」的列表统一做容量裁剪。
// 每解析出一批就整体重跑——上限（host/module/maxItems）只取决于累计集合，
// 因此分块重跑的结果与一次性跑完一致：中断时拿到的是同一套规则下的前缀。
function selectDiscoveredCandidates({ resolved = [], period = {}, maxItems = 120, maxPerHost = 8, maxPerModule = 30 }) {
  const seen = new Set();
  const hostCounts = new Map();
  const moduleCounts = new Map();
  const candidates = [];
  const rejectionReasons = {};
  const rejectionReasonsByModule = {};
  const rejections = [];
  const reject = (item, reason) => {
    const module = item.discovery_module || item.module || '未知模块';
    increment(rejectionReasons, reason);
    rejectionReasonsByModule[module] ||= {};
    increment(rejectionReasonsByModule[module], reason);
    rejections.push({
      title: item.title || '',
      url: item.url || item.discovery_url || '',
      module,
      reason,
    });
  };
  for (const item of resolved) {
    if (item.resolution_status !== 'resolved') {
      reject(item, 'resolution-failed');
      continue;
    }
    if (!/^https?:\/\//i.test(item.url) || /news\.google\.com/i.test(item.url)) {
      reject(item, 'invalid-direct-url');
      continue;
    }
    if (!/^20\d{2}-\d{2}-\d{2}$/.test(item.published_at) || item.published_at < period.start || item.published_at > period.end) {
      reject(item, 'outside-period');
      continue;
    }
    if (PROMOTION.test(item.title)) {
      reject(item, 'promotional-content');
      continue;
    }
    if (!hasModuleEvent(item)) {
      reject(item, 'missing-module-event');
      continue;
    }
    if (!item.discovery_beauty_scoped && !BEAUTY.test(item.title)) {
      reject(item, 'not-beauty-industry');
      continue;
    }
    let host = '';
    try { host = new URL(item.url).hostname.replace(/^www\./, '').toLowerCase(); } catch {
      reject(item, 'invalid-url');
      continue;
    }
    if (seen.has(item.url)) {
      reject(item, 'duplicate-url');
      continue;
    }
    if ((hostCounts.get(host) || 0) >= maxPerHost) {
      reject(item, 'host-capacity');
      continue;
    }
    const module = item.discovery_module || item.module || '';
    if ((moduleCounts.get(module) || 0) >= maxPerModule) {
      reject(item, 'module-capacity');
      continue;
    }
    seen.add(item.url);
    hostCounts.set(host, (hostCounts.get(host) || 0) + 1);
    moduleCounts.set(module, (moduleCounts.get(module) || 0) + 1);
    candidates.push({
      ...item,
      module: item.discovery_module || item.module,
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
  const acceptedByModule = {};
  for (const item of candidates) increment(acceptedByModule, item.discovery_module || item.module);
  return { candidates, rejectionReasons, rejectionReasonsByModule, rejections, acceptedByModule };
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms); });
const GDELT_INTERVAL_MS = Math.max(5000, Number(process.env.DISCOVERY_GDELT_INTERVAL_MS || 6000));
const QUERY_CHUNK_SIZE = Math.max(1, Number(process.env.DISCOVERY_QUERY_CHUNK || 6));
const RESOLVE_CHUNK_SIZE = Math.max(1, Number(process.env.DISCOVERY_RESOLVE_CHUNK || 24));
const EMPTY_SELECTION = Object.freeze({
  candidates: [], acceptedByModule: {}, rejectionReasons: {}, rejectionReasonsByModule: {}, rejections: [],
});

export async function discoverOpenWeb({ period = {}, queryRows = buildDiscoveryQueries(), fetchRss, fetchSecondary, resolveCandidates, maxItems = 120, maxPerHost = 8, maxPerModule = 30, onProgress, signal } = {}) {
  const raw = [];
  const secondaryResults = [];
  const resolved = [];
  const queryCounts = {};
  const rawByModule = {};
  const queryErrors = [];
  let selected = EMPTY_SELECTION;
  // 按 provider 分流：site: 查询只走 Google News RSS，GDELT 默认关闭（见文件头注释）。
  const googleRows = queryRows.filter(row => (row.providers || [PROVIDER_GOOGLE_NEWS_RSS]).includes(PROVIDER_GOOGLE_NEWS_RSS));
  const secondaryRows = queryRows.filter(row => (row.providers || []).includes(PROVIDER_GDELT));

  const snapshot = () => {
    const resolvedByModule = {};
    for (const item of resolved) {
      if (item.resolution_status === 'resolved') increment(resolvedByModule, item.discovery_module || item.module);
    }
    return {
      candidates: selected.candidates,
      audit: {
        queries: queryRows.length,
        queriesByModule: queryCounts,
        raw: raw.length + secondaryResults.length,
        rawByModule,
        googleRaw: raw.length,
        secondaryRaw: secondaryResults.length,
        secondaryProvider: GDELT_ENABLED ? PROVIDER_GDELT : 'disabled',
        googleQueries: googleRows.length,
        secondaryQueries: secondaryRows.length,
        resolved: resolved.filter(item => item.resolution_status === 'resolved').length,
        resolvedByModule,
        unique: selected.candidates.length,
        acceptedByModule: selected.acceptedByModule,
        queryErrors,
        rejectionReasons: selected.rejectionReasons,
        rejectionReasonsByModule: selected.rejectionReasonsByModule,
        rejections: selected.rejections,
      },
    };
  };
  // 每完成一个分块就把当前快照交给调用方；超时中断时调用方手里始终有已完成的部分。
  const emit = () => {
    if (typeof onProgress !== 'function') return;
    try { onProgress(snapshot()); } catch (_error) { /* 进度上报绝不能反过来打断发现流程 */ }
  };

  const collectGoogle = forEachChunk(googleRows, QUERY_CHUNK_SIZE, async chunk => {
    const items = await Promise.all(chunk.map(async row => {
      increment(queryCounts, row.module);
      try {
        const parsed = parseGoogleNewsRss(await fetchRss(row.query, row.module), row.module).map(item => ({
          ...item,
          discovery_query: row.query,
          discovery_module: row.module,
          discovery_beauty_scoped: row.beautyScoped !== false,
        }));
        increment(rawByModule, row.module, parsed.length);
        return parsed;
      } catch (error) {
        queryErrors.push({
          provider: 'google_news_rss',
          module: row.module,
          query: row.query,
          error: String(error?.message || error).slice(0, 240),
        });
        return [];
      }
    }));
    raw.push(...items.flat());
    emit();
  }, signal);

  // 次要供给通道（GDELT）串行 + 限流：GDELT 明确要求 ≥5 秒一次，
  // 并发打过去会被限流罚掉整条通道（旧管线正是并发 51 条）。
  const collectSecondary = typeof fetchSecondary === 'function' && secondaryRows.length
    ? forEachChunk(secondaryRows, 1, async chunk => {
      const row = chunk[0];
      try {
        const fetched = await fetchSecondary(gdeltQueryFor(row), row.module);
        increment(rawByModule, row.module, fetched.length);
        secondaryResults.push(...fetched.map(item => ({
          ...item,
          module: item.module || row.module,
          discovery_query: row.query,
          discovery_module: row.module,
          discovery_beauty_scoped: row.beautyScoped !== false,
        })));
      } catch (_error) {
        // GDELT is frequently unavailable; silently skip
      }
      emit();
      await sleep(GDELT_INTERVAL_MS);
    }, signal)
    : Promise.resolve();

  await Promise.all([collectGoogle, collectSecondary]);

  const resolutionInput = takeBalancedByModule(raw, Math.min(Math.max(1, maxItems), 120));
  await forEachChunk(resolutionInput, RESOLVE_CHUNK_SIZE, async chunk => {
    resolved.push(...await resolveCandidates(chunk));
    selected = selectDiscoveredCandidates({ resolved, period, maxItems, maxPerHost, maxPerModule });
    emit();
  }, signal);

  resolved.push(...secondaryResults);
  selected = selectDiscoveredCandidates({ resolved, period, maxItems, maxPerHost, maxPerModule });
  const final = snapshot();
  emit();
  return { candidates: final.candidates, audit: final.audit };
}

function countCandidatesByModule(candidates = []) {
  const counts = {};
  for (const item of candidates) increment(counts, item.discovery_module || item.module);
  return counts;
}

function expandedPeriod(end, days) {
  const endDate = new Date(`${end}T00:00:00Z`);
  const startDate = new Date(endDate.getTime() - (Math.max(1, days) - 1) * 86400000);
  return { start: startDate.toISOString().slice(0, 10), end };
}

export async function discoverOpenWebWithRecovery({
  period = {},
  queryRows = buildDiscoveryQueries(),
  minimumPerModule = 4,
  recoveryDays = 15,
  runPass,
} = {}) {
  const first = await runPass({ period, queryRows, recovery: false });
  const firstCounts = countCandidatesByModule(first.candidates);
  const recoveryModules = [...new Set(queryRows.map(row => row.module))]
    .filter(module => (firstCounts[module] || 0) < minimumPerModule);
  if (!recoveryModules.length) {
    return { ...first, audit: { ...first.audit, acceptedByModule: firstCounts, recoveryModules: [] } };
  }

  const recoveryRows = queryRows.filter(row => recoveryModules.includes(row.module));
  const recovery = await runPass({
    period: expandedPeriod(period.end, recoveryDays),
    queryRows: recoveryRows,
    recovery: true,
  });
  const seen = new Set();
  const candidates = [...first.candidates, ...recovery.candidates].filter(item => {
    const key = String(item.url || item.discovery_url || '').trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    candidates,
    audit: {
      ...first.audit,
      queries: Number(first.audit?.queries || 0) + Number(recovery.audit?.queries || 0),
      raw: Number(first.audit?.raw || 0) + Number(recovery.audit?.raw || 0),
      resolved: Number(first.audit?.resolved || 0) + Number(recovery.audit?.resolved || 0),
      unique: candidates.length,
      acceptedByModule: countCandidatesByModule(candidates),
      recoveryModules,
      recovery: recovery.audit,
    },
  };
}
