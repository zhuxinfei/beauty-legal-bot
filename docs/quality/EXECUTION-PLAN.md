# Content quality execution plan

This file is the only execution checklist for the current repair.

## Completion rule

A module is complete only when at least two independent cards use the existing card structure and pass `validatePremiumEvidenceCard`. Search results, resolved URLs, hydrated pages, and editorial acceptance are evidence inputs, not completion.

The portfolio is complete only when `npm run quality:gate -- <report.json>` passes with:

- a reporting period of no more than 15 days;
- 20-24 unique cards;
- all six modules represented by 2-5 cards;
- every card passing the existing premium validator.

Do not run the full remote pipeline until the local portfolio gate passes. Debug mode may bypass historical KV dedupe only; it may not bypass card, module, count, language, completeness, or duplicate gates.

## Checklist

- [x] Lock the product contract and existing card structure.
- [x] Repair URL cleanup, detail scheduling, attachment hydration, and candidate-pool omissions.
- [x] Record discovery query failures and per-candidate rejection reasons.
- [ ] Produce and validate at least two complete beauty-dynamics cards.
- [ ] Produce and validate at least two complete beauty IP cards.
- [ ] Produce and validate at least two complete quality/recall/safety cards.
- [ ] Produce and validate at least two complete import/export cards.
- [ ] Build a balanced local portfolio of 20-24 cards.
- [ ] Pass Chinese, completeness, fragment, translation, relevance, and duplicate checks.
- [ ] Pass the local quality gate.
- [ ] Pass two `no_delivery` pipeline runs.
- [ ] Show the final preview for user approval before real delivery.
