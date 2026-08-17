import { parseGoogleNewsRss } from './google-rss-discovery.js';

const QUERY_GROUPS = Object.freeze({
  '广告合规及处罚案例': [
    '化妆品 行政处罚 虚假宣传 罚款', '美妆 直播 广告 处罚',
    '护肤 功效宣称 市场监管 处罚', '化妆品 电商 刷单 反不正当竞争',
    '化妆品 行政处罚决定书 市场监督管理局 site:gov.cn',
    '化妆品 功效宣称 行政处罚决定书 罚款 site:gov.cn',
    '薇诺娜 处罚 罚款', '珀莱雅 处罚',
    '化妆品 直播带货 虚假宣传 市监局 罚款 2026',
    '化妆品 广告法 处罚 罚款 site:gov.cn',
    '化妆品 直播 专项整治 通报 2026',
    '美妆 广告 极限词 虚假 处罚 通告',
    '化妆品 专项检查 整治 处罚 通告',
    '化妆品 飞行检查 通告 整改',
    '化妆品 核查处置 通告 不合格',
  ],
  '知识产权动态': [
    '化妆品 商标 侵权 判决', '美妆 不正当竞争 诉讼',
    '护肤 包装 装潢 仿冒 处罚', '香水 彩妆 专利 侵权 判决',
    '化妆品 商标 侵权 法院 国家知识产权局 site:gov.cn',
    '化妆品 商标 包装装潢 仿冒 侵权 判决 处罚',
    '化妆品企业 商标权 法院 赔偿', '美妆品牌 知识产权 维权 案',
    '化妆品 驰名商标 跨类 保护 判决',
    '护肤品牌 假冒 商标 刑事 判决',
    '珀莱雅 商标 侵权 案', '贝泰妮 商标 侵权',
    '华熙生物 专利', '上海家化 商标 纠纷',
    '欧莱雅 商标 侵权 中国', '雅诗兰黛 商标 维权',
    '花西子 商标', '完美日记 知识产权',
    '化妆品 商标 无效 宣告 国知局',
    '美妆 品牌 仿冒 山寨 法院 判赔',
    '化妆品 专利 纠纷 判决',
    '化妆品 包装 装潢 不正当竞争 判决',
  ],
  '新规及案例动态': [
    '化妆品 标准 征求意见 备案', '化妆品 法规 办法 公告 实施',
    '化妆品 技术指导原则 发布', 'cosmetics regulation effective date',
    '化妆品 公告 征求意见 site:nmpa.gov.cn',
    '化妆品 安全技术规范 修订 公告',
    '化妆品 新规 实施 通告 2026',
    '化妆品 备案 管理 试点 通告',
    '化妆品 注册 备案 新规 实施 2026',
  ],
  '产品质量/召回与安全风险': [
    '化妆品 召回 不合格 批次', '化妆品 抽检 禁用原料 通告',
    '护肤 彩妆 质量安全 风险 通报', 'cosmetics recall contamination',
    '化妆品 不符合规定 通告 召回 site:gov.cn',
    'cosmetics product safety report recall batch',
    '化妆品 抽检 不合格 通告 site:gov.cn',
    '进口化妆品 检测 不合格 通报',
    '化妆品 抽检 通告 黑龙江',
    '化妆品 抽检 通告 山东 不合格',
    '化妆品 抽检 通告 江苏 浙江',
    '化妆品 抽检 通告 广东 四川',
    '化妆品 抽检 通告 湖南 湖北',
    '化妆品 抽检 通告 陕西 河南',
  ],
  '进出口动态': [
    '化妆品 海关 进口 出口 扣留', '进口化妆品 清关 监管 通知',
    '跨境电商 美妆 海关 政策', 'cosmetics customs seizure import alert',
    '进口 化妆品 海关 公告 site:customs.gov.cn',
    '进口化妆品 海关 公告 清关 退运',
    '跨境电商 零售进口 化妆品 清单 调整',
    '进口化妆品 备案 暂停 注销',
  ],
  '美妆动态': [
    // 电商/平台渠道的法律合规动态（非财经新闻：IPO/破产/并购 一律不采）
    '化妆品 电商 平台 处罚 下架',
    '美妆 直播 带货 违规 处罚',
    '化妆品 网店 虚假宣传 处罚',
    '化妆品 网络销售 质量 抽检 通告',
    '美妆 电商 价格 欺诈 处罚',
    '化妆品 跨境电商 监管 政策',
    '美妆 平台 商家 治理 合规',
    '化妆品 电商 监管 市监局 公告',
    '化妆品 电商 消费 投诉 集中整治',
    '美妆 直播间 违规 通报 平台处罚',
    '化妆品 经营 检查 处罚 化妆品店',
    '化妆品 网售 监管 平台 处罚 通告',
    '杭州 美妆 化妆品 监管 政策 浙江',
    '上海 化妆品 电商 合规 监管',
  ],
});

