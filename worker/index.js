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

const NOISE_KEYWORDS = ['融资', '发布会', '新品上市', '代言', '财报', '招聘'];
const REPORT_INDEX_KEY = 'report:index';

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
function extractFingerprints(report) {
  const fingerprints = [];
  const lines = report.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("**") && !trimmed.startsWith("**📌") &&
        !trimmed.startsWith("**📋") && !trimmed.startsWith("**⚖️") &&
        !trimmed.startsWith("**💡")) {
      fingerprints.push(trimmed.slice(0, 120));
    }
  }
  return fingerprints;
}

async function isDuplicate(report, kv) {
  if (!kv) return false;
  const fps = extractFingerprints(report);
  if (!fps.length) return false;

  try {
    const seenKey = "seen_v2";
    const raw = await kv.get(seenKey);
    let seen = raw ? JSON.parse(raw) : [];

    // 清理 7 天前的
    const now = Date.now();
    seen = seen.filter(e => now - e.ts < 30 * 24 * 60 * 60 * 1000);

    const seenSet = new Set(seen.map(e => e.h));
    const newFps = fps.filter(f => !seenSet.has(hashStr(f)));

    // 如果超过 60% 的指纹已存在，视为重复
    const dupRatio = 1 - newFps.length / fps.length;
    return { isDup: dupRatio > 0.6, seen, fps };
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
    await kv.put("seen_v2", JSON.stringify(seen));
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

// ---------------------------------------------------------------------------
// 管道入口
// ---------------------------------------------------------------------------
async function runPipeline(env, requestUrl = 'https://beauty-legal-bot.workers.dev/') {
  const deepseekKey = env.DEEPSEEK_API_KEY;
  const feishuUrl = env.FEISHU_WEBHOOK_URL;
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  const kv = env.SEEN_NEWS;

  if (!deepseekKey) { console.error("缺少 DEEPSEEK_API_KEY"); return; }
  if (!feishuUrl) { console.error("缺少 FEISHU_WEBHOOK_URL"); return; }
  if (!kv) { console.error("缺少 SEEN_NEWS KV 绑定"); return; }

  console.log("=== 周报管道启动 ===");

  console.log("[stage 1/5] 抓取信息源候选...");
  const { candidates, failures } = await collectCandidates(sourceCatalog.sources);
  console.log(`[stage 1/5] 完成，候选 ${candidates.length} 条，失败源 ${failures.length} 个`);

  console.log("[stage 2/5] DeepSeek 结构化分析...");
  const period = getPeriod();
  const report = await deepseekAnalyze({ apiKey: deepseekKey, model, candidates, sources: sourceCatalog.sources, period });
  console.log(`[stage 2/5] 完成，模块 ${report.sections.length} 个`);

  console.log("[stage 3/5] 生成并保存 HTML 周报...");
  const generatedAt = new Date().toISOString();
  const html = renderReportHtml(report, { generatedAt, failures });
  const reportDate = report.period.end;
  await saveReport(kv, reportDate, html, { period: report.period, generatedAt, itemCount: (report.sections || []).flatMap(section => section.items || []).length });
  console.log(`[stage 3/5] 已保存 /report/${reportDate} 和 /report/latest`);

  console.log("[stage 4/5] 内容去重检查...");
  const summaryText = renderFeishuSummary(report, reportUrl(requestUrl, '/report/latest'));
  const { isDup, seen, fps } = await isDuplicate(summaryText, kv);
  if (isDup) {
    console.log("[stage 4/5] 与近期周报高度重复，保留页面但跳过飞书推送");
    return;
  }

  console.log("[stage 5/5] 推送飞书摘要...");
  const ok = await sendToFeishu(feishuUrl, summaryText);
  if (ok) await markSeen(fps, seen, kv);
  console.log(ok ? "=== 周报管道完成 ===" : "=== 周报管道失败 ===");
}

// ---------------------------------------------------------------------------
// 信息源工具
// ---------------------------------------------------------------------------
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
  return RELEVANT_KEYWORDS.some(keyword => text.includes(keyword.toLowerCase()));
}

export function makeCandidate(source, item) {
  return {
    title: item.title,
    url: item.url,
    snippet: item.snippet || '',
    source_name: source.name,
    module: source.module,
    region: source.region,
    country: source.country,
    source_type: source.source_type,
    authority_type: source.authority_type,
    priority: source.priority,
    topics: source.topics || [],
    fetched_at: new Date().toISOString(),
  };
}

export function parseAnalysisJson(text) {
  const cleaned = String(text || '')
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  return JSON.parse(cleaned);
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
      if (!item.title || !item.type || !item.source_name || !item.source_url) {
        throw new Error(`item missing required fields: ${item.title || 'unknown'}`);
      }
    }
  }
  return true;
}

