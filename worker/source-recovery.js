const DEFAULT_RETRY_DELAYS_MS = [1500, 4000];

export class SourceCoverageError extends Error {
  constructor(message, coverage) {
    super(message);
    this.name = 'SourceCoverageError';
    this.coverage = coverage;
  }
}

function errorMessage(value) {
  if (!value) return '';
  if (typeof value === 'string') return value;
  return String(value.message || value.error || value);
}

function outcomeFromError(error) {
  const message = errorMessage(error);
  const name = String(error?.name || '').toLowerCase();
  const kind = name === 'aborterror' || /timed?\s*out|timeout/i.test(message) ? 'timeout' : 'network';
  return { ok: false, status: Number(error?.status || 0), kind, error: message };
}

function normalizeOutcome(value) {
  const status = Number(value?.status || 0);
  const html = String(value?.html || '');
  return {
    ok: value?.ok === true && status >= 200 && status < 400 && html.trim().length > 0,
    status,
    kind: String(value?.kind || (status ? 'http' : 'network')),
    error: errorMessage(value?.error),
    html,
    finalUrl: String(value?.finalUrl || ''),
  };
}

export function classifyFetchFailure({ status = 0, kind = 'network', message = '' } = {}) {
  const numericStatus = Number(status || 0);
  const normalizedKind = String(kind || 'network').toLowerCase();
  const normalizedMessage = String(message || '').toLowerCase();
  const reason = numericStatus ? `http-${numericStatus}` : normalizedKind;
  const terminal = [401, 407].includes(numericStatus)
    || ['captcha', 'login', 'paywall', 'allowlist'].includes(normalizedKind)
    || /captcha|login required|sign[ -]?in required|paywall|allowlist/.test(normalizedMessage);
  const retryable = !terminal && (
    !numericStatus
    || numericStatus === 408
    || numericStatus === 425
    || numericStatus === 429
    || numericStatus >= 500
    || ['network', 'timeout'].includes(normalizedKind)
  );
  return { retryable, terminal, reason };
}

function attemptRecord(method, outcome, startedAt, now) {
  return {
    method,
    ok: outcome.ok,
    status: outcome.status,
    duration_ms: Math.max(0, Number(now()) - Number(startedAt)),
    error: outcome.ok ? '' : outcome.error || classifyFetchFailure({ status: outcome.status, kind: outcome.kind }).reason,
  };
}

async function runAttempt(method, operation, attempts, now) {
  const startedAt = now();
  let outcome;
  try {
    outcome = normalizeOutcome(await operation());
  } catch (error) {
    outcome = normalizeOutcome(outcomeFromError(error));
  }
  attempts.push(attemptRecord(method, outcome, startedAt, now));
  return outcome;
}

function recoveredResult(source, outcome, attempts, recoveryMethod) {
  return {
    status: recoveryMethod === 'direct' ? 'ok' : 'recovered',
    source,
    html: outcome.html,
    finalUrl: outcome.finalUrl || source.url,
    attempts,
    recovery_method: recoveryMethod,
    candidate_count: 0,
    final_error: '',
  };
}

/**
 * 依次尝试普通请求、浏览器渲染和同机构官方备用入口。
 * 单个来源失败不会中断整批采集；调用方根据返回的 attempts 和覆盖率统一决定是否继续生成周报。
 */
export async function recoverPublicSource(source, {
  direct,
  browser,
  alternate,
  maxAttempts = 3,
  retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
  sleep = delay => new Promise(resolve => setTimeout(resolve, delay)),
  jitter = () => Math.floor(Math.random() * 350),
  now = Date.now,
} = {}) {
  if (typeof direct !== 'function') throw new TypeError('recoverPublicSource requires a direct function');

  const attempts = [];
  let lastOutcome = { ok: false, status: 0, kind: 'network', error: 'not attempted', html: '', finalUrl: '' };
  let lastClassification = classifyFetchFailure(lastOutcome);

  for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
    const method = attempt === 0 ? 'direct' : 'retry';
    lastOutcome = await runAttempt(method, () => direct(source, attempt + 1), attempts, now);
    if (lastOutcome.ok) return recoveredResult(source, lastOutcome, attempts, method);

    lastClassification = classifyFetchFailure({
      status: lastOutcome.status,
      kind: lastOutcome.kind,
      message: lastOutcome.error,
    });
    if (!lastClassification.retryable || attempt >= maxAttempts - 1) break;
    const baseDelay = retryDelaysMs[Math.min(attempt, retryDelaysMs.length - 1)] || 0;
    await sleep(Math.max(0, baseDelay + Number(jitter() || 0)));
  }

  if (!lastClassification.terminal && typeof browser === 'function') {
    const browserOutcome = await runAttempt('browser', () => browser(source), attempts, now);
    if (browserOutcome.ok) return recoveredResult(source, browserOutcome, attempts, 'browser');
    lastOutcome = browserOutcome;
  }

  if (typeof alternate === 'function') {
    for (const url of source.alternate_urls || []) {
      const alternateOutcome = await runAttempt('alternate', () => alternate(source, url), attempts, now);
      if (alternateOutcome.ok) return recoveredResult(source, alternateOutcome, attempts, 'alternate');
      lastOutcome = alternateOutcome;
    }
  }

  return {
    status: 'failed',
    source,
    html: '',
    finalUrl: '',
    attempts,
    recovery_method: '',
    candidate_count: 0,
    final_error: lastOutcome.error || classifyFetchFailure({ status: lastOutcome.status, kind: lastOutcome.kind }).reason,
  };
}

function isChinaCritical(source) {
  return source?.priority === 'high' && [source?.country, source?.region].some(value => String(value || '').includes('中国'));
}

function isCovered(result) {
  return ['ok', 'recovered'].includes(result?.status) && Number(result?.candidate_count || 0) > 0;
}

export function calculateSourceCoverage(sources = [], sourceResults = []) {
  const resultByName = new Map(sourceResults.map(result => [result?.source?.name || result?.source_name, result]));
  const coveredSources = sources.filter(source => isCovered(resultByName.get(source.name)));
  const criticalSources = sources.filter(isChinaCritical);
  const coveredCritical = criticalSources.filter(source => isCovered(resultByName.get(source.name)));
  const failedSources = sources
    .filter(source => !isCovered(resultByName.get(source.name)))
    .map(source => source.name);

  return {
    overall: sources.length ? coveredSources.length / sources.length : 1,
    chinaCritical: criticalSources.length ? coveredCritical.length / criticalSources.length : 1,
    covered: coveredSources.length,
    total: sources.length,
    chinaCriticalCovered: coveredCritical.length,
    chinaCriticalTotal: criticalSources.length,
    failedSources,
  };
}

export function assertSourceCoverage(coverage, { minOverall = 0.9, minChinaCritical = 1 } = {}) {
  if (coverage.chinaCritical < minChinaCritical || coverage.overall < minOverall) {
    const message = `Source coverage below gate: China critical ${(coverage.chinaCritical * 100).toFixed(1)}%, overall ${(coverage.overall * 100).toFixed(1)}%`;
    throw new SourceCoverageError(message, coverage);
  }
  return true;
}
