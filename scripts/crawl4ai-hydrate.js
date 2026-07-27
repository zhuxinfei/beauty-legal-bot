import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeHydratedPayload } from '../worker/source-hydration.js';

function parseArgs(argv) {
  const args = {
    input: '',
    output: '',
    python: process.env.CRAWL4AI_PYTHON || process.env.PYTHON || 'python3',
    baseDir: process.env.CRAWL4_AI_BASE_DIRECTORY || '',
    limit: Number(process.env.CRAWL4AI_LIMIT || 0),
    pageTimeoutMs: Number(process.env.CRAWL4AI_PAGE_TIMEOUT_MS || 20000),
    attachmentLimit: Number(process.env.CRAWL4AI_ATTACHMENT_LIMIT || 3),
  };
  const positional = [];
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--input' || token === '-i') {
      args.input = argv[++i] || '';
    } else if (token === '--output' || token === '-o') {
      args.output = argv[++i] || '';
    } else if (token === '--python') {
      args.python = argv[++i] || args.python;
    } else if (token === '--base-dir') {
      args.baseDir = argv[++i] || args.baseDir;
    } else if (token === '--limit') {
      args.limit = Number(argv[++i] || args.limit);
    } else if (token === '--page-timeout-ms') {
      args.pageTimeoutMs = Number(argv[++i] || args.pageTimeoutMs);
    } else if (token === '--attachment-limit') {
      args.attachmentLimit = Number(argv[++i] || args.attachmentLimit);
    } else {
      positional.push(token);
    }
  }
  if (!args.input && positional[0]) args.input = positional[0];
  if (!args.output && positional[1]) args.output = positional[1];
  return args;
}

