import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { normalizeHydratedPayload } from '../worker/source-hydration.js';
import {
  filterHydrationAcquisitionSources,
  isHardFactAcquisitionSource,
} from '../worker/source-acquisition.js';

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
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator
    from crawl4ai.content_filter_strategy import PruningContentFilter
except Exception as exc:
    print(json.dumps({"error": f"crawl4ai import failed: {exc}"}))
    raise SystemExit(1)

spec = json.loads(${JSON.stringify(JSON.stringify(spec))})
base_directory = os.getenv("CRAWL4_AI_BASE_DIRECTORY", ${JSON.stringify('/private/tmp/beauty-legal-bot-crawl4ai')})
attachment_limit = max(0, int(os.getenv("CRAWL4AI_ATTACHMENT_LIMIT", ${JSON.stringify(Number.isFinite(attachmentLimit) ? Math.max(0, attachmentLimit) : 3)})))
detail_link_limit = max(0, int(os.getenv("CRAWL4AI_DETAIL_LINK_LIMIT", "12")))
crawl_timeout_seconds = max(8, int(os.getenv("CRAWL4AI_CRAWL_TIMEOUT_SECONDS", "${Math.ceil(Math.max(5000, Number(pageTimeoutMs) || 20000) / 1000) + 8}")))

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

def extract_detail_urls(markdown, base_url, module=""):
    source = text_value(markdown)
    module_patterns = {
        "知识产权动态": r"商标|专利|著作权|版权|侵权|仿冒|包装装潢|判决|裁定|赔偿|品牌",
        "进出口动态": r"海关|进口|出口|清关|扣留|退运|通关|跨境|口岸|关税|报关|HS\\s*编码|原产地",
        "美妆动态": r"平台规则|平台治理|电商|品牌|商家|下架|禁售|合规|公告|通知|政策|规则",
        "广告合规及处罚案例": r"广告|虚假宣传|功效宣称|直播|刷单|处罚|罚款|行政执法",
        "产品质量/召回与安全风险": r"召回|抽检|不合格|不符合规定|风险|安全|禁用|限用|批次|成分|微生物",
        "新规及案例动态": r"法规|办法|条例|标准|征求意见|备案|注册|公告|通告|实施|生效|原料|成分",
    }
    beauty_pattern = re.compile(r"化妆品|美妆|护肤|彩妆|香水|防晒|染发|着色剂|功效宣称|备案|注册人|标签|包装|配方|原料|成分", re.I)
    module_pattern = re.compile(module_patterns.get(module, r""), re.I)
    hard_pattern = re.compile(r"行政处罚|处罚决定|典型案例|征求意见|公告|通告|标准|新旧衔接|商标|专利|侵权|虚假宣传|功效宣称|平台治理|专项治理|治理公告|海关|进口|出口|HS\\s*编码|附件|pdf|xlsx?", re.I)
    urls = []
    for match in re.finditer(r"\\[([^\\]]{2,120})\\]\\(([^)]+)\\)", source, flags=re.I):
        label = match.group(1) or ""
        href = match.group(2) or ""
        if (beauty_pattern.search(label) or beauty_pattern.search(href) or module_pattern.search(label) or module_pattern.search(href)) and (hard_pattern.search(label) or hard_pattern.search(href) or module_pattern.search(label) or module_pattern.search(href)):
            urls.append((label, href))
    for match in re.finditer(r"https?://[^\\s)]+", source, flags=re.I):
        href = match.group(0)
        if (beauty_pattern.search(href) or module_pattern.search(href)) and (hard_pattern.search(href) or module_pattern.search(href)):
            urls.append((href, href))
    seen = set()
    normalized = []
    def sanitize_detail_href(raw):
        href = text_value(raw).strip().strip('"').strip("'")
        match = re.search(r'''(https?://[^\\s)"']+?\\.html?)''', href, flags=re.I)
        if match:
            return match.group(1)
        match = re.search(r'''([^\\s)"']+?\\.html?)''', href, flags=re.I)
        if match:
            return match.group(1)
        return href
    for label, raw in urls:
        absolute = urljoin(base_url or "", sanitize_detail_href(raw))
        if not absolute or absolute in seen:
            continue
        seen.add(absolute)
        normalized.append({"url": absolute, "title": label})
    return normalized[:detail_link_limit]

