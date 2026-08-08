// Send weekly report to DingTalk — short message with PDF link if available,
// otherwise full markdown in chunks.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const mdPath = resolve(process.argv[2] || 'out/latest-report.md');
const webhookUrl = process.env.DINGTALK_WEBHOOK_URL;
const secret = process.env.DINGTALK_SECRET || '';
const noDelivery = process.env.NO_DELIVERY === '1';
const DINGTALK_BYTE_LIMIT = 18000;
const encoder = new TextEncoder();

if (noDelivery) { console.log('NO_DELIVERY=1, skipping'); process.exit(0); }
if (!webhookUrl) { console.error('DINGTALK_WEBHOOK_URL not set'); process.exit(1); }

const today = new Date().toISOString().slice(0, 10);

// --- Check for PDF ---
const urlPath = resolve('out/report-url.txt');
const pdfUrl = existsSync(urlPath) ? readFileSync(urlPath, 'utf8').trim() : '';
let usePdf = false;

if (pdfUrl) {
  // Wait for GitHub Pages to serve the PDF (may take seconds after push)
  console.log(`Waiting for PDF: ${pdfUrl}`);
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetch(pdfUrl, { method: 'HEAD', signal: AbortSignal.timeout(8000) });
      if (r.ok) { usePdf = true; break; }
      console.log(`  attempt ${i + 1}: HTTP ${r.status}`);
    } catch { console.log(`  attempt ${i + 1}: unreachable`); }
    await new Promise(r => setTimeout(r, 5000));
  }
  // Verify PDF has real content (not a placeholder page)
  if (usePdf) {
    try {
      const check = await fetch(pdfUrl, { signal: AbortSignal.timeout(10000) });
      const body = await check.text();
      if (body.length < 2000 || /beauty-legal-bot v3|weekly AI-reviewed|<!DOCTYPE html/.test(body)) {
        console.error(`PDF content appears to be placeholder (${body.length}B), falling back`);
        usePdf = false;
      }
    } catch { usePdf = false; }
  }
}

// --- Send ---
if (usePdf) {
  // Read card data for executive summary
  let summaryLines = [];
  try {
    const cardsPath = resolve('out/assembled-cards.json');
    const { cards } = JSON.parse(readFileSync(cardsPath, 'utf8'));
    const actionCards = cards.filter(c => c.tier === 'action').slice(0, 3);
    const topCards = cards.sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 5);
    if (topCards.length) {
      summaryLines.push('', '> **本期要点**', '> ');
      for (const c of topCards.slice(0, 5)) {
        const badge = c.tier === 'action' ? '🔴' : '🔵';
        const mod = c.module ? c.module.slice(0, 4) : '';
        summaryLines.push(`> ${badge} ${c.title ? c.title.slice(0, 50) : ''}`);
      }
    }
  } catch (_) { /* no cards data, skip summary */ }

  const msg = [
    `# 美妆法务资讯周报｜${today}`,
    '',
    `📄 [下载完整报告（PDF）](${pdfUrl})`,
    ...summaryLines,
    '',
    `---`,
    `*杭州丽知法务部 · 自动生成 · ${today}*`,
  ].join('\n');

  // Truncate if DingTalk byte limit exceeded (short messages shouldn't, but be safe)
  const msgBytes = encoder.encode(msg).length;
  if (msgBytes > DINGTALK_BYTE_LIMIT) {
    // Drop summary lines until it fits
    const withoutSummary = [
      `# 美妆法务资讯周报｜${today}`,
      '',
      `📄 [下载完整报告（PDF）](${pdfUrl})`,
      '',
      `> 完整内容请下载 PDF 查看`,
      '',
      `---`,
      `*杭州丽知法务部 · 自动生成 · ${today}*`,
    ].join('\n');
    const body = JSON.stringify({ msgtype: 'markdown', markdown: { title: `美妆法务资讯周报｜${today}`, text: withoutSummary } });
    const url = secret ? await buildSignedUrl(webhookUrl, secret, Date.now()) : webhookUrl;
    const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    const result = await resp.json();
    console.log(`DingTalk (summary too long, truncated): ${result.errcode === 0 ? 'OK' : 'FAILED: ' + result.errmsg}`);
    process.exit(result.errcode === 0 ? 0 : 1);
  }

  const body = JSON.stringify({ msgtype: 'markdown', markdown: { title: `美妆法务资讯周报｜${today}`, text: msg } });
  const url = secret ? await buildSignedUrl(webhookUrl, secret, Date.now()) : webhookUrl;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const result = await resp.json();
  console.log(`DingTalk: ${result.errcode === 0 ? 'OK' : 'FAILED: ' + result.errmsg}`);
  process.exit(result.errcode === 0 ? 0 : 1);
}

// --- Fallback: full markdown in chunks ---
const fullMarkdown = readFileSync(mdPath, 'utf8');
console.log(`Sending full markdown (${encoder.encode(fullMarkdown).length} bytes)`);

const lines = fullMarkdown.split('\n');
const headerEnd = lines.findIndex((l, i) => i > 0 && l.startsWith('## '));
const header = lines.slice(0, headerEnd > 0 ? headerEnd : 2).join('\n') + '\n';
const cards = [];
let cur = [];
for (const line of lines) {
  if (line.startsWith('### ')) { if (cur.length) cards.push(cur.join('\n')); cur = [line]; }
  else if (cur.length || line.startsWith('## ')) cur.push(line);
}
if (cur.length) cards.push(cur.join('\n'));

const chunks = [];
let chunk = '';
for (const card of cards) {
  const candidate = chunk ? chunk + '\n' + card : header + '\n' + card;
  if (encoder.encode(candidate).length > DINGTALK_BYTE_LIMIT && chunk) { chunks.push(chunk); chunk = header + '\n' + card; }
  else chunk = candidate;
}
if (chunk) chunks.push(chunk);

let cardNumber = 0;
for (let i = 0; i < chunks.length; i++) {
  let c = chunks[i];
  c = c.replace(/^### \d+\./gm, () => { cardNumber++; return `### ${cardNumber}.`; });
  const bytes = encoder.encode(c).length;
  const label = chunks.length > 1 ? `美妆法务资讯｜${today}（${i + 1}/${chunks.length}）` : `美妆法务资讯｜${today}`;
  const body = JSON.stringify({ msgtype: 'markdown', markdown: { title: label, text: c } });
  const url = secret ? await buildSignedUrl(webhookUrl, secret, Date.now()) : webhookUrl;
  const resp = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
  const result = await resp.json();
  if (result.errcode !== 0) { console.error(`Chunk ${i + 1} failed: ${result.errmsg}`); process.exit(1); }
  console.log(`Chunk ${i + 1}/${chunks.length}: OK (${bytes}B)`);
}
console.log('Delivery complete');

async function buildSignedUrl(webhook, sec, ts) {
  const { createHmac } = await import('node:crypto');
  const sign = createHmac('sha256', sec).update(`${ts}\n${sec}`).digest('base64');
  return `${webhook}&timestamp=${ts}&sign=${encodeURIComponent(sign)}`;
}
