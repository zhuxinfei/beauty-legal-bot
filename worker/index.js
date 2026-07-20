/**
 * 美妆法务资讯周报机器人 - Cloudflare Worker
 *
 * 管道: 信息源抓取 → AI 结构化分析 → HTML 周报 → KV 存档 → 协作平台摘要推送
 * 触发: 每周一 UTC 00:00 (北京时间 08:00) cron 自动执行
 *
 * 部署:
 *   npx wrangler secret put AI_API_KEY
 *   npx wrangler secret put FEISHU_WEBHOOK_URL
 *   npx wrangler secret put DINGTALK_WEBHOOK_URL
 *   npx wrangler kv namespace create SEEN_NEWS  (已创建)
 *   npx wrangler deploy
 */

import sourceCatalog from './sources.json' with { type: 'json' };
import { buildDingTalkMessages } from './dingtalk-single-card.js';
import { buildActionDashboardSvg } from './action-dashboard.js';
import { classifyFreshness, filterCandidatesByFreshness } from './freshness.js';
import { curateReportQuality, curateReportQualityWithAudit, findBeautyEvidenceIndex, objectiveFacts, objectiveObservation } from './report-quality.js';
import {
  assertSourceCoverage,
  calculateSourceCoverage,
  recoverPublicSource,
} from './source-recovery.js';
import {
  evaluateEditorialCandidate,
  evaluateSourceOnlyProof,
  inferArticleChinaRelevance,
  inferCandidateModule,
} from './content-quality.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const DEFAULT_AI_API_BASE_URL = 'https://hk.testvideo.site/v1';
const DEFAULT_AI_MODEL = 'gpt-5.5';

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
const NAVIGATION_TITLE_PATTERNS = [
  /^(?:欢迎访问|欢迎来到|welcome\s+to)/i,
  /^(?:网站|站点|平台)?(?:首页|主页|导航|登录|注册|联系我们|网站地图|搜索结果)$/i,
  /^(?:home|login|sign\s*in|site\s*map|contact\s*us|search)$/i,
  /^(?:404|403|500|not\s+found|access\s+denied)$/i,
];

const NOISE_KEYWORDS = ['融资', '发布会', '新品上市', '代言', '财报', '招聘'];
const REPORT_INDEX_KEY = 'report:index';
const LAST_RUN_KEY = 'run:last';
const LATEST_DECISION_MAP_KEY = 'asset:decision-map:latest';
const LATEST_DECISION_MAP_PNG_KEY = 'asset:decision-map:latest.png';
const LATEST_EDITORIAL_REPORT_PNG_KEY = 'asset:editorial-report:latest.png';
const REPORT_MODULES = [
  '广告合规及处罚案例',
  '美妆动态',
  '知识产权动态',
  '新规及案例动态',
  '进出口动态',
  '产品质量/召回与安全风险',
];
const ACTION_NOISE = ['建议关注', '持续关注', '企业应留意', '可能产生影响', '需持续观察'];
const SOURCE_FETCH_TIMEOUT_MS = 30000;
const SOURCE_FETCH_CONCURRENCY = 4;
const DETAIL_FETCH_CONCURRENCY = 8;
const DETAIL_CANDIDATE_LIMIT = 48;
const DETAIL_FETCH_TIMEOUT_MS = 12000;
const DETAIL_BROWSER_RECOVERY_LIMIT = 18;
const MAX_COMPLETE_ARTICLE_CHARS = 120000;
const WORKER_FETCH_SOURCE_BUDGET = 15;
const AI_REQUEST_TIMEOUT_MS = 120000;
const AI_REQUEST_MAX_ATTEMPTS = 2;
const AI_RETRY_BASE_DELAY_MS = 1500;
const DEFAULT_AI_MAX_TOKENS = 8000;
const QUALITY_AI_MAX_TOKENS = 16000;
const DEFAULT_ANALYSIS_CANDIDATE_LIMIT = 140;
const QUALITY_ANALYSIS_CANDIDATE_LIMIT = 220;
const DEFAULT_ANALYSIS_LEAD_LIMIT = 120;
const QUALITY_ANALYSIS_LEAD_LIMIT = 180;
const DEFAULT_REPORT_ITEMS_PER_MODULE = 8;
const QUALITY_REPORT_ITEMS_PER_MODULE = 12;
const TYPE_REQUIRED_FIELDS = {
  '法规': ['status', 'what_changed', 'legal_obligation', 'affected_business', 'recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence'],
  '案例': ['case_type', 'facts', 'violation_logic', 'penalty_or_result', 'risk_pattern', 'business_lessons', 'recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence'],
  'IP': ['dispute_focus', 'protected_element', 'infringement_logic', 'impact_on_brand_assets', 'recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence'],
  '进出口': ['market_access_change', 'affected_import_flow', 'documents_needed', 'recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence'],
  '动态': ['regulatory_signal', 'compliance_meaning', 'possible_follow_up', 'recommended_actions', 'owner_teams', 'risk_level', 'why_it_matters', 'confidence'],
};
const OBJECTIVE_REQUIRED_FIELDS = ['source_type', 'relevance', 'industry_impact', 'fact_summary', 'next_observation', 'confidence'];

// ---------------------------------------------------------------------------
// AI：一站式搜索 + 分析 + 格式化（OpenAI-compatible API）
// ---------------------------------------------------------------------------
function isRetryableAiNetworkError(error) {
  const code = error?.code || error?.cause?.code;
  return error?.name === 'AbortError'
    || ['UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code)
    || (error instanceof TypeError && /fetch failed|network/i.test(error.message || ''));
}

export async function requestAiChat({
  apiKey,
  baseUrl = DEFAULT_AI_API_BASE_URL,
  model = DEFAULT_AI_MODEL,
  messages,
  temperature = 0.2,
  maxTokens = 8000,
  timeoutMs = AI_REQUEST_TIMEOUT_MS,
  maxAttempts = AI_REQUEST_MAX_ATTEMPTS,
  reasoningEffort = '',
  sleepFn = sleep,
  fetcher = fetch,
}) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (model === 'gpt-5.6-sol') {
    body.reasoning_effort = reasoningEffort || 'medium';
  }
  const endpoint = `${String(baseUrl || DEFAULT_AI_API_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const attempts = Math.max(1, Number(maxAttempts) || AI_REQUEST_MAX_ATTEMPTS);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetcher(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const error = new Error(`AI ${resp.status}: ${await resp.text().then(t => t.slice(0, 300))}`);
        error.retryable = resp.status === 408 || resp.status === 429 || resp.status >= 500;
        throw error;
      }

      const data = await resp.json();
      return data.choices?.[0]?.message?.content || '';
    } catch (error) {
      const normalizedError = error?.name === 'AbortError'
        ? Object.assign(new Error(`AI request timed out after ${timeoutMs}ms`), { code: 'AI_TIMEOUT', retryable: true })
        : error;
      const retryable = normalizedError.retryable || isRetryableAiNetworkError(normalizedError);
      if (!retryable || attempt === attempts - 1) throw normalizedError;
      await sleepFn(AI_RETRY_BASE_DELAY_MS * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('AI request failed without a response');
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

export function shouldSkipDuplicateReport(isDuplicate, forceDelivery = false) {
  return Boolean(isDuplicate) && !forceDelivery;
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
        elements: [{ tag: "plain_text", content: `🤖 由 AI 自动生成 · 仅供参考 · ${today}` }],
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

function markdownList(values) {
  return (values || [])
    .filter(Boolean)
    .map(value => `  - ${String(value).replace(/\n+/g, ' ').trim()}`)
    .join('\n');
}

function markdownTableCell(value) {
  return String(value || '')
    .replace(/\|/g, '/')
    .replace(/\n+/g, ' ')
    .trim() || '待判断';
}

function compactText(value, maxLength = 36) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function firstText(...values) {
  for (const value of values) {
    if (Array.isArray(value)) {
      const found = value.map(item => String(item || '').trim()).find(Boolean);
      if (found) return found;
    } else if (String(value || '').trim()) {
      return String(value).trim();
    }
  }
  return '';
}

function rankReportItem(item) {
  return (item.risk_level === 'high' ? 60 : item.risk_level === 'medium' ? 30 : 10)
    + (item.industry_impact === 'high' ? 40 : item.industry_impact === 'medium' ? 20 : 5)
    + (item.relevance === 'direct' ? 25 : 5)
    + (item.confidence === 'high' ? 20 : item.confidence === 'medium' ? 10 : 0)
    + (isHttpUrl(item.source_url) ? 15 : 0);
}

function compactAction(item) {
  return (item.recommended_actions || [])
    .map(action => String(action || '').trim())
    .find(Boolean) || '建议法务团队核验原文并判断是否需要更新内部合规清单。';
}

function compactImpact(item) {
  return (item.business_impact || []).slice(0, 3).join(' / ') || item.why_it_matters || '待结合业务覆盖范围判断。';
}

function moduleCode(module) {
  const index = REPORT_MODULES.indexOf(module);
  return index >= 0 ? `M${index + 1}` : 'M?';
}

function verifiedReportItems(report) {
  return (report.sections || [])
    .flatMap(section => (section.items || []).map(item => ({ ...item, module: section.module })))
    .filter(item => isHttpUrl(item.source_url));
}

export function shouldPublishDecisionMap(report) {
  return verifiedReportItems(report).some(item => item.report_tier === 'action');
}

function buildLegacyDecisionMapSvg(items) {
  const graphItems = (items || []).slice(0, 10);
  const width = 1600;
  const height = 1180;
  const center = { x: 800, y: 570 };
  const moduleCounts = new Map();
  const countryCounts = new Map();
  const impactCounts = new Map();
  const ownerCounts = new Map();
  const riskCounts = new Map();
  for (const item of graphItems) {
    const add = (map, key) => map.set(key, (map.get(key) || 0) + 1);
    add(moduleCounts, `${moduleCode(item.module)} ${item.module || '未分类'}`);
    add(countryCounts, item.country || item.region || '全球');
    for (const impact of (item.business_impact || []).slice(0, 2)) add(impactCounts, impact);
    for (const owner of (item.owner_teams || []).slice(0, 2)) add(ownerCounts, owner);
    add(riskCounts, riskLabel(item.risk_level));
  }
  const topEntries = (map, limit) => [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-Hans-CN')).slice(0, limit);
  const groups = [
    { label: '监管主题', sub: '六大模块中的高频事项', entries: topEntries(moduleCounts, 6), x: 250, y: 410, fill: '#DBEAFE', stroke: '#2563EB', accent: '#1D4ED8' },
    { label: '重点市场', sub: '本周出现监管信号的国家/地区', entries: topEntries(countryCounts, 6), x: 1310, y: 410, fill: '#E0F2FE', stroke: '#0891B2', accent: '#0E7490' },
    { label: '风险强度', sub: '优先处置顺序', entries: topEntries(riskCounts, 4), x: 250, y: 830, fill: '#FEE2E2', stroke: '#DC2626', accent: '#B91C1C' },
    { label: '业务影响', sub: '可能被牵动的内部流程', entries: topEntries(impactCounts, 6), x: 800, y: 1030, fill: '#FEF3C7', stroke: '#D97706', accent: '#B45309' },
    { label: '行动归口', sub: '建议优先协同团队', entries: topEntries(ownerCounts, 6), x: 1310, y: 830, fill: '#DCFCE7', stroke: '#16A34A', accent: '#15803D' },
  ];
  const line = (x1, y1, x2, y2, color = '#94A3B8', weight = 1) => `<path d="M ${x1} ${y1} C ${(x1 + x2) / 2} ${y1}, ${(x1 + x2) / 2} ${y2}, ${x2} ${y2}" stroke="${color}" stroke-width="${2.2 + weight * 0.9}" fill="none" opacity=".68"/>`;
  const pill = (x, y, text, count, fill, stroke) => {
    const label = `${compactText(text, 18)}${count > 1 ? ` ×${count}` : ''}`;
    const w = Math.max(138, Math.min(275, 30 + label.length * 15));
    return `<g>
      <rect x="${x - w / 2}" y="${y - 24}" width="${w}" height="48" rx="24" fill="${fill}" stroke="${stroke}" stroke-width="2.2"/>
      <text x="${x}" y="${y + 7}" text-anchor="middle" font-size="18" fill="#0F172A" font-weight="800">${escapeHtml(label)}</text>
    </g>`;
  };
  const groupSvg = groups.map(group => {
    const rows = group.entries.length ? group.entries : [['暂无高价值节点', 1]];
    const nodes = rows.map(([text, count], index) => {
      const y = group.y + (index - (rows.length - 1) / 2) * 62;
      return `${line(center.x, center.y, group.x, y, group.stroke, count)}${pill(group.x, y, text, count, group.fill, group.stroke)}`;
    }).join('');
    return `<g>
      <rect x="${group.x - 175}" y="${group.y - 230}" width="350" height="70" rx="18" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="2"/>
      <text x="${group.x}" y="${group.y - 202}" text-anchor="middle" font-size="23" fill="${group.accent}" font-weight="900">${escapeHtml(group.label)}</text>
      <text x="${group.x}" y="${group.y - 175}" text-anchor="middle" font-size="14" fill="#64748B">${escapeHtml(group.sub)}</text>
      ${nodes}
    </g>`;
  }).join('');
  const total = graphItems.length;
  const high = graphItems.filter(item => item.risk_level === 'high').length;
  const direct = graphItems.filter(item => item.relevance === 'direct').length;
  const official = graphItems.filter(item => ['official', 'regulator', 'official_site', 'court'].includes(item.source_type) || item.authority_type === 'regulator').length;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <defs>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="10" stdDeviation="12" flood-color="#0F172A" flood-opacity=".13"/>
      </filter>
      <radialGradient id="core" cx="50%" cy="45%" r="65%">
        <stop offset="0%" stop-color="#1E293B"/>
        <stop offset="100%" stop-color="#020617"/>
      </radialGradient>
    </defs>
    <rect width="${width}" height="${height}" fill="#F8FAFC"/>
    <rect x="38" y="30" width="${width - 76}" height="${height - 60}" rx="34" fill="#FFFFFF" stroke="#E2E8F0" stroke-width="2"/>
    <text x="70" y="78" font-size="34" fill="#0F172A" font-weight="900">本周美妆法务风险雷达</text>
    <text x="70" y="110" font-size="16" fill="#64748B">把可核验情报压缩为“监管主题 - 重点市场 - 风险强度 - 业务影响 - 行动归口”的关联视图</text>
    <g>
      <rect x="1110" y="54" width="94" height="54" rx="14" fill="#F1F5F9"/>
      <text x="1157" y="76" text-anchor="middle" font-size="13" fill="#64748B">情报</text>
      <text x="1157" y="99" text-anchor="middle" font-size="20" fill="#0F172A" font-weight="900">${total}</text>
      <rect x="1220" y="54" width="94" height="54" rx="14" fill="#FEF2F2"/>
      <text x="1267" y="76" text-anchor="middle" font-size="13" fill="#991B1B">高风险</text>
      <text x="1267" y="99" text-anchor="middle" font-size="20" fill="#B91C1C" font-weight="900">${high}</text>
      <rect x="1330" y="54" width="94" height="54" rx="14" fill="#EFF6FF"/>
      <text x="1377" y="76" text-anchor="middle" font-size="13" fill="#1D4ED8">直接相关</text>
      <text x="1377" y="99" text-anchor="middle" font-size="20" fill="#1D4ED8" font-weight="900">${direct}</text>
      <rect x="1440" y="54" width="94" height="54" rx="14" fill="#ECFDF5"/>
      <text x="1487" y="76" text-anchor="middle" font-size="13" fill="#15803D">官方源</text>
      <text x="1487" y="99" text-anchor="middle" font-size="20" fill="#15803D" font-weight="900">${official}</text>
    </g>
    ${groupSvg}
    <g filter="url(#shadow)">
      <circle cx="${center.x}" cy="${center.y}" r="132" fill="url(#core)"/>
      <circle cx="${center.x}" cy="${center.y}" r="148" fill="none" stroke="#CBD5E1" stroke-width="3"/>
      <text x="${center.x}" y="${center.y - 30}" text-anchor="middle" font-size="30" fill="#FFFFFF" font-weight="900">美妆法务</text>
      <text x="${center.x}" y="${center.y + 8}" text-anchor="middle" font-size="30" fill="#FFFFFF" font-weight="900">风险雷达</text>
      <text x="${center.x}" y="${center.y + 48}" text-anchor="middle" font-size="16" fill="#CBD5E1">${graphItems.length} 条可核验情报</text>
      <text x="${center.x}" y="${center.y + 74}" text-anchor="middle" font-size="14" fill="#94A3B8">AI distilled map</text>
    </g>
  </svg>`;
}

