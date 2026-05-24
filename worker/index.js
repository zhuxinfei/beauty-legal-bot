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

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------
const DEEPSEEK_API = "https://api.deepseek.com/chat/completions";

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
async function callDeepSeek(apiKey, model = "deepseek-chat") {
  const today = (() => {
    const d = new Date(new Date().getTime() + 8 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  })();

  const prompt = SYSTEM_PROMPT.replace("---TODAY---", today);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(DEEPSEEK_API, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: prompt },
            {
              role: "user",
              content: `今天是 ${today}。直接输出日报，禁止任何开场白。`,
            },
          ],
          temperature: 0.3,
          max_tokens: 1200,
        }),
      });

      if (resp.ok) {
        const data = await resp.json();
        return data.choices[0].message.content;
      }

      console.error(`DeepSeek ${resp.status}: ${await resp.text().then(t => t.slice(0, 300))}`);
      if (attempt < 2) await sleep(2000 * (attempt + 1));
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
