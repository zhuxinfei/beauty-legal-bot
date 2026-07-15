# AI Core Judgement Review Design

## Goal

Upgrade each formal report item from a display-time fallback labelled "核心判断" to an explicit AI-generated `core_judgement`, add a resilient evidence review pass, switch the configured model to `gpt-5.6-sol`, and stop AI-generated internal completion dates.

## Scope

The change is limited to the AI request boundary, report schema validation, DingTalk single-card rendering, model configuration, fixtures, tests, and operator documentation. Collection, source recovery, source coverage gates, China-first sorting, the 18 KB one-card policy, statutory dates, scheduling, and DingTalk delivery remain unchanged.

## Report Contract

Every formal report item must contain `core_judgement` as one concise statement that combines:

1. the material regulatory or case conclusion;
2. the concrete impact on the group's cosmetics business; and
3. uncertainty or a verification boundary when the evidence is incomplete.

The card renderer uses `core_judgement` first. Legacy type-specific fields remain as a compatibility fallback for historical stored reports, but newly generated reports fail validation when `core_judgement` is absent.

## Time Rules

AI-generated actions identify the recommended owner and concrete action, but do not invent an internal completion date. Leaders decide internal delivery dates.

Objective dates stated by the source remain in `effective_date`, `feedback_deadline`, and `next_deadline`. The AI may reproduce those dates only when supported by the source evidence.

## Model And Reasoning

All checked-in defaults use the model identifier `gpt-5.6-sol`. Requests for this model include `reasoning_effort: "high"`. The active Worker recognizes only the generic `AI_API_KEY`, `AI_API_BASE_URL`, and `AI_MODEL` configuration; deprecated `DEEPSEEK_*` fallbacks and the `deepseek-v4-pro` branch are removed.

The primary AI call produces the structured report. A second review call receives the validated draft and only the evidence snippets for URLs used by that draft. It must correct or remove unsupported statements, preserve the period and module taxonomy, avoid adding new items, and return valid JSON.

## Reliability Policy

The primary result must pass the existing schema and quality checks before review. A reviewed result is adopted only when it also parses and validates successfully. Network failure, malformed reviewer JSON, or reviewer validation failure logs a warning and returns the already validated primary result. This keeps the quality improvement from creating a new terminal failure mode.

## Verification

Tests must prove:

- `gpt-5.6-sol` sends high reasoning effort and checked-in defaults use the same identifier;
- the analysis prompt requires `core_judgement` and forbids invented internal dates;
- validation rejects new report items without `core_judgement`;
- the card displays `core_judgement` before legacy fields;
- a valid reviewer result replaces the draft;
- reviewer failure falls back to the validated draft;
- statutory date fields remain supported;
- the full worker test suite and syntax checks pass.