const BEAUTY = /化妆品|美妆|护肤|彩妆|香水|防晒|染发|洗护|cosmetic|beauty|skincare/i;
const PROMOTION = /招商|加盟|新品上市|品牌推荐|十大|排行榜|促销|折扣|代购|选购指南/i;
const MODULE_EVENT = Object.freeze({
  '广告合规及处罚案例': /处罚|罚款|没收|虚假宣传|广告违法|功效宣称|刷单|反不正当竞争|penalty|fine|advertising/i,
  '知识产权动态': /商标|专利|著作权|侵权|仿冒|包装装潢|不正当竞争|判决|诉讼|赔偿|trademark|patent|infringement|lawsuit/i,
  '新规及案例动态': /法规|办法|条例|标准|征求意见|备案|注册|指导原则|公告|实施|policy|regulation|standard|guidance/i,
  '产品质量/召回与安全风险': /召回|不合格|抽检|检出|禁用|批次|质量安全|风险通报|污染|recall|contamination|safety alert/i,
  '进出口动态': /海关|进口|出口|清关|扣留|退运|通关|跨境|进口预警|customs|import|export|seizure|import alert/i,
  '美妆动态': /平台规则|平台治理|公告|通知|合规|下架|禁售|调整|新规|执法|调查|整改|数据泄露|停产|停业|许可证|电商|网售|网络销售|直播|店铺|商家|质量抽检|不合格|policy|rule|enforcement|investigation|compliance|ecommerce/i,
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

export function buildDiscoveryQueries({ modules } = {}) {
  const selectedModules = Array.isArray(modules) && modules.length ? new Set(modules) : null;
  return Object.entries(QUERY_GROUPS)
    .filter(([module]) => !selectedModules || selectedModules.has(module))
    .flatMap(([module, queries]) => queries.map(query => ({
    module,
    query,
    beautyScoped: true,
  })));
}

export async function discoverOpenWeb({ period = {}, queryRows = buildDiscoveryQueries(), fetchRss, fetchSecondary, resolveCandidates, maxItems = 120, maxPerHost = 8, maxPerModule = 30 } = {}) {
  const raw = [];
  const queryCounts = {};
  const rawByModule = {};
  const queryErrors = [];
  const queryResults = await Promise.all(queryRows.map(async row => {
    increment(queryCounts, row.module);
    try {
      const items = parseGoogleNewsRss(await fetchRss(row.query, row.module), row.module).map(item => ({
        ...item,
        discovery_query: row.query,
        discovery_module: row.module,
        discovery_beauty_scoped: row.beautyScoped !== false,
      }));
      increment(rawByModule, row.module, items.length);
      return items;
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
  raw.push(...queryResults.flat());
  const resolutionInput = takeBalancedByModule(raw, Math.min(Math.max(1, maxItems), 120));
  const googleResolved = await resolveCandidates(resolutionInput);
  const secondaryResults = typeof fetchSecondary === 'function'
    ? (await Promise.all(queryRows.map(async row => {
      try {
        const items = await fetchSecondary(row.query, row.module);
        increment(rawByModule, row.module, items.length);
        return items.map(item => ({
          ...item,
          module: item.module || row.module,
          discovery_query: row.query,
          discovery_module: row.module,
          discovery_beauty_scoped: row.beautyScoped !== false,
        }));
      } catch (_error) {
        // GDELT is frequently unavailable; silently skip
        return [];
      }
    }))).flat()
    : [];
  const resolved = [...googleResolved, ...secondaryResults];
  const resolvedByModule = {};
  for (const item of resolved) {
    if (item.resolution_status === 'resolved') increment(resolvedByModule, item.discovery_module || item.module);
  }
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
  return {
    candidates,
    audit: {
      queries: queryRows.length,
      queriesByModule: queryCounts,
      raw: raw.length + secondaryResults.length,
      rawByModule,
      googleRaw: raw.length,
      secondaryRaw: secondaryResults.length,
      resolved: resolved.filter(item => item.resolution_status === 'resolved').length,
      resolvedByModule,
      unique: candidates.length,
      acceptedByModule,
      queryErrors,
      rejectionReasons,
      rejectionReasonsByModule,
      rejections,
    },
  };
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
