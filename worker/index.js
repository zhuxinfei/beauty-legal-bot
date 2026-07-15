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
import { buildSingleDingTalkMessage } from './dingtalk-single-card.js';
import { buildActionDashboardSvg } from './action-dashboard.js';
import {
  assertSourceCoverage,
  calculateSourceCoverage,
  recoverPublicSource,
} from './source-recovery.js';

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const DEFAULT_AI_API_BASE_URL = 'https://hk.testvideo.site/v1';
const DEFAULT_AI_MODEL = 'gpt-5.6-sol';

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
const LATEST_DECISION_MAP_KEY = 'asset:decision-map:latest';
const LATEST_DECISION_MAP_PNG_KEY = 'asset:decision-map:latest.png';
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
const WORKER_FETCH_SOURCE_BUDGET = 15;
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
const ENTERPRISE_REQUIRED_FIELDS = ['source_type', 'relevance', 'industry_impact', 'business_impact', 'market_scope', 'core_judgement'];

// ---------------------------------------------------------------------------
// AI：一站式搜索 + 分析 + 格式化（OpenAI-compatible API）
// ---------------------------------------------------------------------------
export async function requestAiChat({ apiKey, baseUrl = DEFAULT_AI_API_BASE_URL, model = DEFAULT_AI_MODEL, messages, temperature = 0.2, maxTokens = 8000, fetcher = fetch }) {
  const body = {
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (model === 'gpt-5.6-sol') {
    body.reasoning_effort = 'high';
  }
  const endpoint = `${String(baseUrl || DEFAULT_AI_API_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
  const resp = await fetcher(endpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    throw new Error(`AI ${resp.status}: ${await resp.text().then(t => t.slice(0, 300))}`);
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
  return [buildSingleDingTalkMessage(report, {
    imageUrl: options.decisionMapUrl || options.imageUrl || '',
    coverage: options.coverage,
    maxBytes: options.maxBytes,
  })];
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

export async function notifyReport({ report, reportUrl: latestUrl, env, sendDingTalk = sendToDingTalk, sendFeishu = sendToFeishu }) {
  if (env.DINGTALK_WEBHOOK_URL) {
    const messages = buildDingTalkWebhookMessages(report, {
      decisionMapUrl: env.DECISION_MAP_URL || '',
      coverage: env.SOURCE_COVERAGE,
      maxBytes: env.DINGTALK_MAX_BYTES,
    });
    const delivery = await sendDingTalkMessages({
      messages,
      webhookUrl: env.DINGTALK_WEBHOOK_URL,
      secret: env.DINGTALK_SECRET || '',
      interMessageDelayMs: 0,
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
export async function runPipeline(env, requestUrl = 'https://beauty-legal-bot.workers.dev/') {
  const aiKey = env.AI_API_KEY;
  const aiBaseUrl = env.AI_API_BASE_URL || DEFAULT_AI_API_BASE_URL;
  const feishuUrl = env.FEISHU_WEBHOOK_URL;
  const dingTalkUrl = env.DINGTALK_WEBHOOK_URL;
  const model = env.AI_MODEL || DEFAULT_AI_MODEL;
  const kv = env.SEEN_NEWS;
  const qualityMode = env.QUALITY_MODE === '1' || env.REPORT_QUALITY_MODE === 'quality' || env.CONTENT_QUALITY_MODE === 'quality';
  const candidateLimit = Number(env.ANALYSIS_CANDIDATE_LIMIT || (qualityMode ? QUALITY_ANALYSIS_CANDIDATE_LIMIT : DEFAULT_ANALYSIS_CANDIDATE_LIMIT));
  const leadLimit = Number(env.ANALYSIS_LEAD_LIMIT || (qualityMode ? QUALITY_ANALYSIS_LEAD_LIMIT : DEFAULT_ANALYSIS_LEAD_LIMIT));
  const maxTokens = Number(env.AI_MAX_TOKENS || (qualityMode ? QUALITY_AI_MAX_TOKENS : DEFAULT_AI_MAX_TOKENS));
  const itemsPerModule = Number(env.REPORT_ITEMS_PER_MODULE || (qualityMode ? QUALITY_REPORT_ITEMS_PER_MODULE : DEFAULT_REPORT_ITEMS_PER_MODULE));

  if (!aiKey) throw new Error('AI_API_KEY is required');
  if (!dingTalkUrl && !feishuUrl) throw new Error('DINGTALK_WEBHOOK_URL or FEISHU_WEBHOOK_URL is required');
  if (!kv) throw new Error('SEEN_NEWS KV binding is required');

  console.log("=== 周报管道启动 ===");

  try {
    console.log("[stage 1/5] 抓取信息源候选...");
    const sources = env.FULL_SOURCE_SCAN === '1' || qualityMode
      ? sourceCatalog.sources
      : selectSourcesForWorkerBudget(sourceCatalog.sources, Number(env.WORKER_FETCH_SOURCE_BUDGET || WORKER_FETCH_SOURCE_BUDGET));
    const { fetchableSources } = splitSources(sources);
    console.log(`[stage 1/5] Worker 抓取预算：${fetchableSources.length} 个可抓取源，${sources.length - fetchableSources.length} 个线索源`);
    const { candidates, leads, failures, sourceResults, coverage } = await collectCandidates(sources, async () => {}, {
      fetcher: env.SOURCE_FETCH || fetch,
      browserFetcher: env.BROWSER_FETCH_HTML,
      timeoutMs: Number(env.SOURCE_FETCH_TIMEOUT_MS || SOURCE_FETCH_TIMEOUT_MS),
      sleepFn: env.SOURCE_RETRY_SLEEP,
      jitter: env.SOURCE_RETRY_JITTER,
    });
    assertSourceCoverage(coverage, {
      minOverall: Number(env.MIN_SOURCE_COVERAGE || 0.9),
      minChinaCritical: Number(env.MIN_CHINA_CRITICAL_COVERAGE || 1),
    });
    console.log(`[stage 1/5] 完成，候选 ${candidates.length} 条，线索 ${leads.length} 条，恢复源 ${sourceResults.filter(result => result.status === 'recovered').length} 个，失败源 ${failures.length} 个，覆盖率 ${(coverage.overall * 100).toFixed(1)}%`);

    console.log("[stage 2/5] AI 结构化分析...");
    const period = getPeriod();
    const rawReport = await deepseekAnalyzeByModule({ apiKey: aiKey, baseUrl: aiBaseUrl, model, candidates, leads, sources, period, candidateLimit, leadLimit, maxTokens });
    const sourceCheckedReport = filterReportToObservedSources(rawReport, { candidates, sources });
    const imageAwareReport = attachReportImages(sourceCheckedReport, { candidates });
    const report = limitReportSections(filterReportQuality(dedupeReport(enrichReportWithSourceSignals(imageAwareReport, { candidates, sources }))), itemsPerModule);
    validateReport(report);
    const itemCount = (report.sections || []).flatMap(section => section.items || []).length;
    console.log(`[stage 2/5] 完成，模块 ${report.sections.length} 个，去重后 ${itemCount} 条`);

    console.log("[stage 3/5] 生成管理层行动看板并保存报告...");
    const generatedAt = new Date().toISOString();
    const reportDate = report.period.end;
    const decisionMapSvg = buildDecisionMapSvg(
      verifiedReportItems(report).sort((a, b) => rankReportItem(b) - rankReportItem(a)),
      { period: report.period, coverage, generatedAt }
    );
    await saveDecisionMap(kv, reportDate, decisionMapSvg);
    const decisionMapPng = env.CREATE_DECISION_MAP_PNG
      ? await env.CREATE_DECISION_MAP_PNG({ svg: decisionMapSvg, date: reportDate, requestUrl })
      : null;
    if (decisionMapPng) await saveDecisionMapPng(kv, reportDate, decisionMapPng);
    const decisionMapUrl = decisionMapPng && typeof env.PUBLISH_DECISION_MAP === 'function'
      ? await env.PUBLISH_DECISION_MAP({ date: reportDate, png: decisionMapPng, svg: decisionMapSvg, requestUrl })
      : await resolveDecisionMapUrl({ env, requestUrl, decisionMapPng, date: reportDate });
    if (!decisionMapUrl) throw new Error('Decision map publication returned no public URL');
    const markdown = renderDingTalkMarkdown(report, { decisionMapUrl });
    if (typeof env.ON_REPORT_READY === 'function') {
      await env.ON_REPORT_READY({ report, markdown, decisionMapUrl, generatedAt, failures, sourceResults, coverage });
    }
    console.log("[stage 4/5] 内容去重检查...");
    const { isDup, seen, fps } = await isDuplicateFingerprints(extractReportFingerprints(report), kv);
    if (isDup) {
      console.log("[stage 4/5] 报告条目 30 天内已全部推送过，跳过摘要推送");
      return { stage: 'dedupe', status: 'skipped', message: 'all report items were already pushed in 30 days' };
    }

    console.log("[stage 5/5] 推送协作平台摘要...");
    const notification = await notifyReport({
      report,
      reportUrl: '',
      env: { ...env, DECISION_MAP_URL: decisionMapUrl, SOURCE_COVERAGE: coverage },
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
    for (const item of section.items) {
      for (const field of ['title', 'type', 'source_name', 'source_url', 'region', 'country']) {
        if (!hasValue(item[field])) throw new Error(`${field} missing: ${item.title || 'unknown'}`);
      }
      for (const field of getRequiredFields(item)) {
        if (!hasValue(item[field])) throw new Error(`${field} missing: ${item.title || 'unknown'}`);
      }
      if (!hasSpecificActions(item)) throw new Error(`recommended_actions not specific: ${item.title || 'unknown'}`);
      if (hasInternalCompletionDeadline(item)) throw new Error(`recommended_actions contains internal completion deadline: ${item.title || 'unknown'}`);
    }
  }
  return true;
}

function defaultDynamicAnalysis(item) {
  const source = item.source_name || '该来源';
  const title = item.title || '该动态';
  return {
    regulatory_signal: [`${source}发布或更新了与${item.module || item.type || '美妆法务'}相关的信息：${title}。`],
    compliance_meaning: [item.why_it_matters || '该动态可能影响集团相关市场的法务、注册、供应链、市场或电商运营判断，需结合业务覆盖范围核验。'],
    possible_follow_up: item.recommended_actions || [`建议法务团队核验${source}原文，并判断是否需要更新内部合规清单。`],
  };
}

export function normalizeReportForValidation(report) {
  return {
    ...report,
    sections: (report.sections || []).map(section => ({
      ...section,
      items: (section.items || []).map(item => {
        if (item.type !== '动态') return item;
        return { ...defaultDynamicAnalysis(item), ...item };
      }),
    })),
  };
}

export function filterReportQuality(report) {
  const normalizedReport = normalizeReportForValidation(report);
  return {
    ...normalizedReport,
    sections: (normalizedReport.sections || []).map(section => ({
      ...section,
      items: (section.items || []).filter(item => {
        if (!hasValue(item.source_url)) return false;
        const allowLeadSignal = ['美妆动态', '进出口动态'].includes(section.module)
          && ['wechat_lead', 'industry_media', 'wechat_public_account'].includes(item.source_type)
          && item.industry_impact !== 'low'
          && hasSpecificActions(item);
        if (item.confidence === 'low' && item.relevance !== 'direct' && item.industry_impact !== 'high' && !allowLeadSignal) return false;
        try {
          validateReport({ ...normalizedReport, sections: [{ ...section, items: [item] }] });
          return true;
        } catch {
          return false;
        }
      }),
    })),
  };
}

export function limitReportSections(report, itemLimit = DEFAULT_REPORT_ITEMS_PER_MODULE) {
  return {
    ...report,
    sections: REPORT_MODULES.map(module => {
      const section = (report.sections || []).find(item => item.module === module) || { module, items: [] };
      const limit = Number(itemLimit || DEFAULT_REPORT_ITEMS_PER_MODULE);
      return { ...section, items: (section.items || []).slice(0, limit) };
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
- 如果该模块有 candidates 或 leads，不要返回空数组；至少输出 2 条，优先 3 条。
- 对无法直接打开原文的公众号/行业源，可以输出“待核验”线索型动态，但必须说明待核验点、业务影响和建议动作。
- 美妆动态重点看行业监管趋势、平台治理、产品安全、功效宣称、渠道变化、头部品牌合规动作。
- 进出口动态重点看进口准入、清关、口岸抽检、跨境电商、认证、海关监管、召回和贸易合规。
- 产品质量/召回与安全风险重点看产品安全、抽检不合格、召回、禁限用成分、质量投诉、过敏/微生物/重金属风险和平台下架。
` : '';
  return `你是国际化美妆电商集团的高级法务情报分析员。用户是集团法务、合规、注册备案、跨境供应链、品牌/IP、市场投放、电商平台运营团队。不要输出未加工新闻，必须输出可用于业务判断的法务情报。

集团业务背景：
- 国际化美妆电商集团，关注中国、欧盟、美国、日本、韩国、泰国、越南、印尼、墨西哥、意大利等市场。
- 业务覆盖护肤、彩妆、防晒、香水、洗护、跨境进口、直播电商、平台销售、自有品牌和第三方品牌。
- 需要直接相关法规，也需要间接影响业务的广告、消费者保护、平台规则、知识产权、进出口、数据合规、召回案例。
- 产品质量/召回与安全风险单独成模块，重点覆盖产品安全、抽检不合格、召回、禁限用成分、质量投诉、过敏/微生物/重金属风险和平台下架。

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

模块必须使用以下 6 个，前 5 个来自用户 Excel 的“分类”列，第 6 个用于承接产品质量、召回和安全风险：
- 广告合规及处罚案例
- 美妆动态
- 知识产权动态
- 新规及案例动态
- 进出口动态
- 产品质量/召回与安全风险

输出要求：
- 输出合法 JSON，不要 Markdown，不要解释。
- 目标覆盖全部 6 个模块；每个模块优先输出 2-3 条，总量控制在 10-18 条。只有确无高价值信息时才允许模块为空。
- 美妆动态和进出口动态可以更多使用公众号/行业媒体作为线索，但必须标注 source_type 为 wechat_lead 或 industry_media，confidence 为 medium 或 low，并说明待核验点。
- 字段要完整但表达精炼，避免超长 JSON。
- 每条信息要有国家/大洲、直接/间接相关、行业影响力、业务影响面、建议动作。
- core_judgement 必须用 1-2 句话给出“监管或案件结论 + 对集团美妆业务的实质影响 + 必要的不确定性边界”，不能只复述标题或事实。
- 案例必须拆解事实、认定逻辑、处罚/结果、业务启发。
- 建议动作必须说明建议由哪个团队做什么，使用“建议...”口吻，不能是命令。
- 内部完成时间由具体领导决定，不得编造内部完成日期、天数或“本周内”等期限。
- 法规原文明确的生效日、反馈截止日和法定整改节点应保留在 effective_date、feedback_deadline、next_deadline。
- 禁止“建议关注”“持续关注”“企业应留意”等空泛动作。
${moduleInstruction}

JSON 结构：
{
  "period": { "start": "${period.start}", "end": "${period.end}" },
  "summary": ["3-5条集团级执行摘要，必须包含市场/国家、风险、业务影响和建议"],
  "risk_alerts": [{ "level": "high|medium|low", "text": "风险提醒" }],
  "sections": [{
      "module": "广告合规及处罚案例|美妆动态|知识产权动态|新规及案例动态|进出口动态|产品质量/召回与安全风险",
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
      "core_judgement": "监管或案件结论 + 对集团美妆业务的实质影响 + 必要的不确定性边界",
      "why_it_matters": "为什么值得国际化美妆电商集团法务关注",
      "recommended_actions": ["建议由哪个团队排查/更新/提交什么；不填写内部完成时间"],
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
候选信息 candidates（已按7天新鲜度、国家/大洲、来源权威性和行业影响力预排序）：${JSON.stringify(sortCandidatesForAnalysis(candidates).slice(0, candidateLimit))}
线索 leads（公众号和不可抓来源，可作为强线索但需标注可信度）：${JSON.stringify(leads.slice(0, leadLimit))}`;
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
      evidence_snippet: String(candidate?.snippet || '').slice(0, 2000),
    };
  }));
}

