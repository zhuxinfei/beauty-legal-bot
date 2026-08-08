import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { XMLParser } from 'fast-xml-parser';

const execFileAsync = promisify(execFile);
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });

function textValue(value) {
  return typeof value === 'object' ? String(value?.['#text'] || '') : String(value || '');
}

export function parseGoogleNewsRss(xml, module) {
  const document = parser.parse(String(xml || ''));
  const items = [].concat(document?.rss?.channel?.item || []);
  return items.flatMap(item => {
    const sourceName = textValue(item.source).trim();
    const rawTitle = textValue(item.title).trim();
    const title = sourceName && rawTitle.endsWith(` - ${sourceName}`)
      ? rawTitle.slice(0, -(` - ${sourceName}`.length)).trim()
      : rawTitle;
    const discoveryUrl = textValue(item.link).trim();
    const date = new Date(textValue(item.pubDate));
    if (!title || !/^https:\/\/news\.google\.com\//i.test(discoveryUrl) || Number.isNaN(date.getTime())) return [];
    return [{
      title,
      discovery_url: discoveryUrl,
      source_name: sourceName,
      publisher_url: String(item.source?.['@_url'] || ''),
      published_at: date.toISOString().slice(0, 10),
      module,
    }];
  });
}

export function extractGoogleDecodingParams(html) {
  const timestamp = String(html || '').match(/data-n-a-ts=["']([^"']+)["']/i)?.[1] || '';
  const signature = String(html || '').match(/data-n-a-sg=["']([^"']+)["']/i)?.[1] || '';
  return timestamp && signature ? { timestamp, signature } : null;
}

export function parseGoogleBatchResponse(text) {
  const parts = String(text || '').split(/\n\n/).filter(Boolean);
  for (const part of parts) {
    try {
      const rows = JSON.parse(part.replace(/^\)\]\}'\s*/, ''));
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!['wrb.fr', 'w779db'].includes(row?.[0]) || row?.[1] !== 'Fbv4je') continue;
        const inner = JSON.parse(row[2]);
        const url = String(inner?.[1] || '');
        if (/^https?:\/\//i.test(url) && !/^https?:\/\/news\.google\.com\//i.test(url)) return url;
      }
    } catch {}
  }
  return '';
}

function googleToken(url) {
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parsed.hostname !== 'news.google.com' || !['articles', 'read'].includes(parts.at(-2))) return '';
    return parts.at(-1) || '';
  } catch {
    return '';
  }
}

function batchBody(token, { timestamp, signature }) {
  const request = [
    'Fbv4je',
    `["garturlreq",[["X","X",["X","X"],null,null,1,1,"US:en",null,1,null,null,null,null,null,0,1],"X","X",1,[1,1,1],1,1,null,0,0,null,0],"${token}",${timestamp},"${signature}"]`,
  ];
  return `f.req=${encodeURIComponent(JSON.stringify([[request]]))}`;
}

async function curlText(args) {
  const { stdout } = await execFileAsync('/usr/bin/curl', [
    '-L', '--max-time', '15', '-sS',
    '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126 Safari/537.36',
    ...args,
  ], { maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export async function resolveGoogleNewsCandidate(candidate) {
  const token = googleToken(candidate.discovery_url);
  if (!token) return { ...candidate, resolution_status: 'failed', resolution_reason: 'invalid-google-url' };
  try {
    const html = await curlText([candidate.discovery_url]);
    const params = extractGoogleDecodingParams(html);
    if (!params) return { ...candidate, resolution_status: 'failed', resolution_reason: 'missing-decoding-params' };
    const response = await curlText([
      '-X', 'POST',
      '-H', 'Content-Type: application/x-www-form-urlencoded;charset=UTF-8',
      '-H', 'Origin: https://news.google.com',
      '-H', 'Referer: https://news.google.com/',
      '--data-raw', batchBody(token, params),
      'https://news.google.com/_/DotsSplashUi/data/batchexecute',
    ]);
    const url = parseGoogleBatchResponse(response);
    return url
      ? { ...candidate, url, resolution_status: 'resolved', resolution_reason: '' }
      : { ...candidate, resolution_status: 'failed', resolution_reason: 'invalid-batch-response' };
  } catch (error) {
    return { ...candidate, resolution_status: 'failed', resolution_reason: String(error?.message || error).slice(0, 240) };
  }
}

export async function resolveGoogleNewsCandidates(candidates, concurrency = 6) {
  const results = new Array(candidates.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, candidates.length) }, async () => {
    while (next < candidates.length) {
      const index = next;
      next += 1;
      results[index] = await resolveGoogleNewsCandidate(candidates[index]);
    }
  }));
  return results;
}
