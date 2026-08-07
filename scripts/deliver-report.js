// Read latest-report.md and send to DingTalk, splitting if needed.
// Usage: node scripts/deliver-report.js [markdown-file]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const mdPath = resolve(process.argv[2] || 'out/latest-report.md');
const webhookUrl = process.env.DINGTALK_WEBHOOK_URL;
const secret = process.env.DINGTALK_SECRET || '';
const noDelivery = process.env.NO_DELIVERY === '1';
const DINGTALK_BYTE_LIMIT = 18000;
const encoder = new TextEncoder();

if (noDelivery) {
  console.log('NO_DELIVERY=1, skipping DingTalk push');
  process.exit(0);
}
if (!webhookUrl) {
  console.error('DINGTALK_WEBHOOK_URL not set');
  process.exit(1);
}

const fullMarkdown = readFileSync(mdPath, 'utf8');
const totalBytes = encoder.encode(fullMarkdown).length;
console.log(`Report: ${fullMarkdown.split('\n').length} lines, ${totalBytes} bytes`);

// Split into chunks at module (##) boundaries, then card (###) if needed
function splitMarkdown(md, limit) {
  const lines = md.split('\n');
  const headerEnd = lines.findIndex((l, i) => i > 0 && l.startsWith('## '));
  const header = lines.slice(0, headerEnd > 0 ? headerEnd : 2).join('\n') + '\n';
  const headerBytes = encoder.encode(header).length;

  // Gather cards: each card starts with ### N.
  const cards = [];
  let current = [];
  let inCard = false;
  for (const line of lines) {
    if (line.startsWith('### ')) {
      if (current.length) cards.push(current.join('\n'));
      current = [line];
      inCard = true;
    } else if (inCard || line.startsWith('## ')) {
      current.push(line);
    }
  }
  if (current.length) cards.push(current.join('\n'));

  // Pack cards into chunks under byte limit
  const chunks = [];
  let chunk = '';
  for (const card of cards) {
    const candidate = chunk ? `${chunk}\n${card}` : `${header}\n${card}`;
    if (encoder.encode(candidate).length > limit && chunk) {
      chunks.push(chunk);
      chunk = `${header}\n${card}`;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) chunks.push(chunk);
  return chunks.length ? chunks : [md];
}

const chunks = splitMarkdown(fullMarkdown, DINGTALK_BYTE_LIMIT);
console.log(`Split into ${chunks.length} message(s)`);

for (let i = 0; i < chunks.length; i++) {
  const chunk = chunks[i];
  const bytes = encoder.encode(chunk).length;
  const label = chunks.length > 1 ? `美妆法务资讯（${i + 1}/${chunks.length}）` : '美妆法务资讯';
  console.log(`  Chunk ${i + 1}: ${bytes} bytes`);

  const body = JSON.stringify({
    msgtype: 'markdown',
    markdown: { title: label, text: chunk },
  });

  const timestamp = Date.now();
  const url = secret
    ? await buildSignedUrl(webhookUrl, secret, timestamp)
    : webhookUrl;

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const result = await resp.json();

  if (result.errcode !== 0) {
    console.error(`  FAILED: ${result.errmsg}`);
    process.exit(1);
  }
  console.log(`  OK`);
}

console.log('Delivery complete');

async function buildSignedUrl(webhook, sec, ts) {
  const { createHmac } = await import('node:crypto');
  const sign = createHmac('sha256', sec).update(`${ts}\n${sec}`).digest('base64');
  return `${webhook}&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
}
