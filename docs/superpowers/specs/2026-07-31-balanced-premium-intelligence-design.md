# Balanced Premium Beauty Legal Intelligence Design

## Objective

Produce one DingTalk report containing 18-22 evidence-backed beauty legal intelligence cards. Every report must cover all six supported modules, with at least two accepted cards per module. Quantity must come from broader and better-targeted acquisition, never from weaker final quality gates.

## Product Contract

The six required modules are:

1. New laws, regulations, and policies
2. Advertising compliance and enforcement
3. Intellectual property protection and infringement
4. Product quality, recalls, and safety risks
5. Import and export
6. Beauty ecommerce and platform legal developments

A normal DingTalk delivery is valid only when:

- final card count is between 18 and 22;
- every module contains at least two cards;
- no module contains more than five cards;
- every card passes the existing premium evidence, hard-fact, freshness, beauty relevance, language, and DingTalk formatting gates;
- duplicate reports, duplicate events, syndicated copies, navigation pages, promotional pages, and unsupported claims remain rejected.

If the contract is not met after bounded recovery, the workflow must fail with a category audit and must not send an incomplete normal report.

## Acquisition Architecture

Each module owns an independent discovery lane. A lane has its own query matrix, source families, acquisition budget, Crawl4AI hydration budget, evidence validation, and candidate floor. Candidates are not pooled until every lane has completed acquisition, so regulation candidates cannot consume the budgets of other modules.

Each query matrix combines:

- event terms specific to the module;
- beauty product and channel terms;
- authority and source-specific queries, including regulator, court, customs, recall database, and platform domains;
- Chinese and international queries;
- product synonyms such as cosmetics, skincare, fragrance, sunscreen, hair dye, personal care, and beauty ecommerce.

Search titles are used only to reject obvious spam and promotion. Beauty and legal relevance are decided from query provenance, title, snippet, and Crawl4AI article text together. A title is not rejected merely because it omits a beauty keyword.

## Source Strategy

Evidence priority is:

1. Government, regulator, court, customs, and official databases
2. Official platform, retailer, brand, and recall notices
3. Reputable secondary reporting supported by two independent hosts and matching event anchors
4. Lead-only sources, which can start discovery but cannot enter the report

Crawl4AI hydrates every candidate that can reach formal review. Discovery metadata and module provenance must survive URL resolution, hydration, corroboration, AI extraction, and final delivery.

## Bounded Recovery

The first pass searches the most recent 14 days. For any module below its candidate floor, recovery performs additional source-specific queries and widens only that module to 30 days. Older cards retain their actual publication dates and the report period reflects the effective acquisition window.

Per module, acquisition targets are:

- at least 15 discovered leads;
- at least 8 resolved original URLs;
- at least 5 successful article hydrations;
- at least 3 evidence-eligible candidates before AI review;
- at least 2 final premium cards.

These are acquisition and delivery floors, not permission to weaken evidence requirements.

## Evidence Contracts

Each module has a deterministic minimum fact bundle:

- Regulations: authority, document or rule, concrete change, and effective date, deadline, or transition arrangement.
- Advertising enforcement: authority, named party, conduct, product or channel, and penalty, disposition, or legal basis.
- Intellectual property: parties, right type, disputed conduct, product or brand asset, and judgment, penalty, or disposition.
- Quality and recall: authority or recalling party, product or batch, identified risk, date, and recall, withdrawal, warning, or testing result.
- Import and export: jurisdiction or port, product, customs or market-access measure, date, and operational import/export consequence.
- Ecommerce and platform developments: official platform or authority, affected beauty sellers or products, concrete rule or enforcement change, effective date or rollout node, and affected workflow.

AI may structure and summarize only evidence already present in the acquired article. It cannot supply a missing hard fact.

## Selection

Final selection runs in two stages:

1. Select the best two premium cards from every module.
2. Fill remaining slots up to the target of 20 using score, freshness, China relevance, business impact, and source strength, while enforcing the five-card module cap.

No module can displace another module's two-card floor. Event-level deduplication runs before and after selection.

## Audit And Failure Behavior

Every workflow prints and stores this table:

`module | search results | resolved URLs | hydrated articles | evidence eligible | AI accepted | final cards | rejection reasons`

The workflow fails before delivery when:

- any module has fewer than two final cards;
- total final cards are fewer than 18 or more than 22;
- any final card fails the premium quality validator;
- category metadata is missing or changed during the pipeline;
- the report contains a duplicate event or unsupported secondary-source claim.

## Verification

Automated fixtures must cover at least three valid and three invalid examples for every module. Tests must prove:

- title-only beauty filtering no longer removes query-backed relevant articles;
- each lane retains its own acquisition and AI budget;
- Crawl4AI evidence and category metadata survive end to end;
- weak cards cannot satisfy a category floor;
- portfolio selection produces 18-22 cards with all six modules when valid fixtures are available;
- underfilled or single-category reports fail without DingTalk delivery;
- existing sample-grade output tests remain unchanged and pass.

Production acceptance requires three consecutive manually triggered Actions runs to satisfy the product contract. A successful unit test alone is not evidence that production quantity has been achieved.