async def crawl_one(crawler, url, item, module, config, attachment=False):
    result = await asyncio.wait_for(crawler.arun(url=url, config=config), timeout=crawl_timeout_seconds)
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
        "discovery_module": item.get("discovery_module", "") or module,
        "discovery_query": item.get("discovery_query", "") or "",
        "source_name": item.get("name", "") or item.get("source_name", "") or "",
        "source_scope": item.get("source_scope", "") or "",
        "source_type": item.get("source_type", "") or "",
        "authority_type": item.get("authority_type", "") or "",
        "publisher_host": item.get("publisher_host", "") or "",
        "discovery_provider": item.get("discovery_provider", "") or "",
        "priority": item.get("priority", "") or "",
        "topics": item.get("topics", []) or [],
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
                module = item.get("discovery_module") or item.get("module") or ""
                try:
                    config = CrawlerRunConfig(
                        word_count_threshold=80,
                        scan_full_page=True,
                        wait_for_images=False,
                        remove_consent_popups=True,
                        adjust_viewport_to_content=True,
                        markdown_generator=DefaultMarkdownGenerator(content_filter=PruningContentFilter()),
                        page_timeout=${JSON.stringify(Math.max(5000, Number(pageTimeoutMs) || 20000))},
                        cache_mode=CacheMode.BYPASS if hasattr(CacheMode, "BYPASS") else None,
                    )
                    record = await crawl_one(crawler, url, item, module, config)
                    detail_links = extract_detail_urls("\\n".join([
                        record.get("fit_markdown", ""),
                        record.get("raw_markdown", ""),
                        record.get("references_markdown", ""),
                    ]), record.get("final_url") or url, module)
                    record["detail_urls"] = [detail.get("url") for detail in detail_links if detail.get("url")]
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
                    for detail in detail_links:
                        detail_url = detail.get("url") or ""
                        if not detail_url or detail_url == (record.get("final_url") or url):
                            continue
                        try:
                            detail_item = dict(item)
                            if detail.get("title"):
                                detail_item["title"] = detail.get("title")
                            detail_record = await crawl_one(crawler, detail_url, detail_item, module, config)
                            detail_record["parent_url"] = record.get("final_url") or url
                            detail_record["discovered_from"] = "lead_page"
                            detail_attachment_records = []
                            for attachment_url in extract_attachment_urls("\\n".join([
                                detail_record.get("fit_markdown", ""),
                                detail_record.get("raw_markdown", ""),
                                detail_record.get("references_markdown", ""),
                            ]), detail_record.get("final_url") or detail_url, module):
                                try:
                                    attachment_record = await crawl_one(crawler, attachment_url, item, module, config, attachment=True)
                                    attachment_record["parent_url"] = detail_record.get("final_url") or detail_url
                                    detail_attachment_records.append(attachment_record)
                                except Exception as attachment_exc:
                                    detail_attachment_records.append({
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
                                        "parent_url": detail_record.get("final_url") or detail_url,
                                    })
                            detail_record["attachment_urls"] = [attachment.get("url") for attachment in detail_attachment_records if attachment.get("url")]
                            detail_record["attachment_records"] = detail_attachment_records
                            results.append(detail_record)
                        except Exception as detail_exc:
                            results.append({
                                "url": detail_url,
                                "final_url": detail_url,
                                "title": detail.get("title", "") or "",
                                "published_at": item.get("published_at", "") or "",
                                "country": item.get("country", "") or "",
                                "region": item.get("region", "") or "",
                                "module": module,
                                "discovery_module": item.get("discovery_module", "") or module,
                                "discovery_query": item.get("discovery_query", "") or "",
                                "source_name": item.get("name", "") or item.get("source_name", "") or "",
                                "raw_markdown": "",
                                "fit_markdown": "",
                                "references_markdown": "",
                                "article_text": "",
                                "snippet": "",
                                "metadata": {},
                                "extraction": {},
                                "crawl_status": "failed",
                                "quality_flags": [str(detail_exc)],
                                "source_url": detail_url,
                                "parent_url": record.get("final_url") or url,
                                "discovered_from": "lead_page",
                            })
                except Exception as exc:
                    results.append({
                        "url": url,
                        "final_url": url,
                        "title": item.get("title", "") or "",
                        "published_at": item.get("published_at", "") or "",
                        "country": item.get("country", "") or "",
                        "region": item.get("region", "") or "",
                        "module": module,
                        "discovery_module": item.get("discovery_module", "") or module,
                        "discovery_query": item.get("discovery_query", "") or "",
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
  if (/药监|市场监督|市场监管|海关|法院|知识产权|标准|处罚|商标|进出口|平台治理|功效宣称|虚假宣传|美妆合规/.test(text)) score += 200;
  if (item.monitor_only) score -= 100;
  return score;
}

export function prioritizeHydrationSources(records = []) {
  return [...records].sort((a, b) => {
    const scopeDelta = Number(isHardFactAcquisitionSource(b)) - Number(isHardFactAcquisitionSource(a));
    return scopeDelta || hydrationSourceScore(b) - hydrationSourceScore(a);
  });
}

export function selectHydrationSources(records = [], { limit = 0, minimumPerModule = 0, modules = [] } = {}) {
  const eligible = prioritizeHydrationSources(filterHydrationAcquisitionSources(records));
  const capacity = limit > 0 ? Math.min(limit, eligible.length) : eligible.length;
  const selected = [];
  const selectedKeys = new Set();
  const keyFor = item => String(item?.url || item?.source_url || '').trim();
  const take = item => {
    if (!item) return false;
    const key = keyFor(item);
    if (!key || selectedKeys.has(key) || selected.length >= capacity) return false;
    selected.push(item);
    selectedKeys.add(key);
    return true;
  };

  // Reserve a crawl slot for every module, including official list pages.
  // List pages are seeds only; premium evidence still requires a concrete
  // detail record after hydration.
  const floorEligible = eligible;
  for (let round = 0; round < Math.max(0, minimumPerModule); round += 1) {
    for (const module of modules) {
      take(floorEligible.filter(item => (item.discovery_module || item.module) === module)[round]);
    }
  }
  for (const item of eligible) take(item);
  return selected;
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

export function annotateHydratedRecords(records = []) {
  return normalizeHydratedPayload({ records });
}

export function hydrationEvidenceStats(records = []) {
  const rows = Array.isArray(records) ? records : [];
  return {
    hardFactReady: rows.filter(record => record.evidence_grade === 'hard_fact_ready').length,
    chinaHardFactReady: rows.filter(record => record.evidence_grade === 'hard_fact_ready' && record.country === '中国').length,
    leadOnly: rows.filter(record => record.evidence_grade === 'lead_only').length,
    attachmentPending: rows.filter(record => record.evidence_grade === 'attachment_pending').length,
    reject: rows.filter(record => record.evidence_grade === 'reject').length,
  };
}

function assertHydrationTextGate(records = []) {
  const stats = hydrationTextStats(records);
  const evidence = hydrationEvidenceStats(records);
  const configuredMin = Number(process.env.MIN_CRAWL4AI_WITH_TEXT || 6);
  const min = Math.min(configuredMin, Math.max(1, Math.ceil(stats.records / 2)));
  console.error(`hydrated records=${stats.records}, china=${stats.china}, withText=${stats.withText}, attachments=${stats.attachments}`);
  console.error(`hard_fact_ready=${evidence.hardFactReady}, china_hard_fact_ready=${evidence.chinaHardFactReady}, lead_only=${evidence.leadOnly}, attachment_pending=${evidence.attachmentPending}, reject=${evidence.reject}`);
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

  const loaded = filterHydrationAcquisitionSources(await loadInput(resolve(input)));
  const manualPreviewLimit = process.env.GITHUB_EVENT_NAME === 'workflow_dispatch'
    ? Number(process.env.CRAWL4AI_PREVIEW_LIMIT || 39)
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
  const spec = selectHydrationSources(loaded, {
    limit: effectiveLimit,
    minimumPerModule: Number(process.env.CRAWL4AI_MIN_PER_MODULE || 6),
    modules: [...new Set(loaded.map(item => item.discovery_module || item.module).filter(Boolean))],
  });
  if (manualPreviewLimit > 0) {
    console.log(`Manual preview Crawl4AI limit: ${spec.length}/${loaded.length} sources`);
  }
  const env = { ...process.env };
  if (baseDir) env.CRAWL4_AI_BASE_DIRECTORY = baseDir;
  if (manualPreviewLimit > 0) {
    const currentDetailLimit = Number(env.CRAWL4AI_DETAIL_LINK_LIMIT || 12);
    const previewDetailLimit = Number(env.CRAWL4AI_PREVIEW_DETAIL_LINK_LIMIT || 3);
    env.CRAWL4AI_DETAIL_LINK_LIMIT = String(Math.min(currentDetailLimit, previewDetailLimit));
    env.CRAWL4AI_CRAWL_TIMEOUT_SECONDS = String(Math.ceil(effectivePageTimeoutMs / 1000) + 5);
  }
  const stdout = execFileSync(python, ['-c', buildPythonScript(spec, { pageTimeoutMs: effectivePageTimeoutMs, attachmentLimit: effectiveAttachmentLimit, outputPath: output ? resolve(output) : '' })], { encoding: 'utf8', env, maxBuffer: 1024 * 1024 * 200 });

  if (output) {
    const summary = stdout.trim() ? JSON.parse(stdout.trim()) : { records: spec.length, output: resolve(output) };
    const payload = JSON.parse(await readFile(resolve(output), 'utf8'));
    const annotated = annotateHydratedRecords(payload.records || []);
    await writeFile(resolve(output), `${JSON.stringify({ records: annotated }, null, 2)}\n`);
    assertHydrationTextGate(annotated);
    console.log(`Generated ${summary.output || resolve(output)} (${summary.records || spec.length} records)`);
  } else {
    const payload = annotateHydratedRecords(JSON.parse(stdout).records || []);
    assertHydrationTextGate(payload);
    process.stdout.write(`${JSON.stringify({ records: payload }, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
