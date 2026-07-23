const MODULE_ORDER = [
  '新法律法规政策',
  '广告处罚案例',
  '知识产权保护或者侵权',
  '进出口',
  '产品质量/召回与安全风险',
  '美妆动态',
];

const MODULE_ALIAS = {
  '新规及案例动态': '新法律法规政策',
  '广告合规及处罚案例': '广告处罚案例',
  '知识产权动态': '知识产权保护或者侵权',
  '进出口动态': '进出口',
};

const GENERIC_PATTERNS = /建议关注|持续关注|企业应留意|可能产生影响|后续观察|待进一步明确|视情况|适时/i;
const CONCRETE_PATTERNS = /(20\d{2}|发布|公布|通报|处罚|罚款|召回|判决|裁定|征求意见|生效|实施|备案|注册|禁用|限用|进口|出口|海关|监管|法院|委员会|药监|市场监管|快速预警|危险非食品|rapid alert|dangerous non-food|Safety Gate|FDA|FTC|BPOM|MFDS|EUIPO|WIPO|\d+(?:\.\d+)?\s*(?:万|亿|元|美元|欧元|件|批|天|%|％))/i;
const OWNER_PATTERN = /法务|合规|法规|质量|研发|供应链|采购|电商|广告|品牌|市场|知识产权|IP|进出口|关务|注册|备案|产品|渠道|海外|本地团队/;

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeModule(value) {
  const module = text(value);
  return MODULE_ALIAS[module] || module || '美妆动态';
}

function list(value) {
  return (Array.isArray(value) ? value : [value]).map(text).filter(Boolean);
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function isChinaCard(card) {
  return /中国|China|CN|内地|大陆/i.test(text(card.country));
}

function moduleRank(module) {
  const index = MODULE_ORDER.indexOf(normalizeModule(module));
  return index >= 0 ? index : MODULE_ORDER.length;
}

function comparePremiumCards(a, b) {
  const chinaDiff = Number(isChinaCard(b)) - Number(isChinaCard(a));
  if (chinaDiff) return chinaDiff;
  const moduleDiff = moduleRank(a.module) - moduleRank(b.module);
  if (moduleDiff) return moduleDiff;
  return b.score - a.score;
}

function compareSelectionCards(a, b) {
  return b.score - a.score || moduleRank(a.module) - moduleRank(b.module);
}

function scoreCard(card) {
  let score = 0;
  score += Math.max(0, 60 - MODULE_ORDER.indexOf(normalizeModule(card.module)) * 8);
  if (isChinaCard(card)) score += 20;
  if (/gov|gob|europa\.eu|fda\.gov|ftc\.gov|wipo\.int|euipo\.europa\.eu/i.test(text(card.source_url))) score += 30;
  if (/监管|药监|市场监督|市场监管|法院|海关|委员会|总局|FDA|FTC|BPOM|MFDS|EUIPO|WIPO/i.test(text(card.source_name))) score += 25;
  if (/处罚|罚款|召回|判决|裁定|禁用|限用|生效|征求意见|备案|注册|进口|出口|海关/i.test([card.title, card.legal_signal, card.business_impact, card.recommended_action].join(' '))) score += 18;
  if (OWNER_PATTERN.test(text(card.recommended_action))) score += 12;
  return score;
}

export function validatePremiumEvidenceCard(card = {}) {
  const normalized = {
    ...card,
    title: text(card.title),
    module: normalizeModule(card.module),
    source_url: text(card.source_url || card.url),
    source_name: text(card.source_name || card.name),
    published_at: text(card.published_at),
    country: text(card.country || card.region || '未知'),
    facts: list(card.facts),
    legal_signal: text(card.legal_signal),
    business_impact: text(card.business_impact),
    recommended_action: text(card.recommended_action),
  };

  if (!normalized.title) return { accepted: false, reason: 'missing-title', card: normalized };
  if (!isHttpUrl(normalized.source_url)) return { accepted: false, reason: 'missing-source-url', card: normalized };
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(normalized.published_at)) return { accepted: false, reason: 'missing-date', card: normalized };
  if (!normalized.facts.length || !CONCRETE_PATTERNS.test(normalized.facts.join(' '))) {
    return { accepted: false, reason: 'weak-facts', card: normalized };
  }
  if (!normalized.legal_signal || GENERIC_PATTERNS.test(normalized.legal_signal)) {
    return { accepted: false, reason: 'weak-legal-signal', card: normalized };
  }
  if (!normalized.business_impact || GENERIC_PATTERNS.test(normalized.business_impact)) {
    return { accepted: false, reason: 'weak-business-impact', card: normalized };
  }
  if (!normalized.recommended_action || GENERIC_PATTERNS.test(normalized.recommended_action)) {
    return { accepted: false, reason: 'generic-action', card: normalized };
  }
  if (!OWNER_PATTERN.test(normalized.recommended_action)) {
    return { accepted: false, reason: 'missing-owner-action', card: normalized };
  }
  return {
    accepted: true,
    tier: scoreCard(normalized) >= 95 ? 'action' : 'watch',
    score: scoreCard(normalized),
    card: normalized,
  };
}

