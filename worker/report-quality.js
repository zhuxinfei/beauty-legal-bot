export const REPORT_MODULES = [
  '广告合规及处罚案例',
  '美妆动态',
  '知识产权动态',
  '新规及案例动态',
  '进出口动态',
  '产品质量/召回与安全风险',
];

const OFFICIAL_SOURCE_TYPES = new Set(['official', 'official_site', 'regulator', 'court', 'database']);
const EMPTY_ACTIONS = ['建议关注', '持续关注', '提高重视', '加强管理', '企业应留意', '可能产生影响'];

function text(value) {
  return Array.isArray(value) ? value.filter(Boolean).join('；') : String(value || '').trim();
}

function isSpecific(value, minimum = 12) {
  const result = text(value);
  return result.length >= minimum && !EMPTY_ACTIONS.some(noise => result === noise || result.includes(noise));
}

function evidenceScore(item) {
  if (!/^https?:\/\//i.test(String(item.source_url || '').trim())) return 0;
  if (OFFICIAL_SOURCE_TYPES.has(item.source_type) && item.confidence === 'high') return 2;
  return item.confidence === 'low' ? 0 : 1;
}

function noveltyScore(item, period) {
  const publishedAt = String(item.published_at || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedAt)) return 1;
  const published = Date.parse(`${publishedAt}T00:00:00Z`);
  const end = Date.parse(`${period?.end || publishedAt}T23:59:59Z`);
  const ageDays = Math.floor((end - published) / 86400000);
  if (ageDays >= 0 && ageDays <= 7) return 2;
  if (ageDays >= 0 && ageDays <= 30) return 1;
  return ['法规', '征求意见', '生效提醒', '案例', '召回'].includes(item.type) ? 1 : 0;
}

function relevanceScore(item) {
  const hasScope = text(item.business_impact).length > 0 && text(item.market_scope).length > 0;
  if (item.relevance === 'direct' && hasScope) return 2;
  return hasScope ? 1 : 0;
}

function depthScore(item) {
  const judgement = text(item.core_judgement);
  if (judgement.length >= 45 && isSpecific(item.why_it_matters, 18)) return 2;
  return judgement.length >= 24 ? 1 : 0;
}

function preferredTier(item) {
  if (item.report_tier === 'watch') {
    return isSpecific(item.watch_value, 18) && isSpecific(item.next_watch_signal, 18) ? 'watch' : 'reject';
  }
  if (isSpecific(item.recommended_actions)) return 'action';
  if (isSpecific(item.watch_value, 18) && isSpecific(item.next_watch_signal, 18)) return 'watch';
  return 'reject';
}

function valueScore(item, tier) {
  if (tier === 'action') return isSpecific(item.recommended_actions) ? 2 : 0;
  if (tier === 'watch') {
    return isSpecific(item.watch_value, 18) && isSpecific(item.next_watch_signal, 18) ? 2 : 0;
  }
  return 0;
}

export function classifyReportItem(item, period = {}) {
  const candidateTier = preferredTier(item);
  const dimensions = {
    evidence: evidenceScore(item),
    novelty: noveltyScore(item, period),
    relevance: relevanceScore(item),
    depth: depthScore(item),
    value: valueScore(item, candidateTier),
  };
  const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  const accepted = candidateTier === 'action'
    ? dimensions.evidence === 2 && score >= 8
    : candidateTier === 'watch' && dimensions.evidence >= 1 && score >= 7;
  return { tier: accepted ? candidateTier : 'reject', score, dimensions };
}

function rejectedDimensions(classification) {
  if (classification.tier !== 'reject') return [];
  const reasons = [];
  if (classification.dimensions.evidence < 1) reasons.push('evidence');
  if (classification.dimensions.relevance < 1) reasons.push('relevance');
  if (classification.dimensions.depth < 1) reasons.push('depth');
  if (classification.dimensions.value < 1) reasons.push('value');
  if (!reasons.length) reasons.push('score');
  return reasons;
}

export function rankReportQualityItem(item) {
  return (item.country === '中国' ? 1000 : 0)
    + Number(item.quality_score || 0) * 20
    + (item.risk_level === 'high' ? 100 : item.risk_level === 'medium' ? 50 : 0)
    + (item.relevance === 'direct' ? 20 : 0);
}

export function curateReportQualityWithAudit(report) {
  const audit = {
    inputItems: 0,
    acceptedItems: 0,
    rejectedItems: 0,
    reasons: {},
  };
  const sections = REPORT_MODULES.map(module => {
    const source = (report.sections || []).find(section => section.module === module);
    const items = (source?.items || [])
      .map(item => {
        const classification = classifyReportItem(item, report.period);
        audit.inputItems += 1;
        if (classification.tier === 'reject') {
          audit.rejectedItems += 1;
          for (const reason of rejectedDimensions(classification)) {
            audit.reasons[reason] = (audit.reasons[reason] || 0) + 1;
          }
        } else {
          audit.acceptedItems += 1;
        }
        return {
          ...item,
          report_tier: classification.tier,
          quality_score: classification.score,
        };
      })
      .filter(item => item.report_tier !== 'reject')
      .sort((a, b) => rankReportQualityItem(b) - rankReportQualityItem(a));
    return { module, items };
  });
  const curated = {
    ...report,
    sections,
    display_sections: sections.filter(section => section.items.some(item => item.report_tier === 'action')),
  };
  return { report: curated, audit };
}

export function curateReportQuality(report) {
  return curateReportQualityWithAudit(report).report;
}

function uniqueItems(items, valueForItem) {
  const seen = new Set();
  return items.filter(item => {
    const key = String(valueForItem(item) || '')
      .toLowerCase()
      .replace(/[\s，。；：、,.!?！？:;()（）《》]/g, '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function summarizeExecutiveReport(report) {
  const items = (report.sections || [])
    .flatMap(section => section.items || [])
    .sort((a, b) => rankReportQualityItem(b) - rankReportQualityItem(a));
  const actionItems = items.filter(item => item.report_tier === 'action');
  const watchItems = items.filter(item => item.report_tier === 'watch');
  const judgementItems = uniqueItems(actionItems, item => item.core_judgement).slice(0, 3);
  const priorityItems = uniqueItems(actionItems, item => (item.recommended_actions || []).find(Boolean)).slice(0, 3);
  return {
    judgements: judgementItems.map(item => ({
      title: item.title,
      text: item.core_judgement,
      source_url: item.source_url,
    })),
    actions: priorityItems.map(item => ({
      title: item.title,
      text: (item.recommended_actions || []).find(Boolean) || '',
      owners: (item.owner_teams || []).filter(Boolean).slice(0, 2),
      risk_level: item.risk_level,
      source_name: item.source_name,
      source_url: item.source_url,
    })),
    watch: watchItems.slice(0, 3),
  };
}