function buildPythonScript(spec, { pageTimeoutMs = 20000, outputPath = '', attachmentLimit = 3 } = {}) {
  return `
import asyncio
import json
import os
import re
import sys
from urllib.parse import urljoin

try:
    from crawl4ai import AsyncWebCrawler, BrowserConfig, CrawlerRunConfig, CacheMode
except Exception as exc:
    print(json.dumps({"error": f"crawl4ai import failed: {exc}"}))
    raise SystemExit(1)

spec = json.loads(${JSON.stringify(JSON.stringify(spec))})
base_directory = os.getenv("CRAWL4_AI_BASE_DIRECTORY", ${JSON.stringify('/private/tmp/beauty-legal-bot-crawl4ai')})
attachment_limit = max(0, int(os.getenv("CRAWL4AI_ATTACHMENT_LIMIT", ${JSON.stringify(Number.isFinite(attachmentLimit) ? Math.max(0, attachmentLimit) : 3)})))

def text_value(value):
    return value if isinstance(value, str) else ""

def extract_attachment_urls(markdown, base_url):
    source = text_value(markdown)
    urls = []
    for match in re.finditer(r"\\[[^\\]]+\\]\\(([^)]+?\\.(?:pdf|docx?|xlsx?))(?:[?#][^)]*)?\\)", source, flags=re.I):
        urls.append(match.group(1))
    for match in re.finditer(r"https?://[^\\s)]+?\\.(?:pdf|docx?|xlsx?)(?:[?#][^\\s)]*)?", source, flags=re.I):
        urls.append(match.group(0))
    seen = set()
    normalized = []
    for raw in urls:
        absolute = urljoin(base_url or "", raw)
        if not absolute or absolute in seen:
            continue
        seen.add(absolute)
        normalized.append(absolute)
    return normalized[:attachment_limit]

async def crawl_one(crawler, url, item, module, config, attachment=False):
    result = await crawler.arun(url=url, config=config)
    metadata = getattr(result, "metadata", {}) or {}
    extraction = getattr(result, "extraction", None) or getattr(result, "extracted_content", None) or {}
    markdown = getattr(result, "markdown", "") or ""
    fit_markdown = getattr(result, "fit_markdown", "") or ""
    references_markdown = getattr(result, "references_markdown", "") or ""
    title = getattr(result, "title", "") or metadata.get("title", "") or item.get("title", "") or ""
    final_url = getattr(result, "url", "") or getattr(result, "final_url", "") or url
    body = markdown or fit_markdown or getattr(result, "text", "") or ""
    return {
        "url": url,
        "final_url": final_url,
        "title": title,
        "published_at": item.get("published_at", "") or metadata.get("published_time", "") or metadata.get("date", "") or "",
        "country": item.get("country", "") or "",
        "region": item.get("region", "") or "",
        "module": module,
        "source_name": item.get("name", "") or item.get("source_name", "") or "",
        "raw_markdown": markdown,
        "fit_markdown": fit_markdown,
        "references_markdown": references_markdown,
        "article_text": body,
        "snippet": body[:1200],
        "metadata": metadata,
        "extraction": extraction,
        "crawl_status": "attachment_hydrated" if attachment else "hydrated",
        "quality_flags": [],
        "source_url": url,
    }

async def run():
    browser_config = BrowserConfig(headless=True)
    results = []
    try:
        async with AsyncWebCrawler(config=browser_config, base_directory=base_directory) as crawler:
            for item in spec:
                url = item.get("url") or item.get("source_url") or ""
                module = item.get("module") or ""
                try:
                    config = CrawlerRunConfig(
                        word_count_threshold=80,
                        scan_full_page=True,
                        wait_for_images=False,
                        remove_consent_popups=True,
                        adjust_viewport_to_content=True,
                        page_timeout=${JSON.stringify(Math.max(5000, Number(pageTimeoutMs) || 20000))},
                        cache_mode=CacheMode.BYPASS if hasattr(CacheMode, "BYPASS") else None,
                    )
                    record = await crawl_one(crawler, url, item, module, config)
                    attachment_records = []
                    for attachment_url in extract_attachment_urls("\\n".join([
                        record.get("fit_markdown", ""),
                        record.get("raw_markdown", ""),
                        record.get("references_markdown", ""),
                    ]), record.get("final_url") or url):
                        try:
                            attachment_record = await crawl_one(crawler, attachment_url, item, module, config, attachment=True)
                            attachment_record["parent_url"] = record.get("final_url") or url
                            attachment_records.append(attachment_record)
                        except Exception as attachment_exc:
                            attachment_records.append({
                                "url": attachment_url,
                                "final_url": attachment_url,
                                "title": "",
                                "article_text": "",
                                "raw_markdown": "",
                                "fit_markdown": "",
                                "references_markdown": "",
                                "crawl_status": "attachment_failed",
                                "quality_flags": [str(attachment_exc)],
                                "source_url": attachment_url,
                                "parent_url": record.get("final_url") or url,
                            })
                    record["attachment_urls"] = [attachment.get("url") for attachment in attachment_records if attachment.get("url")]
                    record["attachment_records"] = attachment_records
                    results.append(record)
                except Exception as exc:
                    results.append({
                        "url": url,
                        "final_url": url,
                        "title": item.get("title", "") or "",
                        "published_at": item.get("published_at", "") or "",
                        "country": item.get("country", "") or "",
                        "region": item.get("region", "") or "",
                        "module": module,
                        "source_name": item.get("name", "") or item.get("source_name", "") or "",
                        "raw_markdown": "",
                        "fit_markdown": "",
                        "references_markdown": "",
                        "article_text": "",
                        "snippet": "",
                        "metadata": {},
                        "extraction": {},
                        "crawl_status": "failed",
                        "quality_flags": [str(exc)],
                        "source_url": url,
                    })
    except Exception as exc:
        results.append({
            "url": "",
            "final_url": "",
            "title": "",
            "published_at": "",
            "country": "",
            "region": "",
            "module": "",
            "source_name": "",
            "raw_markdown": "",
            "fit_markdown": "",
            "references_markdown": "",
            "article_text": "",
            "snippet": "",
            "metadata": {},
            "extraction": {},
            "crawl_status": "failed",
            "quality_flags": [str(exc)],
            "source_url": "",
        })

    payload = json.dumps({"records": results}, ensure_ascii=False, indent=2)
    ${outputPath ? `with open(${JSON.stringify(outputPath)}, "w", encoding="utf-8") as handle:\n        handle.write(payload + "\\n")\n    print(json.dumps({"records": len(results), "output": ${JSON.stringify(outputPath)}}))` : 'print(payload)'}

asyncio.run(run())
`;
}

async function loadInput(inputPath) {
  const raw = await readFile(inputPath, 'utf8');
  const parsed = JSON.parse(raw);
  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.sources)
      ? parsed.sources
      : Array.isArray(parsed.records)
        ? parsed.records
        : [];
  return records.filter(item => /^https?:\/\//i.test(String(item?.url || item?.source_url || '')));
}

