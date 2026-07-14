import { readFile, writeFile, mkdir } from 'node:fs/promises';
import sharp from 'sharp';
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
  AI_API_KEY: process.env.AI_API_KEY || process.env.DEEPSEEK_API_KEY,
  AI_API_BASE_URL: process.env.AI_API_BASE_URL || process.env.DEEPSEEK_API_BASE_URL || 'https://hk.testvideo.site/v1',
  AI_MODEL: process.env.AI_MODEL || process.env.DEEPSEEK_WORKER_MODEL || process.env.DEEPSEEK_MODEL || 'gpt-5.4-mini',
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
  SEEN_NEWS: kv,
};

env.ON_REPORT_READY = async ({ report, markdown }) => {
  await mkdir('out', { recursive: true });
  await writeFile('out/latest-report.md', markdown, 'utf8');
  await writeFile('out/latest-report.json', JSON.stringify(report, null, 2), 'utf8');
};

async function renderDecisionMapPng({ svg }) {
  await mkdir('out', { recursive: true });
  await writeFile('out/decision-map.svg', svg, 'utf8');
  await sharp(Buffer.from(svg), { density: 180 }).png().toFile('out/decision-map.png');
  return new Uint8Array(await readFile('out/decision-map.png'));
}

env.CREATE_DECISION_MAP_PNG = renderDecisionMapPng;

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

const result = await runPipeline(env, 'https://beauty-legal-bot.ai-cf.workers.dev/');
if (!result || result.status === 'failed') {
  throw new Error(`Pipeline failed at ${result?.stage || 'unknown'}: ${result?.message || 'pipeline returned no result'}`);
}
console.log(`Pipeline ${result.status}: ${result.message}`);

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
