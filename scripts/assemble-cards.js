// Direct card assembly from hydrated records.
// Code handles selection + fact extraction; templates generate narrative.
// Usage: node scripts/assemble-cards.js [hydrated-authority.json] [output.json]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeHydratedRecord } from '../worker/source-hydration.js';
import { extractHardFacts, gradeEvidence } from '../worker/hard-fact-extractor.js';
import { corroborateEvidenceCandidates } from '../worker/evidence-corroboration.js';
import {
  premiumCardFromCandidate,
  validatePremiumEvidenceCard,
  auditPremiumEvidenceCards,
  buildPremiumDingTalkMarkdown,
} from '../worker/premium-quality.js';
import { cleanArticleEvidence } from '../worker/article-evidence.js';

// Client context — used to prioritize geographically relevant content
const CLIENT = { name: '杭州丽知', cities: ['杭州', '上海', '郑州'], province: '浙江' };
const IS_CLIENT_CITY = new RegExp(CLIENT.cities.join('|'));

const inputPath = resolve(process.argv[2] || 'out/hydrated-authority.json');
const outputPath = resolve(process.argv[3] || 'out/assembled-cards.json');
const FINGERPRINTS_PATH = resolve('out/seen-fingerprints.json');

// Load previously-seen fingerprints for cross-week dedup.
// The file may contain old-format KV entries (e.g. "seen_v3_report_items")
// from the legacy pipeline — skip those, only use card-level fingerprints.
let previousFingerprints = new Set();
try {
  if (existsSync(FINGERPRINTS_PATH)) {
    const raw = JSON.parse(readFileSync(FINGERPRINTS_PATH, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const [key, val] of Object.entries(raw)) {
        // Old-format entries are single keys with array values; skip them
        if (Array.isArray(val) || typeof val === 'object') continue;
        // Card fingerprints: key is the fingerprint, value is the date
        if (key.length > 5 && typeof val === 'string') {
          previousFingerprints.add(key);
        }
      }
    }
    console.log(`Loaded ${previousFingerprints.size} previous card fingerprints`);
  }
} catch (_) { /* first run, no history */ }

console.log(`Loading hydration records from ${inputPath}...`);
const payload = JSON.parse(readFileSync(inputPath, 'utf8'));
const rawRecords = payload.records || [];

// Derive period from hydration data, filtering outliers
const now = new Date();
const dates = rawRecords
  .map(r => r.published_at)
  .filter(d => /^20\d{2}-\d{2}-\d{2}$/.test(d))
  .filter(d => {
    const dt = new Date(d + 'T00:00:00Z');
    const daysAgo = (now - dt) / 86400000;
    return daysAgo > 0 && daysAgo < 60; // last 60 days only
  })
  .sort();
const period = {
  start: dates[0] || new Date(now - 15*86400000).toISOString().slice(0, 10),
  end: dates[dates.length - 1] || now.toISOString().slice(0, 10),
};

