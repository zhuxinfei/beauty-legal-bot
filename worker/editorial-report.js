import {
  REPORT_MODULES,
  curateReportQuality,
  rankReportQualityItem,
  summarizeExecutiveReport,
} from './report-quality.js';

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
  const specific = typeSpecificContent(item);
  return {
    type: text(item.type || '动态'),
    module: text(item.module),
    title: text(item.title || '未命名事项'),
    country: text(item.country || item.region || '全球'),
    region: text(item.region || '全球'),
    risk_level: text(item.risk_level || 'low'),
    report_tier: item.report_tier === 'watch' ? 'watch' : 'action',
    quality_score: Number(item.quality_score || 0),
    summary: text(item.core_judgement || item.why_it_matters || item.title),
    facts: specific.facts,
    legal_analysis: specific.legal_analysis,
    results: specific.results,
    practical_insights: specific.practical_insights,
    practical_label: specific.practical_label,
    why_it_matters: text(item.why_it_matters),
    business_impact: values(item.business_impact, item.affected_business),
    market_scope: values(item.market_scope),
    recommended_actions: values(item.recommended_actions),
    owner_teams: values(item.owner_teams),
    watch_value: text(item.watch_value),
    next_watch_signal: text(item.next_watch_signal),
    statutory_date: text(item.next_deadline || item.effective_date || item.feedback_deadline),
    published_at: text(item.published_at || '未知'),
    source_name: text(item.source_name || item.title || '来源'),
    source_url: text(item.source_url),
    confidence: text(item.confidence || 'medium'),
    _rank: rankReportQualityItem(item),
    _identity: identity(item),
  };
}

export function buildEditorialReport(inputReport = {}) {
  const report = preparedReport(inputReport);
  const seen = new Set();
  const items = (report.sections || [])
    .flatMap(section => (section.items || []).map(item => editorialItem({ ...item, module: item.module || section.module })))
    .sort((a, b) => (b.country === '中国') - (a.country === '中国') || b._rank - a._rank)
    .filter(item => {
      if (seen.has(item._identity)) return false;
      seen.add(item._identity);
      return true;
    });

  const sections = REPORT_MODULES
    .map((module, moduleIndex) => ({
      module,
      moduleIndex,
      items: items.filter(item => item.module === module),
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
      const { _rank, _identity, ...publicItem } = item;
      return { ...publicItem, number };
    });
    delete section.moduleIndex;
  }

  const executive = summarizeExecutiveReport(report);
  const managementConclusions = executive.judgements.map(item => text(item.text)).filter(Boolean).slice(0, 3);
  if (!managementConclusions.length) {
    for (const summary of report.summary || []) {
      if (managementConclusions.length >= 3) break;
      const candidate = text(summary);
      if (candidate && !managementConclusions.includes(candidate)) managementConclusions.push(candidate);
    }
  }

  const publicItems = sections.flatMap(section => section.items);
  const actionTitles = publicItems.filter(item => item.report_tier === 'action').slice(0, 2).map(item => `《${item.title}》`);
  const watchTitles = publicItems.filter(item => item.report_tier === 'watch').slice(0, 2).map(item => `《${item.title}》`);
  const activeModules = sections.slice(0, 3).map(section => section.module).join('、');
  let finalSynthesis = '本期未发现达到准入标准的重大合规更新。';
  if (actionTitles.length) {
    finalSynthesis = `本期法务工作应优先围绕${activeModules}展开，先核验${actionTitles.join('、')}并更新相应审核与证据留存流程；${watchTitles.length ? `同时持续跟踪${watchTitles.join('、')}的正式落地信号；` : ''}具体完成时间由责任领导确定。`;
  } else if (watchTitles.length) {
    finalSynthesis = `本期暂未形成需要立即分派的行动事项，建议围绕${activeModules}持续跟踪${watchTitles.join('、')}的正式规则、监管问答或代表性案例。`;
  }

  return {
    period: report.period || {},
    management_conclusions: managementConclusions,
    sections,
    item_count: number,
    final_synthesis: finalSynthesis,
  };
}
