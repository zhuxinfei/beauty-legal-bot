const LEAD_HOST = /(?:sohu|163|sina|qq|toutiao|baijiahao|mp\.baidu)\.com$/i;
const PRIMARY_HOST = /(?:gov\.cn|court\.gov\.cn|customs\.gov\.cn|fda\.gov|ftc\.gov|europa\.eu|gov\.uk|wipo\.int)$/i;

function text(value) { return String(value || '').replace(/\s+/g, ' ').trim(); }
function hostOf(candidate) {
  if (candidate.publisher_host) return text(candidate.publisher_host).replace(/^www\./, '').toLowerCase();
  try { return new URL(candidate.final_url || candidate.url || candidate.source_url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}
function values(value) { return (Array.isArray(value) ? value : [value]).map(text).filter(Boolean); }
function normalized(value) { return text(value).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, ''); }
function eventOutcomes(value) {
  const source = normalized(value);
  const outcomes = [];
  if (/(?:上市申请(?:状态)?(?:变更为)?失效|ipo申请失效|招股书失效)/u.test(source)) outcomes.push('上市申请失效');
  if (/(?:挂牌上市|登陆(?:北交所|上交所|深交所|港交所))/u.test(source)) outcomes.push('挂牌上市');
  return outcomes;
}

export function classifyEvidenceSource(candidate = {}) {
  const host = hostOf(candidate);
  const sourceType = text(candidate.source_type);
  const authorityType = text(candidate.authority_type);
  const name = text(candidate.source_name || candidate.name);
  if (LEAD_HOST.test(host) || /转载|公众号|聚合/.test(name) || ['wechat_public_account', 'wechat_lead'].includes(sourceType)) return { tier: 'lead_only', host };
  if (PRIMARY_HOST.test(host) || authorityType === 'regulator' || ['official_site', 'regulator', 'court', 'official_database'].includes(sourceType)) return { tier: 'primary', host };
  if (/平台规则|品牌公告|召回公告|投资者关系/.test(name) || ['platform_official', 'company_official'].includes(sourceType)) return { tier: 'first_party', host };
  return { tier: 'secondary', host };
}

export function extractEventAnchors(candidate = {}) {
  const hard = candidate.hard_facts || {};
  const source = text([candidate.title, candidate.article_text, candidate.snippet].filter(Boolean).join(' '));
  const matches = pattern => [...source.matchAll(pattern)].map(match => text(match[1] || match[0]));
  return {
    parties: values(hard.involved_party).flatMap(value => value.split(/[、,，]/)).filter(Boolean),
    document_numbers: values(hard.document_number).length ? values(hard.document_number) : matches(/(?:[\u4e00-\u9fa5A-Za-z]{0,12}〔20\d{2}〕\d+号|20\d{2}年第\d+号)/g),
    amounts: values(hard.penalty_amount).length ? values(hard.penalty_amount) : matches(/\d+(?:\.\d+)?\s*(?:万|亿)?元/g),
    products_or_batches: values(hard.product_or_batch),
    dates: values([
      candidate.published_at,
      hard.effective_date,
      hard.deadline,
      ...matches(/20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?/g),
    ]).flat(),
    dispositions: values(hard.confiscation_result),
    event_outcomes: eventOutcomes(source),
  };
}

function anchorMap(candidate) {
  const anchors = extractEventAnchors(candidate);
  return new Map(Object.entries(anchors).map(([key, rows]) => [key, new Set(rows.map(normalized).filter(Boolean))]));
}
function partyCore(value) {
  return value.replace(/(?:有限责任公司|股份有限公司|有限公司|公司)$/u, '');
}
function hasDistinctivePartyOverlap(left, right) {
  const a = partyCore(left); const b = partyCore(right);
  if (a.length >= 4 && b.length >= 4 && (a.includes(b) || b.includes(a))) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  for (let index = 0; index <= shorter.length - 8; index += 1) {
    const segment = shorter.slice(index, index + 8);
    const distinctive = segment.replace(/(?:化妆品|母公司|主体|品牌|公司|股份|有限)/gu, '');
    if (distinctive.length >= 4 && longer.includes(segment)) return true;
  }
  return false;
}
function matchedAnchorKinds(left, right) {
  const a = anchorMap(left); const b = anchorMap(right); const matched = [];
  for (const [kind, rows] of a) {
    const other = b.get(kind) || new Set();
    const hasMatch = [...rows].some(value => [...other].some(candidate => (
      value === candidate
      || (kind === 'parties' && hasDistinctivePartyOverlap(value, candidate))
      || (kind === 'products_or_batches'
        && value.length >= 4 && candidate.length >= 4
        && (value.includes(candidate) || candidate.includes(value)))
    )));
    if (hasMatch) matched.push(kind);
  }
  return matched;
}
function isSameEvent(left, right) {
  const kinds = matchedAnchorKinds(left, right);
  const leftParties = anchorMap(left).get('parties'); const rightParties = anchorMap(right).get('parties');
  if (leftParties?.size && rightParties?.size && !kinds.includes('parties')) return false;
  return kinds.includes('document_numbers') || kinds.length >= 2;
}

export function hasVerifiedCorroboration(candidate = {}) {
  return candidate.evidence_grade === 'corroborated_fact_ready'
    && candidate.verification_status === 'corroborated'
    && Array.isArray(candidate.supporting_sources) && candidate.supporting_sources.length >= 2
    && Array.isArray(candidate.agreed_anchors) && candidate.agreed_anchors.length >= 2;
}

export function corroborateEvidenceCandidates(records = []) {
  const groups = [];
  for (const record of records) {
    const group = groups.find(rows => rows.some(item => isSameEvent(item, record)));
    if (group) group.push(record); else groups.push([record]);
  }
  const candidates = [];
  const packages = groups.map((group, index) => {
    const ranked = [...group].sort((a, b) => ['primary', 'first_party', 'secondary', 'lead_only'].indexOf(classifyEvidenceSource(a).tier) - ['primary', 'first_party', 'secondary', 'lead_only'].indexOf(classifyEvidenceSource(b).tier));
    const primary = ranked.find(item => ['primary', 'first_party'].includes(classifyEvidenceSource(item).tier) && item.evidence_grade === 'hard_fact_ready');
    const independent = ranked.filter((item, position, rows) => {
      if (classifyEvidenceSource(item).tier === 'lead_only') return false;
      const signature = normalized(item.article_text || item.snippet).slice(0, 500);
      return rows.findIndex(other => classifyEvidenceSource(other).host === classifyEvidenceSource(item).host) === position
        && (!signature || rows.findIndex(other => normalized(other.article_text || other.snippet).slice(0, 500) === signature) === position);
    });
    const agreement = independent.length >= 2 ? matchedAnchorKinds(independent[0], independent[1]) : [];
    const conflicts = [];
    if (independent.length >= 2) {
      const left = anchorMap(independent[0]); const right = anchorMap(independent[1]);
      for (const kind of ['document_numbers', 'amounts']) {
        const a = left.get(kind); const b = right.get(kind);
        if (a?.size && b?.size && ![...a].some(value => b.has(value))) conflicts.push(kind);
      }
    }
    const corroborated = independent.length >= 2 && !conflicts.length && agreement.length >= 2 && agreement.some(kind => ['parties', 'document_numbers', 'amounts', 'products_or_batches', 'dates', 'dispositions'].includes(kind));
    const canonical = { ...(primary || independent[0] || ranked[0]) };
    const status = primary ? 'primary_verified' : corroborated ? 'corroborated' : 'unverified';
    const grade = primary ? 'hard_fact_ready' : corroborated ? 'corroborated_fact_ready' : 'lead_only';
    const supporting = independent.map(item => ({ url: item.final_url || item.url || item.source_url, host: classifyEvidenceSource(item).host, tier: classifyEvidenceSource(item).tier, matched_anchors: agreement }));
    const packageRow = { event_id: `event-${index + 1}`, verification_status: status, evidence_grade: grade, canonical_record: canonical, supporting_sources: supporting, agreed_anchors: agreement, conflicts };
    if (grade !== 'lead_only') candidates.push({ ...canonical, evidence_grade: grade, verification_status: status, supporting_sources: supporting, agreed_anchors: agreement, event_id: packageRow.event_id });
    return packageRow;
  });
  return { candidates, packages, audit: { records: records.length, events: groups.length, primaryVerified: packages.filter(row => row.verification_status === 'primary_verified').length, corroborated: packages.filter(row => row.verification_status === 'corroborated').length, unverified: packages.filter(row => row.verification_status === 'unverified').length } };
}
