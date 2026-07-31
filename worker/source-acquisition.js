const HARD_FACT_SCOPES = new Set(['hard_fact_endpoint', 'hard_fact_list']);
const PORTAL_SCOPE = new Set(['portal', 'homepage', 'lead_only', 'discovery_only']);

const HARD_FACT_PATH_PATTERN = /(?:\/art\/\d{4}\/\d{1,2}\/\d{1,2}\/|\/col\/col(?:144|2428|2425|3611|2073|75|66)\b|\/xxgk\/|\/xw\/zj\/art\/|行政处罚|处罚决定|典型案例|征求意见|zhqyj|公告|通告|recall|safety-gate|press-releases)/i;
const PORTAL_PATH_PATTERN = /^(?:\/|\/index(?:\.html?)?|\/portal\/(?:en\/)?index(?:\.html?)?|\/(?:syx|pub\/sfbgw|customs\/syx)\/?index(?:\.html?)?)$/i;
const PORTAL_HOST_PATTERN = /(?:^|\.)gov\.cn$|(?:^|\.)samr\.gov\.cn$|(?:^|\.)nmpa\.gov\.cn$|(?:^|\.)cnipa\.gov\.cn$|(?:^|\.)customs\.gov\.cn$/i;
const SOFT_PORTAL_WORD_PATTERN = /首页|主页|门户|portal|综合服务平台|公共服务网|协会$/i;

export function isLikelyPortalUrl(url = '') {
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    const path = parsed.pathname || '/';
    if (PORTAL_PATH_PATTERN.test(path)) return true;
    if (PORTAL_HOST_PATTERN.test(parsed.hostname) && /^\/(?:[a-z0-9_-]+\/)?$/i.test(path)) return true;
    return false;
  } catch {
    return false;
  }
}

export function isHardFactAcquisitionSource(source = {}) {
  const scope = String(source.source_scope || '').trim();
  if (HARD_FACT_SCOPES.has(scope)) return true;
  if (PORTAL_SCOPE.has(scope)) return false;
  if (source.monitor_only || source.source_type === 'wechat_public_account') return false;

  const url = String(source.url || source.source_url || '').trim();
  if (!/^https?:\/\//i.test(url)) return false;
  if (isLikelyPortalUrl(url)) return false;

  const text = `${source.name || ''} ${source.module || ''} ${(source.topics || []).join(' ')} ${url}`;
  if (SOFT_PORTAL_WORD_PATTERN.test(String(source.name || '')) && !HARD_FACT_PATH_PATTERN.test(url)) return false;
  return HARD_FACT_PATH_PATTERN.test(text);
}

export function isHydrationAcquisitionSource(source = {}) {
  if (isHardFactAcquisitionSource(source)) return true;
  if (String(source.source_scope || '') !== 'discovered_article') return false;
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(String(source.published_at || ''))) return false;
  const url = String(source.url || source.source_url || '');
  return /^https?:\/\//i.test(url) && !isLikelyPortalUrl(url) && !/news\.google\.com/i.test(url);
}

export function filterHydrationAcquisitionSources(sources = []) {
  return (Array.isArray(sources) ? sources : []).filter(isHydrationAcquisitionSource);
}

export function isFormalAcquisitionMode(options = {}) {
  const env = options.env || {};
  return Boolean(options.qualityMode || options.hardFactOnly || options.formalRun)
    || env.QUALITY_MODE === '1'
    || env.REPORT_QUALITY_MODE === 'quality'
    || env.CONTENT_QUALITY_MODE === 'quality'
    || env.CRAWL4AI_HARD_FACT_ONLY === '1';
}

export function filterHardFactAcquisitionSources(sources = [], options = {}) {
  const rows = Array.isArray(sources) ? sources : [];
  if (!isFormalAcquisitionMode(options)) return rows;
  return rows.filter(isHardFactAcquisitionSource);
}
