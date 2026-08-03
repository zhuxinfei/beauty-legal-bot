const LEAD_SOURCE_TYPES = new Set(['industry_media', 'media', 'wechat_lead', 'wechat_public_account']);
const REPUBLISHER_HOST_PATTERN = /(?:^|\.)((?:sohu|163|sina|qq|toutiao|baijiahao|thepaper|jiemian|36kr)\.com|(?:baijiahao|mp)\.baidu\.com)$/i;
const PRIMARY_AUTHORITY_HOST_PATTERN = /(?:^|\.)((?:gov|gov\.cn|court\.gov\.cn|customs\.gov\.cn|samr\.gov\.cn|nmpa\.gov\.cn|cnipa\.gov\.cn)|(?:europa\.eu|fda\.gov|ftc\.gov|wipo\.int))$/i;
const PRIMARY_AUTHORITY_NAME_PATTERN = /国家市场监督管理总局|市场监督管理局|国家药监局|药品监督管理局|国家知识产权局|海关总署|海关|人民法院|法院|欧盟委员会|FDA|FTC|WIPO|EUIPO/i;
const FIRST_PARTY_RULE_HOST_PATTERN = /(?:^|\.)(?:rulechannel\.taobao\.com|rules\.tmall\.com|rule\.jd\.com|school\.jinritemai\.com|rules-center\.meituan\.com|open\.xiaohongshu\.com)$/i;
const FIRST_PARTY_NAME_PATTERN = /淘宝规则|天猫规则|京东规则|抖音电商|快手电商|小红书开放平台|平台规则中心/i;
const MODULE_AUTHORITY_ANCHORS = Object.freeze({
  '广告合规及处罚案例': '行政处罚决定书 化妆品 市场监督管理局 site:gov.cn',
  '知识产权动态': '化妆品 商标 侵权 判决 国家知识产权局 法院 site:gov.cn',
  '新规及案例动态': '化妆品 公告 征求意见 国家药监局 site:gov.cn',
  '产品质量/召回与安全风险': '化妆品 不符合规定 召回 通告 药品监督管理局 site:gov.cn',
  '进出口动态': '进口 化妆品 海关 公告 site:customs.gov.cn',
  '美妆动态': '美妆 化妆品 商家 平台规则 公告 淘宝 天猫 京东 抖音电商',
});

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function hostOf(value) {
  try {
    return new URL(String(value || '')).hostname;
  } catch {
    return '';
  }
}

function tokensFromLead(lead = {}) {
  const source = `${text(lead.title)} ${text(lead.snippet)} ${text(lead.article_text)}`;
  const tokens = [
    ...Array.from(source.matchAll(/[A-Z][A-Z0-9-]{2,}/g)).map(match => match[0]),
    ...Array.from(source.matchAll(/[\u4e00-\u9fa5A-Za-z0-9-]{2,}(?:商标|标准|办法|征求意见稿|行政处罚|刷单|爱马仕|玻色因|化妆品)/g)).map(match => match[0]),
    ...Array.from(source.matchAll(/\d+(?:\.\d+)?\s*(?:万|亿)?元|\d+(?:,\d{3})*\s*(?:盒|件|单)/g)).map(match => match[0]),
  ];
  return [...new Set(tokens.map(text).filter(Boolean))].slice(0, 10);
}

export function classifyAuthorityTrust(candidate = {}) {
  const sourceType = text(candidate.source_type);
  const authorityType = text(candidate.authority_type);
  const sourceName = text(candidate.source_name || candidate.name);
  const host = hostOf(candidate.url || candidate.source_url);
  if (
    REPUBLISHER_HOST_PATTERN.test(host)
    || LEAD_SOURCE_TYPES.has(sourceType)
    || authorityType === 'media'
    || /搜狐|转载|综合自|公众号|行业媒体/.test(sourceName)
  ) {
    return { level: 'lead_only', reason: 'media-or-republisher' };
  }
  if (
    authorityType === 'regulator'
    || ['official_site', 'regulator', 'court', 'official'].includes(sourceType)
    || PRIMARY_AUTHORITY_HOST_PATTERN.test(host)
    || PRIMARY_AUTHORITY_NAME_PATTERN.test(sourceName)
  ) {
    return { level: 'primary_authority', reason: 'official-authority' };
  }
  if (FIRST_PARTY_RULE_HOST_PATTERN.test(host) || FIRST_PARTY_NAME_PATTERN.test(sourceName)) {
    return { level: 'official_first_party', reason: 'official-platform-rule' };
  }
  if (sourceType === 'discovered_publisher' || candidate.source_scope === 'discovered_article') {
    return { level: 'lead_only', reason: 'unverified-discovered-publisher' };
  }
  if (/数据库|公示|信用中国|裁判文书|处罚|公告/.test(sourceName)) {
    return { level: 'official_database', reason: 'official-database' };
  }
  return { level: 'unknown', reason: 'unclassified-source' };
}

