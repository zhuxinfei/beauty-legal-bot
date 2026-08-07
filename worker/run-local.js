import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createBrowserSourceFetcher } from './browser-fetch.js';
import { runPipeline } from './index.js';

// File-based KV for CI dedupe persistence across weekly runs.
// Reads `out/seen-fingerprints.json` if present, writes back on change.
// Falls back to in-memory when the file is missing or unreadable.
const SEEN_FILE = resolve('out', 'seen-fingerprints.json');
const store = new Map();
let storeDirty = false;

async function loadPersistedFingerprints() {
  try {
    if (!existsSync(SEEN_FILE)) return;
    const raw = await readFile(SEEN_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data && typeof data === 'object') {
      for (const [k, v] of Object.entries(data)) {
        store.set(k, v);
      }
      console.log(`[dedupe] loaded ${store.size} fingerprints from ${SEEN_FILE}`);
    }
  } catch (err) {
    console.warn(`[dedupe] could not load ${SEEN_FILE}: ${err.message.slice(0, 120)}`);
  }
}

async function savePersistedFingerprints() {
  if (!storeDirty) return;
  try {
    await mkdir('out', { recursive: true });
    const obj = Object.fromEntries(store);
    await writeFile(SEEN_FILE, JSON.stringify(obj), 'utf8');
    console.log(`[dedupe] saved ${store.size} fingerprints to ${SEEN_FILE}`);
  } catch (err) {
    console.warn(`[dedupe] could not save ${SEEN_FILE}: ${err.message.slice(0, 120)}`);
  }
}

await loadPersistedFingerprints();

const kv = {
  async get(key, type) {
    const value = store.get(key);
    if (!value) return null;
    if (type === 'arrayBuffer' && value instanceof Uint8Array) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    return value;
  },
  async put(key, value) {
    store.set(key, value);
    storeDirty = true;
  },
};

const defaultArtifactOnly = '0';
const manualPreview = defaultArtifactOnly === '1' && process.env.ARTIFACT_ONLY !== '0';

const env = {
  AI_API_KEY: process.env.AI_API_KEY,
  AI_API_BASE_URL: process.env.AI_API_BASE_URL || 'https://api.deepseek.com/v1',
  AI_MODEL: process.env.AI_MODEL || 'deepseek-chat',
  AI_MAX_TOKENS: manualPreview ? '4000' : process.env.AI_MAX_TOKENS,
  DINGTALK_WEBHOOK_URL: process.env.DINGTALK_WEBHOOK_URL,
  DINGTALK_SECRET: process.env.DINGTALK_SECRET,
  FEISHU_WEBHOOK_URL: process.env.FEISHU_WEBHOOK_URL || 'https://example.com/skip-feishu',
  QUALITY_MODE: process.env.QUALITY_MODE || '0',
  REPORT_QUALITY_MODE: process.env.REPORT_QUALITY_MODE,
  CONTENT_QUALITY_MODE: process.env.CONTENT_QUALITY_MODE,
  ARTIFACT_ONLY: process.env.ARTIFACT_ONLY || defaultArtifactOnly,
  SOURCE_ONLY_PROOF_REQUIRED: process.env.SOURCE_ONLY_PROOF_REQUIRED || '0',
  FULL_SOURCE_SCAN: manualPreview ? '0' : process.env.FULL_SOURCE_SCAN || (process.env.QUALITY_MODE === '1' || process.env.REPORT_QUALITY_MODE === 'quality' || process.env.CONTENT_QUALITY_MODE === 'quality' ? '1' : '0'),
  WORKER_FETCH_SOURCE_BUDGET: manualPreview ? '8' : process.env.WORKER_FETCH_SOURCE_BUDGET,
  ANALYSIS_CANDIDATE_LIMIT: manualPreview ? '16' : process.env.ANALYSIS_CANDIDATE_LIMIT,
  ANALYSIS_LEAD_LIMIT: manualPreview ? '8' : process.env.ANALYSIS_LEAD_LIMIT,
  REPORT_ITEMS_PER_MODULE: process.env.REPORT_ITEMS_PER_MODULE,
  REPORT_TARGET_ITEMS: manualPreview ? '4' : process.env.REPORT_TARGET_ITEMS || '20',
  PREMIUM_TARGET_ITEMS: manualPreview ? '4' : process.env.PREMIUM_TARGET_ITEMS || '20',
  PREMIUM_MIN_ITEMS: manualPreview ? '0' : process.env.PREMIUM_MIN_ITEMS || '20',
  PREMIUM_MAX_ITEMS: manualPreview ? '4' : process.env.PREMIUM_MAX_ITEMS || '24',
  PREMIUM_MIN_PER_MODULE: manualPreview ? '0' : process.env.PREMIUM_MIN_PER_MODULE || '2',
  PREMIUM_MAX_PER_MODULE: manualPreview ? '4' : process.env.PREMIUM_MAX_PER_MODULE || '5',
  MIN_SOURCE_COVERAGE: process.env.MIN_SOURCE_COVERAGE || '0.9',
  MIN_CHINA_CRITICAL_COVERAGE: process.env.MIN_CHINA_CRITICAL_COVERAGE || '0.9',
  FORCE_DELIVERY: process.env.FORCE_DELIVERY || (manualPreview ? '1' : '0'),
  NO_DELIVERY: process.env.NO_DELIVERY || '0',
  DETAIL_FETCH_ENABLED: process.env.DETAIL_FETCH_ENABLED || '1',
  DETAIL_CANDIDATE_LIMIT: manualPreview ? '18' : process.env.DETAIL_CANDIDATE_LIMIT || '48',
  DETAIL_FETCH_TIMEOUT_MS: process.env.DETAIL_FETCH_TIMEOUT_MS || '12000',
  DETAIL_FETCH_CONCURRENCY: process.env.DETAIL_FETCH_CONCURRENCY || '8',
  DETAIL_BROWSER_RECOVERY_LIMIT: process.env.DETAIL_BROWSER_RECOVERY_LIMIT || '18',
  SOURCE_HYDRATION_JSON: process.env.SOURCE_HYDRATION_JSON,
  SOURCE_HYDRATION_FILE: process.env.SOURCE_HYDRATION_FILE,
  SOURCE_HYDRATION_URL: process.env.SOURCE_HYDRATION_URL,
  SEEN_NEWS: kv,
};