export function buildDecisionMapSvg(items, options = {}) {
  return buildActionDashboardSvg(items, options);
}

function renderWholeReportInsights(report) {
  const items = verifiedReportItems(report);
  const countries = [...new Set(items.map(item => item.country).filter(Boolean))];
  const modules = [...new Set(items.map(item => item.module).filter(Boolean))];
  const impacts = [...new Set(items.flatMap(item => item.business_impact || []).filter(Boolean))].slice(0, 6);
  const highRisk = items.filter(item => item.risk_level === 'high');
  const direct = items.filter(item => item.relevance === 'direct');
  const official = items.filter(item => ['official', 'regulator', 'official_site', 'court'].includes(item.source_type) || item.authority_type === 'regulator');

  if (!items.length) {
    return [
      '本期没有形成足够可核验的正式条目；这本身说明当前信息源需要继续补充可稳定抓取的官方原文入口。',
      '建议先把公众号和行业媒体作为线索池，不把未核验内容作为正式法务判断依据。',
    ];
  }

  return [
    `本期可核验信息集中在${countries.slice(0, 5).join('、') || '多个市场'}，覆盖${modules.slice(0, 4).join('、')}；这说明美妆法务监测不能只盯国内药监，还要同时覆盖广告、IP、进出口和产品质量风险。`,
    `${direct.length} 条为直接相关、${highRisk.length} 条为高风险、${official.length} 条来自官方或监管源；优先处理顺序应按“官方源 + 直接相关 + 有生效/整改节点”的组合排序。`,
    `从业务影响看，${impacts.join('、') || '注册备案、广告投放、供应链和平台运营'}是本期主要受影响面；法务输出应转化为注册、市场、电商、供应链可执行的检查清单，而不是只转发资讯标题。`,
  ];
}

function renderWholeReportActionBoard(report) {
  const actions = [];
  const seen = new Set();
  for (const item of verifiedReportItems(report).sort((a, b) => rankReportItem(b) - rankReportItem(a))) {
    const teams = (item.owner_teams || ['法务']).join('/');
    for (const action of item.recommended_actions || []) {
      const text = String(action || '').trim();
      if (!text || seen.has(`${teams}:${text}`)) continue;
      seen.add(`${teams}:${text}`);
      actions.push({ teams, text, source: item.title });
      if (actions.length >= 8) return actions;
    }
  }
  return actions;
}

export function renderDingTalkSummaryCard(report, docUrl = '', options = {}) {
  const sections = report.sections || [];
  const topItems = verifiedReportItems(report)
    .sort((a, b) => rankReportItem(b) - rankReportItem(a))
    .slice(0, 5);

  const lines = [
    `# 美妆法务资讯｜${report.period?.end || '本期'}周报摘要`,
    '',
    '## 本周最值得看',
    '',
  ];

  if (!topItems.length) {
    lines.push('本周暂无可核验的高价值正式条目。', '');
  } else {
    topItems.forEach((item, index) => {
      lines.push(`${index + 1}. **[${riskLabel(item.risk_level)}] ${item.country || item.region || '全球'}｜${item.title}**`);
      lines.push(`   - 来源：[原文](${item.source_url})｜${item.source_name || '来源待核验'}`);
      lines.push(`   - 影响：${compactImpact(item)}`);
      lines.push(`   - AI判断：${item.why_it_matters || '该信息需要相关团队结合业务覆盖范围判断影响。'}`);
      lines.push(`   - 动作：${compactAction(item)}`);
    });
    lines.push('');
  }

  lines.push('## 模块概览', '');
  for (const section of sections) {
    const items = section.items || [];
    const verified = items.filter(item => isHttpUrl(item.source_url)).length;
    const countries = [...new Set(items.map(item => item.country).filter(Boolean))].slice(0, 5);
    lines.push(`- ${section.module}：${verified} 条可核验${countries.length ? `｜${countries.join('、')}` : ''}`);
  }
  lines.push('');

  lines.push('## 关系图', '');
  const graphItems = topItems.slice(0, 4);
  const graphImageUrl = options.decisionMapUrl || '';
  if (graphImageUrl) {
    lines.push(`![本周美妆法务风险雷达](${graphImageUrl})`, '');
  }
  if (graphItems.length) {
    for (const item of graphItems) {
      const team = (item.owner_teams || ['法务']).slice(0, 2).join('/');
      const impact = (item.business_impact || ['业务影响待判断'])[0];
      lines.push(`${item.source_name || item.country || '信息源'} -> ${item.module || item.type || '风险事项'} -> ${impact} -> ${team}`);
    }
  } else {
    lines.push('信息源 -> 风险类型 -> 影响业务 -> 责任团队');
  }
  lines.push('');

  if (docUrl) {
    lines.push(`[查看完整版本](${docUrl})`);
  } else {
    lines.push('完整版本：待接入钉钉文档后提供链接。');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sortReportItemsForDelivery(items = []) {
  return [...items].sort((a, b) => {
    const chinaPriority = Number(String(b.country || '').trim() === '中国')
      - Number(String(a.country || '').trim() === '中国');
    if (chinaPriority) return chinaPriority;
    return rankReportItem(b) - rankReportItem(a)
      || String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN');
  });
}

function renderDingTalkDeliveryItem(item, index) {
  const happened = firstText(
    item.what_changed,
    item.facts,
    item.regulatory_signal,
    item.compliance_meaning,
    item.title
  );
  const legalAnalysis = firstText(
    item.legal_obligation,
    item.violation_logic,
    item.dispute_focus,
    item.market_access_change,
    item.analysis
  ) || item.why_it_matters || '需由法务结合原文和业务场景进一步核验。';
  const teams = (item.owner_teams || ['法务']).join('、');
  const source = isHttpUrl(item.source_url)
    ? `[${item.source_name || '查看原文'}](${item.source_url})`
    : (item.source_name || '来源待核验');
  const deadline = item.next_deadline || item.effective_date || item.feedback_deadline || '';
  return [
    `### ${index + 1}. [${riskLabel(item.risk_level)}] ${item.country || item.region || '全球'}｜${item.title}`,
    `- **来源**：${source}`,
    `- **事实摘要**：${happened}`,
    `- **法务拆解**：${legalAnalysis}`,
    `- **业务影响**：${compactImpact(item)}`,
    `- **责任团队**：${teams}`,
    `- **具体动作**：${compactAction(item)}`,
    ...(deadline ? [`- **关键节点**：${deadline}`] : []),
  ].join('\n');
}

function markdownByteLength(value) {
  return new TextEncoder().encode(String(value || '')).length;
}

function splitTextByBytes(text, maxBytes) {
  const chunks = [];
  let current = '';
  for (const character of String(text || '')) {
    if (current && markdownByteLength(`${current}${character}`) > maxBytes) {
      chunks.push(current);
      current = character;
    } else {
      current += character;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function splitOversizedMarkdownBlock(block, maxBytes) {
  const segments = [];
  let current = '';
  for (const line of String(block || '').split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (current && markdownByteLength(candidate) > maxBytes) {
      segments.push(current);
      current = '';
    }
    if (markdownByteLength(line) > maxBytes) {
      if (current) {
        segments.push(current);
        current = '';
      }
      segments.push(...splitTextByBytes(line, maxBytes));
    } else {
      current = current ? `${current}\n${line}` : line;
    }
  }
  if (current) segments.push(current);
  return segments;
}

function splitDingTalkMessageBlocks(header, blocks, maxBytes) {
  const separator = '\n\n---\n\n';
  const blockLimit = Math.max(128, maxBytes - markdownByteLength(header) - markdownByteLength(separator));
  const chunks = [];
  let current = header;
  const safeBlocks = blocks.flatMap(block => markdownByteLength(`${header}${separator}${block}`) > maxBytes
    ? splitOversizedMarkdownBlock(block, blockLimit)
    : [block]);
  for (const block of safeBlocks) {
    const candidate = `${current}${current ? separator : ''}${block}`;
    if (current !== header && markdownByteLength(candidate) > maxBytes) {
      chunks.push(current);
      current = `${header}\n\n${block}`;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function renderDingTalkModuleDelivery(report, module, maxBytes) {
  const section = (report.sections || []).find(candidate => candidate.module === module);
  const items = sortReportItemsForDelivery(section?.items || []).filter(item => isHttpUrl(item.source_url));
  const header = `# ${moduleCode(module)} ${module}`;
  if (!items.length) {
    return [`${header}\n\n本周无高置信更新。`];
  }
  const blocks = items.map((item, index) => renderDingTalkDeliveryItem(item, index));
  return splitDingTalkMessageBlocks(header, blocks, maxBytes);
}

/**
 * 将已验证周报压缩为一条群机器人消息。
 * 字节预算由单卡渲染器统一负责，发送层不能再把超长报告静默拆成多张卡。
 */
export function buildDingTalkWebhookMessages(report, options = {}) {
  return buildDingTalkMessages(report, {
    maxBytes: options.maxBytes,
  });
}

export function renderDingTalkMarkdown(report, options = {}) {
  const sectionByModule = new Map((report.sections || []).map(section => [section.module, section]));
  const lines = [
    '# 美妆法务资讯完整周报',
    '',
    `周期：${report.period?.start || ''} 至 ${report.period?.end || ''}`,
    '',
  ];

  lines.push('## 目录', '');
  const toc = [
    '本周摘要',
    'AI 洞察与思考',
    '风险提示',
    '本周美妆法务风险雷达',
    ...REPORT_MODULES.map(module => `${moduleCode(module)} ${module}`),
    'Action Board',
    '来源证据索引',
  ];
  toc.forEach((title, index) => lines.push(`${index + 1}. ${title}`));
  lines.push('', '快速定位：钉钉文档内搜索 `M1`-`M6` 可直达对应模块。');
  lines.push('');

  if (report.summary?.length) {
    lines.push('## 本周摘要', '');
    for (const item of report.summary.slice(0, 5)) lines.push(`- ${item}`);
    lines.push('');
  }

  lines.push('## AI 洞察与思考', '');
  for (const insight of renderWholeReportInsights(report)) {
    lines.push(`- ${insight}`);
  }
  lines.push('');

  if (report.risk_alerts?.length) {
    lines.push('## 风险提示', '');
    for (const alert of report.risk_alerts.slice(0, 8)) {
      lines.push(`- ${riskLabel(alert.level)}：${alert.text}`);
    }
    lines.push('');
  }

  lines.push('## 本周美妆法务风险雷达', '');
  const graphItems = verifiedReportItems(report)
    .sort((a, b) => rankReportItem(b) - rankReportItem(a))
    .slice(0, 6);
  const graphImageUrl = options.decisionMapUrl || '';
  if (graphImageUrl) {
    lines.push(`![本周美妆法务风险雷达](${graphImageUrl})`, '');
  }
  if (graphItems.length) {
    for (const [index, item] of graphItems.entries()) {
      const team = (item.owner_teams || ['法务']).slice(0, 2).join('/');
      const impact = (item.business_impact || ['业务影响待判断'])[0];
      lines.push(`**链路 ${index + 1}｜${moduleCode(item.module)} ${item.country || item.region || '全球'}**`);
      lines.push(`- 信号：${item.source_name || '信息源'}｜${item.title}`);
      lines.push(`- 风险：${item.module || item.type || '风险事项'}｜${riskLabel(item.risk_level)}`);
      lines.push(`- 影响：${impact}`);
      lines.push(`- 动作归口：${team}`);
      lines.push('');
    }
    lines.push('| 信号 | 风险 | 影响 | 动作归口 |');
    lines.push('| --- | --- | --- | --- |');
    for (const item of graphItems) {
      const team = (item.owner_teams || ['法务']).slice(0, 2).join('/');
      const impact = (item.business_impact || ['业务影响待判断'])[0];
      lines.push(`| ${markdownTableCell(item.source_name || item.country || '信息源')} | ${markdownTableCell(`${moduleCode(item.module)} ${item.module || item.type || '风险事项'}`)} | ${markdownTableCell(impact)} | ${markdownTableCell(team)} |`);
    }
  } else {
    lines.push('本期没有形成可核验的高价值链路；建议优先补充可稳定抓取的官方原文入口。', '');
    lines.push('| 信号 | 风险 | 影响 | 动作归口 |');
    lines.push('| --- | --- | --- | --- |');
    lines.push('| 待补充 | 待判断 | 待判断 | 法务 |');
  }
  lines.push('');

  for (const module of REPORT_MODULES) {
    const section = sectionByModule.get(module) || { module, items: [] };
    lines.push(`## ${moduleCode(module)} ${section.module}`, '');
    const byRegion = new Map();
    for (const item of section.items || []) {
      const region = item.region || '全球';
      const country = item.country || '未分类';
      if (!byRegion.has(region)) byRegion.set(region, new Map());
      const byCountry = byRegion.get(region);
      if (!byCountry.has(country)) byCountry.set(country, []);
      byCountry.get(country).push(item);
    }

    if (!byRegion.size) {
      lines.push('本周无高价值更新', '');
      continue;
    }

    for (const [region, byCountry] of byRegion) {
      lines.push(`### ${region}`, '');
      for (const [country, items] of byCountry) {
        lines.push(`#### ${country}`, '');
        for (const item of items) {
          lines.push(`**${item.title}**`);
          lines.push('');
          lines.push(`- **发生了什么**：${firstText(item.what_changed, item.facts, item.regulatory_signal, item.compliance_meaning, item.title)}`);
          lines.push(`- **为什么重要**：${item.why_it_matters || '需要结合业务覆盖范围判断影响。'}`);
          lines.push(`- **对我们的影响**：${compactImpact(item)}`);
          lines.push(`- **建议动作**：${compactAction(item)}`);
          lines.push(`- **来源**：${item.source_url && isHttpUrl(item.source_url) ? `[查看原文](${item.source_url})` : (item.source_name || item.source_url || '待核验线索')}｜${item.relevance === 'direct' ? '直接相关' : '间接相关'}｜可信度：${item.confidence || 'medium'}｜风险：${riskLabel(item.risk_level)}`);
          if (item.owner_teams?.length) lines.push(`- 责任团队：${item.owner_teams.join('、')}`);
          const deadline = item.next_deadline || item.effective_date || item.feedback_deadline;
          if (deadline) lines.push(`- 节点：${deadline}`);
          lines.push('');
        }
      }
    }
  }

  const actions = renderWholeReportActionBoard(report);
  lines.push('## Action Board', '');
  if (actions.length) {
    lines.push('| 优先级 | 动作 | 责任团队 | 内部完成时间 | 来源事项 |');
    lines.push('| --- | --- | --- | --- | --- |');
    actions.forEach((action, index) => {
      lines.push(`| P${index + 1} | ${markdownTableCell(action.text)} | ${markdownTableCell(action.teams)} | 由责任领导确定 | ${markdownTableCell(action.source)} |`);
    });
  } else {
    lines.push('本期暂无可直接分派的行动项；建议法务先复核信息源质量和候选原文。');
  }
  lines.push('');

  lines.push('## 来源证据索引', '');
  const evidenceItems = verifiedReportItems(report)
    .sort((a, b) => String(a.module || '').localeCompare(String(b.module || ''), 'zh-Hans-CN') || rankReportItem(b) - rankReportItem(a));
  if (evidenceItems.length) {
    for (const item of evidenceItems) {
      lines.push(`- ${moduleCode(item.module)}｜${item.country || item.region || '全球'}｜[${item.source_name || item.title}](${item.source_url})`);
    }
  } else {
    lines.push('本期暂无可核验来源链接。');
  }
  lines.push('');

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function buildDingTalkWebhookUrl(webhookUrl, secret = '', timestamp = Date.now()) {
  if (!secret) return webhookUrl;
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    new TextEncoder().encode(`${timestamp}\n${secret}`)
  );
  const sign = btoa(String.fromCharCode(...new Uint8Array(signature)));
  const url = new URL(webhookUrl);
  url.searchParams.set('timestamp', String(timestamp));
  url.searchParams.set('sign', sign);
  return url.toString();
}

async function sendToDingTalkResult({ webhookUrl, secret = '', title, markdown, fetcher = fetch }) {
  if (!webhookUrl) return { ok: false, retryable: false, error: 'DINGTALK_WEBHOOK_URL is required' };
  try {
    const url = await buildDingTalkWebhookUrl(webhookUrl, secret);
    const resp = await fetcher(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'markdown',
        markdown: { title, text: markdown },
      }),
    });
    const bodyText = await resp.text();
    if (!resp.ok) {
      return {
        ok: false,
        retryable: resp.status === 408 || resp.status === 429 || resp.status >= 500,
        error: `DingTalk HTTP ${resp.status}: ${bodyText.slice(0, 200)}`,
      };
    }
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      return { ok: false, retryable: true, error: `DingTalk invalid JSON: ${bodyText.slice(0, 200)}` };
    }
    if (body.errcode === 0 || body.code === 0) {
      return { ok: true, retryable: false, error: '' };
    }
    return { ok: false, retryable: false, error: `DingTalk error: ${bodyText.slice(0, 300)}` };
  } catch (error) {
    return { ok: false, retryable: true, error: `DingTalk network error: ${error.message}` };
  }
}

export async function sendToDingTalk(options) {
  const result = await sendToDingTalkResult(options);
  if (result.ok) console.log('钉钉推送成功');
  else console.error(result.error);
  return result.ok;
}

/**
 * 顺序发送钉钉消息。每个分段独立重试，终止后返回准确的发送数量和失败位置，
 * 供流水线决定是否写入去重状态以及是否以失败退出。
 */
export async function sendDingTalkMessages({
  messages,
  webhookUrl = '',
  secret = '',
  sendMessage,
  maxAttempts = 3,
  interMessageDelayMs = 0,
  sleepFn = sleep,
}) {
  const delivery = sendMessage || (message => sendToDingTalkResult({
    webhookUrl,
    secret,
    title: message.title,
    markdown: message.markdown,
  }));
  let sent = 0;
  let retries = 0;
  for (const message of messages || []) {
    let lastResult = { ok: false, retryable: false, error: 'unknown delivery error' };
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const rawResult = await delivery(message);
      lastResult = typeof rawResult === 'boolean'
        ? { ok: rawResult, retryable: !rawResult, error: rawResult ? '' : 'DingTalk send failed' }
        : rawResult;
      if (lastResult.ok) {
        sent += 1;
        console.log(`钉钉推送成功: ${message.id} (${sent}/${messages.length})`);
        if (sent < messages.length && interMessageDelayMs > 0) {
          await sleepFn(interMessageDelayMs);
        }
        break;
      }
      if (!lastResult.retryable || attempt === maxAttempts) break;
      retries += 1;
      await sleepFn(750 * attempt);
    }
    if (!lastResult.ok) {
      console.error(`钉钉推送失败: ${message.id}: ${lastResult.error}`);
      return {
        ok: false,
        sent,
        total: messages.length,
        retries,
        failedMessageId: message.id,
        error: lastResult.error || 'DingTalk send failed',
      };
    }
  }
  return {
    ok: true,
    sent,
    total: (messages || []).length,
    retries,
    failedMessageId: '',
    error: '',
  };
}

async function parseJsonResponse(resp, label) {
  const text = await resp.text();
  const data = text ? JSON.parse(text) : {};
  if (!resp.ok || data.code || data.errcode) {
    throw new Error(`${label} ${resp.status}: ${text.slice(0, 300)}`);
  }
  return data;
}

export async function getDingTalkAccessToken({ clientId, clientSecret, fetcher = fetch }) {
  const resp = await fetcher('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
  });
  const data = await parseJsonResponse(resp, 'DingTalk token');
  if (!data.accessToken) throw new Error('DingTalk token response missing accessToken');
  return data.accessToken;
}

export async function createDingTalkDocument({ accessToken, workspaceId, operatorId, title, fetcher = fetch }) {
  const resp = await fetcher(`https://api.dingtalk.com/v1.0/doc/workspaces/${encodeURIComponent(workspaceId)}/docs`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': accessToken,
    },
    body: JSON.stringify({
      operatorId,
      docType: 'DOC',
      name: title,
    }),
  });
  const data = await parseJsonResponse(resp, 'DingTalk create doc');
  if (!data.docKey || !data.url) throw new Error('DingTalk create doc response missing docKey or url');
  return data;
}