export function buildAuthoritySearchQueries(lead = {}) {
  const title = text(lead.title || lead.name);
  const tokens = tokensFromLead(lead);
  const core = [title, ...tokens].filter(Boolean).join(' ');
  const anchors = [];
  const moduleAnchor = MODULE_AUTHORITY_ANCHORS[text(lead.module || lead.discovery_module)];
  if (moduleAnchor) anchors.push(moduleAnchor);
  if (/处罚|罚款|刷单|违法|侵权|商标/i.test(core)) {
    anchors.push('行政处罚决定书 市场监督管理局 site:gov.cn');
  }
  if (/标准|办法|征求意见|法规|规定|公告/i.test(core)) {
    anchors.push('征求意见稿 国家药监局 国家市场监督管理总局 site:gov.cn');
  }
  if (/海关|进口|出口|HS\s*编码|清关|报关/i.test(core)) {
    anchors.push('海关总署 进口化妆品 公告 site:customs.gov.cn');
  }
  if (!anchors.length) anchors.push('化妆品 监管 公告 site:gov.cn');
  return [...new Set(anchors.map(anchor => `${core} ${anchor}`.replace(/\s+/g, ' ').trim()))];
}

export function buildAuthoritySearchTasks(leads = []) {
  return (Array.isArray(leads) ? leads : [])
    .map(lead => ({
      title: text(lead.title || lead.name),
      url: text(lead.url || lead.source_url),
      source_name: text(lead.source_name || lead.name),
      module: text(lead.module),
      country: text(lead.country || '中国'),
      trust: classifyAuthorityTrust(lead),
      queries: buildAuthoritySearchQueries(lead),
    }))
    .filter(task => task.trust.level === 'lead_only' && task.queries.length);
}

export function buildAuthoritySearchRows(leads = [], limit = 24) {
  const maximum = Math.max(0, Number(limit) || 0);
  const moduleRows = Object.entries(MODULE_AUTHORITY_ANCHORS).map(([module, query]) => ({
    module,
    query,
    beautyScoped: true,
    authorityResolution: true,
    authorityTaskId: `module:${module}`,
    authorityLeadUrl: '',
    authorityLeadTitle: '',
  }));
  const leadTasks = buildAuthoritySearchTasks(leads);
  if (maximum < moduleRows.length && leadTasks.length) {
    return leadTasks.slice(0, maximum).flatMap((task, index) => task.queries.slice(0, 1).map(query => ({
      module: task.module,
      query,
      beautyScoped: true,
      authorityResolution: true,
      authorityTaskId: `${index}:${task.title}`,
      authorityLeadUrl: task.url,
      authorityLeadTitle: task.title,
    })));
  }
  const moduleBudget = Math.min(moduleRows.length, maximum);
  const leadBudget = Math.max(0, maximum - moduleBudget);
  const tasks = leadTasks.slice(0, leadBudget);
  const leadRows = tasks.flatMap((task, index) => task.queries.slice(0, 1).map(query => ({
    module: task.module,
    query,
    beautyScoped: true,
    authorityResolution: true,
    authorityTaskId: `${index}:${task.title}`,
    authorityLeadUrl: task.url,
    authorityLeadTitle: task.title,
  })));
  return [...leadRows, ...moduleRows.slice(0, moduleBudget)];
}

export function attachAuthorityResolutionProvenance(candidates = [], rows = []) {
  const byQuery = new Map(rows.map(row => [text(row.query), row]));
  return selectAuthorityResolvedCandidates(candidates).map(candidate => {
    const row = byQuery.get(text(candidate.discovery_query));
    const module = row?.module || candidate.module || candidate.discovery_module || '';
    return {
      ...candidate,
      module,
      discovery_module: module,
      discovery_query: text(candidate.discovery_query),
      authority_resolved: true,
      authority_resolution_status: 'resolved',
      authority_lead_url: text(row?.authorityLeadUrl),
      authority_lead_title: text(row?.authorityLeadTitle),
      source_scope: 'discovered_article',
      source_type: 'official_site',
      authority_type: candidate.authority_trust_level === 'official_first_party' ? 'official' : 'regulator',
      source_name: text(candidate.source_name || candidate.name),
    };
  });
}

export function selectAuthorityResolvedCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => {
      const trust = classifyAuthorityTrust(candidate);
      return {
        ...candidate,
        authority_trust_level: trust.level,
        authority_trust_reason: trust.reason,
        authority_resolution_status: ['primary_authority', 'official_database', 'official_first_party'].includes(trust.level)
          ? 'resolved'
          : 'unresolved',
      };
    })
    .filter(candidate => candidate.authority_resolution_status === 'resolved');
}
