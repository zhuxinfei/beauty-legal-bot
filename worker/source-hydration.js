function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function stripMarkdown(value) {
  return text(value)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/`+/g, '')
    .replace(/\s*⟨\d+⟩/g, '')
    .trim();
}

function normalizeKey(value) {
  const textValue = text(value);
  if (!textValue) return '';
  try {
    const url = new URL(textValue);
    url.hash = '';
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}${url.search}`;
  } catch {
    return textValue.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

function candidateKeys(candidate = {}) {
  return [
    normalizeKey(candidate.source_url),
    normalizeKey(candidate.url),
    normalizeKey(candidate.final_url),
  ].filter(Boolean);
}

function recordKeys(record = {}) {
  return [
    normalizeKey(record.source_url || record.url),
    normalizeKey(record.final_url),
    normalizeKey(record.url),
  ].filter(Boolean);
}

export function normalizeHydratedRecord(record = {}) {
  const sourceUrl = text(record.source_url || record.url);
  const finalUrl = text(record.final_url || record.url || record.source_url);
  const fitMarkdown = text(record.fit_markdown);
  const rawMarkdown = text(record.raw_markdown);
  const extractedText = text(
    record.article_text
      || record.extraction?.article_text
      || record.extraction?.text
      || record.extraction?.summary
      || ''
  );
  const articleText = fitMarkdown || rawMarkdown || extractedText;
  const qualityFlags = Array.isArray(record.quality_flags)
    ? record.quality_flags.map(text).filter(Boolean)
    : text(record.quality_flags)
      ? [text(record.quality_flags)]
      : [];

  return {
    ...record,
    url: finalUrl || sourceUrl,
    final_url: finalUrl || sourceUrl,
    source_url: sourceUrl || finalUrl,
    title: text(record.title),
    source_name: text(record.source_name || record.name),
    published_at: text(record.published_at),
    country: text(record.country || record.region || '未知'),
    region: text(record.region || ''),
    module: text(record.module || ''),
    raw_markdown: rawMarkdown,
    fit_markdown: fitMarkdown,
    references_markdown: text(record.references_markdown),
    article_text: articleText,
    full_text: articleText,
    snippet: text(record.snippet || stripMarkdown(articleText).slice(0, 1200)),
    metadata: record.metadata || {},
    extraction: record.extraction || {},
    crawl_status: text(record.crawl_status || 'hydrated'),
    quality_flags: qualityFlags,
    hydration_source: text(record.hydration_source || 'crawl4ai'),
  };
}

export function mergeHydratedCandidates(candidates = [], hydratedRecords = []) {
  const normalizedRecords = (Array.isArray(hydratedRecords) ? hydratedRecords : [])
    .map(normalizeHydratedRecord)
    .filter(record => record.url || record.source_url || record.title);

  const recordIndex = new Map();
  for (const record of normalizedRecords) {
    for (const key of recordKeys(record)) {
      if (!recordIndex.has(key)) recordIndex.set(key, record);
    }
  }

  let hydrated = 0;
  let unmatched = 0;
  const merged = (Array.isArray(candidates) ? candidates : []).map(candidate => {
    const keys = candidateKeys(candidate);
    const record = keys.map(key => recordIndex.get(key)).find(Boolean);
    if (!record) {
      unmatched += 1;
      return candidate;
    }
    hydrated += 1;
    const mergedQualityFlags = [
      ...new Set([
        ...(Array.isArray(candidate.quality_flags) ? candidate.quality_flags : []),
        ...(Array.isArray(record.quality_flags) ? record.quality_flags : []),
      ].map(text).filter(Boolean)),
    ];
    return {
      ...candidate,
      title: record.title || candidate.title,
      url: record.final_url || candidate.url,
      final_url: record.final_url || candidate.final_url || candidate.url,
      source_url: candidate.source_url || candidate.url,
      source_name: record.source_name || candidate.source_name,
      module: record.module || candidate.module,
      region: record.region || candidate.region,
      country: record.country || candidate.country,
      published_at: record.published_at || candidate.published_at,
      snippet: record.snippet || candidate.snippet,
      article_text: record.article_text || candidate.article_text || candidate.snippet,
      full_text: record.full_text || candidate.full_text || record.article_text || candidate.snippet,
      raw_markdown: record.raw_markdown || candidate.raw_markdown || '',
      fit_markdown: record.fit_markdown || candidate.fit_markdown || '',
      references_markdown: record.references_markdown || candidate.references_markdown || '',
      metadata: record.metadata || candidate.metadata || {},
      extraction: record.extraction || candidate.extraction || {},
      crawl_status: record.crawl_status || candidate.crawl_status || 'hydrated',
      quality_flags: mergedQualityFlags,
      hydration_source: record.hydration_source || candidate.hydration_source || 'crawl4ai',
      detail_status: 'hydrated',
      detail_reason: 'crawl4ai-hydrated',
    };
  });

  return {
    candidates: merged,
    audit: {
      input: candidates.length,
      records: normalizedRecords.length,
      hydrated,
      unmatched,
    },
  };
}

export async function loadHydratedRecordsFromEnv(env = {}, fetcher = fetch) {
  const payload = text(env.SOURCE_HYDRATION_JSON || '');
  if (payload) {
    return normalizeHydratedPayload(payload);
  }

  const url = text(env.SOURCE_HYDRATION_URL || '');
  if (url) {
    const response = await fetcher(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Failed to load source hydration payload: HTTP ${response.status}`);
    return normalizeHydratedPayload(await response.text());
  }

  return [];
}

export function normalizeHydratedPayload(payload) {
  if (!payload) return [];
  const parsed = typeof payload === 'string' ? JSON.parse(payload) : payload;
  const records = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.records)
      ? parsed.records
      : Array.isArray(parsed.candidates)
        ? parsed.candidates
        : [];
  return records.map(normalizeHydratedRecord);
}
