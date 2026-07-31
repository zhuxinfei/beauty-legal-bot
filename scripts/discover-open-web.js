import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { discoverOpenWeb } from '../worker/open-web-discovery.js';
import { resolveGoogleNewsCandidates } from '../worker/google-rss-discovery.js';

function period() {
  const end = process.env.REPORT_PERIOD_END || new Date().toISOString().slice(0, 10);
  const endDate = new Date(`${end}T00:00:00Z`);
  const startDate = new Date(endDate.getTime() - 14 * 86400000);
  return { start: process.env.REPORT_PERIOD_START || startDate.toISOString().slice(0, 10), end };
}

const output = resolve(process.argv[2] || 'out/discovery.json');
const manifestOutput = resolve(process.argv[3] || 'out/acquisition-manifest.json');
const catalog = JSON.parse(await readFile(resolve('worker/sources.json'), 'utf8'));
const fetchRss = async query => {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:14d`)}&hl=zh-CN&gl=CN&ceid=CN:zh-Hans`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.DISCOVERY_QUERY_TIMEOUT_MS || 8000));
  const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 beauty-legal-bot/2.0' }, signal: controller.signal });
  clearTimeout(timer);
  if (!response.ok) throw new Error(`Google News RSS HTTP ${response.status}`);
  return response.text();
};
const fetchSecondary = async (query, module) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(process.env.DISCOVERY_QUERY_TIMEOUT_MS || 8000));
  try {
    const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=20&timespan=2weeks&format=json&sort=DateDesc`;
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

let result;
try {
  const discovery = discoverOpenWeb({
    period: period(),
    fetchRss,
    fetchSecondary,
    resolveCandidates: rows => resolveGoogleNewsCandidates(rows, 6),
    maxItems: Number(process.env.DISCOVERY_MAX_ITEMS || 120),
    maxPerHost: Number(process.env.DISCOVERY_MAX_PER_HOST || 8),
    maxPerModule: Number(process.env.DISCOVERY_MAX_PER_MODULE || 30),
  });
  let timeout;
  try {
    result = await Promise.race([
      discovery,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('open-web discovery timed out')), Number(process.env.DISCOVERY_TOTAL_TIMEOUT_MS || 90000)); }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
} catch (error) {
  console.warn(`Open-web discovery unavailable: ${error.message}`);
  result = { candidates: [], audit: { queries: 0, raw: 0, resolved: 0, unique: 0, error: error.message } };
}
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify({ period: period(), ...result }, null, 2)}\n`);
await writeFile(manifestOutput, `${JSON.stringify({ sources: [...(catalog.sources || []), ...result.candidates] }, null, 2)}\n`);
console.log(`Discovery queries=${result.audit.queries}, raw=${result.audit.raw}, resolved=${result.audit.resolved}, unique=${result.audit.unique}`);
console.log(`Generated ${manifestOutput}`);
