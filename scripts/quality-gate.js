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

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: npm run quality:gate -- <report.json>');
  const payload = JSON.parse(readFileSync(resolve(input), 'utf8'));
  const result = assertReportQualityGate(payload.report || payload);
  console.log(JSON.stringify({ pass: result.pass, ...result.audit }, null, 2));
}
