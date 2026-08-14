import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { buildDiscoveryQueries, discoverOpenWeb, discoverOpenWebWithRecovery } from '../worker/open-web-discovery.js';
import { parseGoogleNewsRss, resolveGoogleNewsCandidates } from '../worker/google-rss-discovery.js';
import { attachAuthorityResolutionProvenance, buildAuthoritySearchRows } from '../worker/authority-resolver.js';
import { loadSeenEntries, normalizeDedupUrl } from '../worker/dedup-state.js';

const execFileAsync = promisify(execFile);

const DISCOVERY_WINDOW_DAYS = Number(process.env.DISCOVERY_WINDOW_DAYS || 15);
const DISCOVERY_MODULES = String(process.env.DISCOVERY_MODULES || '')
  .split(',')
  .map(value => value.trim())
  .filter(Boolean);

function period() {
  const end = process.env.REPORT_PERIOD_END || new Date().toISOString().slice(0, 10);
  const endDate = new Date(`${end}T00:00:00Z`);
  const startDate = new Date(endDate.getTime() - (DISCOVERY_WINDOW_DAYS - 1) * 86400000);
  return { start: process.env.REPORT_PERIOD_START || startDate.toISOString().slice(0, 10), end };
}

const output = resolve(process.argv[2] || 'out/discovery.json');
const manifestOutput = resolve(process.argv[3] || 'out/acquisition-manifest.json');
const catalog = JSON.parse(await readFile(resolve('worker/sources.json'), 'utf8'));
// Google News RSS over curl instead of fetch: undici's TLS fingerprint is
// throttled by Google (every query times out), while curl completes in seconds.
// Same curl path already proven in worker/google-rss-discovery.js resolution.
async function curlGoogleNewsRss(query, days) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:${days}d`)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const timeoutSeconds = Math.max(5, Math.ceil(Number(process.env.DISCOVERY_QUERY_TIMEOUT_MS || 8000) / 1000));
  const { stdout } = await execFileAsync('/usr/bin/curl', [
    '-L', '--max-time', String(timeoutSeconds), '-sS',
    '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
    '--compressed',
    url,
  ], { maxBuffer: 8 * 1024 * 1024 });
  if (!stdout.trim()) throw new Error('Google News RSS empty response');
  return stdout;
}
const fetchRssForDays = days => async query => curlGoogleNewsRss(query, days);
const fetchSecondaryForDays = days => async (query, module) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.DISCOVERY_QUERY_TIMEOUT_MS || 8000));
  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=20&timespan=${days}days&format=json&sort=DateDesc`;
    const response = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'beauty-legal-bot/2.0' } });
    if (!response.ok) return [];
    const payload = await response.json();
    return (payload.articles || []).map(article => ({
      title: article.title || '',
      url: article.url || '',
      discovery_url: article.url || '',
      source_name: article.domain || '',
      publisher_url: article.url || '',
      published_at: String(article.seendate || '').slice(0, 8).replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'),
      module,
      resolution_status: 'resolved',
      discovery_provider: 'gdelt',
    }));
  } finally {
    clearTimeout(timer);
  }
};

