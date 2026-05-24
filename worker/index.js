/**
 * 美妆法务资讯周报机器人 - Cloudflare Worker
 *
 * 管道: 信息源抓取 → DeepSeek 结构化分析 → HTML 周报 → KV 存档 → 飞书摘要推送
 * 触发: 每周一 UTC 00:00 (北京时间 08:00) cron 自动执行
 *
 * 部署:
 *   npx wrangler secret put DEEPSEEK_API_KEY
 *   npx wrangler secret put FEISHU_WEBHOOK_URL
 *   npx wrangler kv namespace create SEEN_NEWS  (已创建)
 *   npx wrangler deploy
 */

import sourceCatalog from './sources.json' with { type: 'json' };

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const DEEPSEEK_API = "https://api.deepseek.com/chat/completions";

const RELEVANT_KEYWORDS = [
  '化妆品', '美妆', '护肤', '彩妆', '香水', '防晒', '洗护', '功效宣称', '备案', '注册',
  '标签', '广告', '虚假宣传', '处罚', '召回', '禁用', '限用', '进出口', '跨境', '清真',
  'cosmetic', 'cosmetics', 'beauty', 'skincare', 'sunscreen', 'MoCRA', 'BPOM', 'AICIS',
];
const BEAUTY_KEYWORDS = [
  '化妆品', '美妆', '护肤', '彩妆', '香水', '防晒', '洗护', '功效宣称', '功效评价', '牙膏',
  '儿童化妆品', '普通化妆品', '特殊化妆品', '化妆品原料', '化妆品标签', '化妆品备案',
  'cosmetic', 'cosmetics', 'beauty', 'skincare', 'sunscreen',
];
const INDIRECT_BEAUTY_ECOMMERCE_KEYWORDS = ['直播带货', '直播', '电商', '平台', '消费者保护', '跨境', '进口', '商标', '外观设计'];
const HIGH_IMPACT_LEGAL_KEYWORDS = ['国家标准', '强制性标准', '征求意见', '管理办法', '监督管理条例', '行政处罚', '召回'];

const NOISE_KEYWORDS = ['融资', '发布会', '新品上市', '代言', '财报', '招聘'];
const REPORT_INDEX_KEY = 'report:index';
const LAST_RUN_KEY = 'run:last';
const REPORT_MODULES = [
  '广告合规及处罚案例',
  '美妆动态',
  '知识产权动态',
  '新规及案例动态',
  '进出口动态',
];
const ACTION_NOISE = ['建议关注', '持续关注', '企业应留意', '可能产生影响', '需持续观察'];
const SOURCE_FETCH_TIMEOUT_MS = 30000;
const SOURCE_FETCH_CONCURRENCY = 4;
const TYPE_REQUIRED_FIELDS = {
  '法规': ['status', 'what_changed', 'legal_obligation', 'affected_business', 'recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence'],
  '案例': ['case_type', 'facts', 'violation_logic', 'penalty_or_result', 'risk_pattern', 'business_lessons', 'recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence'],
  'IP': ['dispute_focus', 'protected_element', 'infringement_logic', 'impact_on_brand_assets', 'recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence'],
  '进出口': ['market_access_change', 'affected_import_flow', 'documents_needed', 'recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence'],
  '动态': ['regulatory_signal', 'compliance_meaning', 'possible_follow_up', 'recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence'],
};
const ENTERPRISE_REQUIRED_FIELDS = ['source_type', 'relevance', 'industry_impact', 'business_impact', 'market_scope'];

// ---------------------------------------------------------------------------
// DeepSeek：一站式搜索 + 分析 + 格式化
// ---------------------------------------------------------------------------
async function requestDeepSeekChat({ apiKey, model = "deepseek-chat", messages, temperature = 0.2, maxTokens = 3000 }) {
  const resp = await fetch(DEEPSEEK_API, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    }),
  });

  if (!resp.ok) {
    throw new Error(`DeepSeek ${resp.status}: ${await resp.text().then(t => t.slice(0, 300))}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || "";
}

// ---------------------------------------------------------------------------
// KV 去重：基于摘要内容 hash，30 天内不重复
// ---------------------------------------------------------------------------
function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

// 从报告中提取关键短语作为去重指纹（取 ## 标题行）
export function extractReportFingerprints(report) {
  return (report.sections || [])
    .flatMap(section => section.items || [])
    .map(item => [item.type, item.region, item.country, item.title, item.source_url].map(value => String(value || '').trim()).join('|'))
    .filter(Boolean);
}

export function dedupeReport(report) {
  const seen = new Set();
  return {
    ...report,
    sections: (report.sections || []).map(section => ({
      ...section,
      items: (section.items || []).filter(item => {
        const sourceUrl = String(item.source_url || '').trim().toLowerCase();
        const titleKey = String(item.title || '').replace(/\s+/g, '').toLowerCase();
        const key = sourceUrl || `${item.type || ''}:${item.country || ''}:${titleKey}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    })),
  };
}

async function isDuplicateFingerprints(fingerprints, kv) {
  if (!kv) return { isDup: false, seen: [], fps: fingerprints || [] };
  const fps = fingerprints || [];
  if (!fps.length) return { isDup: false, seen: [], fps };

  try {
    const seenKey = "seen_v3_report_items";
    const raw = await kv.get(seenKey);
    let seen = raw ? JSON.parse(raw) : [];

    // 清理 7 天前的
    const now = Date.now();
    seen = seen.filter(e => now - e.ts < 30 * 24 * 60 * 60 * 1000);

    const seenSet = new Set(seen.map(e => e.h));
    const newFps = fps.filter(f => !seenSet.has(hashStr(f)));

    return { isDup: newFps.length === 0, seen, fps };
  } catch (e) {
    return { isDup: false, seen: [], fps };
  }
}

