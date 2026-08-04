# Weekly Beauty Legal Intelligence Product Repair Design

## Goal

Every weekly run must produce a DingTalk-ready report with at least 20 distinct, recent, evidence-backed beauty legal intelligence items that are useful to in-house legal professionals and legal managers.

## Product Contract

The report covers six modules:

1. New laws, regulations, policies, standards, and regulatory interpretation
2. Advertising compliance and enforcement cases
3. Intellectual property protection and infringement
4. Import and export, customs, and market access
5. Product quality, recalls, testing, and safety risks
6. Beauty ecommerce, platform governance, and material industry compliance developments

The existing item structure and display order are preserved exactly:

`标题 -> 来源 -> 事实依据 -> 法务观察 -> 业务影响 -> 下一步观察建议`

This repair does not add, remove, rename, or reorder displayed fields. Any future structural change requires a real before/after sample to be shown for user approval before implementation.

The normal delivery gate is:

- final item count is at least 20; the selector uses at most 24 items for a readable weekly message;
- every module has at least 2 items and no module has more than 5;
- every item has one canonical HTTP(S) original URL, a valid publication or update date, and a beauty-specific event;
- every item contains at least two independently extracted hard facts that are traceable to the acquired source text;
- every item states the legal or regulatory signal, affected business process, and a concrete next action or observation point with an appropriate owner or deadline when the source provides one;
- Chinese is the display language. English source titles and substantive fields are translated or summarized into Chinese before delivery, while names, document numbers, product names, and legal citations may retain the original form alongside Chinese;
- duplicate URLs, syndicated copies, navigation pages, topic pages, generic homepages, promotional content, food-only cases, malformed dates, shell text, and fabricated facts are rejected;
- the exact Markdown used for quality validation, the saved artifact, and the DingTalk payload is the same string.

Deduplication has two explicit modes:

- Debug mode may allow repeated items so acquisition, quality, translation, and module coverage can be verified without historical state hiding regressions.
- Normal delivery must deduplicate against prior delivered events and within the current report. After the product contract is proven in debug runs, the historical deduplication state will be reset and normal deduplication will be re-enabled according to the user's release instruction.

If the bounded acquisition and recovery process cannot meet the gate, the run must not send an incomplete normal report. It must emit a compact shortage audit by module and rejection reason.

## Root Causes To Address

The current run has enough raw volume but loses the product contract in later stages: a recent run had 386 candidates, 311 freshness-accepted candidates, 107 successful detail hydrations, but only 24 editorially accepted candidates. The AI input was already skewed to 16 regulation, 3 import/export, and 1 quality candidate, with no usable advertising, IP, or beauty-dynamics lane. The final report therefore cannot contain those modules, regardless of prompt quality.

The repair therefore addresses supply balance, detail-page selection, deterministic hard-fact extraction, module preservation, multilingual rendering, duplicate event identity, and final portfolio selection together. Access-controlled sites remain restricted sources; the system may use ordinary public HTTP and browser rendering, but does not bypass login, CAPTCHA, paywalls, or access controls.

## Acquisition And Data Flow

Each module owns an acquisition lane with:

- a query matrix containing Chinese and English event terms, beauty product synonyms, and authority/source-specific terms;
- an independent discovery, resolution, hydration, and analysis budget;
- a minimum candidate floor before the global pool is assembled;
- a recovery pass limited to the deficient module, widening freshness from 15 to 30 days only when needed and preserving the actual date in the report.

The pipeline records the following counts per module:

`discovered -> resolved_original -> hydrated_with_substantive_text -> hard_fact_ready -> editorial_accepted -> AI_accepted -> premium_selectable -> final`

Candidates are routed using discovery provenance first and article evidence second. A regulation keyword cannot turn an IP, recall, advertising, or platform event into a regulation item. The AI receives module-specific batches and cannot create an item without a candidate identifier and matching source evidence.

Hydration must prefer article/detail URLs over source roots and list pages. A successful HTTP response or browser navigation is not evidence success; substantive article text and event facts are required.

## Quality Standard

An item is useful to legal staff only when it answers four questions:

1. What happened or changed, and who/what is involved?
2. What legal, regulatory, enforcement, IP, safety, customs, or platform rule signal does it establish?
3. Which product, market, workflow, team, or business decision is affected?
4. What should legal or the responsible business owner do or monitor next?

Minimum fact bundles are module-specific:

- Regulation: issuing authority, document/rule, concrete change, and effective date, deadline, transition, or feedback channel.
- Advertising: authority, named party, conduct/claim/channel, and penalty, disposition, or legal basis.
- IP: parties, right type, disputed conduct, affected brand/product asset, and judgment, penalty, or disposition.
- Import/export: jurisdiction or port, product, customs or market-access measure, date, and affected import/export process.
- Quality/safety: authority or recalling party, product/batch, identified risk or test result, date, and recall/withdrawal/warning outcome.
- Beauty/platform: platform or authority, affected beauty seller/product/workflow, concrete rule or enforcement change, and effective date or rollout node.

The renderer must remove page-shell fragments before extraction. A field containing only a fragment such as `的，按照相关法律、行政法规的规定处理` is empty, not a fact. Generated legal conclusions, amounts, parties, dates, and deadlines must be supported by source text; otherwise the item is rejected or the field is explicitly marked as unavailable.

## Validation Plan

Tests are written before production changes and run in red-green cycles.

Unit and contract tests will prove:

- each module retains its own discovery and analysis budget;
- detail selection excludes homepages/list pages and preserves article text, date, URL, and module;
- all six fact bundles accept representative valid fixtures and reject missing or shell-only fixtures;
- invalid dates, food-only enforcement, fragment fields, navigation pages, and unlocalized English fields cannot enter the premium portfolio;
- event-level deduplication removes syndicated copies while allowing distinct events from the same source;
- debug mode can retain a repeated fixture or previously delivered event, while normal mode rejects it and does not mark it as newly delivered;
- portfolio selection returns at least 20 items with two per module when valid fixtures exist, and reports the exact deficient modules when they do not;
- the saved Markdown and DingTalk payload are identical;
- an underfilled run does not send or mark deduplication state.

Production verification is a no-delivery run on the target branch. Its artifact must include the per-module funnel table and final Markdown. Acceptance requires three consecutive runs, with different collection dates, each meeting the contract; one successful run or a passing unit test is insufficient.

## Scope Boundaries

This repair does not add login automation, CAPTCHA bypass, proxy rotation, paid-source scraping, or a new storage platform. It does not rewrite the Worker deployment architecture. Changes stay within discovery/query construction, source hydration and evidence normalization, module-aware analysis, premium quality selection, report rendering, workflow diagnostics, and focused regression fixtures.
