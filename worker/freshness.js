const DAY_MS = 86400000;
const FRESH_DAYS = 7;
const EXCEPTION_HORIZON_DAYS = 90;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function asDate(value) {
  const text = String(value || '').slice(0, 10);
  if (!ISO_DATE.test(text)) return null;
  const time = Date.parse(`${text}T00:00:00Z`);
  return Number.isFinite(time) ? time : null;
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
  const deadline = [item.effective_date, item.feedback_deadline, item.next_deadline]
    .map(asDate)
    .find(value => value !== null && value >= end && value <= horizonEnd);
  const exception = String(item.freshness_exception || '').trim();
  if (exception === 'upcoming_deadline' && deadline) {
    return { accepted: true, allowedTier: 'action', status: 'historical-node', reason: '历史规则·本期节点', ageDays };
  }
  if (exception === 'ongoing_enforcement' && hasText(item.change_evidence)) {
    return { accepted: true, allowedTier: 'action', status: 'historical-ongoing', reason: '历史规则·持续执行', ageDays };
  }
  if (exception === 'current_week_change' && hasText(item.change_evidence) && asDate(item.updated_at) && Math.floor((end - asDate(item.updated_at)) / DAY_MS) <= FRESH_DAYS) {
    return { accepted: true, allowedTier: 'action', status: 'current-week-update', reason: '本周更新', ageDays };
  }
  if (exception === 'open_action' && hasText(item.open_action_evidence || item.recommended_actions)) {
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