const publicWorkerBaseUrl = process.env.PUBLIC_WORKER_BASE_URL || 'https://beauty-legal-bot.ai-cf.workers.dev';

env.ON_REPORT_READY = async ({ report, markdown }) => {
  await mkdir('out', { recursive: true });
  await writeFile('out/latest-report.md', markdown, 'utf8');
  await writeFile('out/latest-report.json', JSON.stringify(report, null, 2), 'utf8');
  if (env.PRINT_REPORT_MARKDOWN !== '0') {
    console.log('=== BEGIN LATEST REPORT MARKDOWN ===');
    console.log(markdown.trim());
    console.log('=== END LATEST REPORT MARKDOWN ===');
  }
};

if (!env.AI_API_KEY) {
  throw new Error('AI_API_KEY is required');
}

if (!process.env.FEISHU_WEBHOOK_URL) {
  globalThis.fetch = new Proxy(globalThis.fetch, {
    apply(target, thisArg, args) {
      const [url] = args;
      if (String(url) === 'https://example.com/skip-feishu') {
        return Promise.resolve(new Response(JSON.stringify({ code: 0 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}

let browserSourceFetcher = null;
try {
  browserSourceFetcher = await createBrowserSourceFetcher({ chromium });
  env.BROWSER_FETCH_HTML = browserSourceFetcher.fetchHtml;
  console.log('Playwright browser launched for source recovery');
} catch (err) {
  console.warn(`Playwright browser unavailable (${err.message.slice(0, 120)}), source recovery will skip browser fallback`);
  env.BROWSER_FETCH_HTML = undefined;
}

let result;
try {
  result = await runPipeline(env, `${publicWorkerBaseUrl}/`);
  if (!result || result.status === 'failed') {
    throw new Error(`Pipeline failed at ${result?.stage || 'unknown'}: ${result?.message || 'pipeline returned no result'}`);
  }
  console.log(`Pipeline ${result.status}: ${result.message}`);
} finally {
  if (browserSourceFetcher) await browserSourceFetcher.close();
  await savePersistedFingerprints();
}

await mkdir('out', { recursive: true });
console.log('Generated out/latest-report.md');
console.log('Generated out/latest-report.json');
if (result.delivery) {
  console.log(`Delivery ${result.delivery.channel || result.stage}: ${result.delivery.sent || 0}/${result.delivery.total || 0}, retries=${result.delivery.retries || 0}`);
}
