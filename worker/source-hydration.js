import { readFile } from 'node:fs/promises';
import { extractHardFacts, gradeEvidence } from './hard-fact-extractor.js';
import { cleanArticleEvidence } from './article-evidence.js';

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

function firstMatch(value, patterns) {
  const source = String(value || '');
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return text(match[1]).replace(/[。；;，,]$/, '');
  }
  return '';
}

function uniqueValues(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(text).filter(Boolean)) {
    const key = value.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function extractCompanyNames(value = '') {
  const source = stripMarkdown(value);
  const companyPattern = /([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,40}?(?:有限责任公司|股份有限公司|有限公司|个体工商户|工作室|商行|公司))/g;
  const matches = [
    ...Array.from(source.matchAll(new RegExp(`(?:^|[，,。；;\\s：:、])${companyPattern.source}`, 'g'))).map(match => ({ name: match[1], index: match.index })),
    ...Array.from(source.matchAll(new RegExp(`(?:当事人|被处罚人|涉案主体|原告|被告|申请人|被申请人|披露|认定|处罚|罚没|没收)[：:\\s]*${companyPattern.source}`, 'g'))).map(match => ({ name: match[1], index: match.index })),
  ]
    .sort((a, b) => a.index - b.index)
    .map(match => text(match.name)
      .replace(/^.*?(?:披露|通报|认定|处罚)/, '')
      .replace(/^(?:当事人|被处罚人|涉案主体|原告|被告|申请人|被申请人)[：:\s]*/, ''))
    .filter(name => !/^(?:两家|多家|相关|涉案|部分|若干|某些)?(?:公司|企业|主体|商家|经营者|美妆企业|化妆品企业)$/.test(name))
    .filter(name => !/市场监督管理局|药品监督管理局|国家知识产权局|海关|人民法院|委员会|协会|监管部门/.test(name));
  return uniqueValues(matches).slice(0, 4);
}

function extractInvolvedParty(source = '') {
  const labelled = firstMatch(source, [
    /(?:当事人|涉案主体|被处罚人|申请人|被告|原告)[：:\s]*([^。；;\n]{2,80})/,
  ]);
  const labelledCompanies = extractCompanyNames(labelled);
  if (labelledCompanies.length) return labelledCompanies.join('、');
  const companies = extractCompanyNames(source);
  return companies.join('、');
}

function extractViolationBehavior(source = '') {
  const labelled = firstMatch(source, [
    /(?:违法事实|违法行为|主要违法事实|侵权行为|违法情形)[：:\s]*([^。；;\n]{6,120})/,
  ]);
  if (labelled) return labelled;
  return firstMatch(source, [
    /([^。；;\n]{4,120}(?:侵权|冒用|假冒|刷单|虚假交易|虚假宣传|未经授权|擅自使用)[^。；;\n]{0,80})/,
  ]);
}

function extractConfiscationResult(source = '') {
  return firstMatch(source, [
    /((?:没收|罚没|销毁|责令下架|下架|停止销售|召回)[^。；;\n]{2,120})/,
  ]);
}

function extractFeedbackChannel(source = '') {
  return firstMatch(source, [
    /(?:反馈渠道|反馈方式|意见反馈|提交方式|电子邮箱|邮箱|联系人|邮寄地址)[：:\s]*([^。；;\n]{4,120})/,
    /((?:电子邮箱|邮箱|邮寄地址|联系人)[：:\s]*[^。；;\n]{4,120})/,
  ]);
}

function normalizeLink(urlValue, baseValue) {
  const raw = text(urlValue);
  if (!raw) return '';
  try {
    return new URL(raw, baseValue || undefined).href;
  } catch {
    return '';
  }
}

function extractAttachmentUrls(markdown = '', baseUrl = '') {
  const source = String(markdown || '');
  const urls = [
    ...Array.from(source.matchAll(/\[[^\]]+\]\(([^)]+?\.(?:pdf|docx?|xlsx?))(?:[?#][^)]*)?\)/gi)).map(match => match[1]),
    ...Array.from(source.matchAll(/https?:\/\/[^\s)]+?\.(?:pdf|docx?|xlsx?)(?:[?#][^\s)]*)?/gi)).map(match => match[0]),
  ];
  const seen = new Set();
  const result = [];
  for (const url of urls) {
    const normalized = normalizeLink(url, baseUrl);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function normalizeAttachmentRecord(record = {}, baseUrl = '') {
  const sourceUrl = text(record.source_url || record.url);
  const finalUrl = text(record.final_url || record.url || record.source_url);
  const fitMarkdown = String(record.fit_markdown || '').trim();
  const rawMarkdown = String(record.raw_markdown || '').trim();
  const articleText = cleanArticleEvidence(fitMarkdown
    || rawMarkdown
    || record.article_text
    || record.extraction?.article_text
    || record.extraction?.text
    || record.extraction?.summary
    || '');
  return {
    ...record,
    url: finalUrl || sourceUrl,
    final_url: finalUrl || sourceUrl,
    source_url: sourceUrl || finalUrl,
    title: text(record.title),
    article_text: articleText,
    raw_markdown: rawMarkdown,
    fit_markdown: fitMarkdown,
    references_markdown: text(record.references_markdown),
    attachment_urls: extractAttachmentUrls([fitMarkdown, rawMarkdown, text(record.references_markdown)].join('\n'), finalUrl || sourceUrl || baseUrl),
    crawl_status: text(record.crawl_status || 'hydrated'),
    extraction_status: text(record.extraction_status || record.crawl_status || 'hydrated'),
    extraction_error: text(record.extraction_error || ''),
    quality_flags: Array.isArray(record.quality_flags) ? record.quality_flags.map(text).filter(Boolean) : [],
  };
}

function normalizeArray(value) {
  return (Array.isArray(value) ? value : [value]).map(text).filter(Boolean);
}

function attachmentMatchesPrimaryEvent(primaryTitle = '', attachmentTitle = '') {
  const compact = value => text(value)
    .replace(/^(?:附件\s*[一二三四五六七八九十\d]+[：:]?\s*)/i, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLowerCase();
  const primary = compact(primaryTitle);
  const attachment = compact(attachmentTitle);
  if (!primary || !attachment) return false;
  const shorter = primary.length <= attachment.length ? primary : attachment;
  const longer = shorter === primary ? attachment : primary;
  for (let index = 0; index <= shorter.length - 4; index += 1) {
    if (longer.includes(shorter.slice(index, index + 4))) return true;
  }
  const words = value => new Set(text(value).toLowerCase().match(/[a-z0-9]{4,}/g) || []);
  const primaryWords = words(primaryTitle);
  const sharedWords = [...words(attachmentTitle)].filter(word => primaryWords.has(word));
  return sharedWords.length >= 2;
}

function cleanInvolvedParty(value = '') {
  return uniqueValues(text(value).split(/[、,，]/)
    .map(item => item.trim())
    .filter(Boolean)
    .filter(name => !/^(?:两家|多家|相关|涉案|部分|若干|某些)?(?:公司|企业|主体|商家|经营者|美妆企业|化妆品企业)$/.test(name)))
    .join('、');
}

function classifySignalType(value) {
  const source = String(value || '');
  if (/处罚|罚款|行政处罚|判决|裁定|侵权|违法|召回|不合格/i.test(source)) return '风险案例';
  if (/公告|办法|规定|条例|标准|征求意见|实施|生效|备案|注册|禁用|限用/i.test(source)) return '新增义务';
  if (/海关|关税|HS\s*编码|进出口|进口|出口|清关|报关/i.test(source)) return '新增义务';
  if (/入口|监测|预警|Safety Gate|rapid alert/i.test(source)) return '观察入口';
  return '执法趋势';
}

function classifyRiskTier(value) {
  const source = String(value || '');
  if (/处罚|罚款|行政处罚|召回|不合格|立即|截止|生效|禁用|限用|不得|违法/i.test(source)) return '立即处理';
  if (/公告|办法|规定|海关|关税|备案|注册|商标|知识产权|判决|裁定/i.test(source)) return '本周排查';
  return '持续监测';
}

function extractHardFactsFromText(value = '') {
  const source = stripMarkdown(value);
  if (!source) return {};
  const hardFacts = {
    document_number: firstMatch(source, [
      /(?:文号|决定书文号|公告编号|公告|编号)[：:\s]*([^\s。；;，,]{2,40}(?:〔20\d{2}〕\d+号|20\d{2}年第\d+号|第\d+号))/,
      /([^\s。；;，,]{0,20}〔20\d{2}〕\d+号)/,
      /(20\d{2}年第\d+号)/,
    ]),
    authority: firstMatch(source, [
      /(?:处罚机关|发布机关|发文机关|监管部门|执法机关)[：:\s]*([^。；;\n]{3,40})/,
      /(国家市场监督管理总局|国家药监局|国家知识产权局|海关总署|[\u4e00-\u9fa5]{2,20}市场监督管理局|[\u4e00-\u9fa5]{2,20}药品监督管理局)/,
    ]),
    penalty_amount: firstMatch(source, [
      /(?:罚款|处罚金额)[：:\s]*([0-9]+(?:\.[0-9]+)?\s*(?:万|亿)?元)/,
      /(罚款[0-9]+(?:\.[0-9]+)?\s*(?:万|亿)?元)/,
    ]).replace(/^罚款/, ''),
    confiscation_result: extractConfiscationResult(source),
    legal_basis: firstMatch(source, [
      /(《[^》]{2,40}》第[一二三四五六七八九十百零\d]+条(?:第[一二三四五六七八九十百零\d]+款)?)/,
      /(依据《[^》]{2,40}》[^。；;\n]{0,30})/,
    ]).replace(/^依据/, ''),
    violation_behavior: extractViolationBehavior(source),
    involved_party: extractInvolvedParty(source),
    product_or_batch: firstMatch(source, [
      /(?:涉及产品|产品名称|产品\/批次|批号|批次)[：:\s]*([^。；;\n]{2,60})/,
      /(化妆品中[^。；;\n]{2,80}?检验方法(?:标准)?)/,
      /(《化妆品中[^》]{2,80}?检验方法[(（]征求意见稿[)）]》(?:等\d+项化妆品标准)?)/,
      /公开征求《([^》]{2,80}?检验方法[(（]征求意见稿[)）])》等\d+项化妆品标准意见/,
      /公开征求([^。；;\n]{2,100}?化妆品标准)意见/,
    ]),
    hs_code: firstMatch(source, [
      /(?:HS\s*编码|HS Code|商品编码)[：:\s]*([0-9]{6,10})/i,
    ]),
    effective_date: firstMatch(source, [
      /(?:自|于)(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)(?:起)?(?:实施|生效|执行)/,
      /(?:生效日期|实施日期|执行日期)[：:\s]*(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)/,
    ]),
    deadline: firstMatch(source, [
      /(?:截止|截至|过渡期至|应于|须于)[：:\s]*(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)/,
    ]),
    feedback_channel: extractFeedbackChannel(source),
  };
  const compactSource = source.replace(/\s+/g, '');
  hardFacts.signal_type = classifySignalType(compactSource);
  hardFacts.risk_tier = classifyRiskTier(compactSource);
  return Object.fromEntries(Object.entries(hardFacts).filter(([, value]) => text(value)));
}

function normalizeHardFacts(record = {}, articleText = '') {
  const combinedText = [record.title, articleText].filter(Boolean).join('\n');
  const extracted = {
    ...extractHardFactsFromText(combinedText),
    ...extractHardFacts(combinedText, {
      title: record.title,
      source_name: record.source_name || record.name,
      source_url: record.source_url || record.url,
      module: record.module,
      country: record.country || record.region,
    }),
  };
  const provided = record.hard_facts || record.extraction?.hard_facts || record.extraction?.legal_facts || {};
  const merged = {
    ...extracted,
    ...Object.fromEntries(Object.entries(provided || {}).map(([key, value]) => [
      key,
      Array.isArray(value) ? normalizeArray(value) : text(value),
    ]).filter(([, value]) => Array.isArray(value) ? value.length : value)),
  };
  if (!merged.signal_type) merged.signal_type = classifySignalType(articleText);
  if (!merged.risk_tier) merged.risk_tier = classifyRiskTier(articleText);
  if (merged.involved_party) merged.involved_party = cleanInvolvedParty(merged.involved_party);
  return merged;
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
  const fitMarkdown = String(record.fit_markdown || '').trim();
  const rawMarkdown = String(record.raw_markdown || '').trim();
  const attachmentRecords = (Array.isArray(record.attachment_records) ? record.attachment_records : [])
    .map(item => normalizeAttachmentRecord(item, finalUrl || sourceUrl))
    .filter(item => item.url || item.title || item.article_text);
  const extractedText = cleanArticleEvidence(
    record.article_text
      || record.extraction?.article_text
      || record.extraction?.text
      || record.extraction?.summary
      || ''
  );
  const primaryArticleText = fitMarkdown || rawMarkdown || extractedText;
  const attachmentText = attachmentRecords
    .filter(item => attachmentMatchesPrimaryEvent(record.title, item.title))
    .map(item => [item.title, item.article_text].filter(Boolean).join('\n'))
    .filter(Boolean)
    .join('\n\n');
  const extractedMarkdown = cleanArticleEvidence(
    record.extraction?.markdown
      || record.extraction?.fit_markdown
      || record.extraction?.markdown_with_citations
      || record.extraction?.text
      || record.extraction?.summary
      || ''
  );
  const articleText = cleanArticleEvidence([primaryArticleText, extractedMarkdown, attachmentText].filter(Boolean).join('\n\n'));
  const qualityFlags = Array.isArray(record.quality_flags)
    ? record.quality_flags.map(text).filter(Boolean)
    : text(record.quality_flags)
      ? [text(record.quality_flags)]
      : [];
  const emptyHydratedBody = text(record.crawl_status || 'hydrated') === 'hydrated' && !stripMarkdown(articleText);
  const normalizedQualityFlags = emptyHydratedBody
    ? [...new Set([...qualityFlags, 'empty-hydrated-body'])]
    : qualityFlags;
  const crawlStatus = emptyHydratedBody ? 'failed' : text(record.crawl_status || 'hydrated');
  const attachmentUrls = [
    ...extractAttachmentUrls([fitMarkdown, rawMarkdown, text(record.references_markdown)].join('\n'), finalUrl || sourceUrl),
    ...normalizeArray(record.attachment_urls),
    ...attachmentRecords.flatMap(item => [item.source_url, item.final_url, item.url, ...(item.attachment_urls || [])]),
  ].map(url => normalizeLink(url, finalUrl || sourceUrl)).filter(Boolean);

  const hardFacts = normalizeHardFacts(record, articleText);
  const computedEvidence = gradeEvidence({
    text: articleText,
    hard_facts: hardFacts,
    source_url: finalUrl || sourceUrl,
    title: text(record.title),
    source_name: text(record.source_name || record.name),
    country: text(record.country || record.region || '未知'),
  });
  const providedQuotes = record.evidence_quotes || record.extraction?.evidence_quotes || {};
  const evidenceQuotes = {
    ...(computedEvidence.evidence_quotes || {}),
    ...Object.fromEntries(Object.entries(providedQuotes || {}).map(([key, value]) => [key, text(value)]).filter(([, value]) => value)),
  };

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
    attachment_urls: [...new Set(attachmentUrls)],
    attachment_records: attachmentRecords,
    article_text: articleText,
    full_text: articleText,
    snippet: text(record.snippet || stripMarkdown(articleText).slice(0, 1200)),
    metadata: record.metadata || {},
    extraction: record.extraction || {},
    hard_facts: hardFacts,
    evidence_grade: text(record.evidence_grade || record.extraction?.evidence_grade || computedEvidence.evidence_grade),
    evidence_reason: text(record.evidence_reason || record.extraction?.evidence_reason || computedEvidence.evidence_reason),
    evidence_quotes: evidenceQuotes,
    crawl_status: crawlStatus,
    quality_flags: normalizedQualityFlags,
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
  const matchedRecords = new Set();
  const merged = (Array.isArray(candidates) ? candidates : []).map(candidate => {
    const keys = candidateKeys(candidate);
    const record = keys.map(key => recordIndex.get(key)).find(Boolean);
    if (!record) {
      unmatched += 1;
      return candidate;
    }
    hydrated += 1;
    matchedRecords.add(record);
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
      hard_facts: record.hard_facts || candidate.hard_facts || {},
      evidence_grade: record.evidence_grade || candidate.evidence_grade || '',
      evidence_reason: record.evidence_reason || candidate.evidence_reason || '',
      evidence_quotes: record.evidence_quotes || candidate.evidence_quotes || {},
      attachment_urls: record.attachment_urls || candidate.attachment_urls || [],
      attachment_records: record.attachment_records || candidate.attachment_records || [],
      crawl_status: record.crawl_status || candidate.crawl_status || 'hydrated',
      quality_flags: mergedQualityFlags,
      hydration_source: record.hydration_source || candidate.hydration_source || 'crawl4ai',
      detail_status: 'hydrated',
      detail_reason: 'crawl4ai-hydrated',
    };
  });

  const mergedKeys = new Set(merged.flatMap(candidateKeys));
  const appendedHardFactRecords = [];
  for (const record of normalizedRecords) {
    if (matchedRecords.has(record)) continue;
    if (record.evidence_grade !== 'hard_fact_ready') continue;
    const keys = recordKeys(record);
    if (keys.some(key => mergedKeys.has(key))) continue;
    appendedHardFactRecords.push({
      ...record,
      url: record.final_url || record.url || record.source_url,
      source_url: record.source_url || record.final_url || record.url,
      detail_status: 'hydrated',
      detail_reason: 'crawl4ai-hard-fact-unmatched',
      hydration_source: record.hydration_source || 'crawl4ai',
    });
    for (const key of keys) mergedKeys.add(key);
  }
  const outputCandidates = [...merged, ...appendedHardFactRecords];

  return {
    candidates: outputCandidates,
    audit: {
      input: candidates.length,
      records: normalizedRecords.length,
      hydrated,
      unmatched,
      appendedHardFactRecords: appendedHardFactRecords.length,
      hardFactReady: normalizedRecords.filter(record => record.evidence_grade === 'hard_fact_ready').length,
      chinaHardFactReady: normalizedRecords.filter(record => record.evidence_grade === 'hard_fact_ready' && record.country === '中国').length,
      leadOnly: normalizedRecords.filter(record => record.evidence_grade === 'lead_only').length,
      attachmentPending: normalizedRecords.filter(record => record.evidence_grade === 'attachment_pending').length,
      reject: normalizedRecords.filter(record => record.evidence_grade === 'reject').length,
    },
  };
}

export async function loadHydratedRecordsFromEnv(env = {}, fetcher = fetch) {
  const payload = text(env.SOURCE_HYDRATION_JSON || '');
  if (payload) {
    return normalizeHydratedPayload(payload);
  }

  const file = text(env.SOURCE_HYDRATION_FILE || '');
  if (file) {
    return normalizeHydratedPayload(await readFile(file, 'utf8'));
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