export async function overwriteDingTalkDocument({ accessToken, docKey, operatorId, markdown, fetcher = fetch }) {
  const resp = await fetcher(`https://api.dingtalk.com/v1.0/doc/suites/documents/${encodeURIComponent(docKey)}/overwriteContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': accessToken,
    },
    body: JSON.stringify({
      operatorId,
      content: markdown,
      contentType: 'markdown',
    }),
  });
  return parseJsonResponse(resp, 'DingTalk overwrite doc');
}

export async function uploadDingTalkImage({ accessToken, image, filename = 'decision-map.png', fetcher = fetch }) {
  if (!accessToken || !image) return '';
  const form = new FormData();
  const blob = image instanceof Blob ? image : new Blob([image], { type: 'image/png' });
  form.append('media', blob, filename);
  const resp = await fetcher(`https://oapi.dingtalk.com/media/upload?access_token=${encodeURIComponent(accessToken)}&type=image`, {
    method: 'POST',
    body: form,
  });
  const data = await parseJsonResponse(resp, 'DingTalk upload image');
  if (!data.media_id) throw new Error('DingTalk upload image response missing media_id');
  return data.media_id;
}

export async function publishDingTalkDocument({ env, title, markdown, fetcher = fetch }) {
  const clientId = env.DINGTALK_CLIENT_ID || env.DINGTALK_APP_KEY;
  const clientSecret = env.DINGTALK_CLIENT_SECRET || env.DINGTALK_APP_SECRET;
  const operatorId = env.DINGTALK_OPERATOR_ID;
  const workspaceId = env.DINGTALK_WORKSPACE_ID;
  if (!clientId || !clientSecret || !operatorId || !workspaceId) {
    return null;
  }

  const accessToken = await getDingTalkAccessToken({ clientId, clientSecret, fetcher });
  const doc = await createDingTalkDocument({ accessToken, workspaceId, operatorId, title, fetcher });
  await overwriteDingTalkDocument({ accessToken, docKey: doc.docKey, operatorId, markdown, fetcher });
  return doc;
}

async function resolveDecisionMapUrl({ env, requestUrl, decisionMapPng, date }) {
  if (env.DECISION_MAP_PUBLIC_URL || env.DECISION_MAP_URL) return env.DECISION_MAP_PUBLIC_URL || env.DECISION_MAP_URL;
  return decisionMapPng
    ? reportUrl(requestUrl, `/assets/decision-map/${date}.png`)
    : reportUrl(requestUrl, '/assets/decision-map.svg');
}

function editorialReportPngKeyForDate(date) {
  return `asset:editorial-report:${date}.png`;
}

async function saveEditorialReportPng(kv, date, png) {
  if (!png) return;
  await kv.put(editorialReportPngKeyForDate(date), png, { metadata: { contentType: 'image/png', date } });
  await kv.put(LATEST_EDITORIAL_REPORT_PNG_KEY, png, { metadata: { contentType: 'image/png', date } });
}

async function prepareEditorialReportImage({ report, env, kv, requestUrl, date, generatedAt, logger = console }) {
  const itemCount = (report.sections || []).flatMap(section => section.items || []).length;
  if (!itemCount || typeof env.CREATE_EDITORIAL_REPORT_PNG !== 'function') return '';
  try {
    const png = await env.CREATE_EDITORIAL_REPORT_PNG({ report, date, generatedAt, requestUrl });
    if (!(png instanceof Uint8Array) || !png.byteLength) throw new Error('image renderer returned no PNG data');
    await saveEditorialReportPng(kv, date, png);
    const url = typeof env.PUBLISH_EDITORIAL_REPORT === 'function'
      ? await env.PUBLISH_EDITORIAL_REPORT({ date, png, report, requestUrl })
      : reportUrl(requestUrl, `/assets/editorial-report/${date}.png`);
    if (!url) throw new Error('image publication returned no public URL');
    return url;
  } catch (error) {
    logger.warn(`资讯长图不可用，自动回退完整文字报告: ${error.message}`);
    return '';
  }
}

