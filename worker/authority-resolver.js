const LEAD_SOURCE_TYPES = new Set(['industry_media', 'media', 'wechat_lead', 'wechat_public_account']);
const REPUBLISHER_HOST_PATTERN = /(?:^|\.)((?:sohu|163|sina|qq|toutiao|baijiahao|thepaper|jiemian|36kr)\.com|(?:baijiahao|mp)\.baidu\.com)$/i;
const PRIMARY_AUTHORITY_HOST_PATTERN = /(?:^|\.)((?:gov|gov\.cn|court\.gov\.cn|customs\.gov\.cn|samr\.gov\.cn|nmpa\.gov\.cn|cnipa\.gov\.cn)|(?:europa\.eu|fda\.gov|ftc\.gov|wipo\.int))$/i;
const PRIMARY_AUTHORITY_NAME_PATTERN = /国家市场监督管理总局|市场监督管理局|国家药监局|药品监督管理局|国家知识产权局|海关总署|海关|人民法院|法院|欧盟委员会|FDA|FTC|WIPO|EUIPO/i;

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
      source_name: text(lead.source_name || lead.name),
      module: text(lead.module),
      country: text(lead.country || '中国'),
      trust: classifyAuthorityTrust(lead),
      queries: buildAuthoritySearchQueries(lead),
    }))
    .filter(task => task.trust.level === 'lead_only' && task.queries.length);
}

export function selectAuthorityResolvedCandidates(candidates = []) {
  return (Array.isArray(candidates) ? candidates : [])
    .map(candidate => {
      const trust = classifyAuthorityTrust(candidate);
      return {
        ...candidate,
        authority_trust_level: trust.level,
        authority_trust_reason: trust.reason,
        authority_resolution_status: trust.level === 'primary_authority' || trust.level === 'official_database'
          ? 'resolved'
          : 'unresolved',
      };
    })
    .filter(candidate => candidate.authority_resolution_status === 'resolved');
}
