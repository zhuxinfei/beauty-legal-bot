import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertPremiumPortfolioDelivery,
  buildPremiumDingTalkDelivery,
  validatePremiumEvidenceCard,
} from '../worker/premium-quality.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function assertFifteenDayPeriod(period = {}) {
  const start = Date.parse(`${period.start || ''}T00:00:00Z`);
  const end = Date.parse(`${period.end || ''}T00:00:00Z`);
  const days = Number.isFinite(start) && Number.isFinite(end) ? Math.floor((end - start) / DAY_MS) + 1 : 0;
  if (days < 1 || days > 15) throw new Error(`Quality gate period failed: days=${days}, required=1-15`);
}

export function assertReportQualityGate(report = {}) {
  assertFifteenDayPeriod(report.period);
  const delivery = buildPremiumDingTalkDelivery(report, {
    maxItems: 24,
    targetItems: 20,
    minimumItems: 20,
    maximumItems: 24,
    minimumPerModule: 2,
    maximumPerModule: 5,
  });
  assertPremiumPortfolioDelivery(delivery.audit, {
    minimumItems: 20,
    maximumItems: 24,
    minimumPerModule: 2,
  });
  const rejected = delivery.cards
    .map(card => validatePremiumEvidenceCard(card))
    .filter(decision => !decision.accepted);
  if (rejected.length) {
    throw new Error(`Quality gate card validation failed: ${rejected.map(item => item.reason).join(',')}`);
  }
  const identities = new Set(delivery.cards.map(card => `${card.source_url}|${card.title}`));
  if (identities.size !== delivery.cards.length) {
    throw new Error(`Quality gate duplicate failed: unique=${identities.size}, cards=${delivery.cards.length}`);
  }
  return { pass: true, audit: delivery.audit, cards: delivery.cards };
}

// 正文残留标记：导航/页脚/门户组件——出现即说明该条目的证据文本不干净
const JUNK_MARKERS = [
  /您的位置/, /首页\s*>/, /分享到/, /扫一扫/, /人才队伍/, /院务动态/,
  /主办单位/, /版权所有/, /网站标识码/, /ICP备/, /无障碍/, /返回首页/,
  /打印本页/, /网页设置/, /正在浏览[:：]/, /微信里点/,
];
const REQUIRED_CARD_FIELDS = ['title', 'source_url', 'module', 'legal_signal', 'business_impact', 'recommended_action'];

// CI 模式：weekly.yml 在 assemble 之后、渲染 PDF 之前调用。
// 硬门槛（非零退出，阻止 PDF 与钉钉推送）：条目数 < REPORT_MIN_ITEMS、字段缺失、重复条目；
// 告警（不阻断，输出 ::warning:: 并写入质检报告）：正文残留导航、模块覆盖过窄、
// 事实要点过少、法规模块条目不足。
// 核心类目：承载实质法律/监管内容的模块。美妆动态属行业新闻，不计入硬门槛，
// 因此核心数 ≈ 总量 - 美妆动态，硬门槛实际等价于「总量下限」。
export const CORE_MODULES = [
  '新法律法规政策',
  '广告处罚案例',
  '知识产权保护或者侵权',
  '进出口',
  '产品质量/召回与安全风险',
];