// --- Patterns ---
const BEAUTY_PATTERN = /(?:化妆品|美妆|护肤|彩妆|香水|口红|面膜|洗护|防晒|染发|美容|祛斑|美白|功效宣称|玻色因|配方|着色剂|色素|进口化妆品|出口化妆品|化妆品标准|cosmetic|cosmetics|MoCRA)/i;
// Judge beauty relevance from article body (first 1000 chars), not page chrome.
// Strips known portal/nav text before checking. Returns true if the article's
// primary subject is beauty/cosmetics — not just incidentally mentioned.
function isArticleAboutBeauty(title = '', text = '') {
  const combined = `${title} ${text.slice(0, 1000)}`;
  return /(?:化妆品|美妆|护肤|彩妆|香水|防晒|染发|洗护|面膜|口红|精华液|面霜|祛斑|美白|功效宣称|玻色因|配方|着色剂|进口化妆品|出口化妆品|化妆品标准|cosmetic|MoCRA)/i.test(combined);
}
const ACADEMIC_IP_PATTERN = /(?:损害赔偿请求权|法理探析|制度研究|案例评析|案例聚焦|知识产权律师网)/i;
const NEWS_CHROME = [
  /要闻\s*北京\s*科技\s*财经\s*AI\s*更多[^。]*/g,
  /正在浏览：[^。]*/g,
  /GPLP\s*游戏\s*应用\s*网页设置[^。]*/g,
  /安装电脑版\s*内容更精彩[^。]*/g,
  /微信\s*随时随地看[^。]*/g,
  /元宝\s*·\s*新闻妹[^。]*/g,
  /文章配图-\d[^。]*/g,
  /链接复制成功[^。]*/g,
  /发布于：[^。]*/g,
];
const FORUM_HOSTS = /(?:wenxuecity\.com|\.tieba\.|\.zhihu\.|\.douban\.|\.weibo\.)/i;
const WEAK_TITLE_PATTERN = /(?:举办|召开|培训|会议|活动|论坛|调研|考察|检查指导|工作部署)/;
const PORTAL_CHROME = [
  /化妆品审评\s*国家抽检管理\s*医疗器械标准与分类管理[^。]*/g,
  /访问我的专属空间[^。]*/g,
  /无障碍\s*关怀版\s*繁體[^。]*/g,
  /办理流程\s*立案→调查取证→审查→告知→决定→送达→执行/g,
  /返回首页\s*页面放大\s*页面缩小[^。]*/g,
  /移动版\s*本站查询[^。]*/g,
  /主要职责\s*基本信息\s*领导介绍\s*机构设置[^。]*/g,
  /缴纳情况\s*\d{4}年\d{1,2}月\d{1,2}日已缴纳[^。]*/g,
  /智能问答\s*["'][^"']*["'][^。]*/g,
  /返回首页[^。]*/g,
  /智能问答[^。]*/g,
  /访问我的专属空间[^。]*/g,
  /一网通查[^。]*/g,
  /请\s*\d+s\)\s*抱歉[^。]*/g,
  /药品GSP认证公示[^。]*/g,
  /生物制品批签发[^。]*/g,
  /国家标准物质与菌毒种[^。]*/g,
  /阳光采购平台[^。]*/g,
  /补充检验方法管理系统[^。]*/g,
  /业务咨询\s*区[^。]*/g,
  /用户空间\s*海关电邮[^。]*/g,
  /守国门\s*促发展[^。]*/g,
  /当好让党放心[^。]*/g,
  /能力验证\s*进口药品[^。]*/g,
  /仪器设备管理系统[^。]*/g,
];

// Step 1: Normalize records with substantive text
console.log(`Normalizing ${rawRecords.length} records...`);
const records = rawRecords
  .map(r => normalizeHydratedRecord(r))
  .filter(r => (r.article_text || '').length > 100);

// Step 2: Pre-clean, extract hard facts, grade evidence
console.log(`Extracting hard facts from ${records.length} records...`);
const candidates = records.map(r => {
  let text = cleanArticleEvidence(r.article_text || '');
  for (const pattern of PORTAL_CHROME) text = text.replace(pattern, '');
  for (const pattern of NEWS_CHROME) text = text.replace(pattern, '');
  text = text.replace(/\s{2,}/g, ' ');

  const facts = extractHardFacts(text, {
    title: r.title, source_name: r.source_name || r.name,
    source_url: r.final_url || r.url, module: r.module,
    country: r.country || r.region,
  });
  const grade = gradeEvidence({
    text, hard_facts: facts,
    source_url: r.final_url || r.url, title: r.title,
    source_name: r.source_name || r.name,
    country: r.country || r.region,
  });
  return { ...r, article_text: text, hard_facts: facts,
    evidence_grade: grade.evidence_grade, evidence_reason: grade.evidence_reason };
});

// Step 3: Corroborate multi-source events
const corroboration = corroborateEvidenceCandidates(candidates);
console.log(`Corroboration: ${corroboration.audit.records} → ${corroboration.audit.events} events (${corroboration.audit.corroborated} corrob, ${corroboration.audit.primaryVerified} primary)`);

// Step 4: Build cards — accept all grades that have substantive text, let premium gate filter
let pool = [
  ...corroboration.candidates,
  ...candidates.filter(c =>
    !corroboration.candidates.some(cc => cc.url === c.url)
    && c.evidence_grade !== 'reject'
    && (c.article_text || '').length > 200
  ),
  // Lead-only candidates with substantive body text can still produce useful cards
  ...candidates.filter(c =>
    !corroboration.candidates.some(cc => cc.url === c.url)
    && c.evidence_grade === 'lead_only'
    && (c.article_text || '').length > 300
    && BEAUTY_PATTERN.test(c.title + ' ' + c.article_text)
  ),
];
// Deduplicate by URL
const seen_urls = new Set();
pool = pool.filter(c => {
  const key = (c.url || c.source_url || '').trim();
  if (!key || seen_urls.has(key)) return false;
  seen_urls.add(key);
  return true;
});
console.log(`Candidate pool: ${pool.length} records`);