async function markSeen(fps, seen, kv) {
  if (!kv || !fps.length) return;
  try {
    const now = Date.now();
    for (const fp of fps) {
      seen.push({ h: hashStr(fp), ts: now });
    }
    // 只保留最近 7 天
    seen = seen.filter(e => now - e.ts < 30 * 24 * 60 * 60 * 1000);
    await kv.put("seen_v3_report_items", JSON.stringify(seen));
  } catch (e) {
    console.warn(`去重标记失败: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// 飞书推送
// ---------------------------------------------------------------------------
function buildCard(content) {
  const today = (() => {
    const d = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  })();
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `⚖️ 美妆法务周报 · ${today}` },
      template: "blue",
    },
    elements: [
      { tag: "div", text: { tag: "lark_md", content } },
      { tag: "hr" },
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: `🤖 由 DeepSeek AI 自动生成 · 仅供参考 · ${today}` }],
      },
    ],
  };
}

async function sendToFeishu(webhookUrl, content) {
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "interactive", card: buildCard(content) }),
    });
    if (resp.ok) {
      const body = await resp.json();
      if (body.code === 0 || body.StatusCode === 0) {
        console.log("飞书推送成功");
        return true;
      }
      console.error(`飞书错误: ${JSON.stringify(body)}`);
      return false;
    }
    console.error(`飞书 ${resp.status}: ${await resp.text().then(t => t.slice(0, 200))}`);
    return false;
  } catch (e) {
    console.error(`飞书异常: ${e.message}`);
    return false;
  }
}

async function recordLastRun(kv, patch) {
  if (!kv) return;
  const now = new Date().toISOString();
  const raw = await kv.get(LAST_RUN_KEY);
  const current = raw ? JSON.parse(raw) : {};
  await kv.put(LAST_RUN_KEY, JSON.stringify({ ...current, ...patch, updated_at: now }, null, 2));
}

// ---------------------------------------------------------------------------
// 管道入口
// ---------------------------------------------------------------------------
export async function runPipeline(env, requestUrl = 'https://beauty-legal-bot.workers.dev/') {
  const deepseekKey = env.DEEPSEEK_API_KEY;
  const feishuUrl = env.FEISHU_WEBHOOK_URL;
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  const kv = env.SEEN_NEWS;

  if (!deepseekKey) { console.error("缺少 DEEPSEEK_API_KEY"); return; }
  if (!feishuUrl) { console.error("缺少 FEISHU_WEBHOOK_URL"); return; }
  if (!kv) { console.error("缺少 SEEN_NEWS KV 绑定"); return; }

  console.log("=== 周报管道启动 ===");

  try {
    console.log("[stage 1/5] 抓取信息源候选...");
    const { candidates, leads, failures } = await collectCandidates(sourceCatalog.sources);
    console.log(`[stage 1/5] 完成，候选 ${candidates.length} 条，线索 ${leads.length} 条，失败源 ${failures.length} 个`);

    console.log("[stage 2/5] DeepSeek 结构化分析...");
    const period = getPeriod();
    const rawReport = await deepseekAnalyzeByModule({ apiKey: deepseekKey, model, candidates, leads, sources: sourceCatalog.sources, period });
    const sourceCheckedReport = filterReportToObservedSources(rawReport, { candidates, sources: sourceCatalog.sources });
    const imageAwareReport = attachReportImages(sourceCheckedReport, { candidates });
    const report = limitReportSections(filterReportQuality(dedupeReport(enrichReportWithSourceSignals(imageAwareReport, { candidates, sources: sourceCatalog.sources }))));
    validateReport(report);
    const itemCount = (report.sections || []).flatMap(section => section.items || []).length;
    console.log(`[stage 2/5] 完成，模块 ${report.sections.length} 个，去重后 ${itemCount} 条`);

    console.log("[stage 3/5] 生成并保存 HTML 周报...");
    const generatedAt = new Date().toISOString();
    const html = renderReportHtml(report, { generatedAt, failures });
    const reportDate = report.period.end;
    await saveReport(kv, reportDate, html, { period: report.period, generatedAt, itemCount });
    console.log(`[stage 3/5] 已保存 /report/${reportDate} 和 /report/latest`);

    console.log("[stage 4/5] 内容去重检查...");
    const summaryText = renderFeishuSummary(report, reportUrl(requestUrl, '/report/latest'));
    const { isDup, seen, fps } = await isDuplicateFingerprints(extractReportFingerprints(report), kv);
    if (isDup) {
      console.log("[stage 4/5] 报告条目 30 天内已全部推送过，保留页面但跳过飞书推送");
      return { stage: 'dedupe', status: 'skipped', message: 'all report items were already pushed in 30 days' };
    }

    console.log("[stage 5/5] 推送飞书摘要...");
    const ok = await sendToFeishu(feishuUrl, summaryText);
    if (ok) await markSeen(fps, seen, kv);
    console.log(ok ? "=== 周报管道完成 ===" : "=== 周报管道失败 ===");
    return { stage: 'feishu', status: ok ? 'done' : 'failed', message: ok ? 'Feishu sent' : 'Feishu send failed' };
  } catch (error) {
    console.error(`管道异常: ${error.stack || error.message}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 信息源工具
// ---------------------------------------------------------------------------
export async function fetchWithTimeout(url, init = {}, timeoutMs = SOURCE_FETCH_TIMEOUT_MS, fetcher = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`fetch timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex], currentIndex);
    }
  }));

  return results;
}

export function normalizeUrl(href, baseUrl) {
  if (!href) return '';
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return '';
  }
}

export function htmlToText(html) {
  return String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLinks(html, baseUrl) {
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  return Array.from(String(html || '').matchAll(re))
    .map(match => ({ title: htmlToText(match[2]), url: normalizeUrl(match[1], baseUrl) }))
    .filter(link => link.title && link.url);
}

export function extractImageUrl(html, baseUrl) {
  const text = String(html || '');
  const metaPatterns = [
    /<meta\s+[^>]*(?:property|name)=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']og:image["'][^>]*>/i,
    /<meta\s+[^>]*(?:property|name)=["']twitter:image["'][^>]*content=["']([^"']+)["'][^>]*>/i,
    /<meta\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']twitter:image["'][^>]*>/i,
  ];
  for (const pattern of metaPatterns) {
    const match = text.match(pattern);
    if (match?.[1]) return normalizeUrl(match[1], baseUrl);
  }
  const img = text.match(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/i);
  return img?.[1] ? normalizeUrl(img[1], baseUrl) : '';
}

export function getSourceStats(sources = sourceCatalog.sources) {
  const byModule = {};
  const byCountry = {};
  for (const source of sources) {
    byModule[source.module] = (byModule[source.module] || 0) + 1;
    byCountry[source.country] = (byCountry[source.country] || 0) + 1;
  }
  return { total: sources.length, byModule, byCountry };
}

export function isRelevantTitle(title) {
  const text = String(title || '').toLowerCase();
  if (!text) return false;
  if (NOISE_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()))) return false;
  const hasBeauty = BEAUTY_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
  if (hasBeauty) return true;
  if (INDIRECT_BEAUTY_ECOMMERCE_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()))) return true;
  const hasGenericLegal = RELEVANT_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
  const hasHighImpact = HIGH_IMPACT_LEGAL_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
  return hasGenericLegal && hasHighImpact && /(化妆|美妆|护肤|彩妆|香水|防晒|洗护|牙膏|cosmetic|beauty|skincare|sunscreen)/i.test(text);
}

export function extractPublishedDate(...values) {
  const text = values.map(value => String(value || '')).join(' ');
  const patterns = [
    /((?:20)\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/,
    /(\d{1,2})[-/.月](\d{1,2})日?[-/.年]((?:20)\d{2})/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const [, a, b, c] = match;
    const year = a.length === 4 ? a : c;
    const month = a.length === 4 ? b : a;
    const day = a.length === 4 ? c : b;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return '';
}

export function makeCandidate(source, item) {
  return {
    title: item.title,
    url: item.url,
    snippet: item.snippet || '',
    image_url: item.image_url || '',
    source_name: source.name,
    module: source.module,
    region: source.region,
    country: source.country,
    source_type: source.source_type,
    authority_type: source.authority_type,
    priority: source.priority,
    topics: source.topics || [],
    published_at: item.published_at || extractPublishedDate(item.title, item.url, item.snippet),
    fetched_at: new Date().toISOString(),
  };
}

export function makeLead(source) {
  return {
    name: source.name,
    source_type: source.source_type,
    module: source.module,
    region: source.region,
    country: source.country,
    topics: source.topics || [],
    priority: source.priority,
  };
}

export function makeSourceLeadCandidate(source) {
  return makeCandidate(source, {
    title: `${source.name}：${source.module}行业线索`,
    url: source.url || source.name,
    snippet: [
      `来源：${source.name}`,
      `分类：${source.module}`,
      `市场：${source.country || '未知'} / ${source.region || '未知'}`,
      `主题：${(source.topics || []).join('、')}`,
      '用途：作为周报选题线索；如无法直接抓取原文，需在报告中标注待核验和可信度。',
    ].filter(Boolean).join('。'),
  });
}

export function splitSources(sources = sourceCatalog.sources) {
  const leadSources = sources.filter(source => source.source_type === 'wechat_public_account');
  const fetchableSources = sources.filter(source => source.source_type !== 'wechat_public_account');
  return { fetchableSources, leadSources };
}

function scoreCandidate(candidate, now = new Date()) {
  let score = 0;
  if (candidate.priority === 'high') score += 30;
  if (candidate.priority === 'medium') score += 15;
  if (candidate.authority_type === 'regulator') score += 25;
  if (candidate.authority_type === 'court' || candidate.authority_type === 'official') score += 20;
  if (candidate.source_type === 'official_site') score += 10;

  if (candidate.published_at) {
    const ageDays = Math.floor((now - new Date(`${candidate.published_at}T00:00:00Z`)) / (24 * 60 * 60 * 1000));
    if (ageDays >= 0 && ageDays <= 7) score += 80;
    else if (ageDays > 7 && ageDays <= 14) score += 35;
    else if (ageDays > 14 && ageDays <= 30) score += 10;
  }

  return score;
}

export function sortCandidatesForAnalysis(candidates, now = new Date()) {
  return [...(candidates || [])].sort((a, b) => {
    const scoreDiff = scoreCandidate(b, now) - scoreCandidate(a, now);
    if (scoreDiff) return scoreDiff;
    return String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
  });
}

export function parseAnalysisJson(text) {
  const cleaned = String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

function hasValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).length > 0;
  return String(value || '').trim().length > 0;
}

export function getRequiredFields(item) {
  return [
    ...(TYPE_REQUIRED_FIELDS[item.type] || ['recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence']),
    ...ENTERPRISE_REQUIRED_FIELDS,
  ];
}

export function hasSpecificActions(item) {
  const actions = item.recommended_actions;
  if (!Array.isArray(actions) || !actions.length) return false;
  return actions.some(action => {
    const text = String(action || '').trim();
    return text.length >= 12 && !ACTION_NOISE.some(noise => text === noise || text.includes(noise));
  });
}

export function validateReport(report) {
  if (!report || typeof report !== 'object') throw new Error('report must be object');
  if (!report.period || !report.period.start || !report.period.end) throw new Error('period missing');
  if (!Array.isArray(report.summary)) throw new Error('summary must be array');
  if (!Array.isArray(report.risk_alerts)) throw new Error('risk_alerts must be array');
  if (!Array.isArray(report.sections)) throw new Error('sections must be array');
  for (const section of report.sections) {
    if (!section.module) throw new Error('section.module missing');
    if (!Array.isArray(section.items)) throw new Error('section.items must be array');
    for (const item of section.items) {
      for (const field of ['title', 'type', 'source_name', 'source_url', 'region', 'country']) {
        if (!hasValue(item[field])) throw new Error(`${field} missing: ${item.title || 'unknown'}`);
      }
      for (const field of getRequiredFields(item)) {
        if (!hasValue(item[field])) throw new Error(`${field} missing: ${item.title || 'unknown'}`);
      }
      if (!hasSpecificActions(item)) throw new Error(`recommended_actions not specific: ${item.title || 'unknown'}`);
    }
  }
  return true;
}

export function filterReportQuality(report) {
  return {
    ...report,
    sections: (report.sections || []).map(section => ({
      ...section,
      items: (section.items || []).filter(item => {
        if (!hasValue(item.source_url)) return false;
        const allowLeadSignal = ['美妆动态', '进出口动态'].includes(section.module)
          && ['wechat_lead', 'industry_media', 'wechat_public_account'].includes(item.source_type)
          && item.industry_impact !== 'low'
          && hasSpecificActions(item);
        if (item.confidence === 'low' && item.relevance !== 'direct' && item.industry_impact !== 'high' && !allowLeadSignal) return false;
        try {
          validateReport({ ...report, sections: [{ ...section, items: [item] }] });
          return true;
        } catch {
          return false;
        }
      }),
    })),
  };
}

export function limitReportSections(report) {
  return {
    ...report,
    sections: REPORT_MODULES.map(module => {
      const section = (report.sections || []).find(item => item.module === module) || { module, items: [] };
      const limit = 8;
      return { ...section, items: (section.items || []).slice(0, limit) };
    }),
  };
}

function getPeriod(now = new Date()) {
  const end = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function buildAnalysisPrompt({ candidates, leads = [], sources, period, targetModule = '' }) {
  const moduleInstruction = targetModule ? `
当前只分析模块：${targetModule}
- 只返回这个模块的 section。
- 如果该模块有 candidates 或 leads，不要返回空数组；至少输出 2 条，优先 3 条。
- 对无法直接打开原文的公众号/行业源，可以输出“待核验”线索型动态，但必须说明待核验点、业务影响和建议动作。
- 美妆动态重点看行业监管趋势、平台治理、产品安全、功效宣称、渠道变化、头部品牌合规动作。
- 进出口动态重点看进口准入、清关、口岸抽检、跨境电商、认证、海关监管、召回和贸易合规。
` : '';
  return `你是国际化美妆电商集团的高级法务情报分析员。用户是集团法务、合规、注册备案、跨境供应链、品牌/IP、市场投放、电商平台运营团队。不要输出未加工新闻，必须输出可用于业务判断的法务情报。

集团业务背景：
- 国际化美妆电商集团，关注中国、欧盟、美国、日本、韩国、泰国、越南、印尼、墨西哥、意大利等市场。
- 业务覆盖护肤、彩妆、防晒、香水、洗护、跨境进口、直播电商、平台销售、自有品牌和第三方品牌。
- 需要直接相关法规，也需要间接影响业务的广告、消费者保护、平台规则、知识产权、进出口、数据合规、召回案例。

来源和质量规则：
- candidates 来自可抓取网页；leads 来自公众号或不可抓来源。公众号可以作为强线索，但最终必须标注 source_type 和 confidence。
- 优先国家/区域监管机构、法院、知识产权机构、海关、产品安全召回平台、行业权威媒体。
- 可以基于 leads 做选题归纳，但不能把传闻当事实；无法找到公开原文时，source_url 可填来源主页，confidence 必须为 medium 或 low，并说明待核验。
- 每条必须解释美妆电商集团的业务影响；解释不了就丢弃。

时间和影响力规则：
- 周报优先过去 7 天发布或更新的信息。
- 7 天之外的信息只有在行业影响力高时保留，例如国家级监管规则、成分禁限用、标签/功效宣称规则、重点处罚、召回、跨境准入、代表性 IP 案例、平台治理口径。
- 未来 90 天生效、反馈截止、过渡期、认证节点可以入选。
- 同等条件下优先直接相关、高影响力、官方源、覆盖核心市场的信息。

模块必须使用以下 5 个，来自用户 Excel 的“分类”列：
- 广告合规及处罚案例
- 美妆动态
- 知识产权动态
- 新规及案例动态
- 进出口动态

输出要求：
- 输出合法 JSON，不要 Markdown，不要解释。
- 目标覆盖全部 5 个模块；每个模块优先输出 2-3 条，总量控制在 10-15 条。只有确无高价值信息时才允许模块为空。
- 美妆动态和进出口动态可以更多使用公众号/行业媒体作为线索，但必须标注 source_type 为 wechat_lead 或 industry_media，confidence 为 medium 或 low，并说明待核验点。
- 字段要完整但表达精炼，避免超长 JSON。
- 每条信息要有国家/大洲、直接/间接相关、行业影响力、业务影响面、建议动作。
- 案例必须拆解事实、认定逻辑、处罚/结果、业务启发。
- 建议动作必须是“建议...”口吻，不能是命令。
- 禁止“建议关注”“持续关注”“企业应留意”等空泛动作。
${moduleInstruction}

JSON 结构：
{
  "period": { "start": "${period.start}", "end": "${period.end}" },
  "summary": ["3-5条集团级执行摘要，必须包含市场/国家、风险、业务影响和建议"],
  "risk_alerts": [{ "level": "high|medium|low", "text": "风险提醒" }],
  "sections": [{
    "module": "广告合规及处罚案例|美妆动态|知识产权动态|新规及案例动态|进出口动态",
    "items": [{
      "type": "法规|征求意见|生效提醒|废止|案例|召回|动态|IP|进出口|平台规则",
      "module": "模块名称",
      "region": "亚洲|欧洲|北美洲|南美洲|大洋洲|全球",
      "country": "国家或市场，例如中国|欧盟|美国|日本|韩国|泰国|越南|印尼|墨西哥|意大利",
      "title": "标题",
      "source_name": "来源名称",
      "source_url": "公开原文URL或来源主页",
      "source_type": "official|court|regulator|industry_media|wechat_lead|database",
      "published_at": "YYYY-MM-DD或未知",
      "relevance": "direct|indirect",
      "industry_impact": "high|medium|low",
      "business_impact": ["注册备案|标签|功效宣称|广告投放|直播电商|平台运营|跨境清关|供应链|品牌/IP|客服售后|数据合规"],
      "market_scope": ["受影响国家/区域/渠道/SKU范围"],
      "risk_level": "high|medium|low",
      "why_it_matters": "为什么值得国际化美妆电商集团法务关注",
      "recommended_actions": ["建议谁在什么时间排查/更新/提交什么"],
      "owner_teams": ["法务|注册|供应链|电商|市场|品牌|客服|数据合规"],
      "confidence": "high|medium|low",
      "status": "法规状态，仅法规/征求意见/生效提醒/废止必填",
      "effective_date": "生效日或未知，仅法规",
      "feedback_deadline": "反馈截止日或未知，仅法规",
      "regulatory_area": "备案|注册|标签|功效宣称|配方|原料|广告|进出口|认证|平台治理|数据合规，仅法规",
      "what_changed": ["变化点，仅法规"],
      "legal_obligation": ["企业义务，仅法规"],
      "affected_business": ["影响市场/渠道/品类/SKU/团队，仅法规"],
      "next_deadline": "下一关键日期或未知，仅法规",
      "case_type": "行政处罚|民事判决|刑事案件|召回|监管通报|平台处罚，仅案例/召回",
      "parties": "涉事主体或未知，仅案例",
      "facts": ["案情事实，仅案例/召回"],
      "violation_logic": ["监管/法院/平台认定逻辑，仅案例"],
      "penalty_or_result": ["处罚/判决/召回/处理结果，仅案例"],
      "risk_pattern": "功效宣称|虚假广告|标签瑕疵|未备案|IP侵权|进口不合规|平台规则|召回质量，仅案例",
      "business_lessons": ["对国际化美妆电商集团的启发，仅案例"]
    }]
  }]
}

信息源统计：${JSON.stringify(getSourceStats(sources))}
候选信息 candidates（已按7天新鲜度、国家/大洲、来源权威性和行业影响力预排序）：${JSON.stringify(sortCandidatesForAnalysis(candidates).slice(0, 140))}
线索 leads（公众号和不可抓来源，可作为强线索但需标注可信度）：${JSON.stringify(leads.slice(0, 120))}`;
}

async function deepseekAnalyze({ apiKey, model, candidates, leads = [], sources = sourceCatalog.sources, period = getPeriod(), targetModule = '' }) {
  const messages = [
    { role: 'system', content: '你只输出合法 JSON。不要输出解释、Markdown 或代码块。' },
    { role: 'user', content: buildAnalysisPrompt({ candidates, leads, sources, period, targetModule }) },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await requestDeepSeekChat({ apiKey, model, messages, temperature: 0.2, maxTokens: 8000 });
    try {
      const report = filterReportQuality(parseAnalysisJson(content));
      validateReport(report);
      return report;
    } catch (error) {
      if (attempt === 1) throw error;
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: `上一次输出不是合法可用 JSON：${error.message}。请只修复为合法 JSON，不要改变事实，不要输出代码块。` });
    }
  }
  throw new Error('DeepSeek analysis failed');
}

function mergeModuleReports(reports, period) {
  const summary = reports.flatMap(report => report.summary || []).slice(0, 5);
  const riskAlerts = reports.flatMap(report => report.risk_alerts || []).slice(0, 8);
  const sections = REPORT_MODULES.map(module => {
    const items = reports
      .flatMap(report => report.sections || [])
      .filter(section => section.module === module)
      .flatMap(section => section.items || [])
      .slice(0, 3);
    return { module, items };
  });
  return { period, summary, risk_alerts: riskAlerts, sections };
}

export function normalizeModuleReport(report, targetModule) {
  const items = (report.sections || [])
    .flatMap(section => section.items || [])
    .map(item => ({ ...item, module: targetModule }));
  return {
    ...report,
    sections: [{ module: targetModule, items }],
  };
}

function signalSourceType(candidate) {
  if (candidate.source_type === 'wechat_public_account') return 'wechat_lead';
  if (candidate.authority_type === 'media' || candidate.source_type === 'industry_media') return 'industry_media';
  if (candidate.authority_type === 'regulator' || candidate.source_type === 'official_site') return 'regulator';
  return candidate.source_type || 'industry_media';
}

function signalBusinessImpact(module) {
  const map = {
    '广告合规及处罚案例': ['广告投放', '直播电商', '平台运营'],
    '美妆动态': ['注册备案', '功效宣称', '平台运营', '供应链'],
    '知识产权动态': ['品牌/IP', '平台运营'],
    '新规及案例动态': ['注册备案', '标签', '配方', '供应链'],
    '进出口动态': ['跨境清关', '供应链', '平台运营'],
  };
  return map[module] || ['法务'];
}

function signalTypeForModule(module) {
  const map = {
    '广告合规及处罚案例': '动态',
    '美妆动态': '动态',
    '知识产权动态': 'IP',
    '新规及案例动态': '动态',
    '进出口动态': '进出口',
  };
  return map[module] || '动态';
}

function buildSignalItem(candidate, module) {
  const topics = (candidate.topics || []).filter(Boolean);
  const titleCore = String(candidate.title || `${candidate.source_name}：${module}行业线索`).replace(/：.*行业线索$/, '');
  const base = {
    type: signalTypeForModule(module),
    module,
    region: candidate.region || '全球',
    country: candidate.country || '全球',
    title: `${titleCore}：${module}待核验情报线索`,
    source_name: candidate.source_name || candidate.name || '行业来源',
    source_url: candidate.url || candidate.source_url || candidate.source_name || '微信公众号',
    source_type: signalSourceType(candidate),
    published_at: candidate.published_at || '未知',
    relevance: module === '美妆动态' || module === '新规及案例动态' ? 'direct' : 'indirect',
    industry_impact: candidate.priority === 'high' ? 'high' : 'medium',
    business_impact: signalBusinessImpact(module),
    market_scope: [`${candidate.country || '相关市场'} ${topics.join('、') || module}`],
    risk_level: candidate.priority === 'high' ? 'medium' : 'low',
    why_it_matters: `该来源属于${module}信息源，涉及${topics.join('、') || '监管和行业变化'}；即使本周未抓到可直接引用的明细页，也适合作为法务周报的待核验线索，帮助相关团队提前排查业务影响。`,
    recommended_actions: [
      `建议法务团队以${candidate.source_name || candidate.name || '该来源'}为入口，在本周内核验是否有与集团在售品类、渠道或目标市场相关的最新原文。`,
      `建议${signalBusinessImpact(module)[0]}团队结合${candidate.country || '相关市场'}业务清单，先排查是否存在标签、宣称、清关、平台上架或品牌授权方面的潜在影响。`,
    ],
    owner_teams: ['法务', signalBusinessImpact(module)[0]].filter(Boolean),
    confidence: candidate.source_type === 'official_site' ? 'medium' : 'low',
    regulatory_signal: [`${candidate.source_name || candidate.name || '该来源'}提供${module}方向的周度监测线索，主题包括${topics.join('、') || module}。`],
    compliance_meaning: ['该条为自动补全的待核验情报，不替代正式原文判断；用于提示团队不要遗漏该分类下的重要信息源。'],
    possible_follow_up: [`建议下次周报继续优先抓取该来源，并在发现原文后升级为正式法规、案例或进出口条目。`],
  };

  if (base.type === 'IP') {
    return {
      ...base,
      dispute_focus: ['品牌名称、商标使用、外观设计或跨境维权动态。'],
      protected_element: topics.join('、') || '商标和品牌资产',
      infringement_logic: ['需结合原文判断是否涉及抢注、近似混淆、未授权使用或平台侵权投诉。'],
      impact_on_brand_assets: ['可能影响集团自有品牌在目标市场的注册、使用证据留存和平台维权。'],
    };
  }

  if (base.type === '进出口') {
    return {
      ...base,
      market_access_change: ['待核验是否涉及进口准入、清关文件、口岸抽检、跨境电商正面清单或认证要求变化。'],
      affected_import_flow: ['商品准入评估', '清关资料准备', '平台上架节奏', '供应链履约'],
      documents_needed: ['建议核验产品备案/注册资料、中文标签、成分表、原产地及清关单证是否需要更新。'],
    };
  }

  return base;
}

function signalMatchesModule(candidate, module) {
  let text = [
    candidate.title,
    candidate.source_name,
    candidate.name,
    candidate.snippet,
    ...(candidate.topics || []),
  ].join(' ').toLowerCase();
  for (const moduleName of REPORT_MODULES) {
    text = text.replaceAll(moduleName.toLowerCase(), '');
  }
  const rules = {
    '广告合规及处罚案例': ['广告', '处罚', '虚假宣传', '直播', '功效宣称', '监管', '市场监督'],
    '美妆动态': ['美妆', '化妆品', '护肤', '彩妆', '香水', '防晒', '青眼', '浙江美妆', '化妆品观察'],
    '知识产权动态': ['知识产权', '商标', '专利', '版权', 'wipo', 'euipo', '品牌'],
    '新规及案例动态': ['化妆品', '法规', '案例', '药监', 'bpom', 'fda', 'sccs', 'mocra', '卫生部', '最高人民检察院'],
    '进出口动态': ['进出口', '进口', '出口', '海关', '清关', '跨境', '关务', '口岸', 'cbp', '保税'],
  };
  return (rules[module] || []).some(keyword => text.includes(keyword.toLowerCase()));
}

export function enrichReportWithSourceSignals(report, { candidates = [], sources = [] } = {}) {
  const sections = REPORT_MODULES.map(module => {
    const existing = (report.sections || []).find(section => section.module === module)?.items || [];
    const seen = new Set(existing.map(item => item.source_url || item.title));
    const moduleCandidates = candidates
      .filter(candidate => candidate.module === module)
      .filter(candidate => signalMatchesModule(candidate, module))
      .filter(candidate => !seen.has(candidate.url || candidate.source_url || candidate.title));
    const moduleSources = sources
      .filter(source => source.module === module)
      .map(makeSourceLeadCandidate)
      .filter(candidate => signalMatchesModule(candidate, module))
      .filter(candidate => !seen.has(candidate.url || candidate.source_url || candidate.title));
    const signals = [...moduleCandidates, ...moduleSources]
      .sort((a, b) => scoreCandidate(b) - scoreCandidate(a))
      .slice(0, Math.max(0, 3 - existing.length))
      .map(candidate => buildSignalItem(candidate, module));
    return { module, items: [...existing, ...signals].slice(0, 3) };
  });

  const itemCount = sections.flatMap(section => section.items || []).length;
  const summary = report.summary?.length ? report.summary : [`本期共整理 ${itemCount} 条国际美妆法务情报，覆盖法规、案例、知识产权、行业动态和进出口线索；其中待核验线索已在条目中标明，建议相关团队优先核验原文后再形成正式处置。`];
  return { ...report, summary, sections };
}

function normalizeSourceUrl(url) {
  return String(url || '').trim().replace(/\/$/, '');
}

export function filterReportToObservedSources(report, { candidates = [], sources = [] } = {}) {
  const allowed = new Set([
    ...candidates.map(candidate => candidate.url || candidate.source_url),
    ...sources.map(source => source.url),
    '微信公众号',
  ].map(normalizeSourceUrl).filter(Boolean));

  return {
    ...report,
    sections: (report.sections || []).map(section => ({
      ...section,
      items: (section.items || []).filter(item => {
        const url = normalizeSourceUrl(item.source_url);
        if (!url || /xxx|example\.com|placeholder|待补充/i.test(url)) return false;
        return allowed.has(url);
      }),
    })),
  };
}

export function attachReportImages(report, { candidates = [] } = {}) {
  const imagesByUrl = new Map(
    candidates
      .filter(candidate => candidate.url && candidate.image_url)
      .map(candidate => [normalizeSourceUrl(candidate.url), candidate.image_url])
  );
  return {
    ...report,
    sections: (report.sections || []).map(section => ({
      ...section,
      items: (section.items || []).map(item => ({
        ...item,
        image_url: item.image_url || imagesByUrl.get(normalizeSourceUrl(item.source_url)) || '',
      })),
    })),
  };
}

async function deepseekAnalyzeByModule({ apiKey, model, candidates, leads = [], sources = sourceCatalog.sources, period = getPeriod() }) {
  const reports = [];
  for (const module of REPORT_MODULES) {
    const moduleCandidates = candidates.filter(candidate => candidate.module === module);
    const moduleLeads = leads.filter(lead => lead.module === module);
    const moduleSources = sources.filter(source => source.module === module);
    if (!moduleCandidates.length && !moduleLeads.length) {
      reports.push({ period, summary: [], risk_alerts: [], sections: [{ module, items: [] }] });
      continue;
    }
    const report = await deepseekAnalyze({
      apiKey,
      model,
      candidates: moduleCandidates,
      leads: moduleLeads,
      sources: moduleSources,
      period,
      targetModule: module,
    });
    reports.push(normalizeModuleReport(report, module));
  }
  return mergeModuleReports(reports, period);
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderList(values, className = '') {
  const items = (values || []).filter(Boolean);
  if (!items.length) return '';
  return `<ul class="${className}">${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderField(label, values, className = 'compact-list') {
  const list = Array.isArray(values) ? values : (values ? [values] : []);
  if (!list.length) return '';
  return `<div class="analysis-block"><h4>${escapeHtml(label)}</h4>${renderList(list, className)}</div>`;
}

function renderItemAnalysis(item) {
  if (item.type === '法规') {
    return [
      renderField('变化点', item.what_changed),
      renderField('法务拆解', item.legal_obligation),
      renderField('影响范围', item.affected_business, 'scope-list'),
      renderField('合规动作', item.recommended_actions),
      renderField('截止节点', item.next_deadline || item.effective_date || item.feedback_deadline),
    ].join('');
  }
  if (item.type === '案例') {
    return [
      renderField('案情', item.facts),
      renderField('违法逻辑', item.violation_logic),
      renderField('处罚/结果', item.penalty_or_result),
      renderField('业务启示', item.business_lessons),
      renderField('排查动作', item.recommended_actions),
    ].join('');
  }
  if (item.type === 'IP') {
    return [
      renderField('争议焦点', item.dispute_focus),
      renderField('侵权逻辑', item.infringement_logic),
      renderField('品牌资产影响', item.impact_on_brand_assets),
      renderField('合规动作', item.recommended_actions),
    ].join('');
  }
  if (item.type === '进出口') {
    return [
      renderField('准入/清关变化', item.market_access_change),
      renderField('影响流程', item.affected_import_flow),
      renderField('所需文件', item.documents_needed),
      renderField('合规动作', item.recommended_actions),
    ].join('');
  }
  return [
    renderField('监管信号', item.regulatory_signal),
    renderField('合规意义', item.compliance_meaning),
    renderField('后续动作', item.possible_follow_up || item.recommended_actions),
  ].join('');
}

function riskLabel(level) {
  const labels = { high: '高风险', medium: '中风险', low: '低风险' };
  return labels[level] || level || '风险';
}

function impactLabel(level) {
  const labels = { high: '高', medium: '中', low: '低' };
  return labels[level] || level || '待判断';
}

function levelClass(prefix, value, fallback = 'medium') {
  const safe = ['high', 'medium', 'low', 'direct', 'indirect'].includes(value) ? value : fallback;
  return `${prefix}-${safe}`;
}

function moduleId(module) {
  return `module-${hashStr(module)}`;
}

function renderEvidenceImage(item) {
  if (!item.image_url) return '';
  return `<figure class="evidence-image"><img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.source_name)} 来源图片" loading="lazy"></figure>`;
}

export function renderReportHtml(report, { generatedAt = new Date().toISOString(), failures = [] } = {}) {
  validateReport(report);
  const sections = report.sections || [];
  const allItems = sections.flatMap(section => section.items || []);
  const countries = [...new Set(allItems.map(item => item.country).filter(Boolean))];
  const directCount = allItems.filter(item => item.relevance === 'direct').length;
  const highImpactCount = allItems.filter(item => item.industry_impact === 'high').length;
  const highCount = (report.risk_alerts || []).filter(alert => alert.level === 'high').length;
  const mediumCount = (report.risk_alerts || []).filter(alert => alert.level === 'medium').length;
  const lowCount = (report.risk_alerts || []).filter(alert => alert.level === 'low').length;
  const urgentItems = allItems
    .filter(item => item.risk_level === 'high' || item.industry_impact === 'high')
    .slice(0, 4);

  const moduleNav = sections.map(section => {
    const items = section.items || [];
    const high = items.filter(item => item.risk_level === 'high').length;
    return `<a href="#${moduleId(section.module)}"><span>${escapeHtml(section.module)}</span><strong>${items.length}</strong><em>${high ? `${high} 高风险` : '常规监测'}</em></a>`;
  }).join('');

  const sectionHtml = sections.map((section, sectionIndex) => {
    const items = section.items || [];
    const itemHtml = items.length ? items.map((item, itemIndex) => `
      <article class="intel-card">
        <div class="item-topline">
          <span class="item-number">${String(sectionIndex + 1).padStart(2, '0')}.${String(itemIndex + 1).padStart(2, '0')}</span>
          <div class="item-meta">
            <span class="tag ${escapeHtml(item.risk_level || 'medium')} ${levelClass('severity', item.risk_level)}">${escapeHtml(item.type)}</span>
            <span>${escapeHtml(item.country || item.region)}</span>
            <span>${escapeHtml(item.region || '全球')}</span>
            <span>${escapeHtml(item.published_at || '未知日期')}</span>
            <span>${escapeHtml(riskLabel(item.risk_level))}</span>
          </div>
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        <section class="source-evidence">
          ${renderEvidenceImage(item)}
          <div class="evidence-body">
            <p class="evidence-label">Source Evidence</p>
            <a class="evidence-link" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">查看原文：${escapeHtml(item.source_name)}</a>
            <div class="evidence-meta">
              <span>${escapeHtml(item.source_type || 'source')}</span>
              <span class="${levelClass('confidence', item.confidence)}">${escapeHtml(item.confidence || 'medium')} confidence</span>
              <span>${escapeHtml(item.published_at || '未知日期')}</span>
            </div>
          </div>
        </section>
        <section class="conclusion-strip">
          <h4>核心结论</h4>
          <p>${escapeHtml(item.why_it_matters || '该条信息需要相关团队结合业务覆盖范围判断影响。')}</p>
        </section>
        <div class="intel-grid">
          <div class="${levelClass('relevance', item.relevance, 'indirect')}"><b>相关性</b><span>${item.relevance === 'direct' ? '直接相关' : '间接相关'}</span></div>
          <div class="${levelClass('severity', item.industry_impact)}"><b>行业影响力</b><span>${escapeHtml(impactLabel(item.industry_impact))}</span></div>
          <div><b>市场覆盖</b><span>${escapeHtml((item.market_scope || []).join('、') || item.country || '待判断')}</span></div>
        </div>
        <div class="analysis-grid">
          <section class="analysis-panel">
            <h4>业务影响</h4>
            ${renderList(item.business_impact, 'impact-list')}
          </section>
          <section class="analysis-panel action-panel">
            <h4>建议动作</h4>
            ${renderList(item.recommended_actions, 'compact-list')}
          </section>
          <section class="analysis-panel detail-panel">
            <h4>法律 / 案例拆解</h4>
            ${renderItemAnalysis(item)}
          </section>
        </div>
      </article>
    `).join('') : '<p class="empty">本周无高价值更新</p>';
    return `
      <section class="report-section" id="${moduleId(section.module)}">
        <div class="section-heading">
          <div>
            <p>${escapeHtml(report.period.start)} - ${escapeHtml(report.period.end)}</p>
            <h2>${escapeHtml(section.module)}</h2>
          </div>
          <span>${items.length} 条入选</span>
        </div>
        ${itemHtml}
      </section>
    `;
  }).join('');

  const urgentHtml = urgentItems.length ? urgentItems.map(item => `
    <li>
      <strong>${escapeHtml(item.country)} · ${escapeHtml(riskLabel(item.risk_level))}</strong>
      <span>${escapeHtml(item.title)}</span>
    </li>
  `).join('') : '<li><strong>暂无</strong><span>本期无高风险优先项</span></li>';

  const executiveConclusion = report.summary?.[0] || `本期共筛选 ${allItems.length} 条美妆法务情报，建议集团法务按市场和业务线优先处理高风险事项。`;
  const executiveBullets = (report.summary || []).slice(0, 3).map(item => `<li>${escapeHtml(item)}</li>`).join('');
  const marketRiskHtml = countries.map(country => {
    const countryItems = allItems.filter(item => item.country === country);
    const high = countryItems.filter(item => item.risk_level === 'high').length;
    const medium = countryItems.filter(item => item.risk_level === 'medium').length;
    const level = high ? 'high' : (medium ? 'medium' : 'low');
    return `<div class="market-tile ${level}"><strong>${escapeHtml(country)}</strong><span>${countryItems.length} 条情报 · ${high} 高风险 · ${medium} 中风险</span></div>`;
  }).join('');

  const actionTeams = ['法务', '注册备案', '注册', '市场', '电商', '供应链', '品牌/IP', '客服'];
  const actionBoardHtml = actionTeams.map(team => {
    const actions = allItems
      .filter(item => (item.owner_teams || []).some(owner => String(owner).includes(team.replace('/IP', ''))))
      .flatMap(item => item.recommended_actions || [])
      .slice(0, 3);
    if (!actions.length) return '';
    return `<section class="action-column"><h3>${escapeHtml(team)}</h3>${renderList(actions, 'compact-list')}</section>`;
  }).filter(Boolean).join('');

  const moduleThesis = {
    '广告合规及处罚案例': '广告、直播和功效宣称仍是本周最需要前置审核的高频风险。',
    '美妆动态': '行业动态应作为监管风向和渠道规则变化的早期信号，而不是新闻浏览。',
    '知识产权动态': '品牌资产管理需要从被动维权转为商标组合、使用证据和平台治理的常态化管理。',
    '新规及案例动态': '成分、注册备案、标签和案例执法共同指向更高的上市前合规要求。',
    '进出口动态': '跨境链路的核心关注点是准入、清关文件、口岸抽检和美国/中国口岸监管信号。',
  };
  const strategicThemeHtml = sections.map(section => {
    const items = section.items || [];
    if (!items.length) return '';
    const evidence = items.slice(0, 3).map(item => `
      <li>
        <a href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>
        <span>${escapeHtml(item.country)} · ${escapeHtml(item.source_name)} · ${escapeHtml(riskLabel(item.risk_level))}</span>
      </li>
    `).join('');
    const actions = items.flatMap(item => item.recommended_actions || []).slice(0, 2);
    return `
      <article class="theme-card">
        <div class="theme-head">
          <p>Strategic Theme</p>
          <h3>${escapeHtml(section.module)}</h3>
        </div>
        <p class="theme-thesis">${escapeHtml(moduleThesis[section.module] || '该模块体现本周需要集团法务判断的业务风险主题。')}</p>
        <div class="theme-body">
          <section>
            <h4>支撑证据</h4>
            <ul class="evidence-list">${evidence}</ul>
          </section>
          <section>
            <h4>建议动作</h4>
            ${renderList(actions, 'compact-list') || '<p class="empty">建议相关团队结合业务范围判断是否需要跟进。</p>'}
          </section>
        </div>
      </article>
    `;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Global Beauty Legal Intelligence</title>
  <style>
    :root { color-scheme: light; --bg: #F3F5F8; --panel: #FFFFFF; --ink: #111827; --muted: #667085; --line: #D7DCE5; --line-strong: #B8C0CC; --navy: #101828; --blue: #1D4E89; --cyan: #087E8B; --gold: #A86E1D; --red: #B42318; --green: #287D3C; --soft-blue: #EAF1FB; --soft-gold: #FFF5E5; --soft-red: #FEF3F2; }
    * { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body { margin: 0; background: var(--bg); color: var(--ink); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-size: 15px; line-height: 1.68; }
    a { color: var(--blue); text-decoration-thickness: 0.08em; text-underline-offset: 0.18em; }
    a:focus-visible { outline: 3px solid rgba(37, 87, 167, 0.28); outline-offset: 3px; border-radius: 6px; }
    .page-top { background: #0E1726; color: #fff; border-bottom: 1px solid #263448; }
    .top-inner { max-width: 1320px; margin: 0 auto; padding: 28px 28px 24px; }
    .eyebrow { margin: 0 0 10px; color: #A9BFE8; font-size: 12px; font-weight: 800; letter-spacing: 0; text-transform: uppercase; }
    h1 { margin: 0; font-size: 34px; line-height: 1.18; letter-spacing: 0; }
    .subtitle { max-width: 900px; margin: 12px 0 0; color: #D5DFEF; font-size: 15px; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 22px; }
    .metric { min-height: 92px; background: rgba(255,255,255,0.075); border: 1px solid rgba(255,255,255,0.18); border-radius: 8px; padding: 14px; }
    .metric strong { display: block; font-size: 30px; line-height: 1; }
    .metric span { display: block; margin-top: 8px; color: #C9D5E8; font-size: 13px; }
    .layout { max-width: 1320px; margin: 0 auto; display: grid; grid-template-columns: 280px minmax(0, 1fr); gap: 22px; padding: 22px 28px 56px; align-items: start; }
    .side-rail { position: sticky; top: 16px; display: grid; gap: 14px; }
    .rail-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; box-shadow: 0 8px 24px rgba(16,24,40,.05); }
    .rail-title { margin: 0 0 10px; font-size: 12px; color: var(--muted); font-weight: 800; letter-spacing: 0; text-transform: uppercase; }
    .module-nav { display: grid; gap: 8px; }
    .module-nav a { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 3px 10px; align-items: center; min-height: 54px; padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: #fff; color: var(--ink); text-decoration: none; }
    .module-nav span { font-weight: 800; overflow-wrap: anywhere; }
    .module-nav strong { color: var(--blue); font-size: 18px; }
    .module-nav em { grid-column: 1 / -1; color: var(--muted); font-size: 12px; font-style: normal; }
    .priority-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
    .priority-list li { border-left: 3px solid var(--gold); padding-left: 10px; }
    .priority-list strong { display: block; color: var(--gold); font-size: 12px; }
    .priority-list span { display: block; color: var(--ink); font-size: 13px; line-height: 1.45; }
    .content { min-width: 0; }
    .brief-grid { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(320px, .95fr); gap: 16px; }
    .brief-panel, .risk-board, .market-board, .action-board, .theme-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; box-shadow: 0 8px 24px rgba(16,24,40,.05); }
    .brief-panel h2, .risk-board h2, .market-board h2, .action-board h2, .theme-section h2 { margin: 0 0 12px; color: var(--ink); font-size: 20px; letter-spacing: 0; }
    .executive-conclusion { margin: 0 0 14px; padding: 14px 16px; border-left: 4px solid var(--gold); background: var(--soft-gold); border-radius: 8px; color: var(--navy); font-size: 17px; font-weight: 800; line-height: 1.65; }
    .summary-list { margin: 0; padding-left: 20px; display: grid; gap: 8px; }
    .risk-list { display: grid; gap: 10px; }
    .risk { display: grid; grid-template-columns: 66px minmax(0,1fr); gap: 10px; align-items: start; padding: 11px 12px; background: var(--soft-gold); border: 1px solid #EDD6B3; border-radius: 8px; }
    .risk-badge { text-align: center; border-radius: 6px; padding: 3px 8px; background: var(--gold); color: #fff; font-size: 12px; font-weight: 800; }
    .country-strip { display: flex; gap: 8px; flex-wrap: wrap; }
    .country { border: 1px solid #B8C7E6; background: var(--soft-blue); color: var(--blue); border-radius: 999px; padding: 6px 11px; font-size: 13px; font-weight: 800; }
    .market-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .market-tile { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #FBFCFE; }
    .market-tile.high { border-color: #F2B8B5; background: var(--soft-red); }
    .market-tile.medium { border-color: #EDD6B3; background: var(--soft-gold); }
    .market-tile strong { display: block; font-size: 16px; color: var(--navy); }
    .market-tile span { display: block; margin-top: 4px; color: var(--muted); font-size: 12px; font-weight: 800; }
    .theme-section, .action-board { margin-top: 16px; }
    .theme-stack { display: grid; gap: 14px; }
    .theme-head p { margin: 0 0 4px; color: var(--gold); font-size: 12px; font-weight: 900; text-transform: uppercase; }
    .theme-head h3 { margin: 0; font-size: 22px; }
    .theme-thesis { margin: 10px 0 14px; color: var(--navy); font-size: 16px; font-weight: 800; line-height: 1.65; }
    .theme-body { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(300px, .9fr); gap: 14px; }
    .theme-body h4, .action-column h3 { margin: 0 0 8px; color: var(--blue); font-size: 13px; font-weight: 900; }
    .evidence-list { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
    .evidence-list li { padding: 10px 12px; border: 1px solid var(--line); border-radius: 8px; background: #FBFCFE; }
    .evidence-list a { display: inline-flex; min-height: 32px; align-items: center; color: var(--navy); font-weight: 900; }
    .evidence-list span { display: block; color: var(--muted); font-size: 12px; font-weight: 800; }
    .action-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
    .action-column { border: 1px solid var(--line); border-radius: 8px; padding: 12px; background: #F9FBFA; }
    .report-section { margin-top: 24px; scroll-margin-top: 20px; }
    .section-heading { display: flex; justify-content: space-between; gap: 12px; align-items: end; padding-bottom: 10px; border-bottom: 1px solid var(--line-strong); margin-bottom: 12px; }
    .section-heading p { margin: 0 0 3px; color: var(--muted); font-size: 12px; font-weight: 700; }
    h2 { margin: 0; color: var(--ink); font-size: 24px; letter-spacing: 0; }
    .section-heading span { color: var(--muted); font-size: 13px; font-weight: 800; }
    .intel-card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 18px; margin-top: 14px; box-shadow: 0 8px 22px rgba(16,24,40,.045); }
    .item-topline { display: flex; gap: 12px; align-items: center; justify-content: space-between; }
    .item-number { flex: 0 0 auto; color: var(--blue); font-weight: 900; font-size: 13px; letter-spacing: 0; }
    .item-meta { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; align-items: center; color: var(--muted); font-size: 12px; }
    .tag { background: var(--blue); color: #fff; border-radius: 6px; padding: 3px 9px; font-weight: 800; }
    .tag.high { background: var(--red); }
    .tag.medium { background: var(--gold); }
    .tag.low { background: var(--green); }
    .severity-high { border-color: #F2B8B5 !important; background: #FEF3F2 !important; color: #8A1F16 !important; }
    .severity-medium { border-color: #E7C98A !important; background: #FFF5E5 !important; color: #7A4B12 !important; }
    .severity-low { border-color: #BFD9C7 !important; background: #F0FAF3 !important; color: #1F6B35 !important; }
    .tag.severity-high, .tag.severity-medium, .tag.severity-low { color: #fff !important; }
    .tag.severity-high { background: #B42318 !important; }
    .tag.severity-medium { background: #A86E1D !important; }
    .tag.severity-low { background: #287D3C !important; }
    h3 { margin: 12px 0 10px; font-size: 20px; line-height: 1.38; letter-spacing: 0; }
    .intel-grid { display: grid; grid-template-columns: .8fr .8fr 1.4fr; gap: 10px; margin: 10px 0; }
    .intel-grid div { border: 1px solid var(--line); border-radius: 8px; padding: 10px; background: #FBFCFE; min-width: 0; }
    .intel-grid .relevance-direct { border-color: #B7C9EA; background: #EAF1FB; }
    .intel-grid .relevance-indirect { border-color: #D9D2C5; background: #FBF7F0; }
    .intel-grid b { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
    .intel-grid span { display: block; color: var(--ink); font-size: 13px; font-weight: 800; overflow-wrap: anywhere; }
    .source-row { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; color: var(--muted); }
    .source-link { display: inline-flex; min-height: 44px; align-items: center; font-weight: 700; }
    .confidence { color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; }
    .source-evidence { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; margin: 12px 0; padding: 13px; border: 1px solid #D8C7B2; background: linear-gradient(180deg, #FFFDF9 0%, #FFF8EE 100%); border-radius: 8px; }
    .evidence-label { margin: 0 0 5px; color: var(--gold); font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 0; }
    .evidence-link { display: inline-flex; align-items: center; min-height: 44px; color: var(--navy); font-size: 15px; font-weight: 900; text-decoration-thickness: 0.08em; }
    .evidence-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; color: var(--muted); font-size: 12px; font-weight: 800; text-transform: uppercase; }
    .evidence-meta span { border: 1px solid #E5D4BE; background: rgba(255,255,255,.72); border-radius: 999px; padding: 3px 8px; }
    .evidence-meta .confidence-high { border-color: #BFD9C7; background: #F0FAF3; color: #1F6B35; }
    .evidence-meta .confidence-medium { border-color: #E7C98A; background: #FFF5E5; color: #7A4B12; }
    .evidence-meta .confidence-low { border-color: #F2B8B5; background: #FEF3F2; color: #8A1F16; }
    .evidence-image { margin: 0; border: 1px solid #E6D8C5; border-radius: 8px; overflow: hidden; background: #fff; aspect-ratio: 16 / 9; }
    .evidence-image img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .conclusion-strip { margin: 12px 0; border-left: 4px solid var(--blue); background: var(--soft-blue); border-radius: 8px; padding: 12px 14px; }
    .conclusion-strip h4 { margin: 0 0 5px; color: var(--blue); font-size: 13px; font-weight: 900; }
    .conclusion-strip p { margin: 0; color: var(--ink); font-size: 15px; line-height: 1.7; }
    .analysis-grid { display: grid; grid-template-columns: minmax(0, .95fr) minmax(0, 1.05fr); gap: 12px; margin-top: 12px; }
    .analysis-panel { border: 1px solid var(--line); border-radius: 8px; background: #fff; padding: 13px; }
    .analysis-panel h4 { margin: 0 0 8px; color: var(--blue); font-size: 13px; font-weight: 900; }
    .analysis-panel p { margin: 0; }
    .why-panel { background: var(--soft-blue); border-color: #C7D7F2; }
    .action-panel { background: #F7FAF8; border-color: #C9DDCF; }
    .detail-panel { grid-column: 1 / -1; }
    .compact-list, .scope-list, .impact-list { margin: 10px 0 0; padding-left: 20px; }
    .scope-list li { color: var(--muted); }
    .impact-list li { color: var(--ink); font-weight: 600; }
    .empty { margin: 0; color: var(--muted); }
    .analysis-block { margin-top: 14px; }
    .analysis-block:first-child { margin-top: 0; }
    .analysis-block h4 { margin: 0 0 6px; color: var(--muted); font-size: 12px; font-weight: 900; }
    .footer { max-width: 1320px; margin: 0 auto; padding: 0 28px 34px; color: var(--muted); font-size: 13px; }
    @media (max-width: 1080px) { .layout { grid-template-columns: 1fr; } .side-rail { position: static; } .module-nav { grid-template-columns: repeat(2, minmax(0, 1fr)); } .brief-grid, .theme-body, .action-grid { grid-template-columns: 1fr; } }
    @media (min-width: 900px) { .source-evidence:has(.evidence-image) { grid-template-columns: minmax(180px, 260px) minmax(0, 1fr); align-items: center; } }
    @media (max-width: 720px) { .top-inner, .layout, .footer { padding-left: 14px; padding-right: 14px; } h1 { font-size: 28px; } .metric-grid, .module-nav, .intel-grid, .analysis-grid { grid-template-columns: 1fr; } .detail-panel { grid-column: auto; } .item-topline { align-items: flex-start; flex-direction: column; } .item-meta { justify-content: flex-start; } }
  </style>
</head>
<body>
  <header class="page-top">
    <div class="top-inner">
      <p class="eyebrow">Global Beauty Legal Intelligence</p>
      <h1>国际美妆法务情报周报</h1>
      <p class="subtitle">Intelligence Command Center · 周期：${escapeHtml(report.period.start)} 至 ${escapeHtml(report.period.end)}。面向国际化美妆电商集团，覆盖法规、案例、知识产权、进出口和行业动态。</p>
      <div class="metric-grid" aria-label="风险统计">
        <div class="metric"><strong>${allItems.length}</strong><span>高价值资讯</span></div>
        <div class="metric"><strong>${countries.length}</strong><span>市场覆盖</span></div>
        <div class="metric"><strong>${directCount}</strong><span>直接相关</span></div>
        <div class="metric"><strong>${highImpactCount}</strong><span>高行业影响力</span></div>
      </div>
    </div>
  </header>
  <main class="layout">
    <aside class="side-rail" aria-label="情报导航">
      <section class="rail-card">
        <p class="rail-title">Coverage Map</p>
        <div class="country-strip" aria-label="涉及国家和地区">${countries.map(country => `<span class="country">${escapeHtml(country)}</span>`).join('')}</div>
      </section>
      <section class="rail-card">
        <p class="rail-title">Modules</p>
        <nav class="module-nav" aria-label="模块导航">${moduleNav}</nav>
      </section>
      <section class="rail-card">
        <p class="rail-title">Priority Watch</p>
        <ul class="priority-list">${urgentHtml}</ul>
      </section>
    </aside>
    <div class="content">
      <div class="brief-grid">
        <section class="brief-panel" aria-labelledby="summary-title">
          <h2 id="summary-title">Executive Brief</h2>
          <p class="executive-conclusion">${escapeHtml(executiveConclusion)}</p>
          ${executiveBullets ? `<ul class="summary-list">${executiveBullets}</ul>` : '<p class="empty">本周无高价值更新</p>'}
        </section>
        <section class="risk-board" aria-labelledby="risk-title">
          <h2 id="risk-title">Market Risk Map</h2>
          <div class="market-grid">${marketRiskHtml}</div>
        </section>
      </div>

      <section class="theme-section" aria-labelledby="theme-title">
        <h2 id="theme-title">Strategic Themes</h2>
        <div class="theme-stack">${strategicThemeHtml}</div>
      </section>

      <section class="action-board" aria-labelledby="action-title">
        <h2 id="action-title">Action Board</h2>
        <div class="action-grid">${actionBoardHtml || '<p class="empty">暂无明确团队动作。</p>'}</div>
      </section>

      <div class="brief-grid">
        <section class="risk-board" aria-labelledby="risk-title-detail">
          <h2 id="risk-title-detail">Risk Signals</h2>
          <div class="risk-list">
            ${(report.risk_alerts || []).length ? report.risk_alerts.map(alert => `<div class="risk"><span class="risk-badge">${escapeHtml(riskLabel(alert.level))}</span><span>${escapeHtml(alert.text)}</span></div>`).join('') : '<p class="empty">本周无高价值风险提醒</p>'}
          </div>
        </section>
        <section class="brief-panel">
          <h2>Source Evidence</h2>
          <p class="empty">以下为按 Excel 分类保留的证据明细。每条均保留原文链接、可信度、业务影响和建议动作。</p>
        </section>
      </div>

      ${sectionHtml}
    </div>
  </main>

  <footer class="footer">
    <p>生成时间：${escapeHtml(generatedAt)}</p>
    <p>信息源说明：本页面由公开网页与行业线索自动整理生成，公众号类来源仅作线索，最终以原文链接为准。</p>
    ${failures.length ? `<p>部分源抓取失败：${escapeHtml(failures.slice(0, 12).join('、'))}</p>` : ''}
    <p>AI 生成内容仅供法务信息初筛，不构成正式法律意见。</p>
  </footer>
</body>
</html>`;
}

export function renderFeishuSummary(report, reportUrl) {
  validateReport(report);
  const items = (report.sections || []).flatMap(section => section.items || []);
  const suggest = action => {
    const text = String(action || '').trim();
    if (!text) return '建议相关团队结合业务范围判断是否需要跟进。';
    if (/^(建议|可考虑|建议由|建议法务|建议注册|建议市场|建议电商|建议供应链)/.test(text)) return text;
    return `建议${text.replace(/^(请|需|需要|应当|必须|及时|立即)/, '')}`;
  };
  const executive = report.summary?.[0] || `本周筛选出 ${items.length} 条美妆法务情报，建议按风险等级和业务影响优先处理。`;
  const priorityItems = items
    .filter(item => item.risk_level === 'high' || item.industry_impact === 'high')
    .slice(0, 4);
  const guide = (report.summary || []).slice(0, 3).map((item, index) => `${index + 1}. ${item}`).join('\n') || `1. 本期共 ${items.length} 条情报，建议先看高风险和高行业影响力条目。`;
  const risks = (report.risk_alerts || []).slice(0, 3).map(alert => `• ${riskLabel(alert.level)}：${alert.text}`).join('\n') || '本周暂无高价值风险提醒。';
  const actionLines = priorityItems.map(item => {
    const action = Array.isArray(item.recommended_actions) ? item.recommended_actions[0] : '';
    return `• ${item.country}｜${riskLabel(item.risk_level)}｜${item.title}\n  ${suggest(action)}`;
  }).join('\n') || '• 本周暂无需要立即处理的高风险事项。';
  const evidence = priorityItems.slice(0, 3).map(item => `• ${item.source_name}：${item.source_url}`).join('\n') || '• 完整来源见网页版。';
  return `**美妆法务周报｜${report.period.end}**\n\n**Executive Brief｜核心判断**\n${executive}\n\n**导读｜先看这三件事**\n${guide}\n\n**风险提示**\n${risks}\n\n**Action Board｜建议优先动作**\n${actionLines}\n\n**Source Evidence｜来源证据**\n${evidence}\n\n**完整版网页**\n[查看完整周报](${reportUrl})\n\n_本周报由 DeepSeek 辅助整理，仅作信息初筛，不构成正式法律意见。_`;
}

export function reportKeyForDate(date) {
  return `report:${date}`;
}

export function latestReportKey() {
  return 'report:latest';
}

function reportUrl(requestUrl, pathname) {
  const url = new URL(requestUrl);
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

async function saveReport(kv, date, html, metadata) {
  await kv.put(reportKeyForDate(date), html, { metadata });
  await kv.put(latestReportKey(), html, { metadata: { ...metadata, date } });

  const raw = await kv.get(REPORT_INDEX_KEY);
  const index = raw ? JSON.parse(raw) : [];
  const next = [{ date, ...metadata }, ...index.filter(item => item.date !== date)].slice(0, 24);
  await kv.put(REPORT_INDEX_KEY, JSON.stringify(next));
}

async function loadReport(kv, key) {
  if (!kv) return null;
  return kv.get(key);
}

async function renderReportIndex(kv) {
  const raw = kv ? await kv.get(REPORT_INDEX_KEY) : null;
  const index = raw ? JSON.parse(raw) : [];
  const links = index.map(item => `<li><a href="/report/${escapeHtml(item.date)}">${escapeHtml(item.date)}</a><span>${escapeHtml(item.itemCount ?? 0)} 条资讯</span></li>`).join('');
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>往期美妆法务周报</title><style>body{margin:0;background:#F8FAFC;color:#0F172A;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:16px;line-height:1.7}.shell{max-width:820px;margin:0 auto;padding:32px 18px}h1{color:#1E3A8A}ul{list-style:none;padding:0;display:grid;gap:12px}li{display:flex;justify-content:space-between;gap:12px;background:#fff;border:1px solid #E2E8F0;border-radius:16px;padding:16px;box-shadow:0 10px 28px rgba(15,23,42,.05)}a{color:#1E40AF;font-weight:700;min-height:44px;display:inline-flex;align-items:center}</style></head><body><main class="shell"><h1>往期美妆法务周报</h1>${links ? `<ul>${links}</ul>` : '<p>暂无往期周报。</p>'}</main></body></html>`;
}

async function fetchSourceCandidates(source) {
  if (!source.url || !source.url.startsWith('http')) return [];

  try {
    const response = await fetchWithTimeout(source.url, {
      headers: {
        'User-Agent': 'beauty-legal-bot/1.0 (+legal intelligence monitor)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) return [];

    const html = await response.text();
    const linkLimit = ['美妆动态', '进出口动态'].includes(source.module) ? 14 : 8;
    const snippetLimit = ['美妆动态', '进出口动态'].includes(source.module) ? 1500 : 800;
    const links = extractLinks(html, source.url).filter(link => isRelevantTitle(link.title)).slice(0, linkLimit);
    const imageUrl = extractImageUrl(html, source.url);
    const pageText = htmlToText(html).slice(0, snippetLimit);
    const linkCandidates = links.map(link => makeCandidate(source, { ...link, snippet: pageText, image_url: imageUrl }));
    const sourceText = `${source.name} ${(source.topics || []).join(' ')} ${pageText}`;
    const shouldKeepSourcePage = source.priority === 'high' || BEAUTY_KEYWORDS.some(keyword => sourceText.toLowerCase().includes(keyword.toLowerCase()));
    const sourceCandidate = shouldKeepSourcePage
      ? [makeCandidate(source, {
        title: `${source.name}：${source.module}信息源入口`,
        url: source.url,
        image_url: imageUrl,
        snippet: pageText || `${source.name} ${source.module} ${(source.topics || []).join(' ')}`,
      })]
      : [];
    return [...linkCandidates, ...sourceCandidate];
  } catch (error) {
    console.warn(`fetch failed: ${source.name} ${error.message}`);
    return [];
  }
}

async function collectCandidates(sources = sourceCatalog.sources, onProgress = async () => {}) {
  const { fetchableSources, leadSources } = splitSources(sources);
  const leads = leadSources.map(makeLead);
  const leadCandidates = leadSources.map(makeSourceLeadCandidate);

  const results = await mapWithConcurrency(fetchableSources, SOURCE_FETCH_CONCURRENCY, async (source, index) => {
    await onProgress({ index: index + 1, total: fetchableSources.length, source: source.name });
    const items = await fetchSourceCandidates(source);
    return { source, items: items.length ? items : [makeSourceLeadCandidate(source)] };
  });

  const failures = results.filter(result => result.items.length === 1 && result.items[0].title.includes('行业线索')).map(result => result.source.name);
  const candidates = [...results.flatMap(result => result.items), ...leadCandidates];

  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = item.url || `${item.title}:${item.source_name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  return { candidates: unique, leads, failures };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export default {
  async scheduled(event, env, _ctx) {
    try {
      await recordLastRun(env.SEEN_NEWS, { trigger: 'scheduled', scheduled_time: event?.scheduledTime || null, status: 'started' });
      const result = await runPipeline(env);
      await recordLastRun(env.SEEN_NEWS, { trigger: 'scheduled', scheduled_time: event?.scheduledTime || null, status: result?.status || 'done', stage: result?.stage || 'pipeline' });
    } catch (error) {
      await recordLastRun(env.SEEN_NEWS, { trigger: 'scheduled', scheduled_time: event?.scheduledTime || null, status: 'failed', error: error.stack || error.message });
      throw error;
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/test") {
      const pipeline = env.__TEST_RUN_PIPELINE__ || runPipeline;
      try {
        await recordLastRun(env.SEEN_NEWS, { trigger: 'manual', status: 'started' });
        const result = await pipeline(env, request.url);
        await recordLastRun(env.SEEN_NEWS, { trigger: 'manual', status: result?.status || 'done', stage: result?.stage || 'pipeline' });
        return new Response(`OK — weekly pipeline finished\nstatus: ${result?.status || 'done'}\nlatest_report: ${url.origin}/report/latest`, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (error) {
        await recordLastRun(env.SEEN_NEWS, { trigger: 'manual', status: 'failed', error: error.stack || error.message });
        return new Response(`FAILED — weekly pipeline error\n${error.stack || error.message}`, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    }

    if (url.pathname === "/report") {
      return new Response(await renderReportIndex(env.SEEN_NEWS), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (url.pathname === "/report/latest") {
      const html = await loadReport(env.SEEN_NEWS, latestReportKey());
      return html
        ? new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
        : new Response("No report generated yet", { status: 404 });
    }

    const match = url.pathname.match(/^\/report\/(\d{4}-\d{2}-\d{2})$/);
    if (match) {
      const html = await loadReport(env.SEEN_NEWS, reportKeyForDate(match[1]));
      return html
        ? new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } })
        : new Response("Report not found", { status: 404 });
    }

    return new Response("beauty-legal-bot v3 — weekly DeepSeek legal intelligence", { status: 200 });
  },
};