function getPeriod(now = new Date()) {
  const end = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000);
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
}

function buildAnalysisPrompt({ candidates, sources, period }) {
  return `你是跨境美妆企业法务情报分析员。只基于候选信息生成 JSON，不要编造 URL，不要使用候选外信息。

时间窗口：
- 法规：过去 14 天发布，或未来 90 天进入生效/反馈/认证/过渡期节点。
- 案例：过去 30 天公开；高代表性案例可放宽到 60 天，但必须解释原因。
- 行业媒体：只作为线索，最终尽量回到官方或公开网页链接。

筛选规则：
- 宁缺毋滥，低价值内容丢弃。
- 每条最终资讯必须包含候选里的原文 URL，字段名 source_url。
- 同一事项保留官方源或信息最完整来源。
- 输出必须是合法 JSON，不要 Markdown。

输出结构：
{
  "period": { "start": "${period.start}", "end": "${period.end}" },
  "summary": ["3-5条执行摘要"],
  "risk_alerts": [{ "level": "high|medium|low", "text": "风险提醒" }],
  "sections": [{
    "module": "新规/修订/废止|广告合规及处罚案例|美妆行业动态|知识产权动态|进出口/跨境电商动态",
    "items": [{
      "type": "法规|案例|动态|IP|进出口",
      "region": "区域",
      "country": "国家",
      "title": "标题",
      "source_name": "来源名称",
      "source_url": "候选原文URL",
      "published_at": "YYYY-MM-DD或未知",
      "status": "征求意见|正式发布|生效提醒|废止|公开案例|动态",
      "content": ["核心内容"],
      "impact_scope": ["影响范围"],
      "analysis": "为什么重要",
      "action": "建议动作"
    }]
  }]
}

信息源统计：${JSON.stringify(getSourceStats(sources))}
候选信息：${JSON.stringify(candidates.slice(0, 80))}`;
}