// --- AI content review ---
const indexModule = await import('../worker/index.js');
const { requestAiChat } = indexModule;
const aiKey = process.env.AI_API_KEY;
const aiBaseUrl = process.env.AI_API_BASE_URL || 'https://api.deepseek.com/v1';
const aiModel = process.env.AI_MODEL || 'deepseek-chat';

// AI reads the full article and judges (a) beauty relevance (b) if it's a duplicate
// of any previously accepted article. Maintains a running list of accepted summaries.
const acceptedSummaries = []; // { title, facts, eventSig }
async function aiReview(title, text) {
  if (!aiKey) return { relevant: true, reason: 'no-api-key', eventSig: '', isDuplicate: false };
  const excerpt = (text || '').slice(0, 4000);
  // Only send the last 10 accepted articles for comparison (prevents prompt bloat)
  const recentAccepted = acceptedSummaries.slice(-10);
  const prevList = recentAccepted.length > 0
    ? `\n\n已采纳的文章列表（判断新文章是否与之重复）：\n${recentAccepted.map((s, i) => `${i + 1}. ${s.title} | ${s.facts}`).join('\n')}`
    : '';
  try {
    const resp = await requestAiChat({
      apiKey: aiKey, baseUrl: aiBaseUrl, model: aiModel,
      messages: [
        { role: 'system', content: `你是美妆法务情报审核员。阅读文章后回答：
1. 是否与化妆品/美妆行业实质相关？
2. 事件唯一标识：文号、案号、公告编号或"企业全称+日期"。
3. 是否与"已采纳的文章列表"中任何一篇是同一事件（不同媒体对同一事件的报道算重复）？
回复纯JSON：{"relevant":true或false,"event_sig":"文号或案号或企业名+日期","is_duplicate":true或false,"dup_of":"如果是重复，写出列表中哪一篇","reason":"一句话"}`
        },
        { role: 'user', content: `标题：${title}\n正文：${excerpt}${prevList}` },
      ],
      temperature: 0, maxTokens: 800, timeoutMs: 45000, maxAttempts: 1,
    });
    const j = JSON.parse(resp.replace(/```json\s*|\s*```/g, '').trim());
    return {
      relevant: Boolean(j.relevant),
      eventSig: j.event_sig || '',
      isDuplicate: Boolean(j.is_duplicate),
      dupOf: j.dup_of || '',
      reason: j.reason || '',
    };
  } catch (err) {
    const msg = (err?.message || String(err)).slice(0, 60);
    // Retry once on JSON truncation
    if (msg.includes('end of JSON') || msg.includes('Unexpected end')) {
      try {
        await new Promise(r => setTimeout(r, 2000));
        const retryResp = await requestAiChat({
          apiKey: aiKey, baseUrl: aiBaseUrl, model: aiModel,
          messages: [
            { role: 'system', content: '你是美妆法务情报审核员。判断文章是否与美妆行业实质相关，是否与已采纳列表重复。回复JSON：{"relevant":true或false,"event_sig":"","is_duplicate":true或false,"dup_of":"","reason":"一句话"}' },
            { role: 'user', content: `标题：${title}\n正文：${excerpt.slice(0, 3000)}` },
          ],
          temperature: 0, maxTokens: 400, timeoutMs: 30000, maxAttempts: 1,
        });
        const j2 = JSON.parse(retryResp.replace(/```json\s*|\s*```/g, '').trim());
        return { relevant: Boolean(j2.relevant), eventSig: j2.event_sig || '', isDuplicate: Boolean(j2.is_duplicate), dupOf: j2.dup_of || '', reason: j2.reason || '' };
      } catch (_) {}
    }
    console.warn(`[AI] call failed (${msg}), using regex fallback`);
    const fallback = isArticleAboutBeauty(title, text);
    return { relevant: fallback, reason: fallback ? 'regex-pass' : 'regex-reject', eventSig: '', isDuplicate: false };
  }
}

// Step 5: AI review + build cards (4 concurrent calls)
const cards = [];
const reviews = [];
for (let i = 0; i < pool.length; i += 4) {
  const batch = pool.slice(i, i + 4);
  const results = await Promise.all(batch.map(async c => {
    const r = await aiReview(c.title || '', c.article_text || '');
    return { c, ...r };
  }));
  reviews.push(...results);
}

