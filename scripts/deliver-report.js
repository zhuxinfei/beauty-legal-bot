// Read latest-report.md and send to DingTalk.
// Usage: node scripts/deliver-report.js [markdown-file]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const mdPath = resolve(process.argv[2] || 'out/latest-report.md');
const webhookUrl = process.env.DINGTALK_WEBHOOK_URL;
const secret = process.env.DINGTALK_SECRET || '';
const noDelivery = process.env.NO_DELIVERY === '1';

if (noDelivery) {
  console.log('NO_DELIVERY=1, skipping DingTalk push');
  process.exit(0);
}

if (!webhookUrl) {
  console.error('DINGTALK_WEBHOOK_URL not set, cannot deliver');
  process.exit(1);
}

const markdown = readFileSync(mdPath, 'utf8');
const title = `美妆法务资讯｜${new Date().toISOString().slice(0, 10)}`;
const byteLength = new TextEncoder().encode(markdown).length;
console.log(`Report: ${markdown.split('\n').length} lines, ${byteLength} bytes`);

// Build DingTalk message
const body = JSON.stringify({
  msgtype: 'markdown',
  markdown: { title, text: markdown },
});

const timestamp = Date.now();
const url = secret
  ? await buildSignedUrl(webhookUrl, secret, timestamp)
  : webhookUrl;

console.log(`Sending to DingTalk...`);
const resp = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body,
});
const result = await resp.json();
console.log(`DingTalk response: ${resp.status} ${JSON.stringify(result)}`);

if (result.errcode === 0) {
  console.log('Delivery OK');
} else {
  console.error(`Delivery failed: ${result.errmsg || 'unknown'}`);
  process.exit(1);
}

async function buildSignedUrl(webhook, sec, ts) {
  const { createHmac } = await import('node:crypto');
  const sign = createHmac('sha256', sec)
    .update(`${ts}\n${sec}`)
    .digest('base64');
  const encoded = encodeURIComponent(sign);
  return `${webhook}&timestamp=${ts}&sign=${encoded}`;
}
