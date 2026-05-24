/**
 * 美妆电商法务资讯每日推送机器人 - Cloudflare Worker
 *
 * 管道: DeepSeek 搜索+分析 → KV 去重 → 飞书推送
 * 触发: 每天 UTC 00:00 (北京时间 08:00) cron 自动执行
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

const SYSTEM_PROMPT = `你是一位资深美妆/化妆品电商法务总监，就职于一家跨境电商美妆企业。
公司业务覆盖三大市场：中国、东南亚、欧美。你需要**调研并撰写**一份今日美妆行业法规资讯日报，三个市场均等关注。

## 调研要求
请基于你对全球美妆法规的专业知识，梳理最近 7 天内的重要动态。按市场区域逐一覆盖：

### 🇨🇳 中国
- NMPA（国家药监局）：化妆品注册备案、功效宣称、标签管理、安全评估、禁限用物质清单
- 市场监管/海关：跨境电商化妆品合规、进出口政策
- 直播带货/社交电商：虚假宣传、功效宣称处罚案例

### 🇪🇺 欧美
- EU 1223/2009 修订动态、ECHA 化妆品相关物质评估、SCCS 安全意见
- 成员国（法/德/意/西）化妆品监管执法动态
- FDA MoCRA（化妆品现代化监管法案）实施进展、设施注册、产品列名截止

### 🌏 东南亚
- 东盟化妆品指令 (ACD) 更新：禁限用物质清单、标签要求
- **印尼 BPOM**：化妆品备案/注册、清真认证 (Halal) 强制要求、2026 年化妆品原料清单更新
- 泰国 FDA、越南 DAV、菲律宾 FDA、马来西亚 NPRA 化妆品准入与监管变化
- 跨境进口合规：TPA/BATAM 等港口清关要求

### 🦘 大洋洲
- 澳大利亚 AICIS（工业化学品引入计划）：化妆品原料评估与登记要求
- 新西兰 EPA（环保署）：化妆品产品组标准 (Cosmetic Products Group Standard) 更新
- 澳新防晒霜标准 AS/NZS 2604 更新动态

### 覆盖要求（宁缺毋滥）
- 优先有重大影响的法规变化和案例，有则写、无则标"近期无重大变化"
- 不强制每个区域都有案例，不硬凑
- 法规和案例用 [法规] [案例] 标签区分
- 案例不限于执法处罚，有行业影响力的独立案例也可（头部品牌被罚、重大维权、IP纠纷等）

### 信息来源
优先引用官方来源（NMPA官网、各地药监局、FDA官网、EU Official Journal等）。
如果你不确定某条信息的真实性或完整 URL，请注明信息来源机构名称，但不要编造 URL。

## 铁律
- 每件事只出现一次，不要在"关注"和分区里重复同一内容
- 只保留有重大影响的美妆法规变化和案例
- 新品上市、融资、营销活动 → 不要
- 与美妆无关的内容 → 不要
- 超过 10 天的旧闻 → 不要
- **严禁编造 URL**：不确定的只写来源机构名
- **全文必须控制在 800 字以内。超过 800 字会被系统强行截断，后半部分法务总监根本看不到。**
- **直接输出日报内容，禁止任何开场白、问候语、标题行（如"好的，这是为您准备的..."、"美妆行业法规资讯日报"、"日期：XXX"、"编制：XXX"）。第一个字符就是 🇨🇳。**
- **序号 ① ② ③ 必须独立换行，每条一行，禁止全部挤在同一行。**
- **严格遵守 Markdown 换行规则：每个要点、每个项目符号、每条并列内容必须独立成行。禁止将多个要点用逗号或分号串在一行。**

## 输出格式

**🇨🇳 中国**（1-2 条，标 [法规] 或 [案例]）

[法规] **{标题}**
- 内容：{什么法规、谁发布、何时生效、核心条款}
- 影响范围：{涉及哪些品类/渠道/市场、受影响企业类型}
- 行动建议：{法务部应该做什么}

[案例] **{标题}**
- 案情：{谁、做了什么、违反了哪条法规}
- 处罚/判决：{金额、措施、法律定性}
- 拆解分析：{为什么会被罚、执法逻辑是什么、透露出什么监管信号}
- 合规启示：{我们的业务是否存在同样风险、如何规避}

**🇪🇺 欧美**（1-2 条，格式同上）

**🌏 东南亚**（1-2 条，格式同上）

**🦘 大洋洲**（0-1 条，格式同上，无则跳过）

## 格式规则
- 每件事只出现一次，不设单独的"重点关注"或"行动建议"总结模块——内容都在分区条目里了
- 每条给足背景和判断，让法务经理读完就明白"发生什么、关我什么事、我要做什么"
- 没有重大变化就写"近期无重大法规变化"
- 链接用文字超链接 [来源](url)，严禁裸 URL
- 今天日期：---TODAY---`;

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

async function callDeepSeek(apiKey, model = "deepseek-chat") {
  const today = (() => {
    const d = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  })();

  const prompt = SYSTEM_PROMPT.replace("---TODAY---", today);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await requestDeepSeekChat({
        apiKey,
        model,
        messages: [
          { role: "system", content: prompt },
          { role: "user", content: `今天是 ${today}。直接输出日报，禁止任何开场白。` },
        ],
        temperature: 0.3,
        maxTokens: 1200,
      });
    } catch (e) {
      console.error(`DeepSeek error (${attempt + 1}): ${e.message}`);
      if (attempt < 2) await sleep(2000 * (attempt + 1));
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// KV 去重：基于日报内容 hash，7 天内不重复
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
    seen = seen.filter(e => now - e.ts < 7 * 24 * 60 * 60 * 1000);

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
    seen = seen.filter(e => now - e.ts < 7 * 24 * 60 * 60 * 1000);
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
      title: { tag: "plain_text", content: `⚖️ 美妆法务日报 · ${today}` },
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
async function runPipeline(env) {
  const deepseekKey = env.DEEPSEEK_API_KEY;
  const feishuUrl = env.FEISHU_WEBHOOK_URL;
  const model = env.DEEPSEEK_MODEL || "deepseek-chat";
  const kv = env.SEEN_NEWS;

  if (!deepseekKey) { console.error("缺少 DEEPSEEK_API_KEY"); return; }
  if (!feishuUrl) { console.error("缺少 FEISHU_WEBHOOK_URL"); return; }

  console.log("=== 管道启动 ===");

  // Stage 1: DeepSeek 搜索 + 分析 + 格式化
  console.log("[stage 1/3] DeepSeek 调研中...");
  const report = await callDeepSeek(deepseekKey, model);
  if (!report) {
    console.error("DeepSeek 调用失败");
    await sendToFeishu(feishuUrl, `## ⚠️ 日报生成失败\n\n法务日报生成失败，请检查 DeepSeek API Key。`);
    return;
  }
  console.log(`[stage 1/3] 完成，${report.length} 字符`);

  // Stage 2: KV 去重
  console.log("[stage 2/3] 去重检查...");
  if (kv) {
    const { isDup, seen, fps } = await isDuplicate(report, kv);
    if (isDup) {
      console.log("[stage 2/3] 与近期日报高度重复，跳过推送");
      return;
    }
    // 推送成功后再标记去重（stage 3 之后）
    await markSeen(fps, seen, kv);
    console.log("[stage 2/3] 通过，已标记指纹");
  } else {
    console.log("[stage 2/3] KV 未绑定，跳过去重");
  }

  // Stage 3: 飞书推送
  console.log("[stage 3/3] 推送到飞书...");
  const ok = await sendToFeishu(feishuUrl, report);
  console.log(ok ? "=== 管道完成 ===" : "=== 管道失败 ===");
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
      ctx.waitUntil(runPipeline(env));
      return new Response("OK — pipeline running, check Feishu", { status: 200 });
    }
    return new Response("beauty-legal-bot v2 — DeepSeek only", { status: 200 });
  },
};
