// Direct card assembly from hydrated records.
// Code handles selection + fact extraction; AI handles only narrative fields.
// Usage: AI_API_KEY=xxx node scripts/assemble-cards.js [hydrated-authority.json] [output.json]
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

// Step 1: Normalize and grade all records
console.log(`Normalizing ${rawRecords.length} records...`);
const records = rawRecords
  .map(r => normalizeHydratedRecord(r))
  .filter(r => {
    const text = r.article_text || '';
    return text.length > 100; // must have substantive text
  });

// Step 2: Pre-clean text then extract hard facts and grade evidence
console.log(`Extracting hard facts from ${records.length} records...`);
const WEAK_TITLE_PATTERN = /(?:举办|召开|培训|会议|活动|论坛|调研|考察|检查指导|工作部署)/;
const candidates = records.map(r => {
  // Pre-clean: strip common portal chrome from article text before extraction
  const cleanedText = cleanArticleEvidence(r.article_text || '')
    .replace(/化妆品审评\s*国家抽检管理\s*医疗器械标准与分类管理.*/g, '')
    .replace(/访问我的专属空间.*/g, '')
    .replace(/\s*智能问答\s*["'].*["'].*/g, '')
    .replace(/无障碍\s*关怀版\s*繁體.*/g, '')
    .replace(/办理流程\s*立案→调查取证→审查→告知→决定→送达→执行/g, '')
    .replace(/返回首页\s*页面放大\s*页面缩小.*/g, '')
    .replace(/移动版\s*本站查询.*/g, '')
    .replace(/主要职责\s*基本信息\s*领导介绍\s*机构设置.*/g, '')
    .replace(/缴纳情况\s*\d{4}年\d{1,2}月\d{1,2}日已缴纳.*/g, '')
    .replace(/\s{2,}/g, ' ');
  const facts = extractHardFacts(cleanedText, {
    title: r.title,
    source_name: r.source_name || r.name,
    source_url: r.final_url || r.url,
    module: r.module,
    country: r.country || r.region,
  });
  const grade = gradeEvidence({
    text: cleanedText,
    hard_facts: facts,
    source_url: r.final_url || r.url,
    title: r.title,
    source_name: r.source_name || r.name,
    country: r.country || r.region,
  });
  return { ...r, article_text: cleanedText, hard_facts: facts, evidence_grade: grade.evidence_grade, evidence_reason: grade.evidence_reason };
});

// Step 3: Corroborate multi-source events
const corroboration = corroborateEvidenceCandidates(candidates);
console.log(`Corroboration: ${corroboration.audit.records} records → ${corroboration.audit.events} events (${corroboration.audit.corroborated} corroborated, ${corroboration.audit.primaryVerified} primary)`);

// Step 4: Build premium cards from hard_fact_ready candidates
let hardFactPool = [...corroboration.candidates, ...candidates.filter(c =>
  ['hard_fact_ready'].includes(c.evidence_grade) && !corroboration.candidates.some(cc => cc.url === c.url)
)];
console.log(`Hard fact pool: ${hardFactPool.length} candidates`);

// Step 5: Generate narrative fields via AI for each card
const cards = [];
for (const c of hardFactPool) {
  const card = premiumCardFromCandidate({
    ...c,
    detail_status: 'hydrated',
    source_scope: c.source_scope || 'discovered_article',
  });
  const validation = validatePremiumEvidenceCard(card);

  if (!validation.accepted) {
    console.log(`  SKIP [${validation.reason}]: ${card.title.slice(0, 50)}`);
    continue;
  }

  // Skip weak cards: meeting notices, training events, inspection tours
  const titleText = card.title || '';
  if (WEAK_TITLE_PATTERN.test(titleText) && !/(?:处罚|罚款|召回|不合格|通告|公告|标准|法规|办法)/.test(titleText)) {
    console.log(`  SKIP [weak-content]: ${card.title.slice(0, 50)}`);
    continue;
  }

  console.log(`  OK  ${card.module.slice(0, 8)} | ${card.title.slice(0, 40)}`);

  // Re-validate after AI enhancement
  const recheck = validatePremiumEvidenceCard(card);
  if (recheck.accepted) {
    cards.push({ ...card, score: recheck.score, tier: recheck.tier });
  }
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

for (const card of sorted) {
  const mod = MODULE_MAP[card.module] || card.module;
  const key = `${card.source_url || ''}|${card.title}`.replace(/\s+/g, '');
  if (seen.has(key)) continue;
  if ((moduleCounts.get(mod) || 0) >= 5) continue;
  if (selected.length >= 24) break;
  seen.add(key);
  moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
  selected.push({ ...card, module: mod });
}

// Fill minimums: each module at least 2
for (const mod of MODULES) {
  while ((moduleCounts.get(mod) || 0) < 2 && selected.length < 24) {
    const fallback = sorted.find(c => {
      const m = MODULE_MAP[c.module] || c.module;
      return m === mod && !seen.has(`${c.source_url}|${c.title}`.replace(/\s+/g, ''));
    });
    if (!fallback) break;
    const key = `${fallback.source_url}|${fallback.title}`.replace(/\s+/g, '');
    seen.add(key);
    moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
    selected.push({ ...fallback, module: mod });
  }
}

// Build final report
const sections = MODULES.map(mod => ({
  module: mod,
  items: selected.filter(c => (MODULE_MAP[c.module] || c.module) === mod),
}));

const report = {
  period: { start: '2026-07-23', end: '2026-08-06' },
  sections,
};

const audit = auditPremiumEvidenceCards(selected);
const markdown = buildPremiumDingTalkMarkdown({ period: report.period, cards: selected });

writeFileSync(outputPath, JSON.stringify({ report, audit, cards: selected, markdown }, null, 2) + '\n');
writeFileSync(outputPath.replace('.json', '.md'), markdown, 'utf8');

console.log(`\n=== FINAL ===`);
console.log(`Total: ${selected.length} cards`);
sections.forEach(s => console.log(`  ${s.module}: ${s.items.length}`));
console.log(`Audit: ${audit.accepted}/${audit.input} accepted`);
console.log(`Markdown: ${outputPath.replace('.json', '.md')}`);
