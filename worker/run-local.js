import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { createBrowserSourceFetcher } from './browser-fetch.js';
import { publishVersionedPng } from './cloudflare-assets.js';
import { runPipeline } from './index.js';

const store = new Map();
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
  },
};

const env = {
  AI_API_KEY: process.env.AI_API_KEY,
  AI_API_BASE_URL: process.env.AI_API_BASE_URL || 'https://hk.testvideo.site/v1',
  AI_MODEL: process.env.AI_MODEL || 'gpt-5.5',
  AI_MAX_TOKENS: process.env.AI_MAX_TOKENS,
  DINGTALK_WEBHOOK_URL: process.env.DINGTALK_WEBHOOK_URL,
  DINGTALK_SECRET: process.env.DINGTALK_SECRET,
  FEISHU_WEBHOOK_URL: process.env.FEISHU_WEBHOOK_URL || 'https://example.com/skip-feishu',
  QUALITY_MODE: process.env.QUALITY_MODE || '0',
  REPORT_QUALITY_MODE: process.env.REPORT_QUALITY_MODE,
  CONTENT_QUALITY_MODE: process.env.CONTENT_QUALITY_MODE,
  FULL_SOURCE_SCAN: process.env.FULL_SOURCE_SCAN || (process.env.QUALITY_MODE === '1' || process.env.REPORT_QUALITY_MODE === 'quality' || process.env.CONTENT_QUALITY_MODE === 'quality' ? '1' : '0'),
  WORKER_FETCH_SOURCE_BUDGET: process.env.WORKER_FETCH_SOURCE_BUDGET,
  ANALYSIS_CANDIDATE_LIMIT: process.env.ANALYSIS_CANDIDATE_LIMIT,
  ANALYSIS_LEAD_LIMIT: process.env.ANALYSIS_LEAD_LIMIT,
  REPORT_ITEMS_PER_MODULE: process.env.REPORT_ITEMS_PER_MODULE,
  MIN_SOURCE_COVERAGE: process.env.MIN_SOURCE_COVERAGE || '0.9',
  MIN_CHINA_CRITICAL_COVERAGE: process.env.MIN_CHINA_CRITICAL_COVERAGE || '0.9',
  FORCE_DELIVERY: process.env.FORCE_DELIVERY || '0',
  SEEN_NEWS: kv,
};

const publicWorkerBaseUrl = process.env.PUBLIC_WORKER_BASE_URL || 'https://beauty-legal-bot.ai-cf.workers.dev';
if (env.DINGTALK_WEBHOOK_URL && !process.env.CLOUDFLARE_API_TOKEN) {
  throw new Error('CLOUDFLARE_API_TOKEN is required to publish the dashboard before DingTalk delivery');
}

env.ON_REPORT_READY = async ({ report, markdown }) => {
  await mkdir('out', { recursive: true });
  await writeFile('out/latest-report.md', markdown, 'utf8');
  await writeFile('out/latest-report.json', JSON.stringify(report, null, 2), 'utf8');
};

async function renderDecisionMapPng({ svg }) {
  await mkdir('out', { recursive: true });
  await writeFile('out/decision-map.svg', svg, 'utf8');
  await sharp(Buffer.from(svg)).png().toFile('out/decision-map.png');
  return new Uint8Array(await readFile('out/decision-map.png'));
}

env.CREATE_DECISION_MAP_PNG = renderDecisionMapPng;
if (process.env.CLOUDFLARE_API_TOKEN) {
  env.PUBLISH_DECISION_MAP = ({ date, png }) => publishVersionedPng({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '34ddeeabd234776dc7c0f144257ecb7c',
    namespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID || '3b38ee9b31b74c4faee81ee5b92b3bdb',
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    date,
    png,
    publicBaseUrl: publicWorkerBaseUrl,
  });
}

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

const browserSourceFetcher = await createBrowserSourceFetcher({ chromium });
env.BROWSER_FETCH_HTML = browserSourceFetcher.fetchHtml;

let result;
try {
  result = await runPipeline(env, `${publicWorkerBaseUrl}/`);
  if (!result || result.status === 'failed') {
    throw new Error(`Pipeline failed at ${result?.stage || 'unknown'}: ${result?.message || 'pipeline returned no result'}`);
  }
  console.log(`Pipeline ${result.status}: ${result.message}`);
} finally {
  await browserSourceFetcher.close();
}

const decisionMapSvg = store.get('asset:decision-map:latest');
const decisionMapPng = store.get('asset:decision-map:latest.png');

await mkdir('out', { recursive: true });
if (decisionMapSvg) await writeFile('out/decision-map.svg', decisionMapSvg, 'utf8');
if (decisionMapPng) await writeFile('out/decision-map.png', decisionMapPng);
if (decisionMapSvg) console.log('Generated out/decision-map.svg');
if (decisionMapPng) console.log('Generated out/decision-map.png');
console.log('Generated out/latest-report.md');
console.log('Generated out/latest-report.json');
if (result.delivery) {
  console.log(`Delivery ${result.delivery.channel || result.stage}: ${result.delivery.sent || 0}/${result.delivery.total || 0}, retries=${result.delivery.retries || 0}`);
}
