import { writeFile, mkdir } from 'node:fs/promises';
import { runPipeline, latestReportKey } from './index.js';

const store = new Map();
const kv = {
  async get(key) {
    return store.get(key) || null;
  },
  async put(key, value) {
    store.set(key, value);
  },
};

const env = {
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
  FEISHU_WEBHOOK_URL: process.env.FEISHU_WEBHOOK_URL || 'https://example.com/skip-feishu',
  DEEPSEEK_MODEL: process.env.DEEPSEEK_WORKER_MODEL || 'deepseek-v4-pro',
  FULL_SOURCE_SCAN: process.env.FULL_SOURCE_SCAN || '0',
  SEEN_NEWS: kv,
};

if (!env.DEEPSEEK_API_KEY) {
  throw new Error('DEEPSEEK_API_KEY is required');
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

await runPipeline(env, 'https://beauty-legal-bot.ai-cf.workers.dev/');

const html = store.get(latestReportKey());
if (!html) throw new Error('report:latest was not generated');

await mkdir('out', { recursive: true });
await writeFile('out/latest-report.html', html, 'utf8');
console.log('Generated out/latest-report.html');
console.log(process.env.FEISHU_WEBHOOK_URL ? 'Feishu webhook was called.' : 'Feishu webhook skipped locally because FEISHU_WEBHOOK_URL is not set.');
