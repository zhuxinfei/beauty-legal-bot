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
// 总超时触发时用它叫停仍在飞的请求：否则 curl 子进程会一直吊着事件循环，
// 脚本既拿不到已经抓到的结果、也退不出去。
const abortController = new AbortController();
const discoverySignal = abortController.signal;

// 已完成结果的收割器。发现层每跑完一个分块就推一份快照过来，
// 总超时打断时这些结果就是本轮的全部产出——而不是被清空成 queries=0。
const HARVEST_ADDITIVE_AUDIT_FIELDS = [
  'queries', 'raw', 'googleRaw', 'secondaryRaw', 'resolved',
  'authorityQueries', 'authorityRaw', 'authorityResolved',
];
const HARVEST_MAP_AUDIT_FIELDS = [
  'queriesByModule', 'rawByModule', 'resolvedByModule', 'acceptedByModule',
  'rejectionReasons', 'rejectionReasonsByModule', 'authorityRawByModule', 'authorityResolvedByModule',
];
const HARVEST_LIST_AUDIT_FIELDS = ['queryErrors', 'rejections'];

// 已完成结果的收割器。发现层每跑完一个分块就推一份快照过来，
// 总超时打断时这些结果就是本轮的全部产出——而不是被清空成 queries=0。
// 快照是「每趟累计」的，而恢复扫描是第二趟，所以按趟分别记录再合并，
// 否则第二趟刚起步的空计数会覆盖掉第一趟已经跑出来的量。
const harvest = {
  candidates: [],
  auditByPass: new Map(),
  passes: 0,
  absorb(snapshot, passId = 'default') {
    if (!snapshot) return;
    const seen = new Set(this.candidates.map(item => String(item.url || item.source_url || '')));
    for (const item of snapshot.candidates || []) {
      const key = String(item.url || item.source_url || '');
      if (!key || seen.has(key)) continue;
      seen.add(key);
      this.candidates.push(item);
    }
    if (!this.auditByPass.has(passId)) this.passes += 1;
    this.auditByPass.set(passId, snapshot.audit || {});
  },
  get audit() {
    const merged = {};
    for (const field of HARVEST_ADDITIVE_AUDIT_FIELDS) {
      const total = [...this.auditByPass.values()].reduce((sum, audit) => sum + Number(audit[field] || 0), 0);
      if (total) merged[field] = total;
    }
    for (const field of HARVEST_MAP_AUDIT_FIELDS) {
      const counts = {};
      for (const audit of this.auditByPass.values()) {
        for (const [key, value] of Object.entries(audit[field] || {})) counts[key] = (counts[key] || 0) + Number(value || 0);
      }
      if (Object.keys(counts).length) merged[field] = counts;
    }
    for (const field of HARVEST_LIST_AUDIT_FIELDS) {
      const rows = [...this.auditByPass.values()].flatMap(audit => audit[field] || []);
      if (rows.length) merged[field] = rows;
    }
    // 非计数型字段（错误信息、是否部分结果等）取最后一次已知的。
    for (const audit of this.auditByPass.values()) {
      for (const key of ['error', 'partial', 'recoveryModules']) {
        if (audit[key] !== undefined) merged[key] = audit[key];
      }
    }
    return merged;
  },
};
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
  ], { maxBuffer: 8 * 1024 * 1024, signal: discoverySignal });
  if (!stdout.trim()) throw new Error('Google News RSS empty response');
  return stdout;
}
const fetchRssForDays = days => async query => curlGoogleNewsRss(query, days);
const fetchSecondaryForDays = days => async (query, module) => {
  // 用 AbortSignal.any 把「单查询超时」和「整轮总超时」并成一个信号：
  // 不必给同一个 signal 反复挂监听（早期版本因此触发 MaxListeners 警告），
  // 总超时也能立刻叫停这一路，不会把进程吊在事件循环里。
  const signal = AbortSignal.any([
    AbortSignal.timeout(Number(process.env.DISCOVERY_QUERY_TIMEOUT_MS || 8000)),
    discoverySignal,
  ]);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=20&timespan=${days}days&format=json&sort=DateDesc`;
  const response = await fetch(url, { signal, headers: { 'User-Agent': 'beauty-legal-bot/2.0' } });
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
  // 限流分批：原先 24 条查询一次性铺开，既让 24 个 curl 同时订阅同一个
  // AbortSignal（触发 MaxListeners 告警），也容易把 Google 打到限流。
  const rawGroups = [];
  const width = Math.max(1, Number(process.env.AUTHORITY_QUERY_CHUNK || 6));
  for (let index = 0; index < rows.length; index += width) {
    if (discoverySignal.aborted) break;
    const batch = await Promise.all(rows.slice(index, index + width).map(async row => {
      try {
        return parseGoogleNewsRss(await fetchRss(row.query, row.module), row.module)
          .slice(0, perQuery)
          .map(item => ({ ...item, discovery_query: row.query, discovery_module: row.module }));
      } catch {
        return [];
      }
    }));
    rawGroups.push(...batch);
  }
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
  const passId = recovery ? 'recovery' : 'primary';
  const discovered = await discoverOpenWeb({
    period: passPeriod,
    queryRows,
    fetchRss: fetchRssForDays(days),
    fetchSecondary: fetchSecondaryForDays(days),
    resolveCandidates: rows => resolveGoogleNewsCandidates(rows, 6),
    maxItems: Number(process.env.DISCOVERY_MAX_ITEMS || 120),
    maxPerHost: Number(process.env.DISCOVERY_MAX_PER_HOST || 8),
    maxPerModule: Number(process.env.DISCOVERY_MAX_PER_MODULE || 30),
    onProgress: snapshot => harvest.absorb(snapshot, passId),
    signal: discoverySignal,
  });
  const authority = discoverySignal.aborted
    ? { candidates: [], rows: 0, raw: 0, resolved: 0 }
    : await resolveAuthorityOriginals(discovered.candidates, days);
  const candidates = mergeCandidates(authority.candidates, discovered.candidates);
  const audit = {
    ...discovered.audit,
    unique: candidates.length,
    acceptedByModule: countByModule(candidates),
    authorityQueries: authority.rows,
    authorityRaw: authority.raw,
    authorityResolved: authority.resolved,
    authorityRawByModule: authority.rawByModule,
    authorityResolvedByModule: authority.resolvedByModule,
  };
  // 整趟（含权威原始出处回解）跑完的合并结果再收割一次：这样即使第二趟
  // 恢复扫描超时，第一趟的完整产出也已经落在收割器里。
  harvest.absorb({ candidates, audit }, passId);
  return { candidates, audit };
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
  abortController.abort();
  const partial = harvest.candidates;
  if (partial.length) {
    // fail-open：总超时不再清空已抓到的结果，交给下游按同一套规则继续筛。
    console.warn(`Open-web discovery ${error.message}; keeping ${partial.length} partial candidates from ${harvest.passes} completed chunks`);
    result = {
      candidates: partial,
      audit: { ...harvest.audit, unique: partial.length, partial: true, error: error.message },
    };
  } else {
    console.warn(`Open-web discovery unavailable: ${error.message}`);
    result = { candidates: [], audit: { queries: 0, raw: 0, resolved: 0, unique: 0, partial: true, error: error.message } };
  }
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

// Portal-cap per module: official/government sources are the primary supply;
// low-quality portal/self-media hosts only fill gaps. Cap them per module so
// they cannot crowd out official sources in the hydration budget.
const PORTAL_HOST = /^(www\.)?(sohu|qq|163|sina|ifeng|36kr|eastmoney|21jingji|zhihu|gelonghui|xueqiu|yidianzixun|toutiao|ucnews|huxiu|tmtpost|ebrun|jiemian|dsb|cnstock|stcn|bjnews|shobserver|zaker|wandou|womenofchina|ajudaily|reach24h|fangchan|pcauto|autohome|mgtv|douban|weibo)\.(com|cn|net|cc|org|info|top|vip|com\.cn)$/i;
const MAX_PORTAL_PER_MODULE = 6;
const portalCounts = new Map();
const rankedCandidates = (freshCandidates || []).filter(c => {
  let host = '';
  try { host = new URL(String(c.url || c.source_url || '')).hostname.replace(/^www\./, ''); } catch { host = ''; }
  if (!host || !PORTAL_HOST.test(host)) return true; // official/authority hosts unrestricted
  const mod = c.discovery_module || c.module || '';
  const used = portalCounts.get(mod) || 0;
  if (used >= MAX_PORTAL_PER_MODULE) {
    console.log(`[dedup] portal-capped (${mod}): ${(c.title || '').slice(0, 40)}`);
    return false;
  }
  portalCounts.set(mod, used + 1);
  return true;
});
const portalFiltered = (freshCandidates || []).length - rankedCandidates.length;
if (portalFiltered > 0) console.log(`[dedup] portal-capped ${portalFiltered} candidates across modules (≤${MAX_PORTAL_PER_MODULE}/module)`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ period: period(), ...result }, null, 2)}\n`);
await writeFile(manifestOutput, `${JSON.stringify({ sources: [...(catalog.sources || []), ...rankedCandidates] }, null, 2)}\n`);
console.log(`Discovery queries=${result.audit.queries}, raw=${result.audit.raw}, resolved=${result.audit.resolved}, unique=${result.audit.unique}`);
console.log(`Discovery modules=${JSON.stringify(result.audit.acceptedByModule || {})}, recovery=${JSON.stringify(result.audit.recoveryModules || [])}`);
console.log(`Authority resolution queries=${result.audit.authorityQueries || 0}, raw=${result.audit.authorityRaw || 0}, resolved=${result.audit.authorityResolved || 0}`);
console.log(`Authority resolution modules=${JSON.stringify(result.audit.authorityResolvedByModule || {})}, raw=${JSON.stringify(result.audit.authorityRawByModule || {})}`);
console.log(`Generated ${manifestOutput}`);