export function assertCiReportGate(payload = {}, { minItems = 15, minLegalItems = 2, minCoreItems = 8 } = {}) {
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  const byModule = {};
  for (const card of cards) {
    const module = String(card.module || '未分类');
    byModule[module] = (byModule[module] || 0) + 1;
  }
  const legalItems = (byModule['新法律法规政策'] || 0) + (byModule['广告处罚案例'] || 0);
  const coreItems = cards.filter(card => CORE_MODULES.includes(String(card.module || ''))).length;

  const problems = [];
  const warnings = [];
  cards.forEach((card, index) => {
    const label = `${index + 1}.${String(card.title || '').slice(0, 40)}`;
    for (const field of REQUIRED_CARD_FIELDS) {
      if (!String(card[field] || '').trim()) problems.push(`missing-${field}: ${label}`);
    }
    if (!Array.isArray(card.facts) || card.facts.length === 0) problems.push(`missing-facts: ${label}`);
  });
  const identities = new Map();
  for (const card of cards) {
    const key = `${String(card.source_url || '').toLowerCase()}|${String(card.title || '').replace(/\s+/g, '')}`;
    identities.set(key, (identities.get(key) || 0) + 1);
  }
  for (const [key, count] of identities) {
    if (count > 1) problems.push(`duplicate-card x${count}: ${key.slice(0, 80)}`);
  }
  const junkFindings = [];
  cards.forEach((card, index) => {
    // 只扫描读者可见字段（标题/事实要点/法务观察/业务影响/行动建议）：
    // 媒体页正文里的门户组件会残留在 evidence_text，但不进入成品，不算输出质量缺陷。
    const blob = [
      card.title,
      (card.facts || []).join(' '),
      card.legal_signal,
      card.business_impact,
      card.recommended_action,
    ].filter(Boolean).join(' ');
    const hits = JUNK_MARKERS.filter(pattern => pattern.test(blob)).length;
    if (hits > 0) junkFindings.push(`${index + 1}.${String(card.title || '').slice(0, 32)}(junk=${hits})`);
  });
  if (junkFindings.length) warnings.push(`evidence-junk: ${junkFindings.join(' | ')}`);
  const moduleCount = Object.keys(byModule).length;
  if (moduleCount < 4) warnings.push(`module-coverage=${moduleCount}（少于 4 个模块）`);
  const thinFacts = cards.filter(card => !Array.isArray(card.facts) || card.facts.length < 2).length;
  if (thinFacts) warnings.push(`thin-facts=${thinFacts}（facts 少于 2 条）`);
  if (legalItems < minLegalItems) warnings.push(`legal-items=${legalItems}（低于 ${minLegalItems}）`);

  const summary = { items: cards.length, minItems, coreItems, minCoreItems, legalItems, minLegalItems, modules: moduleCount, byModule, warnings, problems };
  // 硬门槛：核心类目过少说明本期供给太差，不值得占用一次投递名额。
  if (coreItems < minCoreItems) {
    throw new Error(`CI quality gate failed: coreItems=${coreItems} < ${minCoreItems}；核心类目（法规/处罚/知产/进出口/质量）不足，按规则不推送。分布：${JSON.stringify(byModule)}`);
  }
  // 软门槛：总量不足不再阻断整期，改为告警 + 报告内标注。
  // 历史最好成绩正好 15 条（= 原硬门槛），零余量导致任何扰动即整期断供。
  if (cards.length < minItems) {
    warnings.push(`low-supply: items=${cards.length} < ${minItems}（分级门槛放行，报告内已标注）`);
  }
  if (problems.length) {
    throw new Error(`CI quality gate failed: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? ` 等 ${problems.length} 项` : ''}`);
  }
  return { pass: true, ...summary };
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const args = process.argv.slice(2);
  const ciMode = args.includes('--ci');
  const input = args.find(arg => !arg.startsWith('--'));
  if (!input) throw new Error('Usage: node scripts/quality-gate.js [--ci] <report.json>');
  const payload = JSON.parse(readFileSync(resolve(input), 'utf8'));
  if (ciMode) {
    const minItems = Number(process.env.REPORT_MIN_ITEMS || 15);
    const minLegalItems = Number(process.env.REPORT_MIN_LEGAL_ITEMS || 2);
    const minCoreItems = Number(process.env.REPORT_MIN_CORE_ITEMS || 8);
    const result = assertCiReportGate(payload, { minItems, minLegalItems, minCoreItems });
    // 质检报告写入 out/，随 CI 产物一起上传，便于回查本期输出质量
    writeFileSync(join(dirname(resolve(input)), 'quality-report.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify(result, null, 2));
    for (const warning of result.warnings) console.warn(`::warning::${warning}`);
    process.exit(0);
  }
  const result = assertReportQualityGate(payload.report || payload);
  console.log(JSON.stringify({ pass: result.pass, ...result.audit }, null, 2));
}