export function buildEvidenceReviewPrompt({ report, candidates = [] }) {
  return `你是美妆法务情报的事实与逻辑复核员。请基于 evidence 审查 draft_report，并只输出修正后的合法 JSON。

复核规则：
- 逐条检查 core_judgement、事实、法规变化、违法逻辑、业务影响和建议动作是否有 evidence 支持。
- 没有证据支持的确定性表述必须降级为待核验，无法修正的条目应删除。
- 不得新增条目、不得更换 source_url、不得改变 period 或六大模块名称。
- core_judgement 必须包含监管或案件结论、对集团美妆业务的实质影响，以及必要的不确定性边界。
- 建议动作只说明建议由哪个团队做什么；内部完成时间由具体领导决定，不得编造内部完成日期、天数或“本周内”等期限。
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

export async function deepseekAnalyze({ apiKey, baseUrl, model, candidates, leads = [], sources = sourceCatalog.sources, period = getPeriod(), targetModule = '', candidateLimit = DEFAULT_ANALYSIS_CANDIDATE_LIMIT, leadLimit = DEFAULT_ANALYSIS_LEAD_LIMIT, maxTokens = DEFAULT_AI_MAX_TOKENS, fetcher = fetch, logger = console }) {
  const messages = [
    { role: 'system', content: '你只输出合法 JSON。不要输出解释、Markdown 或代码块。' },
    { role: 'user', content: buildAnalysisPrompt({ candidates, leads, sources, period, targetModule, candidateLimit, leadLimit }) },
  ];

  let draft = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await requestAiChat({ apiKey, baseUrl, model, messages, temperature: 0.2, maxTokens, fetcher });
    try {
      const report = filterReportQuality(parseAnalysisJson(content));
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
  return reviewAnalysisReport({ apiKey, baseUrl, model, report: draft, candidates, maxTokens, fetcher, logger });
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

async function deepseekAnalyzeByModule({ apiKey, baseUrl, model, candidates, leads = [], sources = sourceCatalog.sources, period = getPeriod(), candidateLimit = DEFAULT_ANALYSIS_CANDIDATE_LIMIT, leadLimit = DEFAULT_ANALYSIS_LEAD_LIMIT, maxTokens = DEFAULT_AI_MAX_TOKENS }) {
  // 六个模块共享同一份首轮分析和证据复核，避免按模块重复消耗调用额度。
  if (!candidates.length && !leads.length) {
    return { period, summary: [], risk_alerts: [], sections: REPORT_MODULES.map(m => ({ module: m, items: [] })) };
  }
  const report = await deepseekAnalyze({
    apiKey, baseUrl, model, candidates, leads, sources, period, candidateLimit, leadLimit, maxTokens,
    targetModule: REPORT_MODULES.join('、'),
  });
  const reports = REPORT_MODULES.map(module => {
    const section = (report.sections || []).find(s => s.module === module) || { module, items: [] };
    return normalizeModuleReport({ ...report, sections: [section] }, module);
  });
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
  const linkLimit = ['美妆动态', '进出口动态'].includes(source.module) ? 14 : 8;
  const snippetLimit = ['美妆动态', '进出口动态'].includes(source.module) ? 1500 : 800;
  const links = extractLinks(html, finalUrl).filter(link => isRelevantTitle(link.title)).slice(0, linkLimit);
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
  return { candidates: unique, leads, failures, sourceResults, coverage };
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
    minChinaCritical: Number(env.MIN_CHINA_CRITICAL_COVERAGE || 1),
  });

  const model = env.AI_MODEL || DEFAULT_AI_MODEL;
  const baseUrl = env.AI_API_BASE_URL || DEFAULT_AI_API_BASE_URL;
  const qualityOptions = pipelineQualityOptions(env);
  const period = getPeriod();
  const rawReport = await deepseekAnalyzeByModule({
    apiKey: aiKey,
    baseUrl,
    model,
    candidates: allCandidates,
    leads: allLeads,
    sources: sourceCatalog.sources,
    period,
    candidateLimit: qualityOptions.candidateLimit,
    leadLimit: qualityOptions.leadLimit,
    maxTokens: qualityOptions.maxTokens,
  });

  await kv.put(`pipeline:${date}:rawReport`, JSON.stringify(rawReport));
  await kv.put(`pipeline:${date}:candidates`, JSON.stringify({
    candidates: allCandidates,
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

  const sourceCheckedReport = filterReportToObservedSources(rawReport, candidatesMeta);
  const imageAwareReport = attachReportImages(sourceCheckedReport, candidatesMeta);
  const qualityOptions = pipelineQualityOptions(env);
  const report = limitReportSections(filterReportQuality(dedupeReport(enrichReportWithSourceSignals(imageAwareReport, candidatesMeta))), qualityOptions.itemsPerModule);
  validateReport(report);

  const generatedAt = new Date().toISOString();
  const failures = candidatesMeta.failures || [];
  const reportDate = report.period.end;
  const itemCount = (report.sections || []).flatMap(s => s.items || []).length;
  const decisionMapSvg = buildDecisionMapSvg(
    verifiedReportItems(report).sort((a, b) => rankReportItem(b) - rankReportItem(a)),
    { period: report.period, coverage: candidatesMeta.coverage, generatedAt }
  );
  await saveDecisionMap(kv, reportDate, decisionMapSvg);
  const decisionMapPng = env.CREATE_DECISION_MAP_PNG
    ? await env.CREATE_DECISION_MAP_PNG({ svg: decisionMapSvg, date: reportDate, requestUrl })
    : null;
  if (decisionMapPng) await saveDecisionMapPng(kv, reportDate, decisionMapPng);
  const decisionMapUrl = decisionMapPng && typeof env.PUBLISH_DECISION_MAP === 'function'
    ? await env.PUBLISH_DECISION_MAP({ date: reportDate, png: decisionMapPng, svg: decisionMapSvg, requestUrl })
    : await resolveDecisionMapUrl({ env, requestUrl, decisionMapPng, date: reportDate });
  if (!decisionMapUrl) throw new Error('Decision map publication returned no public URL');
  const { isDup, seen, fps } = await isDuplicateFingerprints(extractReportFingerprints(report), kv);
  if (isDup) return { stage: 'dedupe', status: 'skipped', message: '30-day duplicate' };

  const notification = await notifyReport({
    report,
    reportUrl: '',
    env: { ...env, DECISION_MAP_URL: decisionMapUrl, SOURCE_COVERAGE: candidatesMeta.coverage },
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
