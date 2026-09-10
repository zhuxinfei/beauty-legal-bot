import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

// CI 模式：weekly.yml 在 assemble 之后、渲染 PDF 之前调用。
// 硬门槛：条目数 < REPORT_MIN_ITEMS（默认 15）→ 非零退出，阻止 PDF 与钉钉推送；
// 法规模块（新法律法规政策/广告处罚案例）不足 REPORT_MIN_LEGAL_ITEMS 时输出显著告警（不阻断）。
export function assertCiReportGate(payload = {}, { minItems = 15, minLegalItems = 2 } = {}) {
  const cards = Array.isArray(payload.cards) ? payload.cards : [];
  const byModule = {};
  for (const card of cards) {
    const module = String(card.module || '未分类');
    byModule[module] = (byModule[module] || 0) + 1;
  }
  const legalItems = (byModule['新法律法规政策'] || 0) + (byModule['广告处罚案例'] || 0);
  const summary = { items: cards.length, minItems, legalItems, minLegalItems, byModule };
  if (cards.length < minItems) {
    throw new Error(`CI quality gate failed: items=${cards.length} < ${minItems}；本期合格条目不足，按规则不推送。分布：${JSON.stringify(byModule)}`);
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
    const result = assertCiReportGate(payload, { minItems, minLegalItems });
    console.log(JSON.stringify(result, null, 2));
    if (result.legalItems < result.minLegalItems) {
      console.warn(`::warning::法规模块条目偏少：legal=${result.legalItems} < ${result.minLegalItems}（本期可能缺法律法规类内容，请检查法规源与闸门）`);
    }
    process.exit(0);
  }
  const result = assertReportQualityGate(payload.report || payload);
  console.log(JSON.stringify({ pass: result.pass, ...result.audit }, null, 2));
}