async function deepseekAnalyze({ apiKey, model, candidates, sources = sourceCatalog.sources, period = getPeriod() }) {
  const messages = [
    { role: 'system', content: '你只输出合法 JSON。不要输出解释、Markdown 或代码块。' },
    { role: 'user', content: buildAnalysisPrompt({ candidates, sources, period }) },
  ];

  for (let attempt = 0; attempt < 2; attempt++) {
    const content = await requestDeepSeekChat({ apiKey, model, messages, temperature: 0.2, maxTokens: 4000 });
    try {
      const report = parseAnalysisJson(content);
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

function riskLabel(level) {
  const labels = { high: '高风险', medium: '中风险', low: '低风险' };
  return labels[level] || level || '风险';
}

export function renderReportHtml(report, { generatedAt = new Date().toISOString(), failures = [] } = {}) {
  validateReport(report);
  const sections = report.sections || [];
  const allItems = sections.flatMap(section => section.items || []);
  const countries = [...new Set(allItems.map(item => item.country).filter(Boolean))];
  const highCount = (report.risk_alerts || []).filter(alert => alert.level === 'high').length;
  const mediumCount = (report.risk_alerts || []).filter(alert => alert.level === 'medium').length;
  const lowCount = (report.risk_alerts || []).filter(alert => alert.level === 'low').length;

  const sectionHtml = sections.map(section => {
    const items = section.items || [];
    const itemHtml = items.length ? items.map(item => `
      <article class="item-card">
        <div class="item-meta">
          <span class="tag">${escapeHtml(item.type)}</span>
          <span>${escapeHtml(item.region)} · ${escapeHtml(item.country)}</span>
          <span>${escapeHtml(item.status || '动态')}</span>
          <span>${escapeHtml(item.published_at || '未知日期')}</span>
        </div>
        <h3>${escapeHtml(item.title)}</h3>
        <a class="source-link" href="${escapeHtml(item.source_url)}" target="_blank" rel="noopener noreferrer">原文：${escapeHtml(item.source_name)}</a>
        ${renderList(item.content, 'compact-list')}
        ${renderList(item.impact_scope, 'scope-list')}
        ${item.analysis ? `<p><strong>分析：</strong>${escapeHtml(item.analysis)}</p>` : ''}
        ${item.action ? `<p><strong>行动建议：</strong>${escapeHtml(item.action)}</p>` : ''}
      </article>
    `).join('') : '<p class="empty">本周无高价值更新</p>';
    return `
      <section class="report-section">
        <div class="section-heading">
          <h2>${escapeHtml(section.module)}</h2>
          <span>${items.length} 条</span>
        </div>
        ${itemHtml}
      </section>
    `;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>美妆法务周报</title>
  <style>
    :root { color-scheme: light; --bg: #F8FAFC; --panel: #FFFFFF; --primary: #1E3A8A; --primary-2: #1E40AF; --gold: #B45309; --text: #0F172A; --muted: #475569; --border: #E2E8F0; --soft: #EFF6FF; --danger: #B91C1C; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; font-size: 16px; line-height: 1.68; }
    a { color: var(--primary-2); text-decoration-thickness: 0.08em; text-underline-offset: 0.18em; }
    a:focus-visible { outline: 3px solid rgba(180, 83, 9, 0.45); outline-offset: 3px; border-radius: 6px; }
    .shell { max-width: 1120px; margin: 0 auto; padding: 28px 18px 56px; }
    .hero { background: linear-gradient(135deg, #0F274C 0%, #1E3A8A 58%, #B45309 140%); color: #fff; border-radius: 28px; padding: 34px; box-shadow: 0 24px 70px rgba(30, 58, 138, 0.22); }
    .eyebrow { margin: 0 0 10px; color: #FDE68A; font-size: 14px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
    h1 { margin: 0; font-size: clamp(30px, 5vw, 52px); line-height: 1.12; letter-spacing: -0.03em; }
    .subtitle { max-width: 760px; margin: 16px 0 0; color: #DBEAFE; font-size: 18px; }
    .hero-grid { display: grid; grid-template-columns: 1fr; gap: 18px; margin-top: 24px; }
    .metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    .metric { background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.22); border-radius: 18px; padding: 16px; backdrop-filter: blur(12px); }
    .metric strong { display: block; font-size: 28px; line-height: 1; }
    .metric span { color: #DBEAFE; font-size: 13px; }
    .panel { margin-top: 20px; background: var(--panel); border: 1px solid var(--border); border-radius: 22px; padding: 22px; box-shadow: 0 14px 44px rgba(15, 23, 42, 0.06); }
    .summary-list { margin: 0; padding-left: 20px; }
    .risk-list { display: grid; gap: 10px; margin-top: 14px; }
    .risk { display: flex; gap: 10px; align-items: flex-start; padding: 12px 14px; background: #FFFBEB; border: 1px solid #FDE68A; border-radius: 14px; }
    .risk-badge { flex: 0 0 auto; min-width: 58px; text-align: center; border-radius: 999px; padding: 3px 9px; background: var(--gold); color: #fff; font-size: 13px; font-weight: 700; }
    .country-strip { display: flex; gap: 8px; overflow-x: auto; padding-bottom: 4px; }
    .country { flex: 0 0 auto; border: 1px solid var(--border); background: var(--soft); color: var(--primary); border-radius: 999px; padding: 6px 12px; font-size: 14px; font-weight: 700; }
    .report-section { margin-top: 24px; }
    .section-heading { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-bottom: 12px; }
    h2 { margin: 0; color: var(--primary); font-size: 24px; letter-spacing: -0.02em; }
    .section-heading span { color: var(--muted); font-size: 14px; }
    .item-card { background: var(--panel); border: 1px solid var(--border); border-radius: 20px; padding: 20px; margin-top: 12px; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.05); }
    .item-meta { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--muted); font-size: 13px; }
    .tag { background: var(--primary); color: #fff; border-radius: 999px; padding: 3px 10px; font-weight: 700; }
    h3 { margin: 12px 0 8px; font-size: 21px; line-height: 1.35; }
    .source-link { display: inline-flex; min-height: 44px; align-items: center; font-weight: 700; }
    .compact-list, .scope-list { margin: 10px 0 0; padding-left: 20px; }
    .scope-list li { color: var(--muted); }
    .empty { margin: 0; color: var(--muted); }
    .footer { margin-top: 28px; color: var(--muted); font-size: 13px; }
    @media (max-width: 720px) { .shell { padding: 14px 12px 34px; } .hero { border-radius: 20px; padding: 24px 18px; } .metric-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .panel { padding: 18px; border-radius: 18px; } .item-card { padding: 17px; } }
  </style>
</head>
<body>
  <main class="shell">
    <header class="hero">
      <p class="eyebrow">Beauty Legal Intelligence</p>
      <h1>美妆法务周报</h1>
      <p class="subtitle">周期：${escapeHtml(report.period.start)} 至 ${escapeHtml(report.period.end)}。聚焦法规节点、处罚案例、知识产权和跨境合规风险。</p>
      <div class="hero-grid">
        <div class="metric-grid" aria-label="风险统计">
          <div class="metric"><strong>${allItems.length}</strong><span>高价值资讯</span></div>
          <div class="metric"><strong>${highCount}</strong><span>高风险提醒</span></div>
          <div class="metric"><strong>${mediumCount}</strong><span>中风险提醒</span></div>
          <div class="metric"><strong>${lowCount}</strong><span>低风险提醒</span></div>
        </div>
      </div>
    </header>

    <section class="panel" aria-labelledby="summary-title">
      <h2 id="summary-title">执行摘要</h2>
      ${renderList(report.summary, 'summary-list') || '<p class="empty">本周无高价值更新</p>'}
    </section>

    <section class="panel" aria-labelledby="risk-title">
      <h2 id="risk-title">风险雷达</h2>
      <div class="risk-list">
        ${(report.risk_alerts || []).length ? report.risk_alerts.map(alert => `<div class="risk"><span class="risk-badge">${escapeHtml(riskLabel(alert.level))}</span><span>${escapeHtml(alert.text)}</span></div>`).join('') : '<p class="empty">本周无高价值风险提醒</p>'}
      </div>
      <div class="country-strip" aria-label="涉及国家和地区">${countries.map(country => `<span class="country">${escapeHtml(country)}</span>`).join('')}</div>
    </section>

    ${sectionHtml}

    <footer class="footer">
      <p>生成时间：${escapeHtml(generatedAt)}</p>
      <p>信息源说明：本页面由公开网页与行业线索自动整理生成，公众号类来源仅作线索，最终以原文链接为准。</p>
      ${failures.length ? `<p>部分源抓取失败：${escapeHtml(failures.slice(0, 12).join('、'))}</p>` : ''}
      <p>AI 生成内容仅供法务信息初筛，不构成正式法律意见。</p>
    </footer>
  </main>
</body>
</html>`;
}

export function renderFeishuSummary(report, reportUrl) {
  validateReport(report);
  const items = (report.sections || []).flatMap(section => section.items || []);
  const highlights = (report.summary || []).slice(0, 5).map(text => `- ${text}`).join('\n') || '- 本周无高价值更新';
  const risks = (report.risk_alerts || []).slice(0, 3).map(alert => `- ${riskLabel(alert.level)}：${alert.text}`).join('\n') || '- 本周无高价值风险提醒';
  return `**⚖️ 美妆法务周报 · ${report.period.end}**\n\n本周筛选 ${items.length} 条高价值资讯。\n\n**本周最重要**\n${highlights}\n\n**风险提醒**\n${risks}\n\n[打开完整周报](${reportUrl})`;
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
  if (source.source_type === 'wechat_public_account') return [];
  if (!source.url || !source.url.startsWith('http')) return [];

  try {
    const response = await fetch(source.url, {
      headers: {
        'User-Agent': 'beauty-legal-bot/1.0 (+legal intelligence monitor)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });
    if (!response.ok) return [];

    const html = await response.text();
    const links = extractLinks(html, source.url).filter(link => isRelevantTitle(link.title)).slice(0, 8);
    const pageText = htmlToText(html).slice(0, 500);
    return links.map(link => makeCandidate(source, { ...link, snippet: pageText }));
  } catch (error) {
    console.warn(`fetch failed: ${source.name} ${error.message}`);
    return [];
  }
}

async function collectCandidates(sources = sourceCatalog.sources) {
  const candidates = [];
  const failures = [];
  for (const source of sources) {
    const items = await fetchSourceCandidates(source);
    if (!items.length && source.source_type !== 'wechat_public_account') failures.push(source.name);
    candidates.push(...items);
  }

  const seen = new Set();
  const unique = [];
  for (const item of candidates) {
    const key = item.url || `${item.title}:${item.source_name}`;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  return { candidates: unique, failures };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------
export default {
  async scheduled(_event, env, _ctx) {
    await runPipeline(env);
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/test") {
      ctx.waitUntil(runPipeline(env, request.url));
      return new Response("OK — weekly pipeline running, check Feishu and /report/latest", { status: 200 });
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