for (const { c, relevant, reason, isDuplicate, dupOf } of reviews) {
  if (!relevant) {
    console.log(`  SKIP [ai-not-beauty]: ${(reason||'').slice(0,50)} | ${(c.title||'').slice(0,30)}`);
    continue;
  }
  if (isDuplicate) {
    console.log(`  SKIP [ai-dup]: same as "${(dupOf||'').slice(0,40)}" | ${(c.title||'').slice(0,30)}`);
    continue;
  }
  const host = String(c.final_url || c.url || '');
  if (FORUM_HOSTS.test(host)) { console.log(`  SKIP [forum]: ${(c.title||'').slice(0,40)}`); continue; }

  const card = premiumCardFromCandidate({
    ...c, detail_status: 'hydrated',
    source_scope: c.source_scope || 'discovered_article',
  });
  const validation = validatePremiumEvidenceCard(card);
  if (!validation.accepted) {
    console.log(`  SKIP [${validation.reason}]: ${card.title.slice(0, 50)}`);
    continue;
  }

  const titleText = card.title || '';

  // Skip academic IP theory articles (not beauty-specific case law)
  if (ACADEMIC_IP_PATTERN.test(titleText)) {
    // Academic IP articles are only valid if they discuss specific beauty brands or products
    const beautyEvidence = (c.evidence_text || '') + ' ' + titleText;
    if (!/(?:化妆品|美妆|护肤|彩妆|香水|防晒|面膜|口红|精华液|欧莱雅|雅诗兰黛|珀莱雅|贝泰妮|花西子|完美日记|薇诺娜|华熙|上海家化|六神|相宜本草|自然堂|百雀羚|韩束)/i.test(beautyEvidence)) {
      console.log(`  SKIP [academic-ip]: ${card.title.slice(0, 50)}`);
      continue;
    }
  }

  // Skip weak cards
  if (WEAK_TITLE_PATTERN.test(titleText) && !/(?:处罚|罚款|召回|不合格|通告|公告|标准|法规|办法)/.test(titleText)) {
    console.log(`  SKIP [weak-content]: ${card.title.slice(0, 50)}`);
    continue;
  }

  console.log(`  OK  ${card.module.slice(0, 8)} | score=${validation.score} | ${card.title.slice(0, 40)}`);

  // AI polish: refine legal_signal and business_impact for action-tier cards
  if (validation.score >= 100 && aiKey) {
    try {
      const polishResp = await requestAiChat({
        apiKey: aiKey, baseUrl: aiBaseUrl, model: aiModel,
        messages: [
          { role: 'system', content: '润色以下法务情报卡片的两段文字，使其更自然专业。只润色表达，不改动任何事实、数据、主体名称、法律条款。输出纯JSON：{"legal_signal":"...","business_impact":"..."}' },
          { role: 'user', content: `模块：${card.module}\n原标题：${card.title}\n事实：${(card.facts||[]).join('；')}\n法务观察：${card.legal_signal}\n业务影响：${card.business_impact}` },
        ],
        temperature: 0.2, maxTokens: 500, timeoutMs: 30000, maxAttempts: 1,
      });
      const polished = JSON.parse(polishResp.replace(/```json\s*|\s*```/g, '').trim());
      if (polished.legal_signal && polished.legal_signal.length > 20) card.legal_signal = polished.legal_signal;
      if (polished.business_impact && polished.business_impact.length > 15) card.business_impact = polished.business_impact;
    } catch (_) { /* keep original if AI fails */ }
  }

    // Record in accepted list so subsequent AI calls can detect duplicates
  acceptedSummaries.push({
    title: card.title.slice(0, 60),
    facts: (card.facts || []).join('；').slice(0, 150),
    eventSig: reason.eventSig || '',
  });
  cards.push({ ...card, score: validation.score, tier: validation.tier, eventSig: reason.eventSig || '' });
}

// Step 6: Event dedup — one card per event
// Primary: AI-extracted eventSig (文号/案号/主体+日期)
// Fallback: hard-fact anchor matching (party + doc_number or party + amount + product)
const seenEvents = new Map();
function eventKey(card) {
  // AI-extracted signature takes priority
  const sig = (card.eventSig || '').trim();
  if (sig) return sig.replace(/\s+/g, '').toLowerCase();
  // Fallback: hard-fact anchors
  const hf = card.hard_facts || {};
  const party = (hf.involved_party || '').replace(/\s+/g, '');
  const doc = (hf.document_number || '').replace(/\s+/g, '');
  const amount = (hf.penalty_amount || '').replace(/\s+/g, '');
  if (party && doc) return (party + doc).toLowerCase();
  if (party && amount) return (party + amount).toLowerCase();
  // URL as last resort
  return (card.source_url || '').trim();
}
for (const card of cards) {
  const key = eventKey(card);
  if (!key) continue;
  const existing = seenEvents.get(key);
  if (!existing || (card.score || 0) > (existing.score || 0)) {
    seenEvents.set(key, card);
  }
}
const dedupedCards = [];
const dupEvents = new Set();
for (const card of cards) {
  const key = eventKey(card);
  if (key && seenEvents.has(key) && seenEvents.get(key) !== card) {
    dupEvents.add(key.slice(0, 30));
    continue;
  }
  dedupedCards.push(card);
}
console.log(`Event dedup: ${cards.length} → ${dedupedCards.length} cards (${dupEvents.size} duplicates removed)`);

