// Replay raw pages through the evidence pipeline and validate premium cards.
// Usage: node scripts/replay-cards.js <input.json> [output.json]
// Input: { period: {start,end}, pages: [{ title, url, article_text, published_at,
//   module, country, region, source_type, authority_type, source_name }] }
// Output: { period, audit, candidates, accepted: [cards] }
import { readFileSync, writeFileSync } from 'node:fs';
import { extractHardFacts, gradeEvidence } from '../worker/hard-fact-extractor.js';
import { corroborateEvidenceCandidates } from '../worker/evidence-corroboration.js';
import {
  buildPremiumDingTalkDelivery,
  premiumCardFromCandidate,
  validatePremiumEvidenceCard,
} from '../worker/premium-quality.js';

const inputPath = process.argv[2];
const outputPath = process.argv[3] || 'out/replay-output.json';
const payload = JSON.parse(readFileSync(inputPath, 'utf8'));

const records = payload.pages.map(page => {
  const textSource = String(page.article_text || page.fit_markdown || '').trim();
  const facts = extractHardFacts(textSource, {
    title: page.title,
    source_name: page.source_name || page.name,
    source_url: page.url,
    module: page.module,
    country: page.country || page.region,
  });
  const grade = gradeEvidence({
    text: textSource,
    hard_facts: facts,
    source_url: page.url,
    title: page.title,
    source_name: page.source_name || page.name,
    country: page.country || page.region,
  });
  return {
    ...page,
    url: page.url,
    final_url: page.url,
    article_text: textSource,
    hard_facts: facts,
    evidence_grade: grade.evidence_grade,
    evidence_reason: grade.evidence_reason,
    evidence_quotes: grade.evidence_quotes || {},
  };
});

const corroboration = corroborateEvidenceCandidates(records);
const candidates = corroboration.candidates.map(candidate => ({
  ...candidate,
  module: candidate.module || '美妆动态',
  source_scope: candidate.source_scope || 'discovered_article',
  detail_status: candidate.detail_status || 'hydrated',
}));

const delivery = buildPremiumDingTalkDelivery(
  { period: payload.period || {}, sections: [] },
  {
    candidates,
    maxItems: 24,
    minimumItems: 1,
    maximumItems: 24,
    minimumPerModule: 1,
    maximumPerModule: 5,
    logCandidateAudit: true,
    allowSourceOnlyFallback: false,
  }
);

// Module-completion rule per docs/quality/EXECUTION-PLAN.md: a card passes
// when validatePremiumEvidenceCard accepts it, independent of the stricter
// portfolio selection path (isSampleGradeCard).
const decisions = candidates.map(candidate => {
  const card = premiumCardFromCandidate(candidate);
  return { candidate, card, decision: validatePremiumEvidenceCard(card) };
});
const passing = decisions.filter(({ decision }) => decision.accepted);
const portfolioCards = delivery.cards.map(card => ({ ...card, _validation: validatePremiumEvidenceCard(card) }));

const result = {
  period: payload.period || {},
  corroboration: {
    records: corroboration.audit.records,
    events: corroboration.audit.events,
    primaryVerified: corroboration.audit.primaryVerified,
    corroborated: corroboration.audit.corroborated,
    unverified: corroboration.audit.unverified,
  },
  packages: corroboration.packages,
  audit: {
    finalItems: delivery.audit.finalItems,
    finalItemsByModule: delivery.audit.finalItemsByModule,
    missingModules: delivery.audit.missingModules,
    portfolioSelectable: delivery.audit.selectablePortfolioItems,
  },
  passingCards: passing.map(({ card, decision }) => ({ card, score: decision.score, tier: decision.tier })),
  portfolioCards,
  rejectedCandidates: decisions
    .filter(({ decision }) => !decision.accepted)
    .map(({ candidate, decision }) => ({
      title: candidate.title,
      url: candidate.url,
      module: candidate.module,
      evidence_grade: candidate.evidence_grade,
      verification_status: candidate.verification_status,
      reject_reason: decision.reason,
    })),
};

writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
console.log(`records=${corroboration.audit.records}, events=${corroboration.audit.events}, corroborated=${corroboration.audit.corroborated}`);
console.log(`passing(validatePremiumEvidenceCard)=${passing.length}, portfolio(delivery)=${portfolioCards.length}`);
for (const { card, decision } of passing) {
  console.log(`  PASS score=${decision.score} tier=${decision.tier} ${card.module} | ${card.title} | ${card.source_url}`);
}
for (const { candidate, decision } of decisions.filter(({ decision }) => !decision.accepted)) {
  console.log(`  REJECT ${decision.reason}: ${candidate.module} | ${candidate.title}`);
}
