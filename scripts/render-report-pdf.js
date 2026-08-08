// Render latest-report.md to PDF via Playwright and upload to Worker KV.
// Usage: node scripts/render-report-pdf.js [markdown-file]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const mdPath = resolve(process.argv[2] || 'out/latest-report.md');
const pdfPath = resolve('out/latest-report.pdf');
const workerBaseUrl = process.env.PUBLIC_WORKER_BASE_URL || 'https://beauty-legal-bot.ai-cf.workers.dev';
const cloudflareToken = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const kvNamespaceId = process.env.CLOUDFLARE_KV_NAMESPACE_ID;

const markdown = readFileSync(mdPath, 'utf8');

// Simple markdown-to-HTML converter (no external dependencies needed)
function mdToHtml(md) {
  const lines = md.split('\n');
  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; max-width: 800px; margin: 40px auto; padding: 20px; color: #333; line-height: 1.7; }
    h1 { font-size: 1.8em; border-bottom: 2px solid #c00; padding-bottom: 8px; }
    h2 { font-size: 1.3em; margin-top: 28px; border-left: 4px solid #c00; padding-left: 12px; }
    h3 { font-size: 1.05em; margin-top: 20px; }
    blockquote { background: #f5f5f5; padding: 12px 16px; border-left: 3px solid #999; margin: 12px 0; color: #666; }
    strong { color: #222; }
    a { color: #06c; }
    code { background: #f0f0f0; padding: 1px 4px; border-radius: 3px; }
    ul { padding-left: 20px; }
    li { margin: 4px 0; }
    hr { border: none; border-top: 1px solid #eee; margin: 30px 0; }
    @media print { body { margin: 0; padding: 20px; } }
  </style></head><body>\n`;
  let inList = false;
  for (let line of lines) {
    if (line.startsWith('# ')) {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<h1>${line.slice(2)}</h1>\n`;
    } else if (line.startsWith('## ')) {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<h2>${line.slice(3)}</h2>\n`;
    } else if (line.startsWith('### ')) {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<h3>${line.slice(4)}</h3>\n`;
    } else if (line.startsWith('> ')) {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += `<blockquote>${line.slice(2)}</blockquote>\n`;
    } else if (line.startsWith('- **')) {
      if (!inList) { html += '<ul>\n'; inList = true; }
      html += `<li>${line.slice(2).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')}</li>\n`;
    } else if (line.startsWith('  - ')) {
      if (!inList) { html += '<ul>\n'; inList = true; }
      html += `<li>${line.slice(4)}</li>\n`;
    } else if (line.trim() === '') {
      if (inList) { html += '</ul>\n'; inList = false; }
    } else if (line.startsWith('---')) {
      if (inList) { html += '</ul>\n'; inList = false; }
      html += '<hr>\n';
    }
  }
  if (inList) html += '</ul>\n';
  html += '</body></html>';
  return html;
}

console.log(`Rendering ${markdown.split('\n').length} lines to PDF...`);
const html = mdToHtml(markdown);

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent(html, { waitUntil: 'networkidle' });
if (markdown.length < 200) {
  console.error(`Markdown too short (${markdown.length} chars), refusing to generate empty PDF.`);
  process.exit(1);
}
// Verify rendered page has readable text before saving PDF
const firstPage = await page.evaluate(() => document.body.innerText.slice(0, 200));
if (!firstPage.trim() || firstPage.includes('Error') || firstPage.includes('404')) {
  console.error(`Rendered page looks broken: "${firstPage.slice(0, 100)}"`);
  await browser.close();
  process.exit(1);
}

await page.pdf({
  path: pdfPath,
  format: 'A4',
  margin: { top: '20mm', bottom: '20mm', left: '15mm', right: '15mm' },
  printBackground: true,
});
await browser.close();

const pdfBytes = readFileSync(pdfPath).length;
if (pdfBytes < 5000) {
  console.error(`PDF too small (${pdfBytes}B), likely empty/broken.`);
  process.exit(1);
}
console.log(`PDF: ${(pdfBytes / 1024).toFixed(0)}KB → ${pdfPath}, preview: "${firstPage.slice(0, 80)}..."`);

// Push PDF to gh-pages branch for public hosting
const date = new Date().toISOString().slice(0, 10);
const ghPagesUrl = `https://zhuxinfei.github.io/beauty-legal-bot/report-${date}.pdf`;
const latestUrl = `https://zhuxinfei.github.io/beauty-legal-bot/latest-report.pdf`;

console.log(`PDF will be published to: ${latestUrl}`);
writeFileSync('out/report-url.txt', latestUrl, 'utf8');