// Step 7: Cross-week dedup — skip cards previously delivered
function cardFingerprint(card) {
  const hf = card.hard_facts || {};
  const party = (hf.involved_party || '').replace(/\s+/g, '').slice(0, 30);
  const doc = (hf.document_number || '').replace(/\s+/g, '').slice(0, 30);
  const title = (card.title || '').replace(/\s+/g, '').slice(0, 50);
  // Primary: party + document_number (most stable)
  if (party && doc) return (party + doc).toLowerCase();
  // Secondary: title prefix (catches cards with same content but different sources)
  return title.toLowerCase();
}
const freshCards = dedupedCards.filter(card => {
  const fp = cardFingerprint(card);
  if (previousFingerprints.has(fp)) {
    console.log(`  HISTORIC-DUP: ${card.title.slice(0, 40)}`);
    return false;
  }
  return true;
});
if (freshCards.length < dedupedCards.length) {
  console.log(`Cross-week dedup: ${dedupedCards.length} → ${freshCards.length} cards`);
}

// Step 8: Select balanced portfolio
const sorted = freshCards.sort((a, b) => b.score - a.score);
const selected = [];
const moduleCounts = new Map();
const seen = new Set();
const MODULES = ['新法律法规政策', '广告处罚案例', '知识产权保护或者侵权', '进出口', '产品质量/召回与安全风险', '美妆动态'];
const MODULE_MAP = {
  '新规及案例动态': '新法律法规政策', '广告合规及处罚案例': '广告处罚案例',
  '知识产权动态': '知识产权保护或者侵权', '进出口动态': '进出口',
  '产品质量/召回与安全风险': '产品质量/召回与安全风险',
};
const TARGET = 24;
const MIN_PER_MODULE = 2;
const MAX_PER_MODULE = 5;

// Normalize title for dedup: strip punctuation, common suffixes, whitespace
function dedupKey(card) {
  const url = (card.source_url || '').trim();
  const title = (card.title || '').replace(/[\s，,。；;：:｜|_\-\\/]/g, '').replace(/(?:搜狐|腾讯|网易|新浪|凤凰|QQ|头条|百度).*$/i, '').slice(0, 40).toLowerCase();
  return `${url}|${title}`;
}

for (const card of sorted) {
  const mod = MODULE_MAP[card.module] || card.module;
  const key = dedupKey(card);
  if (seen.has(key)) { console.log(`  DEDUP ${card.title.slice(0, 40)}`); continue; }
  if ((moduleCounts.get(mod) || 0) >= MAX_PER_MODULE) continue;
  if (selected.length >= TARGET) break;
  seen.add(key);
  moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
  selected.push({ ...card, module: mod });
}

// IP seed cases — persistent corpus of known beauty IP cases from broader time windows
// Injected when the discovery channel produces < 2 beauty-specific IP cards.
const IP_SEED_PATH = resolve('docs/quality/ip-seed-cases.json');
let ipSeedCases = [];
try {
  ipSeedCases = JSON.parse(readFileSync(IP_SEED_PATH, 'utf8'));
  console.log(`Loaded ${ipSeedCases.length} IP seed cases from ${IP_SEED_PATH}`);
} catch (err) {
  console.warn(`IP seed file not found or unreadable: ${err.message.slice(0, 80)}`);
}

