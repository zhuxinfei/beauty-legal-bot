import {
  curateReportQuality,
  objectiveFacts,
  objectiveObservation,
  rankReportQualityItem,
} from './report-quality.js';

const DISPLAY_MODULES = [
  '新法律法规政策',
  '广告处罚案例',
  '知识产权保护与侵权',
  '进出口',
  '行业新闻简讯',
];

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function values(...candidates) {
  for (const candidate of candidates) {
    const result = (Array.isArray(candidate) ? candidate : [candidate]).map(text).filter(Boolean);
    if (result.length) return result;
  }
  return [];
}

function preparedReport(report) {
  const items = (report.sections || []).flatMap(section => section.items || []);
  return items.every(item => ['action', 'watch'].includes(item.report_tier) && Number.isFinite(item.quality_score))
    ? report
    : curateReportQuality(report);
}

function normalizedUrl(value) {
  try {
    const url = new URL(String(value || ''));
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^(utm_|spm$|from$|source$|ref$)/i.test(key)) url.searchParams.delete(key);
    }
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return text(value).toLowerCase();
  }
}

function identity(item) {
  const url = normalizedUrl(item.source_url);
  const title = text(item.title).toLowerCase().replace(/[\s，。；：、,.!?！？:;()（）《》]/g, '');
  if (/^https?:\/\//i.test(url)) return `url:${url}|title:${title}`;
  return `title:${title}|${text(item.country || item.region).toLowerCase()}`;
}

function titleBigrams(value) {
  const normalized = text(value)
    .toLowerCase()
    .replace(/20\d{2}[年./-]\d{1,2}(?:[月./-]\d{1,2}日?)?/g, '')
    .replace(/(?:关于|发布|公告|通知|最新|本周|化妆品|美妆|监管)/g, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  return new Set(Array.from({ length: normalized.length - 1 }, (_, index) => normalized.slice(index, index + 2)));
}

function similarity(a, b) {
  const left = titleBigrams(a);
  const right = titleBigrams(b);
  if (!left.size || !right.size) return false;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection += 1;
  return intersection / Math.min(left.size, right.size) >= 0.72;
}

function sameEvent(a, b) {
  if (a._identity === b._identity) return true;
  if (similarity(a.title, b.title)) return true;
  const aFacts = (a.facts || []).join(' ');
  const bFacts = (b.facts || []).join(' ');
  const aTitleTokens = titleBigrams(a.title);
  const bTitleTokens = titleBigrams(b.title);
  let sharedTitleTokens = 0;
  for (const token of aTitleTokens) if (bTitleTokens.has(token)) sharedTitleTokens += 1;
  return sharedTitleTokens >= 2 && aFacts.length >= 18 && bFacts.length >= 18 && similarity(aFacts, bFacts);
}

function displayModule(item) {
  const type = text(item.type);
  const module = text(item.module);
  const evidence = [item.title, objectiveFacts(item)].flat().join(' ');
  if (type === 'IP' || module === '知识产权动态') return '知识产权保护与侵权';
  if (type === '进出口' || module === '进出口动态') return '进出口';
  if (module === '广告合规及处罚案例' && (type === '案例' || /处罚|罚款|责令|没收|违法/.test(evidence))) return '广告处罚案例';
  if (['法规', '征求意见', '生效提醒', '废止', '平台规则'].includes(type)) return '新法律法规政策';
  if ((module === '新规及案例动态' || module === '广告合规及处罚案例') && type !== '案例' && type !== '召回') return '新法律法规政策';
  return '行业新闻简讯';
}

function typeSpecificContent(item) {
  if (item.type === '法规' || item.type === '征求意见' || item.type === '生效提醒' || item.type === '废止') {
    return {
      facts: values(item.what_changed, item.regulatory_signal),
      legal_analysis: values(item.legal_obligation, item.compliance_meaning),
      results: [],
      practical_insights: values(item.affected_business),
      practical_label: '影响范围',
    };
  }
  if (item.type === '案例' || item.type === '召回') {
    return {
      facts: values(item.facts),
      legal_analysis: values(item.violation_logic),
      results: values(item.penalty_or_result),
      practical_insights: values(item.business_lessons),
      practical_label: '业务启示',
    };
  }
  if (item.type === 'IP') {
    return {
      facts: values(item.dispute_focus, item.protected_element),
      legal_analysis: values(item.infringement_logic),
      results: values(item.impact_on_brand_assets),
      practical_insights: values(item.business_lessons),
      practical_label: '品牌资产影响',
    };
  }
  if (item.type === '进出口') {
    return {
      facts: values(item.market_access_change),
      legal_analysis: values(item.documents_needed),
      results: [],
      practical_insights: values(item.affected_import_flow),
      practical_label: '影响流程',
    };
  }
  return {
    facts: values(item.regulatory_signal, item.facts, item.what_changed),
    legal_analysis: values(item.compliance_meaning, item.violation_logic),
    results: values(item.penalty_or_result),
    practical_insights: values(item.possible_follow_up, item.business_lessons),
    practical_label: '后续信号',
  };
}

function editorialItem(item) {
  const facts = objectiveFacts(item);
  const observation = objectiveObservation(item);
  return {
    type: text(item.type || '动态'),
    module: text(item.module),
    title: text(item.title || '未命名事项'),
    country: text(item.country || item.region || '全球'),
    region: text(item.region || '全球'),
    quality_score: Number(item.quality_score || 0),
    facts,
    observation,
    source_name: text(item.source_name || item.title || '来源'),
    source_url: text(item.source_url),
    _displayModule: displayModule(item),
    _rank: rankReportQualityItem(item),
    _identity: identity(item),
  };
}

export function buildEditorialReport(inputReport = {}) {
  const report = preparedReport(inputReport);
  const seen = new Set();
  const acceptedItems = [];
  const items = (report.sections || [])
    .flatMap(section => (section.items || []).map(item => editorialItem({ ...item, module: item.module || section.module })))
    .sort((a, b) => (b.country === '中国') - (a.country === '中国') || b._rank - a._rank)
    .filter(item => {
      if (seen.has(item._identity) || acceptedItems.some(accepted => sameEvent(accepted, item))) return false;
      seen.add(item._identity);
      acceptedItems.push(item);
      return true;
    });

  const sections = DISPLAY_MODULES
    .map((module, moduleIndex) => ({
      module,
      moduleIndex,
      items: items.filter(item => item._displayModule === module),
    }))
    .filter(section => section.items.length)
    .sort((a, b) => {
      const aChina = a.items.some(item => item.country === '中国');
      const bChina = b.items.some(item => item.country === '中国');
      return Number(bChina) - Number(aChina) || a.moduleIndex - b.moduleIndex;
    });

  let number = 0;
  for (const section of sections) {
    section.items.sort((a, b) => (b.country === '中国') - (a.country === '中国') || b._rank - a._rank);
    section.items = section.items.map(item => {
      number += 1;
      const { _rank, _identity, _displayModule, ...publicItem } = item;
      return { ...publicItem, number };
    });
    delete section.moduleIndex;
  }

  return {
    period: report.period || {},
    sections,
    item_count: number,
  };
}
