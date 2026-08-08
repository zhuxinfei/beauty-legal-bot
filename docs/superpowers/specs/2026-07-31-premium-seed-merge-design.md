# Premium Seed Merge Design

## Goal

Keep the current premium-card quality floor while allowing the formal quality pipeline to add qualified items from other legal-intelligence modules.

## Problem

Quality mode currently enables hard-fact direct delivery by default. As soon as a few `hard_fact_ready` candidates produce cards, the pipeline sends them and returns before AI analysis runs. The latest formal run therefore delivered three qualified policy cards but never considered the remaining editorial candidates for the same report.

## Design

- `hard_fact_ready` means source material is eligible for analysis and final backfill. It is not permission to end a formal quality run early.
- Formal quality runs always continue through module analysis.
- Qualified hard-fact candidates remain in `premiumCandidates`; `buildPremiumDingTalkDelivery` merges them with qualified report cards and deduplicates by source URL and title.
- Explicit `HARD_FACT_DIRECT_DELIVERY=1` remains available for a deliberately requested direct-only run.
- No quality validator, source-authority rule, sample-grade rule, or maximum item limit is relaxed.
- Category diversity is obtained only from qualified cards. Empty categories are never filled with weak information.

## Acceptance

- Quality mode alone does not enable hard-fact direct delivery.
- Explicit `HARD_FACT_DIRECT_DELIVERY=1` still enables direct delivery.
- Premium delivery keeps qualified hard-fact candidates and qualified report cards together.
- Existing broken-fragment, navigation-page, source, date, China, and hard-fact tests pass.
- The complete worker test suite passes before the change is pushed.

