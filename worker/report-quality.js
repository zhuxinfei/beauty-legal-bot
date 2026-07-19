import { classifyFreshness } from './freshness.js';

export const REPORT_MODULES = [
  '广告合规及处罚案例',
  '美妆动态',
  '知识产权动态',
  '新规及案例动态',
  '进出口动态',
  '产品质量/召回与安全风险',
];


const OFFICIAL_SOURCE_TYPES = new Set(['official', 'official_site', 'regulator', 'court', 'database']);
const EMPTY_OBSERVATIONS = ['建议关注', '持续关注', '提高重视', '加强管理', '企业应留意', '可能产生影响'];
const BEAUTY_EVIDENCE = /化妆品|美妆|护肤|彩妆|香水|防晒|洗护|面霜|眼霜|精华液?|面膜|爽肤水|化妆水|卸妆|洁面|洗面奶|口红|唇釉|气垫霜?|粉底液?|粉饼|散粉|睫毛膏|眼影|眼线|眉笔|腮红|染发剂?|烫发|洗发|护发|沐浴|牙膏|功效宣称|cosmetic|beauty|skincare|skin care|sunscreen|eye cream|foundation|lipstick|mascara|hair dye/i;

export function findBeautyEvidenceIndex(value) {
  return String(value || '').search(BEAUTY_EVIDENCE);
}

export function hasBeautyEvidence(value) {
  return findBeautyEvidenceIndex(value) >= 0;
}

function text(value) {
  return Array.isArray(value) ? value.filter(Boolean).join('；') : String(value || '').trim();
}

function isSpecific(value, minimum = 12) {
  const result = text(value);
  return result.length >= minimum && !EMPTY_OBSERVATIONS.some(noise => result === noise);
}

export function objectiveFacts(item = {}) {
  const explicit = (Array.isArray(item.fact_summary) ? item.fact_summary : [item.fact_summary])
    .map(value => String(value || '').trim()).filter(Boolean);
  if (explicit.length) return explicit.slice(0, 2);
  const candidates = [
    item.facts,
    item.what_changed,
    item.penalty_or_result,
    item.market_access_change,
    item.dispute_focus,
    item.regulatory_signal,
  ];
  return candidates.flatMap(value => Array.isArray(value) ? value : (value ? [value] : [])).map(value => String(value).trim()).filter(Boolean).slice(0, 2);
}

export function objectiveObservation(item = {}) {
  const candidates = [item.next_observation, item.next_watch_signal];
  for (const value of candidates) {
    const entries = (Array.isArray(value) ? value : [value]).map(entry => String(entry || '').trim()).filter(Boolean);
    if (entries.length) return entries.slice(0, 1);
  }
  if (item.feedback_deadline && item.feedback_deadline !== '未知') return [`跟踪${item.feedback_deadline}意见反馈截止及后续正式稿。`];
  if (item.effective_date && item.effective_date !== '未知') return [`跟踪 ${item.effective_date} 的生效及配套执行口径。`];
  if (item.next_deadline && item.next_deadline !== '未知') return [`跟踪${item.next_deadline}法定节点及后续公开进展。`];
  return [];
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
  const facts = objectiveFacts(item).join(' ');
  const evidenceExcerpt = String(item.evidence_excerpt || '').trim();
  if (!hasBeautyEvidence(facts)) return 0;
  if (evidenceExcerpt && !hasBeautyEvidence(evidenceExcerpt)) return 0;
  if (item.relevance === 'direct') return 2;
  if (item.relevance === 'indirect' && item.industry_impact !== 'low') return 1;
  return 0;
}

function depthScore(item) {
  const facts = objectiveFacts(item);
  const length = text(facts).length;
  if (facts.length >= 1 && length >= 30) return 2;
  return length >= 16 ? 1 : 0;
}

function preferredTier(item) {
  return item.report_tier === 'watch' || item.source_type === 'industry_media' || item.source_type === 'wechat_lead'
    ? 'watch'
    : 'action';
}

function valueScore(item) {
  const observation = objectiveObservation(item);
  return isSpecific(observation, 12) ? 2 : text(observation).length >= 6 ? 1 : 0;
}

export function classifyReportItem(item, period = {}) {
  const freshness = classifyFreshness(item, period);
  if (!freshness.accepted) {
    return { tier: 'reject', score: 0, dimensions: { evidence: 0, novelty: 0, relevance: 0, depth: 0, value: 0 }, freshness };
  }
  if (freshness.allowedTier === 'watch' && item.report_tier !== 'watch') item = { ...item, report_tier: 'watch' };
  const candidateTier = preferredTier(item);
  const dimensions = {
    evidence: evidenceScore(item),
    novelty: noveltyScore(item, period),
    relevance: relevanceScore(item),
    depth: depthScore(item),
    value: valueScore(item),
  };
  const score = Object.values(dimensions).reduce((sum, value) => sum + value, 0);
  const accepted = candidateTier === 'action'
    ? dimensions.evidence >= 1 && dimensions.relevance >= 1 && dimensions.depth >= 1 && dimensions.value >= 1 && score >= 7
    : candidateTier === 'watch' && dimensions.evidence >= 1 && dimensions.relevance >= 1 && dimensions.depth >= 1 && dimensions.value >= 1 && score >= 6;
  return { tier: accepted ? candidateTier : 'reject', score, dimensions, freshness };
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
    + (OFFICIAL_SOURCE_TYPES.has(item.source_type) ? 100 : 0)
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
          if (classification.freshness?.status) {
            const reason = `freshness:${classification.freshness.status}`;
            audit.reasons[reason] = (audit.reasons[reason] || 0) + 1;
          }
        } else {
          audit.acceptedItems += 1;
        }
        return {
          ...item,
          report_tier: classification.tier,
          quality_score: classification.score,
          fact_summary: objectiveFacts(item),
          next_observation: objectiveObservation(item),
          freshness_status: classification.freshness?.status || item.freshness_status || 'date-unknown',
          freshness_reason: classification.freshness?.reason || item.freshness_reason || '发布时间待核验',
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