function hydrationSourceScore(item = {}) {
  const text = `${item.name || ''} ${item.source_name || ''} ${item.module || ''} ${(item.topics || []).join(' ')} ${item.url || item.source_url || ''}`;
  let score = 0;
  if (item.country === '中国') score += 10000;
  if (item.authority_type === 'regulator') score += 1000;
  if (item.source_type === 'official_site') score += 500;
  if (item.priority === 'high') score += 300;
  if (/药监|市场监督|市场监管|海关|法院|知识产权|标准|处罚|商标|进出口/.test(text)) score += 200;
  if (item.monitor_only) score -= 100;
  return score;
}

export function prioritizeHydrationSources(records = []) {
  return [...records].sort((a, b) => hydrationSourceScore(b) - hydrationSourceScore(a));
}

function hydrationTextStats(records = []) {
  const rows = Array.isArray(records) ? records : [];
  return {
    records: rows.length,
    china: rows.filter(record => record.country === '中国').length,
    withText: rows.filter(record => String(record.article_text || record.raw_markdown || record.fit_markdown || '').length > 0).length,
    attachments: rows.reduce((sum, record) => sum + (Array.isArray(record.attachment_urls) ? record.attachment_urls.length : 0), 0),
  };
}

function assertHydrationTextGate(records = []) {
  const stats = hydrationTextStats(records);
  const min = Number(process.env.MIN_CRAWL4AI_WITH_TEXT || 6);
  console.error(`hydrated records=${stats.records}, china=${stats.china}, withText=${stats.withText}, attachments=${stats.attachments}`);
  if (stats.records && stats.withText < min) {
    throw new Error(`Crawl4AI withText below gate: ${stats.withText}/${stats.records}, min=${min}`);
  }
  return stats;
}

async function main() {
  const { input, output, python, baseDir, limit, pageTimeoutMs, attachmentLimit } = parseArgs(process.argv);
  if (!input) {
    throw new Error('Usage: node scripts/crawl4ai-hydrate.js --input worker/sources.json --output out/hydrated-sources.json');
  }

  const loaded = await loadInput(resolve(input));
  const manualPreviewLimit = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    ? Number(process.env.CRAWL4AI_PREVIEW_LIMIT || 24)
    : 0;
  const effectivePageTimeoutMs = manualPreviewLimit > 0
    ? Math.min(Number(pageTimeoutMs) || 20000, Number(process.env.CRAWL4AI_PREVIEW_TIMEOUT_MS || 12000))
    : pageTimeoutMs;
  const effectiveAttachmentLimit = manualPreviewLimit > 0
    ? Math.min(Number(attachmentLimit) || 0, Number(process.env.CRAWL4AI_PREVIEW_ATTACHMENT_LIMIT || 0))
    : attachmentLimit;
  const effectiveLimit = manualPreviewLimit > 0
    ? Math.min(limit > 0 ? limit : loaded.length, manualPreviewLimit)
    : limit;
  const prioritized = prioritizeHydrationSources(loaded);
  const spec = effectiveLimit > 0 ? prioritized.slice(0, effectiveLimit) : prioritized;
  if (manualPreviewLimit > 0) {
    console.log(`Manual preview Crawl4AI limit: ${spec.length}/${loaded.length} sources`);
  }
  const env = { ...process.env };
  if (baseDir) env.CRAWL4_AI_BASE_DIRECTORY = baseDir;
  const stdout = execFileSync(python, ['-c', buildPythonScript(spec, { pageTimeoutMs: effectivePageTimeoutMs, attachmentLimit: effectiveAttachmentLimit, outputPath: output ? resolve(output) : '' })], { encoding: 'utf8', env, maxBuffer: 1024 * 1024 * 200 });

  if (output) {
    const summary = stdout.trim() ? JSON.parse(stdout.trim()) : { records: spec.length, output: resolve(output) };
    const payload = JSON.parse(await readFile(resolve(output), 'utf8'));
    assertHydrationTextGate(payload.records || []);
    console.log(`Generated ${summary.output || resolve(output)} (${summary.records || spec.length} records)`);
  } else {
    const payload = normalizeHydratedPayload(stdout);
    assertHydrationTextGate(payload);
    process.stdout.write(`${JSON.stringify({ records: payload }, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