export function selectPremiumEvidenceCards(cards = [], { maxItems = 8, minItems = 4 } = {}) {
  const accepted = [];
  const seen = new Set();
  for (const input of cards) {
    const decision = validatePremiumEvidenceCard(input);
    if (!decision.accepted) continue;
    const card = decision.card;
    const key = `${card.source_url.toLowerCase()}|${card.title.replace(/\s+/g, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({ ...card, tier: decision.tier, score: decision.score });
  }

  accepted.sort(compareSelectionCards);

  const selected = [];
  for (const preferChina of [true, false]) {
    for (const module of MODULE_ORDER.slice(0, 4)) {
      if (selected.length >= maxItems) break;
      const next = accepted.find(card =>
        card.module === module
        && !selected.includes(card)
        && (!preferChina || isChinaCard(card))
      );
      if (next) selected.push(next);
    }
  }
  for (const card of accepted) {
    if (selected.length >= maxItems) break;
    if (!selected.includes(card)) selected.push(card);
  }
  return selected.slice(0, Math.max(minItems, Math.min(maxItems, selected.length)));
}

function esc(value) {
  return text(value).replace(/\|/g, '\\|');
}

function premiumCardFromItem(item, sectionModule) {
  const module = normalizeModule(item.module || sectionModule);
  return {
    title: text(item.title),
    module,
    source_url: text(item.source_url),
    source_name: text(item.source_name),
    published_at: text(item.published_at),
    country: text(item.country || item.region || '未知'),
    facts: list(item.what_changed || item.facts || item.fact_summary || item.dispute_focus || item.market_access_change || item.regulatory_signal),
    legal_signal: text(item.legal_obligation || item.compliance_meaning || item.violation_logic || item.infringement_logic || item.documents_needed || item.core_judgement),
    business_impact: text(item.affected_business || item.business_impact || item.impact_on_brand_assets || item.affected_import_flow || item.why_it_matters || item.risk_pattern || item.business_lessons || item.penalty_or_result),
    recommended_action: text(item.recommended_actions || item.next_observation || item.possible_follow_up),
  };
}

export function buildPremiumDingTalkMarkdown({ period = {}, cards = [] } = {}) {
  const selected = selectPremiumEvidenceCards(cards, { maxItems: cards.length || 8, minItems: 0 });
  const start = text(period.start);
  const end = text(period.end);
  const lines = [
    `# 美妆法务资讯精品卡${start || end ? `（${start} 至 ${end}）` : ''}`,
    '',
    selected.length
      ? `本期精选 ${selected.length} 条，优先覆盖新法律法规政策、广告处罚案例、知识产权保护或者侵权、进出口。`
      : '本期没有达到精品证据门槛的事项，宁缺毋滥。',
  ];

  let number = 0;
  const modules = [...new Set(selected.map(card => card.module))]
    .sort((a, b) => {
      const aHasChina = selected.some(card => card.module === a && isChinaCard(card));
      const bHasChina = selected.some(card => card.module === b && isChinaCard(card));
      const chinaDiff = Number(bHasChina) - Number(aHasChina);
      if (chinaDiff) return chinaDiff;
      return moduleRank(a) - moduleRank(b);
    });

  for (const module of modules) {
    const items = selected
      .filter(card => card.module === module)
      .sort(comparePremiumCards);
    if (!items.length) continue;
    lines.push('', `## ${module}`);
    for (const card of items) {
      number += 1;
      lines.push(
        '',
        `### ${number}. ${esc(card.title)}`,
        `- **来源**：${esc(card.source_name)} / ${esc(card.country)} / ${esc(card.published_at)} / [原文](${card.source_url})`,
        `- **事实依据**：${esc(card.facts[0])}`,
        `- **法务判断**：${esc(card.legal_signal)}`,
        `- **业务影响**：${esc(card.business_impact)}`,
        `- **建议动作**：${esc(card.recommended_action)}`,
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

export function buildPremiumDingTalkMessages(report, options = {}) {
  const reportCards = (report.sections || []).flatMap(section =>
    (section.items || []).map(item => premiumCardFromItem(item, section.module))
  );
  const cards = cardsForPremiumDelivery(reportCards);
  if (!cards.length) return [];
  return [{
    id: 'weekly-report',
    title: `美妆法务资讯｜${text(report.period?.end || '本期')}`,
    markdown: buildPremiumDingTalkMarkdown({ period: report.period || {}, cards }),
    bytes: 0,
    itemCount: cards.length,
    displayedItemCount: cards.length,
    omittedItemCount: 0,
  }];
}

function cardsForPremiumDelivery(cards) {
  return selectPremiumEvidenceCards(cards, { maxItems: cards.length || 0, minItems: 0 });
}