export async function notifyReport({ report, reportUrl: latestUrl, env, sendDingTalk = sendToDingTalk, sendFeishu = sendToFeishu }) {
  if (env.DINGTALK_WEBHOOK_URL) {
    const messages = buildDingTalkWebhookMessages(report, {
      maxBytes: env.DINGTALK_MAX_BYTES,
    });
    const delivery = await sendDingTalkMessages({
      messages,
      webhookUrl: env.DINGTALK_WEBHOOK_URL,
      secret: env.DINGTALK_SECRET || '',
      interMessageDelayMs: env.DINGTALK_MESSAGE_DELAY_MS ?? 1200,
      sendMessage: sendDingTalk === sendToDingTalk ? undefined : message => sendDingTalk({
        webhookUrl: env.DINGTALK_WEBHOOK_URL,
        secret: env.DINGTALK_SECRET || '',
        title: message.title,
        markdown: message.markdown,
      }),
    });
    return { channel: 'dingtalk', ...delivery };
  }

  const ok = await sendFeishu(env.FEISHU_WEBHOOK_URL, renderFeishuSummary(report, latestUrl));
  return { channel: 'feishu', ok };
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
export function isArtifactOnlyRun(env = {}) {
  return env.ARTIFACT_ONLY === '1';
}

export async function runPipeline(env, requestUrl = 'https://beauty-legal-bot.workers.dev/') {
  const aiKey = env.AI_API_KEY;
  const aiBaseUrl = env.AI_API_BASE_URL || DEFAULT_AI_API_BASE_URL;
  const feishuUrl = env.FEISHU_WEBHOOK_URL;
  const dingTalkUrl = env.DINGTALK_WEBHOOK_URL;
  const model = env.AI_MODEL || DEFAULT_AI_MODEL;
  const kv = env.SEEN_NEWS;
  const artifactOnly = isArtifactOnlyRun(env);
  const qualityMode = env.QUALITY_MODE === '1' || env.REPORT_QUALITY_MODE === 'quality' || env.CONTENT_QUALITY_MODE === 'quality';
  const candidateLimit = Number(env.ANALYSIS_CANDIDATE_LIMIT || (qualityMode ? QUALITY_ANALYSIS_CANDIDATE_LIMIT : DEFAULT_ANALYSIS_CANDIDATE_LIMIT));
  const leadLimit = Number(env.ANALYSIS_LEAD_LIMIT || (qualityMode ? QUALITY_ANALYSIS_LEAD_LIMIT : DEFAULT_ANALYSIS_LEAD_LIMIT));
  const maxTokens = Number(env.AI_MAX_TOKENS || (qualityMode ? QUALITY_AI_MAX_TOKENS : DEFAULT_AI_MAX_TOKENS));
  const itemsPerModule = Number(env.REPORT_ITEMS_PER_MODULE || (qualityMode ? QUALITY_REPORT_ITEMS_PER_MODULE : DEFAULT_REPORT_ITEMS_PER_MODULE));

  if (!aiKey) throw new Error('AI_API_KEY is required');
  if (!artifactOnly && !dingTalkUrl && !feishuUrl) throw new Error('DINGTALK_WEBHOOK_URL or FEISHU_WEBHOOK_URL is required');
  if (!kv) throw new Error('SEEN_NEWS KV binding is required');

  console.log("=== 周报管道启动 ===");

  try {
    console.log("[stage 1/5] 抓取信息源候选...");
    const sources = env.FULL_SOURCE_SCAN === '1' || qualityMode
      ? sourceCatalog.sources
      : selectSourcesForWorkerBudget(sourceCatalog.sources, Number(env.WORKER_FETCH_SOURCE_BUDGET || WORKER_FETCH_SOURCE_BUDGET));
    const { fetchableSources } = splitSources(sources);
    console.log(`[stage 1/5] Worker 抓取预算：${fetchableSources.length} 个可抓取源，${sources.length - fetchableSources.length} 个线索源`);
    const { candidates: fetchedCandidates, leads, failures, sourceResults, coverage } = await collectCandidates(sources, async () => {}, {
      fetcher: env.SOURCE_FETCH || fetch,
      browserFetcher: env.BROWSER_FETCH_HTML,
      timeoutMs: Number(env.SOURCE_FETCH_TIMEOUT_MS || SOURCE_FETCH_TIMEOUT_MS),
      sleepFn: env.SOURCE_RETRY_SLEEP,
      jitter: env.SOURCE_RETRY_JITTER,
      hydrateDetails: env.DETAIL_FETCH_ENABLED !== '0',
      detailLimit: Number.MAX_SAFE_INTEGER,
      detailTimeoutMs: Number(env.DETAIL_FETCH_TIMEOUT_MS || DETAIL_FETCH_TIMEOUT_MS),
      detailConcurrency: Number(env.DETAIL_FETCH_CONCURRENCY || DETAIL_FETCH_CONCURRENCY),
      detailBrowserRecoveryLimit: Number(env.DETAIL_BROWSER_RECOVERY_LIMIT || DETAIL_BROWSER_RECOVERY_LIMIT),
    });
    assertSourceCoverage(coverage, {
      minOverall: Number(env.MIN_SOURCE_COVERAGE || 0.9),
      minChinaCritical: Number(env.MIN_CHINA_CRITICAL_COVERAGE || 0.9),
    });
    const period = env.REPORT_PERIOD_END
      ? { start: env.REPORT_PERIOD_START || env.REPORT_PERIOD_END, end: env.REPORT_PERIOD_END }
      : getPeriod();
    const freshCandidates = filterCandidatesByFreshness(fetchedCandidates, period);
    const requireFullText = env.DETAIL_FETCH_ENABLED !== '0';
    const hydratedCandidates = requireFullText
      ? freshCandidates.filter(candidate => candidate.detail_status === 'hydrated')
      : freshCandidates;
    const enforceEditorialGate = qualityMode || env.ARTIFACT_ONLY === '1' || env.CONTENT_QUALITY_REBUILD === '1';
    const editorial = enforceEditorialGate
      ? applyEditorialGate(hydratedCandidates)
      : { candidates: hydratedCandidates, audit: { input: hydratedCandidates.length, accepted: hydratedCandidates.length, rejected: 0, rejections: [] } };
    const candidates = editorial.candidates;
    console.log(`[stage 1/5] 完成，候选 ${fetchedCandidates.length} 条，时效准入 ${freshCandidates.length} 条，全文准入 ${hydratedCandidates.length} 条，编辑准入 ${candidates.length} 条，编辑拒绝 ${editorial.audit.rejected} 条，线索 ${leads.length} 条，恢复源 ${sourceResults.filter(result => result.status === 'recovered').length} 个，失败源 ${failures.length} 个，覆盖率 ${(coverage.overall * 100).toFixed(1)}%`);

    if (enforceEditorialGate && env.SOURCE_ONLY_PROOF_REQUIRED !== '0') {
      const proof = evaluateSourceOnlyProof(candidates, { period });
      console.log(`[stage 1/5] source-only 证明：primary=${proof.primary_count}, china=${proof.china_count}, modules=${proof.active_module_count}, duplicates=${proof.duplicates}`);
      if (!proof.pass) {
        throw new Error(`Source-only proof failed: ${JSON.stringify({
          primary_count: proof.primary_count,
          china_count: proof.china_count,
          active_module_count: proof.active_module_count,
          failure_codes: proof.failure_codes,
          duplicates: proof.duplicates,
        })}`);
      }
    }

    console.log("[stage 2/5] AI 结构化分析...");
    const analysis = await analyzeReportWithRecovery({
      candidates,
      leads,
      sources,
      period,
      itemsPerModule,
      supplementThreshold: Number(env.REPORT_TARGET_ITEMS || 8),
      analyzePrimary: () => deepseekAnalyzeByModule({
        apiKey: aiKey,
        baseUrl: aiBaseUrl,
        model,
        candidates,
        leads,
        sources,
        period,
        candidateLimit,
        leadLimit,
        maxTokens,
        requireCandidateCoverage: requireFullText,
      }),
      analyzeRescue: ({ report: existingReport } = {}) => deepseekRescueAnalyze({
        apiKey: aiKey,
        baseUrl: aiBaseUrl,
        model,
        candidates,
        leads,
        period,
        existingReport,
        requireCandidateCoverage: requireFullText,
      }),
    });
    const report = analysis.report;
    validateReport(report);
    const itemCount = (report.sections || []).flatMap(section => section.items || []).length;
    console.log(`[stage 2/5] 完成，模式 ${analysis.mode}，模块 ${report.sections.length} 个，准入 ${itemCount} 条`);

    console.log(itemCount > 0
      ? "[stage 3/5] 生成单条原生 Markdown 报告..."
      : "[stage 3/5] 无准入事项，生成文字简报...");
    const generatedAt = new Date().toISOString();
    const previewMessages = buildDingTalkWebhookMessages(report, { maxBytes: env.DINGTALK_MAX_BYTES });
    const markdown = previewMessages.map(message => message.markdown).join('\n\n---\n\n');
    if (typeof env.ON_REPORT_READY === 'function') {
      await env.ON_REPORT_READY({ report, markdown, generatedAt, failures, sourceResults, coverage });
    }
    if (artifactOnly) {
      console.log('=== artifact-only report written; delivery and dedupe skipped ===');
      return {
        stage: 'artifact-only',
        status: 'done',
        message: 'artifact-only report written; no delivery attempted',
        report,
        markdown,
      };
    }
    console.log("[stage 4/5] 内容去重检查...");
    const { isDup, seen, fps } = await isDuplicateFingerprints(extractReportFingerprints(report), kv);
    if (shouldSkipDuplicateReport(isDup, env.FORCE_DELIVERY === '1')) {
      console.log("[stage 4/5] 报告条目 30 天内已全部推送过，跳过摘要推送");
      return { stage: 'dedupe', status: 'skipped', message: 'all report items were already pushed in 30 days' };
    }

    console.log("[stage 5/5] 推送协作平台摘要...");
    const notification = await notifyReport({
      report,
      reportUrl: '',
      env: { ...env, SOURCE_COVERAGE: coverage },
    });
    const ok = notification.ok;
    if (ok) await markSeen(fps, seen, kv);
    console.log(ok ? "=== 周报管道完成 ===" : "=== 周报管道失败 ===");
    return {
      stage: notification.channel,
      status: ok ? 'done' : 'failed',
      message: ok
        ? `${notification.channel} sent ${notification.sent || 1}/${notification.total || 1}`
        : `${notification.channel} delivery failed: ${notification.error || 'unknown error'}`,
      delivery: notification,
    };
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

function firstTagText(html, tag) {
  const match = String(html || '').match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? htmlToText(match[1]) : '';
}

export function extractArticleText(html) {
  const raw = String(html || '');
  const title = firstTagText(raw, 'h1') || firstTagText(raw, 'title');
  const mainMatch = raw.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)
    || raw.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);
  const content = (mainMatch?.[1] || raw)
    .replace(/<(?:script|style|noscript|svg|nav|header|footer|aside|form)\b[\s\S]*?<\/(?:script|style|noscript|svg|nav|header|footer|aside|form)>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ');
  const text = htmlToText(content);
  return {
    title,
    text,
    published_at: extractPublishedDate(title, text),
    has_article_container: Boolean(mainMatch),
    paragraph_count: (content.match(/<p\b/gi) || []).length,
  };
}

function supportedArticleContentType(value = '') {
  const contentType = String(value || '').toLowerCase();
  return !contentType
    || contentType.includes('text/html')
    || contentType.includes('application/xhtml+xml')
    || contentType.includes('text/plain');
}

function articleEvidenceFailure(article = {}, contentType = '') {
  if (!supportedArticleContentType(contentType)) return 'unsupported-content-type';
  const shellText = `${String(article.title || '')} ${String(article.text || '').slice(0, 600)}`;
  if (/(?:sign\s*in|log\s*in|login required|access denied|forbidden|captcha|enable javascript|javascript required|pdf\.js|document viewer|not found|404|页面不存在|登录|验证码|访问被拒绝|未找到|错误页面)/i.test(shellText)) {
    return 'access-or-error-page';
  }
  if (String(article.text || '').length < 240) return 'insufficient-text';
  if (String(article.text || '').length > MAX_COMPLETE_ARTICLE_CHARS) return 'article-too-long';
  if (!article.has_article_container && Number(article.paragraph_count || 0) < 2) return 'page-shell';
  return '';
}

function selectDetailCandidates(candidates, limit = DETAIL_CANDIDATE_LIMIT) {
  const ranked = sortCandidatesForAnalysis(candidates)
    .filter(candidate => /^https?:\/\//i.test(String(candidate.url || '')))
    .filter(candidate => !/信息源入口|行业线索/.test(String(candidate.title || '')))
    .filter(candidate => !isNavigationTitle(candidate.title))
    .sort((a, b) => Number(b.country === '中国') - Number(a.country === '中国'));
  const selected = [];
  const selectedUrls = new Set();
  const take = candidate => {
    if (!candidate) return;
    const url = normalizeSourceUrl(candidate.url);
    if (!url || selectedUrls.has(url)) return;
    selected.push(candidate);
    selectedUrls.add(url);
  };
  for (let round = 0; round < 6; round += 1) {
    for (const module of REPORT_MODULES) {
      const available = ranked.filter(candidate => candidate.module === module && !selectedUrls.has(normalizeSourceUrl(candidate.url)));
      take(available[0]);
    }
  }
  for (const candidate of ranked) take(candidate);
  return selected;
}

export function choosePublishedDate(candidateDate, extractedDate) {
  const candidate = /^20\d{2}-\d{2}-\d{2}$/.test(String(candidateDate || '')) ? String(candidateDate) : '';
  const extracted = /^20\d{2}-\d{2}-\d{2}$/.test(String(extractedDate || '')) ? String(extractedDate) : '';
  if (!candidate) return extracted;
  if (!extracted) return candidate;
  const difference = Math.abs(Date.parse(`${candidate}T00:00:00Z`) - Date.parse(`${extracted}T00:00:00Z`));
  return difference <= 3 * 24 * 60 * 60 * 1000 ? extracted : candidate;
}

export async function hydrateCandidateDetails(candidates = [], {
  fetcher = fetch,
  browserFetcher,
  detailLimit = DETAIL_CANDIDATE_LIMIT,
  timeoutMs = DETAIL_FETCH_TIMEOUT_MS,
  concurrency = DETAIL_FETCH_CONCURRENCY,
  browserRecoveryLimit = DETAIL_BROWSER_RECOVERY_LIMIT,
} = {}) {
  const selected = selectDetailCandidates(candidates, Math.max(0, Number(detailLimit) || DETAIL_CANDIDATE_LIMIT));
  const replacements = new Map();
  const audit = { selected: selected.length, hydrated: 0, browserRecovered: 0, failed: 0, reasons: {} };

  await mapWithConcurrency(selected, concurrency, async (candidate, index) => {
    let result = null;
    try {
      const response = await fetchWithTimeout(candidate.url, {
        headers: SOURCE_REQUEST_HEADERS,
        redirect: 'follow',
      }, timeoutMs, fetcher);
      if (response.ok) result = {
        ok: true,
        html: await response.text(),
        finalUrl: response.url || candidate.url,
        contentType: response.headers?.get?.('content-type') || '',
      };
    } catch {}

    let article = result?.ok ? extractArticleText(result.html) : { text: '' };
    let detailFailure = articleEvidenceFailure(article, result?.contentType);
    if (detailFailure && detailFailure !== 'unsupported-content-type' && typeof browserFetcher === 'function' && index < browserRecoveryLimit) {
      try {
        const recovered = await browserFetcher(candidate.url, { timeoutMs: Math.max(timeoutMs, 20000) });
        if (recovered?.ok) {
          result = recovered;
          article = extractArticleText(recovered.html);
          detailFailure = articleEvidenceFailure(article, recovered.contentType);
          if (!detailFailure) audit.browserRecovered += 1;
        }
      } catch {}
    }

    const key = normalizeSourceUrl(candidate.url);
    if (detailFailure) {
      audit.failed += 1;
      audit.reasons[detailFailure] = (audit.reasons[detailFailure] || 0) + 1;
      replacements.set(key, { ...candidate, detail_status: 'failed', detail_reason: detailFailure });
      return;
    }
    audit.hydrated += 1;
    replacements.set(key, {
      ...candidate,
      title: article.title || candidate.title,
      url: result?.finalUrl || candidate.url,
      snippet: article.text,
      published_at: choosePublishedDate(candidate.published_at, article.published_at),
      image_url: extractImageUrl(result?.html || '', result?.finalUrl || candidate.url) || candidate.image_url || '',
      detail_status: 'hydrated',
      detail_reason: 'complete-article-body',
    });
  });

  return {
    candidates: candidates.map(candidate => replacements.get(normalizeSourceUrl(candidate.url)) || candidate),
    audit,
  };
}

export function applyEditorialGate(candidates = []) {
  const accepted = [];
  const rejections = [];
  for (const candidate of candidates) {
    const decision = evaluateEditorialCandidate(candidate);
    if (!decision.accepted) {
      rejections.push({
        title: candidate.title || '',
        url: candidate.url || candidate.source_url || '',
        reason: decision.reason,
      });
      continue;
    }
    const china = inferArticleChinaRelevance(candidate);
    accepted.push({
      ...candidate,
      editorial_status: 'accepted',
      editorial_tier: decision.tier,
      module: inferCandidateModule(candidate),
      china_relevant: china.relevant,
      china_evidence_text: china.evidence_text,
      china_evidence_markers: china.matched_markers,
    });
  }
  return {
    candidates: accepted,
    audit: {
      input: candidates.length,
      accepted: accepted.length,
      rejected: rejections.length,
      rejections,
    },
  };
}

export function extractLinks(html, baseUrl) {
  const re = /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  return Array.from(String(html || '').matchAll(re))
    .map(match => ({ title: htmlToText(match[2]), url: normalizeUrl(match[1], baseUrl) }))
    .filter(link => link.title && link.url);
}

export function isLikelyContentImage(url) {
  const text = String(url || '').toLowerCase();
  if (!/^https?:\/\//.test(text)) return false;
  if (/\.(svg|ico)(\?|$)/.test(text)) return false;
  if (/(logo|favicon|avatar|icon|qrcode|qr-code|wechat|wxlogo|sprite|placeholder|blank|default|loading|banner-logo)/i.test(text)) return false;
  if (/[?&](?:w|width|h|height)=([1-9][0-9]?|1[0-4][0-9])(?:&|$)/i.test(text)) return false;
  return /\.(jpe?g|png|webp)(\?|$)/.test(text) || /(image|upload|media|news|cover|article|content|cms|files)/i.test(text);
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
    if (match?.[1]) {
      const url = normalizeUrl(match[1], baseUrl);
      if (isLikelyContentImage(url)) return url;
    }
  }
  const images = Array.from(text.matchAll(/<img\s+[^>]*src=["']([^"']+)["'][^>]*>/gi))
    .map(match => normalizeUrl(match[1], baseUrl))
    .filter(isLikelyContentImage);
  return images[0] || '';
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

export function isNavigationTitle(title) {
  const text = String(title || '').trim();
  return Boolean(text) && NAVIGATION_TITLE_PATTERNS.some(pattern => pattern.test(text));
}

export function isRelevantTitle(title) {
  const text = String(title || '').toLowerCase();
  if (!text || isNavigationTitle(title)) return false;
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

export function selectSourcesForWorkerBudget(sources = sourceCatalog.sources, fetchBudget = WORKER_FETCH_SOURCE_BUDGET) {
  const { fetchableSources, leadSources } = splitSources(sources);
  const selected = [];
  const selectedKeys = new Set();
  const add = source => {
    const key = `${source.name}:${source.url || ''}`;
    if (!selectedKeys.has(key) && selected.length < fetchBudget) {
      selected.push(source);
      selectedKeys.add(key);
    }
  };

  for (const module of REPORT_MODULES) {
    const moduleSources = fetchableSources.filter(source => source.module === module);
    const directHigh = moduleSources.find(source => source.priority === 'high');
    if (directHigh) add(directHigh);
  }

  for (const country of ['欧盟', '美国', '印尼', '泰国', '越南', '日本', '韩国', '墨西哥', '意大利']) {
    const marketSource = fetchableSources.find(source => source.country === country && source.priority === 'high')
      || fetchableSources.find(source => source.country === country);
    if (marketSource) add(marketSource);
  }

  [...fetchableSources]
    .sort((a, b) => {
      const score = source => (source.priority === 'high' ? 100 : 50)
        + (source.authority_type === 'regulator' ? 30 : 0)
        + (source.authority_type === 'official' ? 20 : 0)
        + (source.country === '中国' ? 8 : 0)
        + (['欧盟', '美国', '印尼', '泰国', '越南', '日本', '韩国', '墨西哥', '意大利'].includes(source.country) ? 6 : 0);
      return score(b) - score(a);
    })
    .forEach(add);

  return [...selected, ...leadSources];
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

export function prioritizeCandidatesForAnalysis(candidates, now = new Date()) {
  return sortCandidatesForAnalysis(candidates, now).sort((a, b) => {
    const chinaDiff = Number(b.country === '中国') - Number(a.country === '中国');
    return chinaDiff || 0;
  });
}

export { classifyFreshness, filterCandidatesByFreshness } from './freshness.js';

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
  return OBJECTIVE_REQUIRED_FIELDS;
}

export function hasSpecificActions(item) {
  const actions = item.recommended_actions;
  if (!Array.isArray(actions) || !actions.length) return false;
  return actions.some(action => {
    const text = String(action || '').trim();
    return text.length >= 12 && !ACTION_NOISE.some(noise => text === noise || text.includes(noise));
  });
}

function hasInternalCompletionDeadline(item) {
  const deadlinePattern = /(?:本周|下周|本月|下月|本季度|月底|周末|周[一二三四五六日天]|今天|明天|后天|(?:\d+|[一二三四五六七八九十]+)\s*(?:个)?(?:工作)?(?:日|天|周|月)内|20\d{2}\s*[-/.年]\s*\d{1,2}\s*[-/.月]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*日)/;
  return (item.recommended_actions || []).some(action => deadlinePattern.test(String(action || '')));
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
    for (const rawItem of section.items) {
      const item = {
        ...rawItem,
        fact_summary: objectiveFacts(rawItem),
        next_observation: objectiveObservation(rawItem),
      };
      for (const field of ['title', 'type', 'source_name', 'source_url', 'region', 'country']) {
        if (!hasValue(item[field])) throw new Error(`${field} missing: ${item.title || 'unknown'}`);
      }
      for (const field of getRequiredFields(item)) {
        if (!hasValue(item[field])) throw new Error(`${field} missing: ${item.title || 'unknown'}`);
      }
      if (!/^https?:\/\//i.test(String(item.source_url))) throw new Error(`source_url must be original http URL: ${item.title || 'unknown'}`);
    }
  }
  return true;
}

export function normalizeReportForValidation(report) {
  return {
    ...report,
    sections: (report.sections || []).map(section => ({
      ...section,
      items: (section.items || []).map(item => ({
        ...item,
        fact_summary: objectiveFacts(item),
        next_observation: objectiveObservation(item),
      })),
    })),
  };
}

export function filterReportQualityWithAudit(report) {
  const normalizedReport = normalizeReportForValidation(report);
  const audit = { inputItems: 0, acceptedItems: 0, rejectedItems: 0, reasons: {} };
  const reject = reason => {
    audit.rejectedItems += 1;
    audit.reasons[reason] = (audit.reasons[reason] || 0) + 1;
    return [];
  };
  const filtered = {
    ...normalizedReport,
    sections: (normalizedReport.sections || []).map(section => ({
      ...section,
      items: (section.items || []).flatMap(item => {
        audit.inputItems += 1;
        if (!hasValue(item.source_url)) return reject('missing-source-url');
        const allowLeadSignal = ['美妆动态', '进出口动态'].includes(section.module)
          && ['wechat_lead', 'industry_media', 'wechat_public_account'].includes(item.source_type)
          && item.industry_impact !== 'low'
          && hasSpecificActions(item);
        if (item.confidence === 'low' && item.relevance !== 'direct' && item.industry_impact !== 'high' && !allowLeadSignal) {
          return reject('low-confidence');
        }
        try {
          validateReport({ ...normalizedReport, sections: [{ ...section, items: [item] }] });
          audit.acceptedItems += 1;
          return [item];
        } catch (error) {
          return reject(`validation:${String(error.message || 'unknown').split(':')[0]}`);
        }
      }),
    })),
  };
  return { report: filtered, audit };
}

export function filterReportQuality(report) {
  return filterReportQualityWithAudit(report).report;
}

export function limitReportSections(report, itemLimit = DEFAULT_REPORT_ITEMS_PER_MODULE) {
  return {
    ...report,
    sections: REPORT_MODULES.map(module => {
      const section = (report.sections || []).find(item => item.module === module) || { module, items: [] };
      return { ...section, items: [...(section.items || [])] };
    }),
  };
}

function getPeriod(now = new Date()) {
  const end = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

export function buildAnalysisPrompt({ candidates, leads = [], sources, period, targetModule = '', candidateLimit = DEFAULT_ANALYSIS_CANDIDATE_LIMIT, leadLimit = DEFAULT_ANALYSIS_LEAD_LIMIT }) {
  const moduleInstruction = targetModule ? `
当前只分析模块：${targetModule}
- 只返回这个模块的 section。
- 对输入 candidates 逐条判断并返回所有符合准入规则的条目，不要只挑重大事项。
- candidates 均为已成功抓取的详情页全文；不得因为同批存在更重要信息而省略其他合格信息。
- 美妆动态重点看行业监管趋势、平台治理、产品安全、功效宣称、渠道变化、头部品牌合规动作。
- 进出口动态重点看进口准入、清关、口岸抽检、跨境电商、认证、海关监管、召回和贸易合规。
- 产品质量/召回与安全风险重点看产品安全、抽检不合格、召回、禁限用成分、质量投诉、过敏/微生物/重金属风险和平台下架。
` : '';
  return `你是美妆行业客观资讯编辑。你只负责提取、分类、去重和压缩公开事实，不生成核心判断、法律分析、风险评价、业务影响推断、管理层总结或行动分派。

集团业务背景：
- 国际化美妆电商集团，关注中国、欧盟、美国、日本、韩国、泰国、越南、印尼、墨西哥、意大利等市场。
- 业务覆盖护肤、彩妆、防晒、香水、洗护、跨境进口、直播电商、平台销售、自有品牌和第三方品牌。
- 只收录正文内容与美妆行业有实质关系的法规、广告处罚、知识产权、进出口、产品安全和行业新闻；不能只看标题关键词，必须结合详情页适用范围、商品、企业和监管对象判断。
- 产品质量/召回与安全风险单独成模块，重点覆盖产品安全、抽检不合格、召回、禁限用成分、质量投诉、过敏/微生物/重金属风险和平台下架。

来源和质量规则：
- candidates 来自可抓取网页；leads 来自公众号或不可抓来源。公众号可以作为强线索，但最终必须标注 source_type 和 confidence。
- 优先国家/区域监管机构、法院、知识产权机构、海关、产品安全召回平台、行业权威媒体。
- leads 只能用于发现选题，不能直接形成正式条目；没有 candidates 中的具体原文 URL 就丢弃，不得用来源主页或微信公众号占位。
- 泛电商、泛广告、泛知识产权或泛进出口信息，如果正文没有美妆对象或具体适用关系，必须丢弃。

时间和影响力规则：
- 周报优先过去 7 天发布或更新的信息。
- 超过 7 天的信息默认禁止进入报告；不能仅凭“影响力高”豁免。
- 历史信息只有在 freshness_exception 为 upcoming_deadline、ongoing_enforcement、current_week_change 或 open_action，且提供对应日期/持续执行证据/未关闭行动证据时保留。
- 未来 90 天生效、反馈截止、过渡期、认证节点可以入选，但必须填写 freshness_exception=upcoming_deadline。
- 无法确认日期的内容只能 report_tier=watch，并标注 freshness_status=日期待核验；不得进入 action。
- 同等条件下优先直接相关、高影响力、官方源、覆盖核心市场的信息。

模块必须使用以下 6 个，前 5 个来自用户 Excel 的“分类”列，第 6 个用于承接产品质量、召回和安全风险：
- 广告合规及处罚案例
- 美妆动态
- 知识产权动态
- 新规及案例动态
- 进出口动态
- 产品质量/召回与安全风险

输出要求：
- 输出合法 JSON，不要 Markdown，不要解释。
- 六个模块分别监测，但只输出通过质量标准的条目；任何模块都允许为空，总量不设最低要求。
- 对每个候选逐条判断；凡正文与美妆实质相关、事实明确、日期合格且有具体原文 URL 的信息都应输出，不得只挑“最重要”的少数几条。
- 中国候选优先：在相同强相关门槛下先处理并优先收录中国原文；不得因为外国事项影响力更高就省略合格的中国信息。中国中强相关、事实明确的简讯可以以 watch 类型收录。
- “不够重大”不是排除理由。只要正文明确包含美妆相关的主体、产品、规则、处罚结果、抽检/召回、进出口要求或品牌保护事实，即使影响为 medium/low 也应作为 report_tier=watch 的新闻简讯收录。
- 仍然必须排除：正文无美妆对象、只有欢迎语/导航/来源首页、事实无法核验、超期且无时效例外、或与已收录事件重复的候选。
- 行业媒体只有在提供具体文章原文、事实明确且与美妆实质相关时才可作为行业新闻简讯；公众号主页不能形成条目。
- 每条只生成 fact_summary 和 next_observation 两类正文信息。
- fact_summary 输出 1-2 条客观事实，优先保留主体、事项、日期、金额、数量、规则变化和处理结果，合计通常 30-100 字。
- next_observation 只输出一个可观察的后续事实节点，例如正式稿、生效日期、反馈截止、处罚后续、判决、复议诉讼、召回进展或执行口径。
- 所有可见的标题、事实摘要、下一步观察和来源名使用简体中文；英文品牌名、机构缩写、法规编号和产品名可在中文后保留原文。
- 中文标题使用“主体 + 具体事项或结果”的自然新闻表达，不要逐词直译，不得只写公告编号、栏目名、“最新动态”或其他空泛标题。
- 来源名优先采用官方或通行中文名称；无通行中文译名时保留原名，不得臆造中文译名。
- 事实摘要直接写明主体、动作、对象以及原文已有的日期、金额、数量或处理结果，避免“发布相关要求”“介绍有关情况”等空泛转述。
- display_title_zh 和 source_name_zh 是面向用户的中文显示文本；程序会保留原文 URL 作为证据，不要翻译 URL。
- core_judgement、why_it_matters、risk_level、business_impact、recommended_actions、owner_teams 等旧分析字段必须为空。
- 法规原文明确的生效日、反馈截止日和法定整改节点应保留在 effective_date、feedback_deadline、next_deadline。
- 禁止“建议关注”“持续关注”“企业应留意”等空泛动作。
${moduleInstruction}
候选覆盖规则：
- candidates 中每条都有 candidate_index。必须在 reviewed_candidates 中对每个 candidate_index 恰好返回一次 include 或 exclude 决定，不得遗漏。
- decision=include 的候选必须在 items 中恰好输出一条，并保留同一 candidate_index；decision=exclude 的候选不得输出 item。
- exclude reason 必须基于正文，例如“正文未涉及美妆”“日期超期且无例外”“仅为导航或重复事件”，不能只写“不重要”。
- 程序会根据 candidate_index 锁定原标题、来源、国家、日期和原文 URL，不得编造或替换。

JSON 结构：
{
  "period": { "start": "${period.start}", "end": "${period.end}" },
  "summary": [],
  "risk_alerts": [],
  "reviewed_candidates": [{ "candidate_index": 0, "decision": "include|exclude", "reason": "基于正文的具体理由" }],
  "sections": [{
      "module": "广告合规及处罚案例|美妆动态|知识产权动态|新规及案例动态|进出口动态|产品质量/召回与安全风险",
    "items": [{
      "candidate_index": 0,
      "display_title_zh": "中文显示标题（英文专有名词可保留）",
      "source_name_zh": "中文来源名",
      "type": "法规|征求意见|生效提醒|废止|案例|召回|动态|IP|进出口|平台规则",
      "module": "模块名称",
      "region": "亚洲|欧洲|北美洲|南美洲|大洋洲|全球",
      "country": "国家或市场，例如中国|欧盟|美国|日本|韩国|泰国|越南|印尼|墨西哥|意大利",
      "title": "标题",
      "source_name": "来源名称",
      "source_url": "candidates 中的具体原文URL，禁止来源主页",
      "source_type": "official|court|regulator|industry_media|wechat_lead|database",
      "published_at": "YYYY-MM-DD或未知",
      "updated_at": "YYYY-MM-DD或未知",
      "freshness_status": "本周发布|本周更新|历史规则·本期节点|历史规则·持续执行|历史规则·未关闭行动|发布时间待核验",
      "freshness_exception": "upcoming_deadline|ongoing_enforcement|current_week_change|open_action或空",
      "change_evidence": "本周新增解释、执行口径或持续执法证据；无则为空",
      "relevance": "direct",
      "industry_impact": "high|medium|low",
      "fact_summary": ["客观事实1", "客观事实2（可省略）"],
      "next_observation": ["一个客观后续观察节点"],
      "report_tier": "action|watch",
      "confidence": "high|medium|low",
      "effective_date": "生效日或未知",
      "feedback_deadline": "反馈截止日或未知",
      "next_deadline": "下一关键日期或未知"
    }]
  }]
}

信息源统计：${JSON.stringify(getSourceStats(sources))}
候选信息 candidates（已按中国优先、7天新鲜度、来源权威性和行业影响力预排序）：${JSON.stringify(prioritizeCandidatesForAnalysis(candidates.map((candidate, candidateIndex) => ({ ...candidate, candidate_index: candidateIndex }))).map(candidate => ({
  ...candidate,
  snippet: String(candidate.snippet || ''),
})))}
线索 leads（仅用于发现选题，不得直接输出为正式条目）：${JSON.stringify(leads)}`;
}

function buildReviewEvidence(report, candidates = []) {
  const candidatesByUrl = new Map();
  for (const candidate of candidates) {
    const url = normalizeSourceUrl(candidate.url || candidate.source_url);
    if (url && !candidatesByUrl.has(url)) candidatesByUrl.set(url, candidate);
  }

  return (report.sections || []).flatMap(section => (section.items || []).map(item => {
    const url = normalizeSourceUrl(item.source_url);
    const candidate = candidatesByUrl.get(url);
    return {
      module: section.module,
      title: item.title,
      source_name: item.source_name,
      source_url: item.source_url,
      evidence_title: candidate?.title || '',
      evidence_snippet: String(candidate?.snippet || ''),
    };
  }));
}

export function buildEvidenceReviewPrompt({ report, candidates = [] }) {
  return `你是美妆行业资讯的客观事实复核员。请基于 evidence 审查 draft_report，并只输出修正后的合法 JSON。

复核规则：
- 逐条检查 fact_summary 和 next_observation 是否有 evidence 支持，且正文内容与美妆行业有实质关系。
- 删除任何核心判断、法律分析、风险评价、业务影响推断、责任团队或行动分派文字。
- 没有证据支持的事实、只有来源主页、与美妆无实质关系或无法修正的条目必须删除。
- 不得新增条目、不得更换 source_url、不得改变 period 或六大模块名称。
- fact_summary 保留 1-2 条短小、具体、可核验的事实；next_observation 只保留一个客观后续节点。
- effective_date、feedback_deadline、next_deadline 只保留 evidence 明确支持的法定节点。
- 保持原 JSON 结构，不要输出解释、Markdown 或代码块。

draft_report：${JSON.stringify(report)}
evidence：${JSON.stringify(buildReviewEvidence(report, candidates))}`;
}

function assertReviewPreservesDraftScope(draft, reviewed) {
  if (reviewed.period?.start !== draft.period?.start || reviewed.period?.end !== draft.period?.end) {
    throw new Error('review changed report period');
  }
  const allowedModules = new Set((draft.sections || []).map(section => section.module));
  const allowedUrls = new Set((draft.sections || []).flatMap(section => section.items || []).map(item => normalizeSourceUrl(item.source_url)).filter(Boolean));
  const draftCount = (draft.sections || []).flatMap(section => section.items || []).length;
  const reviewedItems = (reviewed.sections || []).flatMap(section => section.items || []);
  if (draftCount > 0 && reviewedItems.length === 0) throw new Error('review removed every report item');
  if (reviewedItems.length > draftCount) throw new Error('review added report items');
  for (const section of reviewed.sections || []) {
    if (!allowedModules.has(section.module)) throw new Error(`review added module: ${section.module}`);
    for (const item of section.items || []) {
      if (!allowedUrls.has(normalizeSourceUrl(item.source_url))) throw new Error(`review changed source_url: ${item.source_url}`);
    }
  }
}

export async function reviewAnalysisReport({ apiKey, baseUrl, model, report, candidates = [], maxTokens = DEFAULT_AI_MAX_TOKENS, fetcher = fetch, logger = console }) {
  try {
    const content = await requestAiChat({
      apiKey,
      baseUrl,
      model,
      messages: [
        { role: 'system', content: '你只输出合法 JSON。不要输出解释、Markdown 或代码块。' },
        { role: 'user', content: buildEvidenceReviewPrompt({ report, candidates }) },
      ],
      temperature: 0.1,
      maxTokens,
      fetcher,
    });
    const reviewed = filterReportQuality(parseAnalysisJson(content));
    assertReviewPreservesDraftScope(report, reviewed);
    validateReport(reviewed);
    return reviewed;
  } catch (error) {
    logger.warn(`AI evidence review skipped: ${error.message}`);
    return report;
  }
}

function preferredDisplayTitle(translatedTitle, evidenceTitle, country = '') {
  const evidence = String(evidenceTitle || '').trim();
  if (/\p{Script=Han}/u.test(evidence)) return evidence;
  const translated = String(translatedTitle || '').trim();
  const compact = translated.replace(/[\s《》〈〉「」『』【】\[\]()（）]/g, '');
  const generic = /^(?:第[\d一二三四五六七八九十百]+号)?(?:公告|通知|决定|通报|新闻|动态|最新动态|政策解读)$/i.test(compact);
  if (!translated || generic || isNavigationTitle(translated) || !/\p{Script=Han}/u.test(translated)) return evidence;
  const market = String(country || '').trim();
  if (market && market !== '全球' && !translated.includes(market)) return evidence;
  const anchors = [...new Set(evidence.match(/\b[A-Z]{2,}\b/g) || [])];
  return anchors.every(anchor => translated.includes(anchor)) ? translated : evidence;
}

function preferredDisplaySourceName(translatedName, evidenceName) {
  const evidence = String(evidenceName || '').trim();
  return evidence || String(translatedName || '').trim();
}

function beautyEvidenceExcerpt(value) {
  const text = String(value || '');
  const index = findBeautyEvidenceIndex(text);
  if (index < 0) return text.slice(0, 4000);
  return text.slice(Math.max(0, index - 800), index + 4000);
}

function materializeCandidateBackedReport(report, candidates, targetModule) {
  const reviewed = Array.isArray(report.reviewed_candidates) ? report.reviewed_candidates : [];
  const decisions = new Map();
  for (const entry of reviewed) {
    const index = Number(entry?.candidate_index);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length || decisions.has(index)) {
      throw new Error(`invalid or duplicate reviewed candidate_index: ${entry?.candidate_index}`);
    }
    if (!['include', 'exclude'].includes(entry.decision) || !String(entry.reason || '').trim()) {
      throw new Error(`invalid candidate decision: ${index}`);
    }
    decisions.set(index, entry.decision);
  }
  if (decisions.size !== candidates.length) {
    const missing = candidates.map((_, index) => index).filter(index => !decisions.has(index));
    throw new Error(`candidate review incomplete; missing indexes: ${missing.join(',')}`);
  }

  const rawItems = (report.sections || []).flatMap(section => section.items || []);
  const itemIndexes = new Set();
  const items = rawItems.map(item => {
    const index = Number(item.candidate_index);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length || itemIndexes.has(index)) {
      throw new Error(`invalid or duplicate included candidate_index: ${item.candidate_index}`);
    }
    if (decisions.get(index) !== 'include') throw new Error(`excluded candidate emitted as item: ${index}`);
    itemIndexes.add(index);
    const candidate = candidates[index];
    return {
      ...item,
      candidate_index: index,
      module: targetModule,
      title: preferredDisplayTitle(item.display_title_zh, candidate.title, candidate.country),
      evidence_title: candidate.title,
      evidence_excerpt: beautyEvidenceExcerpt(candidate.snippet),
      source_name: preferredDisplaySourceName(item.source_name_zh, candidate.source_name || candidate.name),
      evidence_source_name: candidate.source_name || candidate.name || '',
      source_url: candidate.url || candidate.source_url,
      source_type: signalSourceType(candidate),
      country: candidate.country,
      region: candidate.region,
      published_at: candidate.published_at || '未知',
      updated_at: candidate.updated_at || '未知',
    };
  });
  for (const [index, decision] of decisions) {
    if (decision === 'include' && !itemIndexes.has(index)) throw new Error(`included candidate missing item: ${index}`);
  }
  return { ...report, sections: [{ module: targetModule, items }] };
}

export async function deepseekAnalyze({ apiKey, baseUrl, model, candidates, leads = [], sources = sourceCatalog.sources, period = getPeriod(), targetModule = '', candidateLimit = DEFAULT_ANALYSIS_CANDIDATE_LIMIT, leadLimit = DEFAULT_ANALYSIS_LEAD_LIMIT, maxTokens = DEFAULT_AI_MAX_TOKENS, fetcher = fetch, logger = console, review = true, requireCandidateCoverage = false }) {
  const messages = [
    { role: 'system', content: '你只输出合法 JSON。不要输出解释、Markdown 或代码块。' },
    { role: 'user', content: buildAnalysisPrompt({ candidates, leads, sources, period, targetModule, candidateLimit, leadLimit }) },
  ];

  let draft = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await requestAiChat({ apiKey, baseUrl, model, messages, temperature: 0.2, maxTokens, fetcher });
    try {
      const parsed = parseAnalysisJson(content);
      const candidateBacked = targetModule && requireCandidateCoverage
        ? materializeCandidateBackedReport(parsed, candidates, targetModule)
        : parsed;
      const report = filterReportQuality(candidateBacked);
      validateReport(report);
      draft = report;
      break;
    } catch (error) {
      if (attempt === 1) throw error;
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: `上一次输出不是合法可用 JSON：${error.message}。请只修复为合法 JSON，不要改变事实，不要输出代码块。` });
    }
  }
  if (!draft) throw new Error('AI analysis failed');
  if (!review) return draft;
  return reviewAnalysisReport({ apiKey, baseUrl, model, report: draft, candidates, maxTokens, fetcher, logger });
}

export function selectRescueEvidenceCandidates(candidates = [], leads = [], existingReport = null) {
  const usedUrls = new Set((existingReport?.sections || [])
    .flatMap(section => section.items || [])
    .map(item => normalizeSourceUrl(item.source_url))
    .filter(Boolean));
  const combined = [...candidates]
    .filter(candidate => /^https?:\/\//i.test(String(candidate.url || candidate.source_url || '')))
    .filter(candidate => !usedUrls.has(normalizeSourceUrl(candidate.url || candidate.source_url)));
  const ranked = sortCandidatesForAnalysis(combined)
    .sort((a, b) => Number(b.country === '中国') - Number(a.country === '中国'));
  const selected = [];
  const selectedUrls = new Set();
  const sourceCounts = new Map();
  const sourceKey = candidate => String(candidate.source_name || candidate.name || new URL(candidate.url || candidate.source_url).hostname);
  const take = candidate => {
    if (!candidate) return false;
    const url = normalizeSourceUrl(candidate.url || candidate.source_url);
    const source = sourceKey(candidate);
    if (!url || selectedUrls.has(url) || (sourceCounts.get(source) || 0) >= 3) return false;
    selected.push(candidate);
    selectedUrls.add(url);
    sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    return true;
  };

  for (let round = 0; round < 3; round += 1) {
    for (const module of REPORT_MODULES) {
      const available = ranked.filter(candidate => candidate.module === module && !selectedUrls.has(normalizeSourceUrl(candidate.url || candidate.source_url)));
      take(available[round] || available.find(candidate => (sourceCounts.get(sourceKey(candidate)) || 0) < 3));
    }
  }
  for (const candidate of ranked) {
    if (selected.length >= 24) break;
    take(candidate);
  }
  return selected;
}

function buildRescueAnalysisPrompt(evidence, period) {
  const candidates = evidence.map((candidate, candidateIndex) => ({
    candidate_index: candidateIndex,
    module: candidate.module,
    title: candidate.title,
    source_name: candidate.source_name || candidate.name,
    country: candidate.country,
    region: candidate.region,
    published_at: candidate.published_at,
    authority_type: candidate.authority_type,
    source_type: candidate.source_type,
    snippet: String(candidate.snippet || ''),
  }));
  return `你是美妆行业客观资讯编辑。常规提取不足，请从已抓取全文证据中识别与美妆行业有实质关系的客观资讯，数量不设业务上限。

规则：
- 中国信息优先，但不得为凑数选择无实质内容的候选。
- 只能引用 candidate_index，不得输出或编造 URL、来源名称、国家和发布日期。
- 必须依据 snippet 正文判断相关性，不能只看标题。
- fact_summary 只提取 1-2 条原文事实；next_observation 只写一个可观察的后续节点。
- 所有输出的自然语言使用简体中文；专有名词可用“中文译名（Original Name）”。
- 中文标题使用“主体 + 具体事项或结果”的自然新闻表达，不要逐词直译，不得只写公告编号、栏目名或空泛的“最新动态”。
- 来源名优先采用官方或通行中文名称；无通行中文译名时保留原名，不得臆造中文译名。
- 事实摘要直接写明主体、动作、对象以及原文已有的日期、金额、数量或处理结果，避免空泛转述。
- 不得输出核心判断、风险、业务影响、行动建议、责任团队或内部完成时间。
- 必须在 reviewed_candidates 对每个 candidate_index 恰好返回一次 include 或 exclude，不得默认遗漏。
- decision=include 必须恰好对应一条 item；decision=exclude 不得输出 item，且 reason 必须说明正文事实不符合哪条准入规则。
- 只输出合法 JSON；确实没有重要事项时仍需输出全部 exclude 决定。

JSON 结构：
{"reviewed_candidates":[{"candidate_index":0,"decision":"include|exclude","reason":"基于正文的具体理由"}],"items":[{
  "candidate_index":0,
  "title_zh":"中文显示标题",
  "source_name_zh":"中文来源名",
  "report_tier":"action|watch",
  "fact_summary":["客观事实1","客观事实2（可省略）"],
  "next_observation":["一个客观后续节点"],
  "relevance":"direct",
  "industry_impact":"high|medium|low",
  "confidence":"high|medium|low"
}]}

报告周期：${period.start} 至 ${period.end}
证据候选：${JSON.stringify(candidates)}`;
}

function rescueItemFromSelection(selection, candidate) {
  const module = REPORT_MODULES.includes(candidate.module) ? candidate.module : '美妆动态';
  const facts = Array.isArray(selection.fact_summary) ? selection.fact_summary.filter(Boolean).slice(0, 2) : [];
  const observation = Array.isArray(selection.next_observation) ? selection.next_observation.filter(Boolean).slice(0, 1) : [];
  const sourceType = signalSourceType(candidate);
  const official = ['official', 'official_site', 'regulator', 'court', 'database'].includes(sourceType)
    || ['official', 'regulator', 'court'].includes(candidate.authority_type);
  return {
    type: '动态',
    module,
    region: candidate.region || '全球',
    country: candidate.country || '全球',
    title: preferredDisplayTitle(selection.title_zh, candidate.title || `${candidate.source_name || candidate.name || '公开来源'}监管动态`, candidate.country),
    evidence_title: candidate.title || '',
    evidence_excerpt: beautyEvidenceExcerpt(candidate.snippet),
    source_name: preferredDisplaySourceName(selection.source_name_zh, candidate.source_name || candidate.name || '公开来源'),
    evidence_source_name: candidate.source_name || candidate.name || '',
    source_url: candidate.url || candidate.source_url,
    source_type: official ? 'regulator' : sourceType,
    published_at: candidate.published_at || '未知',
    relevance: selection.relevance === 'indirect' ? 'indirect' : 'direct',
    industry_impact: ['high', 'medium', 'low'].includes(selection.industry_impact) ? selection.industry_impact : 'medium',
    fact_summary: facts,
    next_observation: observation,
    report_tier: selection.report_tier === 'watch' ? 'watch' : 'action',
    confidence: ['high', 'medium', 'low'].includes(selection.confidence) ? selection.confidence : (official ? 'high' : 'medium'),
  };
}

function validateRescueCandidateCoverage(parsed, evidence) {
  const reviewed = Array.isArray(parsed.reviewed_candidates) ? parsed.reviewed_candidates : [];
  const decisions = new Map();
  for (const entry of reviewed) {
    const index = Number(entry?.candidate_index);
    if (!Number.isInteger(index) || index < 0 || index >= evidence.length || decisions.has(index)) {
      throw new Error(`rescue review invalid candidate_index: ${entry?.candidate_index}`);
    }
    if (!['include', 'exclude'].includes(entry.decision) || !String(entry.reason || '').trim()) {
      throw new Error(`rescue review invalid decision: ${index}`);
    }
    decisions.set(index, entry.decision);
  }
  if (decisions.size !== evidence.length) {
    const missing = evidence.map((_, index) => index).filter(index => !decisions.has(index));
    throw new Error(`rescue review incomplete; missing indexes: ${missing.join(',')}`);
  }
  const itemIndexes = new Set();
  for (const selection of Array.isArray(parsed.items) ? parsed.items : []) {
    const index = Number(selection?.candidate_index);
    if (!Number.isInteger(index) || index < 0 || index >= evidence.length || itemIndexes.has(index)) {
      throw new Error(`rescue item invalid candidate_index: ${selection?.candidate_index}`);
    }
    if (decisions.get(index) !== 'include') throw new Error(`rescue excluded candidate emitted as item: ${index}`);
    itemIndexes.add(index);
  }
  for (const [index, decision] of decisions) {
    if (decision === 'include' && !itemIndexes.has(index)) throw new Error(`rescue included candidate missing item: ${index}`);
  }
  return parsed;
}

export async function deepseekRescueAnalyze({
  apiKey,
  baseUrl,
  model,
  candidates = [],
  leads = [],
  period = getPeriod(),
  existingReport = null,
  fetcher = fetch,
  requireCandidateCoverage = true,
}) {
  const evidence = selectRescueEvidenceCandidates(candidates, leads, existingReport);
  if (!evidence.length) {
    return { period, summary: [], risk_alerts: [], sections: REPORT_MODULES.map(module => ({ module, items: [] })) };
  }
  const messages = [
    { role: 'system', content: '你只输出合法 JSON，不输出 Markdown、代码块或解释。' },
    { role: 'user', content: buildRescueAnalysisPrompt(evidence, period) },
  ];
  let parsed = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const content = await requestAiChat({
      apiKey,
      baseUrl,
      model,
      messages,
      temperature: 0.1,
      maxTokens: 3500,
      fetcher,
    });
    try {
      parsed = parseAnalysisJson(content);
      if (requireCandidateCoverage) validateRescueCandidateCoverage(parsed, evidence);
      break;
    } catch (error) {
      if (attempt === 1) throw error;
      messages.push({ role: 'assistant', content });
      messages.push({ role: 'user', content: `上一次未逐条完成候选决策：${error.message}。请保留事实并补齐每个 candidate_index 的 include/exclude 决定。` });
    }
  }
  const used = new Set();
  const items = (Array.isArray(parsed.items) ? parsed.items : []).flatMap(selection => {
    const index = Number(selection.candidate_index);
    if (!Number.isInteger(index) || index < 0 || index >= evidence.length || used.has(index)) return [];
    used.add(index);
    return [rescueItemFromSelection(selection, evidence[index])];
  });
  return {
    period,
    summary: [],
    risk_alerts: [],
    sections: REPORT_MODULES.map(module => ({
      module,
      items: items.filter(item => item.module === module),
    })),
  };
}

function mergeModuleReports(reports, period, modules = REPORT_MODULES) {
  const summary = reports.flatMap(report => report.summary || []).slice(0, 5);
  const riskAlerts = reports.flatMap(report => report.risk_alerts || []).slice(0, 8);
  const sections = modules.map(module => {
    const items = reports
      .flatMap(report => report.sections || [])
      .filter(section => section.module === module)
      .flatMap(section => section.items || []);
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
    '产品质量/召回与安全风险': ['供应链', '客服售后', '注册备案', '平台运营'],
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
    '产品质量/召回与安全风险': '案例',
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
    core_judgement: `当前仅能确认${candidate.source_name || candidate.name || '该来源'}出现${module}相关信号；在取得公开原文前，不能把它作为确定规则执行，但应核验其是否影响集团相关市场和业务流程。`,
    why_it_matters: `该来源属于${module}信息源，涉及${topics.join('、') || '监管和行业变化'}；即使本周未抓到可直接引用的明细页，也适合作为法务周报的待核验线索，帮助相关团队提前排查业务影响。`,
    recommended_actions: [
      `建议法务团队以${candidate.source_name || candidate.name || '该来源'}为入口，核验是否有与集团在售品类、渠道或目标市场相关的最新原文。`,
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
    '产品质量/召回与安全风险': ['召回', '抽检', '不合格', '产品质量', '产品安全', '禁用', '限用', '成分', '微生物', '重金属', '过敏'],
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
  const raw = String(url || '').trim();
  if (!/^https?:\/\//i.test(raw)) return raw.replace(/\/$/, '');
  try {
    const parsed = new URL(raw);
    parsed.hash = '';
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|spm|from|source)$/i.test(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/$/, '') || '/';
    return parsed.toString().replace(/\/$/, '');
  } catch {
    return raw.replace(/\/$/, '');
  }
}

export function filterReportToObservedSources(report, { candidates = [], sources = [] } = {}) {
  const observedUrls = candidates.map(candidate => candidate.url || candidate.source_url).filter(Boolean);
  const allowed = new Map(observedUrls.map(url => [normalizeSourceUrl(url), String(url).trim()]));

  return {
    ...report,
    sections: (report.sections || []).map(section => ({
      ...section,
      items: (section.items || []).flatMap(item => {
        const url = normalizeSourceUrl(item.source_url);
        if (!url || /xxx|example\.com|placeholder|待补充/i.test(url)) return [];
        const observedUrl = allowed.get(url);
        return observedUrl ? [{ ...item, source_url: observedUrl }] : [];
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

function reportItemCount(report) {
  return (report?.sections || []).reduce((total, section) => total + (section.items || []).length, 0);
}

export function processAnalyzedReport(rawReport, {
  candidates = [],
  sources = [],
  itemsPerModule = DEFAULT_REPORT_ITEMS_PER_MODULE,
} = {}) {
  const aiItems = reportItemCount(rawReport);
  const sourceCheckedReport = filterReportToObservedSources(rawReport, { candidates, sources });
  const sourceMatchedItems = reportItemCount(sourceCheckedReport);
  const imageAwareReport = attachReportImages(sourceCheckedReport, { candidates });
  const dedupedReport = dedupeReport(imageAwareReport);
  const structural = filterReportQualityWithAudit(dedupedReport);
  const quality = curateReportQualityWithAudit(structural.report);
  const report = limitReportSections(quality.report, itemsPerModule);
  const acceptedItems = reportItemCount(report);
  return {
    report,
    audit: {
      aiItems,
      sourceMatchedItems,
      structurallyValidItems: structural.audit.acceptedItems,
      acceptedItems,
      rejectedItems: aiItems - acceptedItems,
      reasons: {
        ...(aiItems > sourceMatchedItems ? { sourceMismatch: aiItems - sourceMatchedItems } : {}),
        ...structural.audit.reasons,
        ...Object.fromEntries(Object.entries(quality.audit.reasons).map(([key, value]) => [`quality:${key}`, value])),
      },
    },
  };
}

function logReportAudit(logger, label, audit) {
  const reasonText = Object.entries(audit.reasons || {})
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ') || 'none';
  (logger.info || logger.log).call(
    logger,
    `[stage 2/5] ${label}审计：AI=${audit.aiItems}，来源匹配=${audit.sourceMatchedItems}，结构有效=${audit.structurallyValidItems}，质量准入=${audit.acceptedItems}，拒绝原因=${reasonText}`,
  );
}

export async function analyzeReportWithRecovery({
  candidates = [],
  leads = [],
  sources = [],
  period,
  itemsPerModule = DEFAULT_REPORT_ITEMS_PER_MODULE,
  supplementThreshold = 8,
  analyzePrimary,
  analyzeRescue,
  logger = console,
}) {
  const primaryRawReport = await analyzePrimary();
  const primary = processAnalyzedReport(primaryRawReport, { candidates, sources, itemsPerModule });
  logReportAudit(logger, '主分析', primary.audit);
  const primaryItems = (primary.report.sections || []).flatMap(section => section.items || []);
  const primaryActionItems = primaryItems.filter(item => item.report_tier === 'action').length;
  const primaryActiveModules = (primary.report.sections || []).filter(section => (section.items || []).length > 0).length;
  const targetItems = Math.max(1, Number(supplementThreshold) || 8);
  const needsSupplement = primary.audit.acceptedItems < targetItems || primaryActionItems === 0 || primaryActiveModules < 2;
  if (!needsSupplement) return { ...primary, mode: 'primary', primaryAudit: primary.audit };

  if (!analyzeRescue || candidates.length + leads.length === 0) {
    return { ...primary, mode: primary.audit.acceptedItems > 0 ? 'primary' : 'no-update', primaryAudit: primary.audit };
  }

  logger.warn(primary.audit.acceptedItems === 0
    ? '[stage 2/5] 主分析无准入条目，启动一次高价值救援分析'
    : `[stage 2/5] 主分析整体不足（准入 ${primary.audit.acceptedItems}/${targetItems}、行动 ${primaryActionItems}、活跃模块 ${primaryActiveModules}），启动一次补充分析`);
  const rescueRawReport = await analyzeRescue({ report: primary.report });
  const rescue = processAnalyzedReport(rescueRawReport, { candidates, sources, itemsPerModule });
  logReportAudit(logger, '救援分析', rescue.audit);
  const combinedRawReport = mergeModuleReports([primary.report, rescue.report], period);
  const combined = processAnalyzedReport(combinedRawReport, { candidates, sources, itemsPerModule });
  if (combined.audit.acceptedItems === 0 && (primary.audit.aiItems > 0 || rescue.audit.aiItems > 0)) {
    throw new Error(
      `Report technical collapse: AI produced ${primary.audit.aiItems + rescue.audit.aiItems} items but none survived source, structure, and quality gates`,
    );
  }
  const addedItems = combined.audit.acceptedItems > primary.audit.acceptedItems;
  return {
    ...combined,
    mode: primary.audit.acceptedItems === 0
      ? (combined.audit.acceptedItems > 0 ? 'rescue' : 'no-update')
      : (addedItems ? 'supplemented' : 'primary'),
    primaryAudit: primary.audit,
    rescueAudit: rescue.audit,
  };
}

export async function analyzeReportByModule({
  modules = REPORT_MODULES,
  analyze,
  candidates = [],
  leads = [],
  sources = [],
  period = getPeriod(),
  logger = console,
}) {
  const reports = await mapWithConcurrency(modules, 2, async module => {
    const moduleCandidates = candidates.filter(candidate => candidate.module === module || signalMatchesModule(candidate, module));
    const moduleLeads = leads.filter(lead => lead.module === module || signalMatchesModule(lead, module));
    try {
      const report = await analyze({
        module,
        candidates: moduleCandidates,
        leads: moduleLeads,
        sources: sources.filter(source => source.module === module),
        period,
      });
      return normalizeModuleReport(report, module);
    } catch (error) {
      logger.warn(`AI module omitted: ${module}: ${error.message}`);
      return {
        period,
        summary: [],
        risk_alerts: [],
        sections: [{ module, items: [] }],
      };
    }
  });
  return mergeModuleReports(reports, period, modules);
}

async function deepseekAnalyzeByModule({ apiKey, baseUrl, model, candidates, leads = [], sources = sourceCatalog.sources, period = getPeriod(), candidateLimit = DEFAULT_ANALYSIS_CANDIDATE_LIMIT, leadLimit = DEFAULT_ANALYSIS_LEAD_LIMIT, maxTokens = DEFAULT_AI_MAX_TOKENS, requireCandidateCoverage = true }) {
  if (!candidates.length && !leads.length) {
    return { period, summary: [], risk_alerts: [], sections: REPORT_MODULES.map(m => ({ module: m, items: [] })) };
  }
  return analyzeReportByModule({
    candidates,
    leads,
    sources,
    period,
    analyze: async ({ module, candidates: moduleCandidates, sources: moduleSources }) => {
      if (!moduleCandidates.length) return { period, summary: [], risk_alerts: [], sections: [{ module, items: [] }] };
      const reports = [];
      for (const batch of chunkArray(prioritizeCandidatesForAnalysis(moduleCandidates), 4)) {
        try {
          const batchReport = await deepseekAnalyze({
            apiKey,
            baseUrl,
            model,
            candidates: batch,
            leads: [],
            sources: moduleSources,
            period,
            candidateLimit,
            leadLimit,
            maxTokens,
            targetModule: module,
            review: false,
            requireCandidateCoverage,
          });
          const reviewed = Array.isArray(batchReport.reviewed_candidates) ? batchReport.reviewed_candidates : [];
          const included = (batchReport.sections || []).flatMap(section => section.items || []).length;
          const chinaInput = batch.filter(candidate => candidate.country === '中国').length;
          const includedItems = (batchReport.sections || []).flatMap(section => section.items || []);
          const chinaIncluded = includedItems.filter(item => item.country === '中国').length;
          const overseasInput = batch.length - chinaInput;
          const overseasIncluded = included - chinaIncluded;
          console.log(`[stage 2/5] 候选批次审计：${module}，输入 ${batch.length}（中国 ${chinaInput}，海外 ${overseasInput}），逐条审阅 ${reviewed.length || (requireCandidateCoverage ? batch.length : 0)}，收录 ${included}（中国 ${chinaIncluded}，海外 ${overseasIncluded}），排除 ${Math.max(0, batch.length - included)}（中国 ${Math.max(0, chinaInput - chinaIncluded)}，海外 ${Math.max(0, overseasInput - overseasIncluded)}）`);
          reports.push(batchReport);
        } catch (error) {
          console.warn(`[stage 2/5] 候选批次跳过：${module}，输入 ${batch.length}，原因 ${error.message}`);
        }
      }
      return mergeModuleReports(reports, period, [module]);
    },
  });
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
  if (!isLikelyContentImage(item.image_url)) return '';
  return `<figure class="evidence-image"><img src="${escapeHtml(item.image_url)}" alt="${escapeHtml(item.source_name)} 来源图片" loading="lazy"></figure>`;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(String(value || ''));
}

function renderSourceAnchor(item) {
  if (!isHttpUrl(item.source_url)) {
    return `<span class="source-note">${escapeHtml(item.source_name || item.source_url || '线索来源')} · 待核验线索</span>`;
  }
  return `<a class="evidence-link" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">查看原文：${escapeHtml(item.source_name)}</a>`;
}

function isWatchlistItem(item) {
  const text = `${item.title || ''} ${item.why_it_matters || ''}`;
  return !isHttpUrl(item.source_url)
    || item.source_type === 'wechat_lead'
    || item.confidence === 'low'
    || /待核验|信息源入口|线索/.test(text);
}

export function renderFeishuSummary(report, reportUrl) {
  validateReport(report);
  const items = (report.sections || []).flatMap(section => section.items || []);
  const mdLink = (label, url) => `[${String(label || '查看原文').replace(/[\[\]\n]/g, '')}](${url})`;
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
  const guide = (report.summary || []).slice(0, 3).map((item, index) => `${index + 1}. **${item}**`).join('\n') || `1. **本期共 ${items.length} 条情报，建议先看高风险和高行业影响力条目。**`;
  const risks = (report.risk_alerts || []).slice(0, 3).map(alert => `• **${riskLabel(alert.level)}**：${alert.text}`).join('\n') || '本周暂无高价值风险提醒。';
  const actionLines = priorityItems.map(item => {
    const action = Array.isArray(item.recommended_actions) ? item.recommended_actions[0] : '';
    return `• **${item.country}｜${riskLabel(item.risk_level)}**｜${item.title}\n  **建议**：${suggest(action)}`;
  }).join('\n') || '• 本周暂无需要立即处理的高风险事项。';
  const evidence = priorityItems.slice(0, 3).map(item => `• ${mdLink(item.source_name, item.source_url)}｜${item.country}｜${riskLabel(item.risk_level)}`).join('\n') || '• 本期暂无可核验的高优先级来源。';
  const fullText = reportUrl ? `\n\n**查看完整版本**\n${mdLink('打开完整法务情报周报 →', reportUrl)}` : '';
  return `**美妆法务周报｜${report.period.end}**\n\n**Executive Brief｜核心判断**\n**${executive}**\n\n**导读｜先看这三件事**\n${guide}\n\n**风险提示**\n${risks}\n\n**Action Board｜建议优先动作**\n${actionLines}\n\n**Source Evidence｜来源证据**\n${evidence}${fullText}`;
}

function reportUrl(requestUrl, pathname) {
  const url = new URL(requestUrl);
  url.pathname = pathname;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function decisionMapKeyForDate(date) {
  return `asset:decision-map:${date}`;
}

async function saveDecisionMap(kv, date, svg) {
  await kv.put(decisionMapKeyForDate(date), svg, { metadata: { contentType: 'image/svg+xml', date } });
  await kv.put(LATEST_DECISION_MAP_KEY, svg, { metadata: { contentType: 'image/svg+xml', date } });
}

function decisionMapPngKeyForDate(date) {
  return `asset:decision-map:${date}.png`;
}

async function saveDecisionMapPng(kv, date, png) {
  if (!png) return;
  await kv.put(decisionMapPngKeyForDate(date), png, { metadata: { contentType: 'image/png', date } });
  await kv.put(LATEST_DECISION_MAP_PNG_KEY, png, { metadata: { contentType: 'image/png' } });
}

const SOURCE_REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36 beauty-legal-bot/2.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control': 'no-cache',
};

async function requestSourceHtml(source, url, fetcher, timeoutMs) {
  const response = await fetchWithTimeout(url, {
    headers: SOURCE_REQUEST_HEADERS,
    redirect: 'follow',
  }, timeoutMs, fetcher);
  if (!response.ok) {
    return { ok: false, status: response.status, kind: 'http', error: `HTTP ${response.status}` };
  }
  const html = await response.text();
  if (htmlToText(html).trim().length < 8) {
    return { ok: false, status: response.status, kind: 'empty-shell', error: 'public page returned no readable text' };
  }
  return { ok: true, status: response.status, html, finalUrl: response.url || url };
}

function extractSourceCandidatesFromHtml(source, html, finalUrl = source.url) {
  const snippetLimit = ['美妆动态', '进出口动态'].includes(source.module) ? 1500 : 800;
  const links = extractLinks(html, finalUrl).filter(link => isRelevantTitle(link.title));
  const imageUrl = extractImageUrl(html, finalUrl);
  const pageText = htmlToText(html).slice(0, snippetLimit);
  const linkCandidates = links.map(link => makeCandidate(source, { ...link, snippet: pageText, image_url: imageUrl }));
  const sourceText = `${source.name} ${(source.topics || []).join(' ')} ${pageText}`;
  const shouldKeepSourcePage = source.priority === 'high' || BEAUTY_KEYWORDS.some(keyword => sourceText.toLowerCase().includes(keyword.toLowerCase()));
  const sourceCandidate = shouldKeepSourcePage
    ? [makeCandidate(source, {
      title: `${source.name}：${source.module}信息源入口`,
      url: finalUrl,
      image_url: imageUrl,
      snippet: pageText || `${source.name} ${source.module} ${(source.topics || []).join(' ')}`,
    })]
    : [];
  return [...linkCandidates, ...sourceCandidate];
}

/**
 * 为单个公开来源保留完整恢复证据，并让所有恢复方式复用同一套候选解析规则。
 * 候选为空会被视为采集失败，避免行业线索占位被误计为成功覆盖。
 */
async function fetchSourceCandidates(source, {
  fetcher = fetch,
  browserFetcher,
  timeoutMs = SOURCE_FETCH_TIMEOUT_MS,
  sleepFn,
  jitter,
} = {}) {
  const recovery = await recoverPublicSource(source, {
    direct: (_source) => requestSourceHtml(source, source.url, fetcher, timeoutMs),
    browser: typeof browserFetcher === 'function'
      ? () => browserFetcher(source.url, { source, timeoutMs: Math.max(timeoutMs, 45000) })
      : undefined,
    alternate: (_source, url) => requestSourceHtml(source, url, fetcher, timeoutMs),
    sleep: sleepFn,
    jitter,
  });
  const items = recovery.html ? extractSourceCandidatesFromHtml(source, recovery.html, recovery.finalUrl || source.url) : [];
  const result = { ...recovery, candidate_count: items.length, items };
  if (!items.length && recovery.status !== 'failed') {
    result.status = 'empty';
    result.empty_reason = 'no relevant public candidates found';
  }
  if (result.status === 'failed') console.warn(`fetch failed: ${source.name} ${result.final_error}`);
  return result;
}

export async function collectCandidates(sources = sourceCatalog.sources, onProgress = async () => {}, options = {}) {
  const { fetchableSources, leadSources } = splitSources(sources);
  const leads = leadSources.map(makeLead);
  const leadCandidates = leadSources.map(makeSourceLeadCandidate);

  const results = await mapWithConcurrency(fetchableSources, SOURCE_FETCH_CONCURRENCY, async (source, index) => {
    await onProgress({ index: index + 1, total: fetchableSources.length, source: source.name });
    return fetchSourceCandidates(source, options);
  });

  const sourceResults = results.map(({ items: _items, html: _html, ...result }) => result);
  const coverage = calculateSourceCoverage(fetchableSources, sourceResults);
  const failures = sourceResults.filter(result => result.status === 'failed').map(result => result.source.name);
  const candidates = [
    ...results.flatMap(result => result.items.length ? result.items : [makeSourceLeadCandidate(result.source)]),
    ...leadCandidates,
  ];

  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = item.url || `${item.title}:${item.source_name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  let hydratedCandidates = unique;
  let detailAudit = { selected: 0, hydrated: 0, browserRecovered: 0, failed: 0, reasons: {} };
  if (options.hydrateDetails) {
    const hydrated = await hydrateCandidateDetails(unique, {
      fetcher: options.fetcher || fetch,
      browserFetcher: options.browserFetcher,
      detailLimit: options.detailLimit,
      timeoutMs: options.detailTimeoutMs,
      concurrency: options.detailConcurrency,
      browserRecoveryLimit: options.detailBrowserRecoveryLimit,
    });
    hydratedCandidates = hydrated.candidates;
    detailAudit = hydrated.audit;
    const detailReasons = Object.entries(detailAudit.reasons || {}).map(([reason, count]) => `${reason}=${count}`).join(', ') || 'none';
    console.log(`[stage 1/5] 详情页审计：选择 ${detailAudit.selected}，全文成功 ${detailAudit.hydrated}，浏览器恢复 ${detailAudit.browserRecovered}，失败保留 ${detailAudit.failed}，原因 ${detailReasons}`);
  }
  return { candidates: hydratedCandidates, leads, failures, sourceResults, coverage, detailAudit };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 多阶段 Pipeline：内部端点认证与编排
// ---------------------------------------------------------------------------
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

function validateInternalAuth(request, env) {
  const key = String(env?.AI_API_KEY || '');
  if (!key) return false;
  const auth = (request.headers.get('Authorization') || '').trim();
  return auth === `Bearer ${key}`;
}

function pipelineQualityOptions(env = {}) {
  const qualityMode = env.QUALITY_MODE === '1' || env.REPORT_QUALITY_MODE === 'quality' || env.CONTENT_QUALITY_MODE === 'quality';
  return {
    qualityMode,
    candidateLimit: Number(env.ANALYSIS_CANDIDATE_LIMIT || (qualityMode ? QUALITY_ANALYSIS_CANDIDATE_LIMIT : DEFAULT_ANALYSIS_CANDIDATE_LIMIT)),
    leadLimit: Number(env.ANALYSIS_LEAD_LIMIT || (qualityMode ? QUALITY_ANALYSIS_LEAD_LIMIT : DEFAULT_ANALYSIS_LEAD_LIMIT)),
    maxTokens: Number(env.AI_MAX_TOKENS || (qualityMode ? QUALITY_AI_MAX_TOKENS : DEFAULT_AI_MAX_TOKENS)),
    itemsPerModule: Number(env.REPORT_ITEMS_PER_MODULE || (qualityMode ? QUALITY_REPORT_ITEMS_PER_MODULE : DEFAULT_REPORT_ITEMS_PER_MODULE)),
  };
}

async function fetchSelf(env, pathname, body, retries = 2) {
  const base = String(env?.WORKER_URL || 'https://beauty-legal-bot.ai-cf.workers.dev').replace(/\/$/, '');
  const url = `${base}${pathname}`;
  const key = String(env?.AI_API_KEY || '');
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${JSON.stringify(data)}`);
      return data;
    } catch (error) {
      if (attempt === retries) throw error;
      await sleep(1000 * (attempt + 1));
    }
  }
}

async function runCollectPhase(sources, batchId, date, env) {
  if (!env?.SEEN_NEWS) throw new Error('SEEN_NEWS KV binding required');
  const { candidates, leads, failures, sourceResults, coverage } = await collectCandidates(sources, async () => {}, {
    fetcher: env.SOURCE_FETCH || fetch,
    browserFetcher: env.BROWSER_FETCH_HTML,
    timeoutMs: Number(env.SOURCE_FETCH_TIMEOUT_MS || SOURCE_FETCH_TIMEOUT_MS),
    sleepFn: env.SOURCE_RETRY_SLEEP,
    jitter: env.SOURCE_RETRY_JITTER,
    hydrateDetails: env.DETAIL_FETCH_ENABLED !== '0',
    detailLimit: Number.MAX_SAFE_INTEGER,
    detailTimeoutMs: Number(env.DETAIL_FETCH_TIMEOUT_MS || DETAIL_FETCH_TIMEOUT_MS),
    detailConcurrency: Number(env.DETAIL_FETCH_CONCURRENCY || DETAIL_FETCH_CONCURRENCY),
    detailBrowserRecoveryLimit: Number(env.DETAIL_BROWSER_RECOVERY_LIMIT || DETAIL_BROWSER_RECOVERY_LIMIT),
  });
  await env.SEEN_NEWS.put(
    `pipeline:${date}:batch:${batchId}`,
    JSON.stringify({ candidates, leads, failures, sourceResults, coverage })
  );
  return { batchId, candidateCount: candidates.length, leadCount: leads.length, failures, coverage };
}

async function runAnalysisPhase(date, env, additionalCandidates = []) {
  const aiKey = env?.AI_API_KEY;
  if (!env?.SEEN_NEWS || !aiKey) throw new Error('KV and AI_API_KEY required');
  const kv = env.SEEN_NEWS;
  const allCandidates = [...additionalCandidates];
  const allLeads = [];
  const allFailures = [];
  const allSourceResults = [];

  for (const batchId of ['1', '2', '3']) {
    const raw = await kv.get(`pipeline:${date}:batch:${batchId}`);
    if (!raw) continue;
    const data = JSON.parse(raw);
    allCandidates.push(...(data.candidates || []));
    allLeads.push(...(data.leads || []));
    allFailures.push(...(data.failures || []));
    allSourceResults.push(...(data.sourceResults || []));
  }

  const coverageSources = allSourceResults.map(result => result.source).filter(Boolean);
  const coverage = calculateSourceCoverage(coverageSources, allSourceResults);
  assertSourceCoverage(coverage, {
    minOverall: Number(env.MIN_SOURCE_COVERAGE || 0.9),
    minChinaCritical: Number(env.MIN_CHINA_CRITICAL_COVERAGE || 0.9),
  });

  const model = env.AI_MODEL || DEFAULT_AI_MODEL;
  const baseUrl = env.AI_API_BASE_URL || DEFAULT_AI_API_BASE_URL;
  const qualityOptions = pipelineQualityOptions(env);
  const period = getPeriod();
  const hydratedCandidates = filterCandidatesByFreshness(allCandidates, period)
    .filter(candidate => candidate.detail_status === 'hydrated');
  const editorial = applyEditorialGate(hydratedCandidates);
  const candidates = editorial.candidates;
  const proof = evaluateSourceOnlyProof(candidates, { period });
  console.log(`[stage 2/5] source-only 证明：primary=${proof.primary_count}, china=${proof.china_count}, modules=${proof.active_module_count}, duplicates=${proof.duplicates}`);
  if (!proof.pass) {
    throw new Error(`Source-only proof failed: ${JSON.stringify({
      primary_count: proof.primary_count,
      china_count: proof.china_count,
      active_module_count: proof.active_module_count,
      failure_codes: proof.failure_codes,
      duplicates: proof.duplicates,
      editorial_rejections: editorial.audit.rejections,
    })}`);
  }
  const analysis = await analyzeReportWithRecovery({
    candidates,
    leads: allLeads,
    sources: sourceCatalog.sources,
    period,
    itemsPerModule: qualityOptions.itemsPerModule,
    supplementThreshold: Number(env.REPORT_TARGET_ITEMS || 8),
    analyzePrimary: () => deepseekAnalyzeByModule({
      apiKey: aiKey,
      baseUrl,
      model,
      candidates,
      leads: allLeads,
      sources: sourceCatalog.sources,
      period,
      candidateLimit: qualityOptions.candidateLimit,
      leadLimit: qualityOptions.leadLimit,
      maxTokens: qualityOptions.maxTokens,
      requireCandidateCoverage: true,
    }),
    analyzeRescue: () => deepseekRescueAnalyze({
      apiKey: aiKey,
      baseUrl,
      model,
      candidates,
      leads: allLeads,
      period,
      requireCandidateCoverage: true,
    }),
  });
  const rawReport = analysis.report;

  await kv.put(`pipeline:${date}:rawReport`, JSON.stringify(rawReport));
  await kv.put(`pipeline:${date}:candidates`, JSON.stringify({
    candidates,
    leads: allLeads,
    failures: allFailures,
    sourceResults: allSourceResults,
    coverage,
  }));

  const itemCount = (rawReport.sections || []).flatMap(s => s.items || []).length;
  return { modules: (rawReport.sections || []).length, itemCount, failures: allFailures, coverage };
}

async function runFinalizePhase(date, env, requestUrl) {
  const kv = env.SEEN_NEWS;
  if (!kv) throw new Error('KV required');

  const raw = await kv.get(`pipeline:${date}:rawReport`);
  if (!raw) throw new Error(`No raw report for ${date}`);

  const rawReport = JSON.parse(raw);
  let candidatesMeta = { candidates: [], sources: sourceCatalog.sources };
  try {
    const metaRaw = await kv.get(`pipeline:${date}:candidates`);
    if (metaRaw) candidatesMeta = JSON.parse(metaRaw);
  } catch { /* use defaults */ }

  const qualityOptions = pipelineQualityOptions(env);
  const processed = processAnalyzedReport(rawReport, {
    candidates: candidatesMeta.candidates || [],
    sources: candidatesMeta.sources || sourceCatalog.sources,
    itemsPerModule: qualityOptions.itemsPerModule,
  });
  logReportAudit(console, '分阶段终审', processed.audit);
  const report = processed.report;
  validateReport(report);

  const { isDup, seen, fps } = await isDuplicateFingerprints(extractReportFingerprints(report), kv);
  if (shouldSkipDuplicateReport(isDup, env.FORCE_DELIVERY === '1')) {
    return { stage: 'dedupe', status: 'skipped', message: '30-day duplicate' };
  }

  const notification = await notifyReport({
    report,
    reportUrl: '',
    env: { ...env, SOURCE_COVERAGE: candidatesMeta.coverage },
  });
  const ok = notification.ok;
  if (ok) await markSeen(fps, seen, kv);
  return {
    stage: notification.channel,
    status: ok ? 'done' : 'failed',
    message: ok
      ? `${notification.channel} sent ${notification.sent || 1}/${notification.total || 1}`
      : `${notification.channel} delivery failed: ${notification.error || 'unknown error'}`,
    delivery: notification,
  };
}

async function cleanupPipelineState(date, kv) {
  if (!kv) return;
  for (const batchId of ['1', '2', '3']) {
    try { await kv.delete(`pipeline:${date}:batch:${batchId}`); } catch {}
  }
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export default {
  async scheduled(event, env, _ctx) {
    try {
      await recordLastRun(env.SEEN_NEWS, { trigger: 'scheduled', scheduled_time: event?.scheduledTime || null, status: 'started' });
      const result = await runPipeline(env);
      if (!result || result.status === 'failed') {
        throw new Error(`${result?.stage === 'dingtalk' ? 'DingTalk' : 'Weekly'} delivery failed: ${result?.message || 'pipeline returned no result'}`);
      }
      await recordLastRun(env.SEEN_NEWS, { trigger: 'scheduled', scheduled_time: event?.scheduledTime || null, status: result?.status || 'done', stage: result?.stage || 'pipeline' });
    } catch (error) {
      await recordLastRun(env.SEEN_NEWS, { trigger: 'scheduled', scheduled_time: event?.scheduledTime || null, status: 'failed', error: error.stack || error.message });
      throw error;
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── 内部端点 ──
    if (url.pathname === '/internal/collect' && request.method === 'POST') {
      if (!validateInternalAuth(request, env)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      try {
        const { sources, batchId, date } = await request.json();
        if (!sources?.length) throw new Error('sources required');
        const result = await runCollectPhase(sources, batchId || '1', date, env);
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (url.pathname === '/internal/analyze' && request.method === 'POST') {
      if (!validateInternalAuth(request, env)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      try {
        const { date } = await request.json();
        const result = await runAnalysisPhase(date, env);
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (url.pathname === '/internal/finalize' && request.method === 'POST') {
      if (!validateInternalAuth(request, env)) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
      try {
        const { date, requestUrl: finalizeUrl } = await request.json();
        const result = await runFinalizePhase(date, env, finalizeUrl || request.url);
        return new Response(JSON.stringify(result), { status: 200, headers: { 'Content-Type': 'application/json' } });
      } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    // ── 公开端点 ──
    if (url.pathname === "/test") {
      // 测试 mock 优先（单元测试用），否则走多阶段 Pipeline
      if (env.__TEST_RUN_PIPELINE__) {
        try {
          await recordLastRun(env.SEEN_NEWS, { trigger: 'manual', status: 'started' });
          const result = await env.__TEST_RUN_PIPELINE__(env, request.url);
          await recordLastRun(env.SEEN_NEWS, { trigger: 'manual', status: result?.status || 'done', stage: result?.stage || 'pipeline' });
          return new Response(`OK — weekly pipeline finished\nstatus: ${result?.status || 'done'}\ndelivery: DingTalk webhook`, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        } catch (error) {
          await recordLastRun(env.SEEN_NEWS, { trigger: 'manual', status: 'failed', error: error.stack || error.message });
          return new Response(`FAILED — weekly pipeline error\n${error.stack || error.message}`, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
        }
      }

      try {
        await recordLastRun(env.SEEN_NEWS, { trigger: 'manual', status: 'started' });
        const result = await runPipeline(env, request.url);
        await recordLastRun(env.SEEN_NEWS, { trigger: 'manual', status: result?.status || 'done', stage: result?.stage || 'pipeline' });
        return new Response(`OK — pipeline finished\nstatus: ${result?.status || 'done'}\ndelivery: DingTalk webhook`, { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      } catch (error) {
        await recordLastRun(env.SEEN_NEWS, { trigger: 'manual', status: 'failed', error: error.stack || error.message });
        return new Response(`FAILED — pipeline error\n${error.stack || error.message}`, { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } });
      }
    }

    if (url.pathname === "/report") {
      return new Response("Online HTML reports have been retired. Full reports are delivered through the DingTalk group webhook.", { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/report/latest") {
      return new Response("Online HTML reports have been retired. Full reports are delivered through the DingTalk group webhook.", { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    if (url.pathname === "/assets/decision-map.svg") {
      const svg = await env.SEEN_NEWS?.get(LATEST_DECISION_MAP_KEY);
      return svg
        ? new Response(svg, { headers: { "Content-Type": "image/svg+xml; charset=utf-8", "Cache-Control": "public, max-age=300" } })
        : new Response("Decision map not found", { status: 404 });
    }

    if (url.pathname === "/assets/decision-map.png") {
      const png = await env.SEEN_NEWS?.get(LATEST_DECISION_MAP_PNG_KEY, 'arrayBuffer');
      return png
        ? new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" } })
        : new Response("Decision map PNG not found", { status: 404 });
    }

    if (url.pathname === "/assets/editorial-report.png") {
      const png = await env.SEEN_NEWS?.get(LATEST_EDITORIAL_REPORT_PNG_KEY, 'arrayBuffer');
      return png
        ? new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=300" } })
        : new Response("Editorial report PNG not found", { status: 404 });
    }

    const editorialReportPngMatch = url.pathname.match(/^\/assets\/editorial-report\/(\d{4}-\d{2}-\d{2})\.png$/);
    if (editorialReportPngMatch) {
      const png = await env.SEEN_NEWS?.get(editorialReportPngKeyForDate(editorialReportPngMatch[1]), 'arrayBuffer');
      return png
        ? new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" } })
        : new Response("Editorial report PNG not found", { status: 404 });
    }

    const decisionMapPngMatch = url.pathname.match(/^\/assets\/decision-map\/(\d{4}-\d{2}-\d{2})\.png$/);
    if (decisionMapPngMatch) {
      const png = await env.SEEN_NEWS?.get(decisionMapPngKeyForDate(decisionMapPngMatch[1]), 'arrayBuffer');
      return png
        ? new Response(png, { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=31536000, immutable" } })
        : new Response("Decision map PNG not found", { status: 404 });
    }

    const match = url.pathname.match(/^\/report\/(\d{4}-\d{2}-\d{2})$/);
    if (match) {
      return new Response("Online HTML reports have been retired. Full reports are delivered through the DingTalk group webhook.", { status: 410, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    }

    return new Response("beauty-legal-bot v3 — weekly AI-reviewed legal intelligence", { status: 200 });
  },
};
