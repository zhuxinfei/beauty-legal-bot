# Objective Beauty Legal Brief Implementation Plan

> **For agentic workers:** Execute inline with test-driven development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the analysis-heavy weekly report with an objective, high-density legal news brief that preserves verified facts, observation points, and original links.

**Architecture:** Keep collection and freshness infrastructure, constrain AI to structured extraction, then apply deterministic URL/date/duplicate gates. Convert the six internal source categories into five display sections and render only four fields per item.

**Tech Stack:** Node.js ES modules, existing OpenAI-compatible chat endpoint, DingTalk Markdown webhook, custom test runner.

---

## Checklist

### Specification and fixtures

- [x] Lock five display sections and four visible fields.
- [x] Add a fixture based on the supplied human weekly brief: regulation, trademark/false transaction case, and Hermès infringement case.
- [x] Add forbidden-copy tests for judgement, analysis, summaries, risk and assignment fields.

### Objective extraction

- [x] Replace analysis prompt requirements with fact extraction requirements.
- [x] Require 1-2 concise fact bullets and one observable follow-up signal.
- [x] Reject unsupported implications and homepage-only source URLs.
- [x] Allow relevant industry news into the brief tier without forcing action analysis.
- [x] Require a readable, structurally valid detail body before formal analysis; reject unsupported documents, page shells and access/error pages.
- [x] Preserve the complete extracted article body without a silent 30,000-character truncation.
- [x] Require an explicit include/exclude decision for every primary and rescue evidence candidate.
- [x] Lock title, source, URL, market and dates to the fetched candidate evidence.

### Classification and deduplication

- [x] Map internal categories to five display sections.
- [x] Add normalized URL deduplication.
- [x] Add same-event title similarity deduplication across sources and sections.
- [x] Keep the most authoritative and information-complete source.
- [x] Preserve distinct developments of the same matter when the current week has a new event.

### Rendering and capacity

- [x] Render only title, fact summary, next observation suggestion and source link.
- [x] Remove management summary, core judgement, legal analysis, risk, owners, action board and conclusion.
- [x] Remove fixed item limits from the display pipeline.
- [x] Compact text before considering message splitting.
- [x] Split at complete item boundaries when DingTalk's byte limit is exceeded; never silently omit accepted items.

### Verification and delivery

- [x] Run focused red/green tests for the new structure.
- [x] Run the complete `node worker/test-runner.js` suite.
- [x] Inspect generated Markdown for duplicates, unsupported claims and concrete original links.
- [ ] Push the test branch without changing the formal webhook.
- [ ] Trigger one test webhook run and verify collection, full-text audit, acceptance counts, content structure and DingTalk delivery.
- [ ] Wait for user approval before any formal webhook restoration or delivery.
