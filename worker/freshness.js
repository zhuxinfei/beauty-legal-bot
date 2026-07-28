const DAY_MS = 86400000;
const FRESH_DAYS = 14;
const EXCEPTION_HORIZON_DAYS = 90;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CN_DATE = /^(\d{4})[年\/.-](\d{1,2})[月\/.-](\d{1,2})日?$/;

function asDate(value) {
  const text = String(value || '').slice(0, 10);
  if (!ISO_DATE.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
}

function parseLooseDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const iso = asDate(text);
  if (iso) return iso;
  const match = text.match(CN_DATE);
  if (!match) return null;
  const [, year, month, day] = match;
  const normalized = `${year}-${String(Number(month)).padStart(2, '0')}-${String(Number(day)).padStart(2, '0')}`;
  return asDate(normalized);
}

function firstDate(values = []) {
  for (const value of values) {
    const parsed = parseLooseDate(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function referenceTime(period = {}, now = new Date()) {
  return asDate(period.end) ?? Date.parse(new Date(now).toISOString().slice(0, 10) + 'T00:00:00Z');
}

function hasText(value) {
  return Array.isArray(value) ? value.some(hasText) : String(value || '').trim().length > 0;
}

export function classifyFreshness(item = {}, period = {}, now = new Date()) {
  const end = referenceTime(period, now);
  const published = asDate(item.published_at);
  const updated = asDate(item.updated_at);
  const eventTime = updated && (!published || updated > published) ? updated : published;
  if (!eventTime) {
    return { accepted: true, allowedTier: 'watch', status: 'date-unknown', reason: '发布时间待核验', ageDays: null };
  }
  const ageDays = Math.floor((end - eventTime) / DAY_MS);
  if (ageDays >= 0 && ageDays <= FRESH_DAYS) {
    return {
      accepted: true,
      allowedTier: 'action',
      status: updated && updated === eventTime && published && updated !== published ? 'current-week-update' : 'current-week',
      reason: updated && updated === eventTime && published && updated !== published ? '本周更新' : '本周发布',
      ageDays,
    };
  }
  if (ageDays < 0) return { accepted: false, allowedTier: 'reject', status: 'future-date', reason: '日期晚于报告周期', ageDays };

  const horizonEnd = end + EXCEPTION_HORIZON_DAYS * DAY_MS;
  const hardFacts = item.hard_facts && typeof item.hard_facts === 'object' ? item.hard_facts : {};
  const deadline = [
    item.effective_date,
    item.feedback_deadline,
    item.next_deadline,
    item.deadline,
    hardFacts.effective_date,
    hardFacts.feedback_deadline,
    hardFacts.next_deadline,
    hardFacts.deadline,
  ]
    .map(parseLooseDate)
    .find(value => value !== null && value >= end && value <= horizonEnd);
  const exception = String(item.freshness_exception || '').trim();
  const activeNodeHints = [
    item.title,
    item.article_text,
    item.text,
    item.full_text,
    item.snippet,
    hardFacts.document_number,
    hardFacts.authority,
  ].join(' ');
  if ((exception === 'upcoming_deadline' || /征求意见|反馈截止|截止|生效|实施|过渡期|新旧衔接/.test(activeNodeHints)) && deadline) {
    return { accepted: true, allowedTier: 'action', status: 'historical-node', reason: '历史规则·本期节点', ageDays };
  }
  if ((exception === 'ongoing_enforcement' || /持续执行|仍在执行|继续执行|ongoing|enforcement/.test(activeNodeHints)) && hasText(item.change_evidence)) {
    return { accepted: true, allowedTier: 'action', status: 'historical-ongoing', reason: '历史规则·持续执行', ageDays };
  }
  if ((exception === 'current_week_change' || /本周更新|近日更新|最新更新/.test(activeNodeHints)) && hasText(item.change_evidence) && asDate(item.updated_at) && Math.floor((end - asDate(item.updated_at)) / DAY_MS) <= FRESH_DAYS) {
    return { accepted: true, allowedTier: 'action', status: 'current-week-update', reason: '本周更新', ageDays };
  }
  if ((exception === 'open_action' || /待反馈|公开征集|行动窗口|申报入口/.test(activeNodeHints)) && hasText(item.open_action_evidence || item.recommended_actions)) {
    return { accepted: true, allowedTier: 'action', status: 'historical-action', reason: '历史规则·未关闭行动', ageDays };
  }
  return { accepted: false, allowedTier: 'reject', status: 'stale', reason: '超过 7 天且无有效例外', ageDays };
}

export function filterCandidatesByFreshness(candidates = [], period = {}, now = new Date()) {
  return candidates.flatMap(candidate => {
    const result = classifyFreshness(candidate, period, now);
    return result.accepted ? [{ ...candidate, freshness_status: result.status, freshness_reason: result.reason, freshness_age_days: result.ageDays }] : [];
  });
}
