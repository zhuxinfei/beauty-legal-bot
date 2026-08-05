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

At runtime, a missing or underfilled module must not suppress valid cards from other modules. The runtime may publish a partial portfolio with an explicit shortfall, while the local product-completion gate remains strict at 20-24 cards.

## Checklist

- [x] Lock the product contract and existing card structure.
- [x] Repair URL cleanup, detail scheduling, attachment hydration, and candidate-pool omissions.
- [x] Record discovery query failures and per-candidate rejection reasons.
- [x] Fix the Google News RSS discovery channel: undici fetch is TLS-throttled by
      Google (all queries timed out), curl completes in seconds. Verified live:
      12 queries -> 67 raw -> 38 unique candidates. (`scripts/discover-open-web.js`)
- [x] Produce and validate at least two complete beauty-dynamics cards.
      Persisted in `docs/quality/local-portfolio.json` (维琪科技北交所挂牌上市,
      山东花物堂/半亩花田港股上市申请失效; both corroborated, pass
      `validatePremiumEvidenceCard`).
- [x] Produce and validate at least two complete beauty IP cards.
      Persisted in portfolio: 欧莱雅诉盒马商标侵权 (score=157, corroborated,
      浦东法院案号(2026)沪0115民初61781号) and 六神诉广州化妆品公司仿冒装潢案
      (score=144, 上海虹口法院判赔25万). Both pass `validatePremiumEvidenceCard`.
      Fixed `firstEvidenceSentence` to skip generic intros with `引发关注`-style
      phrases. Added `人民法院`/`中级法院` to hard-fact authority patterns.
- [x] Produce and validate at least two complete quality/recall/safety cards.
      Persisted: 南阳古法护肤品违规添加禁用原料案 (score=172,
      央视曝光+政府联合调查组通报) and 韩国Medicube面霜检出苏丹红案
      (score=149, 香港海关安全警示). Both pass `validatePremiumEvidenceCard`.
- [ ] Produce and validate at least two complete import/export cards.
- [ ] Build a balanced local portfolio of 20-24 cards.
- [ ] Pass Chinese, completeness, fragment, translation, relevance, and duplicate checks.
- [ ] Pass the local quality gate.
- [ ] Pass two `no_delivery` pipeline runs.
- [ ] Show the final preview for user approval before real delivery.
