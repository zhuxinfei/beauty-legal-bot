// Direct card assembly from hydrated records.
// Code handles selection + fact extraction; templates generate narrative.
// Usage: node scripts/assemble-cards.js [hydrated-authority.json] [output.json]
import { readFileSync, writeFileSync } from 'node:fs';
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
  // Strip portal chrome and footer text that often contains "化妆品" in
  // site-navigation contexts but is not about cosmetics
  const cleaned = text.slice(0, 1000)
    .replace(/政府信息公开|法定主动公开|搜索位置|匹配度|发布日期|政府网站|站点地图|主办单位|通信地址|网站标识码|无障碍浏览/g, '')
    .replace(/当前位置|首页.*?(?=行政处罚|处罚决定|通告|公告)/g, '');
  const combined = `${title} ${cleaned}`;
  // Must have a beauty subject: specific product type, brand, or regulatory domain
  const hasBeautySubject = /(?:化妆品|美妆|护肤|彩妆|香水|防晒|染发|洗护|面膜|口红|眼影|粉底|睫毛|精华液|面霜|爽肤水|卸妆|洁面|美容|祛斑|美白|功效宣称|玻色因|配方|着色剂|进口化妆品|出口化妆品|化妆品标准|cosmetic|cosmetics|MoCRA)/i.test(combined);
  if (!hasBeautySubject) return false;
  // Exclude: the beauty keyword is only in a regulatory citation footer
  const withoutCitations = combined.replace(/化妆品监督管理条例|化妆品安全技术规范|化妆品标识管理规定|化妆品标签管理办法|化妆品注册备案管理办法/g, '');
  return /(?:化妆品|美妆|护肤|彩妆|香水|防晒|染发|洗护|面膜|口红|精华液|面霜|祛斑|美白)/i.test(withoutCitations);
}
const ACADEMIC_IP_PATTERN = /(?:损害赔偿请求权.*认定|.*实现路径|法理.*探析|.*制度研究)/i;
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

// Step 5: Build and validate cards
const cards = [];
for (const c of pool) {
  // Skip non-beauty upfront
  const combined = `${c.title || ''} ${c.article_text || ''}`;
  const host = String(c.final_url || c.url || '');
  if (FORUM_HOSTS.test(host)) { console.log(`  SKIP [forum-host]: ${(c.title||'').slice(0,40)}`); continue; }
  // Content-based beauty relevance: check the article body, not just the title.
  // Strips portal chrome and regulatory citations before checking.
  if (!isArticleAboutBeauty(c.title || '', c.article_text || '')) {
    console.log(`  SKIP [non-beauty]: ${(c.title||'').slice(0,40)}`);
    continue;
  }

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
  if (ACADEMIC_IP_PATTERN.test(titleText) && !/(?:化妆品|美妆|护肤|彩妆|香水|防晒|欧莱雅|雅诗兰黛|珀莱雅|贝泰妮|花西子|完美日记|薇诺娜|华熙生物|上海家化|六神|相宜本草)/i.test(titleText + (c.evidence_text || ''))) {
    console.log(`  SKIP [academic-ip]: ${card.title.slice(0, 50)}`);
    continue;
  }

  // Skip weak cards
  if (WEAK_TITLE_PATTERN.test(titleText) && !/(?:处罚|罚款|召回|不合格|通告|公告|标准|法规|办法)/.test(titleText)) {
    console.log(`  SKIP [weak-content]: ${card.title.slice(0, 50)}`);
    continue;
  }

  console.log(`  OK  ${card.module.slice(0, 8)} | score=${validation.score} | ${card.title.slice(0, 40)}`);
  cards.push({ ...card, score: validation.score, tier: validation.tier });
}

// Step 6: Select balanced portfolio
const sorted = cards.sort((a, b) => b.score - a.score);
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

for (const card of sorted) {
  const mod = MODULE_MAP[card.module] || card.module;
  const key = `${card.source_url || ''}|${card.title}`.replace(/\s+/g, '');
  if (seen.has(key)) continue;
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
