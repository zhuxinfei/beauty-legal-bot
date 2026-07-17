import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildEditorialReportHtml } from '../worker/editorial-report-image.js';

export async function renderEditorialReportPng({
  report,
  browserType,
  outputPath = '',
  generatedAt = new Date().toISOString(),
} = {}) {
  if (!report) throw new Error('Editorial report data is required');
  const chromium = browserType || (await import('playwright')).chromium;
  const browser = await chromium.launch({ headless: true });
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1080, height: 1600 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const page = await context.newPage();
    const html = buildEditorialReportHtml(report, { generatedAt });
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const png = new Uint8Array(await page.screenshot({
      type: 'png',
      fullPage: true,
      animations: 'disabled',
    }));
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, png);
    }
    return png;
  } finally {
    if (context) await context.close();
    await browser.close();
  }
}

async function main() {
  const input = resolve(process.argv[2] || 'worker/sample-report.json');
  const output = resolve(process.argv[3] || 'out/editorial-report.png');
  const report = JSON.parse(await readFile(input, 'utf8'));
  const png = await renderEditorialReportPng({ report, outputPath: output });
  console.log(`Generated ${output} (${png.byteLength} bytes)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
