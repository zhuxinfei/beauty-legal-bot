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
const NON_BEAUTY_PATTERN = /(?:五金|建材|食品|餐饮|农产品|食用|汽车|电动|机票|酒店|房地产|医疗器械(?!.*化妆品)|药品集采|保险|银行|在线酒店|旅游行业|金融监管|证券|外汇|教育培训)/i;
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
];
console.log(`Candidate pool: ${pool.length} records`);

// Step 5: Build and validate cards
const cards = [];
for (const c of pool) {
  // Skip non-beauty upfront
  const combined = `${c.title || ''} ${c.article_text || ''}`;
  const host = String(c.final_url || c.url || '');
  if (FORUM_HOSTS.test(host)) { console.log(`  SKIP [forum-host]: ${(c.title||'').slice(0,40)}`); continue; }
  if (NON_BEAUTY_PATTERN.test(combined) && !BEAUTY_PATTERN.test(combined)) { console.log(`  SKIP [non-beauty]: ${(c.title||'').slice(0,40)}`); continue; }

  const card = premiumCardFromCandidate({
    ...c, detail_status: 'hydrated',
    source_scope: c.source_scope || 'discovered_article',
  });
  const validation = validatePremiumEvidenceCard(card);
  if (!validation.accepted) {
    console.log(`  SKIP [${validation.reason}]: ${card.title.slice(0, 50)}`);
    continue;
  }

  // Skip weak cards
  const titleText = card.title || '';
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

// Fill minimums
for (const mod of MODULES) {
  while ((moduleCounts.get(mod) || 0) < MIN_PER_MODULE && selected.length < TARGET) {
    const fallback = sorted.find(c => {
      const m = MODULE_MAP[c.module] || c.module;
      return m === mod && !seen.has(`${c.source_url}|${c.title}`.replace(/\s+/g, ''));
    });
    if (!fallback) break;
    seen.add(`${fallback.source_url}|${fallback.title}`.replace(/\s+/g, ''));
    moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
    selected.push({ ...fallback, module: mod });
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

console.log(`\n=== FINAL ===`);
console.log(`Period: ${period.start} → ${period.end}`);
console.log(`Cards: ${selected.length}`);
sections.forEach(s => console.log(`  ${s.module}: ${s.items.length}`));
console.log(`Audit: ${audit.accepted}/${audit.input} accepted`);
console.log(`Assembled: ${outputPath.replace('.json', '.md')}`);
