# DingTalk Editorial Legal Intelligence Report Design

## Objective

Turn the verified weekly legal-intelligence data into one useful DingTalk message for the legal department. The result must serve leadership at the top, preserve specialist execution depth in the body, remain readable on a phone, and continue to deliver when image rendering or publication fails.

## Evidence And Root Cause

The collection and AI stages are no longer the main content bottleneck. Recent runs hydrate article detail pages and produce structured fields such as facts, rule changes, legal obligations, violation logic, penalties, business impact, actions, owners, and statutory dates.

The current single-card renderer discards most of those fields. It reduces action items to judgement, impact, action, and source; caps all watch items at three; truncates each field aggressively; then removes low-ranked items to fit a byte budget. The separate action-dashboard image duplicates the same short text. The June renderer felt denser because it retained facts, importance, impact, actions, owners, and dates, but it also repeated summaries and action boards.

The fix therefore belongs at the editorial and presentation boundary, not in another broad collection rewrite.

## Chosen Delivery Model

Use one hybrid DingTalk Markdown message:

1. A concise management summary with no coverage telemetry.
2. One high-resolution, mobile-first editorial report image.
3. A numbered source index whose numbering matches the image.
4. A complete Markdown fallback when image rendering or publication is unavailable.

Only one webhook message is sent. Image failure must not fail the weekly report.

## Editorial Contract

A pure editorial builder converts the admitted report into a presentation model shared by the image and Markdown renderers.

The model contains:

- period and up to three management conclusions;
- active modules only, in the existing six-module order;
- items ordered with China first, then quality rank;
- stable sequential item numbers across modules;
- title, market, risk, tier, summary, facts, legal analysis, business impact, action or watch value, statutory date, source name, source URL, and publication date;
- a final synthesis based on the management conclusions.

Type-specific detail selection:

- Regulations: changes, legal obligations, affected business, and statutory dates.
- Cases and recalls: facts, violation logic, result or penalty, and business lessons.
- IP: dispute focus, infringement logic, and brand-asset impact.
- Import/export: market-access change, affected flow, and required documents.
- Industry or regulatory signals: regulatory signal, compliance meaning, watch value, and next observable signal.

No item is duplicated within a report. URL identity is primary; normalized title plus market is the fallback identity.

## Content Rules

- Keep all admitted action and watch items; do not cap watch items at three.
- Target 8 to 12 useful items when available, without inventing filler or weakening admission.
- Put Chinese items first globally while retaining active-module grouping.
- Keep internal completion time as `由责任领导确定`.
- Preserve source-supported statutory dates.
- Do not show source coverage, critical-source coverage, failed-source count, or formal-item count.
- Do not render the action dashboard.
- Manual workflow runs may bypass cross-run deduplication; within-report deduplication always remains active.

## Visual System

The image is an operational legal briefing, not a marketing page.

- Canvas width: 1080 CSS pixels, captured as a high-resolution PNG.
- Body text: at least 32 CSS pixels at the 1080-pixel layout width; no text truncation.
- Palette: white and cool gray surfaces, near-black text, restrained blue accent, amber/red risk labels only where meaningful.
- Typography: Noto Sans CJK SC with system CJK fallbacks.
- Layout: compact header, management conclusions, active-module bands, numbered editorial entries, dark conclusion band.
- Cards use small radii and subtle borders; no gradients, decorative blobs, charts, or nested cards.
- Every item uses the same information hierarchy and enough vertical space for natural wrapping.

The public image URL is content-versioned. The DingTalk card also includes a `查看高清原图` link so compressed previews never become the only reading surface.

## Failure Handling

Image creation and publication are optional enhancements inside the delivery stage:

- Rendering failure: log the reason and send the full Markdown report.
- Publication or health-check failure: log the reason and send the full Markdown report.
- Empty admitted report: send the existing explicit no-update message without an image.
- DingTalk send failure: preserve existing retry and terminal-failure behavior; do not mark items seen.

## Acceptance Criteria

1. Exactly one DingTalk webhook message per delivered report.
2. No action-dashboard image or wording appears.
3. All admitted items appear once in the image model and once in the appropriate fallback output.
4. Chinese items precede overseas items.
5. Watch items are not capped at three.
6. Type-specific legal facts and statutory dates survive the editorial mapping.
7. The image has no clipping, overlap, blank body, or unreadably small text for 8, 10, and 12 item fixtures.
8. The card stays within the configured DingTalk byte limit.
9. Image failure still produces a successful one-card text delivery.
10. Source links remain clickable and match numbered image entries.