function mergeCandidates(...groups) {
  const seen = new Set();
  return groups.flat().filter(item => {
    const key = normalizeDedupUrl(item.url || item.source_url || '');
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function countByModule(candidates = []) {
  return candidates.reduce((counts, item) => {
    const module = item.discovery_module || item.module || '';
    if (module) counts[module] = (counts[module] || 0) + 1;
    return counts;
  }, {});
}

async function resolveAuthorityOriginals(leads, days) {
  const rows = buildAuthoritySearchRows(leads, Number(process.env.AUTHORITY_RESOLUTION_LEAD_LIMIT || 24));
  if (!rows.length) return { candidates: [], rows: 0, raw: 0, resolved: 0 };
  const fetchRss = fetchRssForDays(days);
  const perQuery = Math.max(1, Number(process.env.AUTHORITY_RESULTS_PER_QUERY || 4));
  const rawGroups = await Promise.all(rows.map(async row => {
    try {
      return parseGoogleNewsRss(await fetchRss(row.query, row.module), row.module)
        .slice(0, perQuery)
        .map(item => ({ ...item, discovery_query: row.query, discovery_module: row.module }));
    } catch {
      return [];
    }
  }));
  const raw = rawGroups.flat();
  const resolved = await resolveGoogleNewsCandidates(raw, 6);
  const candidates = attachAuthorityResolutionProvenance(resolved, rows);
  return {
    candidates,
    rows: rows.length,
    raw: raw.length,
    resolved: candidates.length,
    rawByModule: countByModule(raw),
    resolvedByModule: countByModule(candidates),
  };
}

async function runDiscoveryPass({ period: passPeriod, queryRows, recovery }) {
  const days = recovery ? Number(process.env.DISCOVERY_RECOVERY_DAYS || DISCOVERY_WINDOW_DAYS) : DISCOVERY_WINDOW_DAYS;
  const discovered = await discoverOpenWeb({
    period: passPeriod,
    queryRows,
    fetchRss: fetchRssForDays(days),
    fetchSecondary: fetchSecondaryForDays(days),
    resolveCandidates: rows => resolveGoogleNewsCandidates(rows, 6),
    maxItems: Number(process.env.DISCOVERY_MAX_ITEMS || 120),
    maxPerHost: Number(process.env.DISCOVERY_MAX_PER_HOST || 8),
    maxPerModule: Number(process.env.DISCOVERY_MAX_PER_MODULE || 30),
  });
  const authority = await resolveAuthorityOriginals(discovered.candidates, days);
  const candidates = mergeCandidates(authority.candidates, discovered.candidates);
  return {
    candidates,
    audit: {
      ...discovered.audit,
      unique: candidates.length,
      acceptedByModule: countByModule(candidates),
      authorityQueries: authority.rows,
      authorityRaw: authority.raw,
      authorityResolved: authority.resolved,
      authorityRawByModule: authority.rawByModule,
      authorityResolvedByModule: authority.resolvedByModule,
    },
  };
}

let result;
try {
  const discovery = discoverOpenWebWithRecovery({
    period: period(),
    queryRows: buildDiscoveryQueries({ modules: DISCOVERY_MODULES }),
    minimumPerModule: Number(process.env.DISCOVERY_MIN_PER_MODULE || 8),
    recoveryDays: Number(process.env.DISCOVERY_RECOVERY_DAYS || DISCOVERY_WINDOW_DAYS),
    runPass: runDiscoveryPass,
  });
  let timeout;
  try {
    result = await Promise.race([
      discovery,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('open-web discovery timed out')), Number(process.env.DISCOVERY_TOTAL_TIMEOUT_MS || 180000)); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
} catch (error) {
  console.warn(`Open-web discovery unavailable: ${error.message}`);
  result = { candidates: [], audit: { queries: 0, raw: 0, resolved: 0, unique: 0, error: error.message } };
}
// Cross-week pre-filter: skip discovery candidates already delivered in the
// dedup window. Static catalog sources are kept — they are manually curated
// endpoints whose content changes, not repeatable news items.
const seenUrls = new Set(loadSeenEntries(resolve('docs', 'quality', 'seen-cards.json')).keys());
const freshCandidates = (result.candidates || []).filter(c => {
  const key = normalizeDedupUrl(c.url || c.source_url || '');
  return !(key && seenUrls.has(key));
});
const filteredSeen = (result.candidates || []).length - freshCandidates.length;
if (filteredSeen > 0) console.log(`[dedup] filtered ${filteredSeen} already-delivered discovery candidates`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ period: period(), ...result }, null, 2)}\n`);
await writeFile(manifestOutput, `${JSON.stringify({ sources: [...(catalog.sources || []), ...freshCandidates] }, null, 2)}\n`);
console.log(`Discovery queries=${result.audit.queries}, raw=${result.audit.raw}, resolved=${result.audit.resolved}, unique=${result.audit.unique}`);
console.log(`Discovery modules=${JSON.stringify(result.audit.acceptedByModule || {})}, recovery=${JSON.stringify(result.audit.recoveryModules || [])}`);
console.log(`Authority resolution queries=${result.audit.authorityQueries || 0}, raw=${result.audit.authorityRaw || 0}, resolved=${result.audit.authorityResolved || 0}`);
console.log(`Authority resolution modules=${JSON.stringify(result.audit.authorityResolvedByModule || {})}, raw=${JSON.stringify(result.audit.authorityRawByModule || {})}`);
console.log(`Generated ${manifestOutput}`);
