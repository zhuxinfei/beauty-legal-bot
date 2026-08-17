// 跨周去重共享状态模块 — Actions 生产链路与 Worker 链路共用。
// 单一事实来源：docs/quality/seen-cards.json（新格式 [{ u, t }]）。
// 去重键 = 归一化 URL（剥离 tracking 参数），保证同一条新闻的不同落地链接变体映射到同一键。
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// 60 天记忆窗口：覆盖 45 天发现窗口加缓冲，与 assemble-cards.js 的 60 天记录过滤一致。
export const SEEN_WINDOW_DAYS = 60;

// Google News / 门户在落地链接上追加的 tracking 参数。
// 剥离后同一文章的不同变体（带不带 ?scm=... 等）映射到同一去重键。
const TRACKING_QUERY_KEYS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'scm', 'spm', 'from', 'source', 'ref', 'refer', 'referer', 'scroll',
  'cid', 'clicktime', 'clickid', 'wt', 'at', 'pvid', 'tok',
]);

// 内容平台的等价移动子域：同一文章在 m./mt./wap. 等子域与 www./裸域之间
// 互为变体（如 mt.sohu.com vs m.sohu.com 的同一篇搜狐文章），
// 归一化到主域后映射到同一去重键。
const MOBILE_SUBDOMAINS = new Set(['m', 'mobile', 'wap', '3g', 'www', 'mt', 'it', 'i', '3w', 'app', 'touch']);

export function normalizeDedupUrl(raw = '') {
  const value = String(raw).trim();
  if (!value) return '';
  try {
    const url = new URL(value);
    url.hash = '';
    // 剥离 tracking 参数，保留内容性参数（如 ?id=1705301）。
    const kept = [];
    for (const [key, paramValue] of url.searchParams) {
      const k = key.toLowerCase();
      if (TRACKING_QUERY_KEYS.has(k) || k.startsWith('utm_')) continue;
      kept.push([k, paramValue]);
    }
    kept.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    url.search = kept.length
      ? `?${kept.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&')}`
      : '';
    // 去除默认端口，hostname 已由 URL 构造归一化为小写
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    // 等价移动子域归一化：m./mt./wap. 等 → 主域（如 mt.sohu.com → sohu.com）。
    const hostLabels = url.hostname.split('.');
    if (hostLabels.length > 2 && MOBILE_SUBDOMAINS.has(hostLabels[0])) {
      url.hostname = hostLabels.slice(1).join('.');
    }
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    // 非 URL 输入：至少去掉 hash 与尾斜杠
    return value.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

function toIsoDate(ts) {
  if (!ts) return '';
  const value = String(ts);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{10,13}$/.test(value)) {
    const d = new Date(Number(value));
    return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
  }
  const match = value.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : '';
}

// 读取 seen-cards.json，兼容三种历史格式：
//   新格式 [{ u, t }]、旧对象 [{ title, facts, eventSig }]、裸 URL 字符串数组。
// 返回 Map<normUrl, isoDate>；读取失败返回空 Map（调用方负责保守处理，不应覆写文件）。
export function loadSeenEntries(path) {
  const map = new Map();
  try {
    if (!existsSync(path)) return map;
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    if (!Array.isArray(raw)) return map;
    for (const entry of raw) {
      let url = '';
      let ts = '';
      if (typeof entry === 'string') {
        url = entry;
      } else if (entry && typeof entry === 'object') {
        url = entry.u || entry.source_url || entry.url || '';
        ts = entry.t || entry.ts || '';
      }
      const key = normalizeDedupUrl(url);
      if (!key) continue;
      const iso = toIsoDate(ts);
      const existing = map.get(key);
      if (!existing || (iso && iso > existing)) map.set(key, iso || existing);
    }
    return map;
  } catch (err) {
    console.warn(`[dedup] load failed: ${(err?.message || String(err)).slice(0, 100)}`);
    return map;
  }
}

// 合并本轮已推送 URL 到去重状态文件：按 SEEN_WINDOW_DAYS 淘汰过期条目、
// 归一化去重、写入新格式 [{ u, t }]。返回写入后的条目数组。
export function mergeAndSaveSeen(path, urls = [], now = new Date()) {
  const map = loadSeenEntries(path);
  const cutoff = new Date(now.getTime() - SEEN_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const entries = [];
  const seenKeys = new Set();
  for (const [key, ts] of map) {
    if (ts && ts < cutoff) continue; // 超过窗口，淘汰
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    entries.push({ u: key, t: ts || today });
  }
  for (const url of urls) {
    const key = normalizeDedupUrl(url);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    entries.push({ u: key, t: today });
  }
  entries.sort((a, b) => (a.t < b.t ? 1 : a.t > b.t ? -1 : 0));
  try {
    writeFileSync(path, `${JSON.stringify(entries, null, 2)}\n`);
  } catch (err) {
    console.warn(`[dedup] save failed: ${(err?.message || String(err)).slice(0, 100)}`);
  }
  return entries;
}