// Validate and inject IP seed cases when IP module is underfilled
const ipSelected = selected.filter(c => (MODULE_MAP[c.module] || c.module) === '知识产权保护或者侵权');
if (ipSelected.length < MIN_PER_MODULE && ipSeedCases.length) {
  const now = new Date();
  for (const seed of ipSeedCases) {
    const seedDate = new Date(seed.published_at + 'T00:00:00Z');
    const daysAgo = (now - seedDate) / 86400000;
    if (daysAgo > 90) continue; // only recent-enough seed cases
    const card = premiumCardFromCandidate({
      ...seed, url: seed.source_url, final_url: seed.source_url,
      article_text: seed.evidence_text,
      detail_status: 'hydrated', source_scope: 'discovered_article',
      evidence_grade: 'hard_fact_ready',
    });
    const validation = validatePremiumEvidenceCard(card);
    if (!validation.accepted) {
      console.log(`  IP SEED SKIP [${validation.reason}]: ${seed.title.slice(0, 50)}`);
      continue;
    }
    const key = `${card.source_url}|${card.title}`.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    const mod = '知识产权保护或者侵权';
    if ((moduleCounts.get(mod) || 0) >= MAX_PER_MODULE) continue;
    moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
    selected.push({ ...card, module: mod, score: validation.score, tier: validation.tier });
    console.log(`  IP SEED + ${card.title.slice(0, 40)}`);
    if (ipSelected.length + 1 >= MIN_PER_MODULE) break;
  }
}

// Fill minimums — for IP module, re-classify ad-penalty cards with trademark/IP content
for (const mod of MODULES) {
  while ((moduleCounts.get(mod) || 0) < MIN_PER_MODULE && selected.length < TARGET) {
    const fallback = sorted.find(c => {
      const m = MODULE_MAP[c.module] || c.module;
      return m === mod && !seen.has(`${c.source_url}|${c.title}`.replace(/\s+/g, ''));
    });
    if (fallback) {
      seen.add(`${fallback.source_url}|${fallback.title}`.replace(/\s+/g, ''));
      moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
      selected.push({ ...fallback, module: mod });
      continue;
    }
    // Cross-module fill: ad-penalty cards with trademark/IP keywords → IP module
    if (mod === '知识产权保护或者侵权') {
      const crossCard = sorted.find(c => {
        const m = MODULE_MAP[c.module] || c.module;
        if (m !== '广告处罚案例') return false;
        const combined = `${c.title} ${c.legal_signal} ${c.evidence_text}`;
        if (!/商标|专利|著作权|冒用|假冒|仿冒|包装装潢/i.test(combined)) return false;
        return !seen.has(`${c.source_url}|${c.title}`.replace(/\s+/g, ''));
      });
      if (crossCard) {
        seen.add(`${crossCard.source_url}|${crossCard.title}`.replace(/\s+/g, ''));
        moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
        selected.push({ ...crossCard, module: mod });
        continue;
      }
    }
    break;
  }
}

// Build report
const sections = MODULES.map(mod => ({
  module: mod,
  items: selected.filter(c => (MODULE_MAP[c.module] || c.module) === mod),
}));

const report = { period, sections };
const audit = auditPremiumEvidenceCards(selected);
const markdown = buildPremiumDingTalkMarkdown({ period, cards: selected });

// Persist fingerprints for cross-week dedup — merge with existing
const mergedFingerprints = {};
// Keep existing card-level fingerprints
for (const fp of previousFingerprints) {
  mergedFingerprints[fp] = new Date().toISOString().slice(0, 10);
}
// Add this week's cards
for (const card of selected) {
  const fp = cardFingerprint(card);
  mergedFingerprints[fp] = new Date().toISOString().slice(0, 10);
}
writeFileSync(FINGERPRINTS_PATH, JSON.stringify(mergedFingerprints), 'utf8');
console.log(`Saved ${Object.keys(mergedFingerprints).length} fingerprints (${previousFingerprints.size} old + ${selected.length} new) to ${FINGERPRINTS_PATH}`);

writeFileSync(outputPath, JSON.stringify({ report, audit, cards: selected }, null, 2) + '\n');
writeFileSync(outputPath.replace('.json', '.md'), markdown, 'utf8');
// Overwrite the pipeline report so CI produces a single consolidated output
const mainMd = resolve('out', 'latest-report.md');
writeFileSync(mainMd, markdown, 'utf8');
writeFileSync(resolve('out', 'latest-report.json'), JSON.stringify({ report, audit, cards: selected }, null, 2) + '\n');

console.log(`\n=== FINAL ===`);
console.log(`Period: ${period.start} → ${period.end}`);
console.log(`Cards: ${selected.length}`);
sections.forEach(s => console.log(`  ${s.module}: ${s.items.length}`));
console.log(`Audit: ${audit.accepted}/${audit.input} accepted`);
console.log(`Wrote: ${outputPath.replace('.json', '.md')} → also ${mainMd}`);
