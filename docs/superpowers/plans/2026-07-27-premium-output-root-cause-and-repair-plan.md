# Premium Output Root Cause And Repair Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Do not run or push a DingTalk delivery until the local final markdown passes the gates in this file.

**Goal:** Make the formal pipeline's actual DingTalk markdown reach the same hard-fact quality as the approved manual sample.

**Architecture:** Treat the final DingTalk markdown as the only product. All collection, extraction, AI analysis, fallback, quality gates, saved artifacts, and delivery must converge into one verified `premiumDelivery.messages` object. If the exact markdown that would be sent does not meet the gates below, the process must fail before sending.

**Tech Stack:** Node.js worker code, GitHub Actions formal run, Crawl4AI hydration artifacts, OpenAI-compatible AI endpoint, DingTalk markdown webhook.

---

## Non-Negotiable Target

The target is not "workflow success", "China item count", "Crawl4AI used", or "format looks close".

The target is:

```text
The exact markdown sent to DingTalk must look and feel like the approved manual sample:
- 3 to 5 carefully selected items, not filler.
- China-first ordering.
- At least 3 China hard-fact items when China hard-fact candidates exist.
- Each selected item must contain concrete facts such as authority, party, violation behavior, penalty amount, confiscation/disposition, legal basis, document number, deadline, feedback channel, product/batch, HS code, and affected process.
- No first person.
- No "Crawl4AI".
- No old format labels: "事实摘要", "法务判断", "建议动作", "来源链接", "管理层摘要".
- No source-page, portal-page, topic-page, or generic safety-use page as a premium card.
```

The approved sample quality bar is represented by cards like:

```text
广州赫姿化妆品有限公司、广州尚美生物科技有限公司冒用爱马仕商标，合计罚63.5万元并没收大量货品
广州妍瑟化妆品有限公司侵权玻色因商标并刷单，被市场监管部门罚款17万元
化妆品标准新规征求意见，明确标准执行、新旧衔接及企业参与渠道
```

---

## Root Cause Review

### Root Cause 1: Wrong Acceptance Object

The pipeline previously treated intermediate logs and audit counters as proof of quality.

Observed failure:

```text
Log: 中国候选 61/81，中国准入 0/2，中国入卡 3/5
User-visible DingTalk result: two messages, all United States content.
```

Cause:

```text
The audit inspected `buildPremiumDingTalkDelivery(report, { candidates })`.
The actual sent markdown was built through `buildDingTalkWebhookMessages({ ...report, premium_delivery: true })`.
The second path did not receive `candidates`, so China candidate backfill did not reach the sent message.
```

Repair requirement:

```text
Saved markdown, quality gate markdown, and DingTalk payload markdown must be byte-for-byte the same string.
```

### Root Cause 2: Quality Was Measured By China Count, Not Hard Facts

China count is necessary but not sufficient.

Bad acceptance pattern:

```text
中国入卡 >= 1
```

This allowed weak China items or one China item plus several overseas items.

Required acceptance pattern:

```text
finalChinaItems >= requiredChinaItems
finalSampleGradeItems >= requiredSampleGradeItems
finalChinaSampleGradeItems is reported
```

Sample-grade means:

```text
At least 2 objective hard facts.
Hard legal event is present.
Not navigation/generic/source/topic page.
No forbidden old wording.
```

### Root Cause 3: Formal Sources Are Often Too Soft

The manual sample starts from hard evidence:

```text
administrative penalty, named party, amount, confiscation, legal basis
formal consultation draft, authority, execution rules, transition rules, feedback channel/deadline
customs notice, HS code or declaration detail, affected import process
```

The formal pipeline often collected:

```text
official homepage
topic page
portal page
generic consumer safety page
overseas regulatory explainer
```

These are authoritative but not premium legal intelligence.

Repair requirement:

```text
Authority alone must not qualify a card.
The candidate must expose hard facts or be rejected before DingTalk delivery.
```

### Root Cause 4: Fallback Filled Quantity Before Enforcing Sample Quality

Candidate fallback was added to prevent empty or foreign-only cards, but fallback itself can become another filler path.

Repair requirement:

```text
Fallback candidates must pass the same sample-grade hard-fact gate as AI-selected report items.
If fewer than 3 sample-grade items exist, send fewer items or fail before delivery.
Never fill with overseas topic pages or generic official pages.
```

### Root Cause 5: Tests Did Not Protect The User-Visible Payload

Previous tests checked:

```text
messages exist
workflow success
some China item exists
markdown includes basic headings
```

They did not prove:

```text
payload.markdown.text === markdown saved by ON_REPORT_READY
payload.markdown.text has no old wording
payload.markdown.text has sample-grade hard facts
payload.markdown.text is China-first
```

Repair requirement:

```text
Tests must inspect the exact DingTalk webhook body.
```

---

## Current Known State

Already pushed commits on branch `codex/content-quality-runtime`:

```text
289e8ee Guard China premium coverage and source matching
19c2ea8 Enforce China delivery quality gates
c467ea2 Backfill premium China cards from candidates
4a4f8d8 Warn on source coverage without blocking delivery
63232e9 Limit module analysis batches for formal runs
ce24cf0 Require stronger China coverage in premium cards
ad9ce70 Use verified premium markdown for delivery
```

Current unresolved risks:

```text
1. Formal source quality may still be too soft.
2. Final output may pass structural gates but still feel weaker than the manual sample.
3. Existing broad test runner still has an unrelated source-budget assertion failure.
4. GitHub Action pushes to DingTalk must remain paused until local final markdown is manually inspected.
```

---

## Files And Responsibilities

### `worker/index.js`

Responsibilities:

```text
Own the formal pipeline.
Build `premiumDelivery` once.
Use `premiumDelivery.messages` for saved markdown, quality gates, and DingTalk delivery.
Reject final markdown before sending if it contains old wording or fails hard-fact gates.
Ensure `runFinalizePhase` cannot bypass the same gates.
```

### `worker/premium-quality.js`

Responsibilities:

```text
Normalize report items and candidates into premium cards.
Reject source/generic/topic pages.
Score and select cards.
Backfill China cards from candidates only if they are sample-grade.
Expose audit fields for China count and hard-fact quality.
```

### `worker/premium-hardfacts.test.js`

Responsibilities:

```text
Lock the approved manual sample behavior.
Prove named parties, penalty amounts, legal basis, disposition, and affected processes render in final card format.
Prove AI dropping China candidates still results in sample-grade China cards.
```

### `worker/test-runner.js`

Responsibilities:

```text
Prove the exact DingTalk webhook payload equals the saved markdown.
Prove old wording is blocked from final payload.
Prove no-update AI output can still use sample-grade candidate fallback, but cannot send an empty/filler card.
```

### `scripts/crawl4ai-hydrate.js`

Responsibilities:

```text
Prioritize China official/hard-fact sources.
Do not treat "hydrated" as sufficient quality.
Hydration is only evidence input, not delivery approval.
```

---

## Execution Rules

1. Do not trigger a DingTalk webhook run until a local/generated final markdown is pasted or inspected and passes this file's gates.
2. Do not accept workflow success as quality success.
3. Do not accept audit counters alone as quality success.
4. Do not use source authority as a substitute for hard facts.
5. Do not add more news quantity before the 3-item sample-grade output is stable.
6. Do not modify format unless the user explicitly asks. Keep:

```text
标题
来源
事实依据
法务观察
业务影响
下一步观察建议
```

7. Do not let these strings appear in final DingTalk markdown:

```text
Crawl4AI
建议动作
法务判断
事实摘要
来源链接
管理层摘要
```

---

## Acceptance Gates

### Gate 1: Exact Payload Gate

The DingTalk payload text must equal the saved markdown:

```js
assert.equal(payload.markdown.text, readyMarkdown);
```

### Gate 2: Premium Format Gate

The final markdown must include:

```text
# 美妆法务资讯精品卡
- **来源**
- **事实依据**
- **法务观察**
- **业务影响**
- **下一步观察建议**
```

The final markdown must not include:

```text
Crawl4AI
建议动作
法务判断
事实摘要
来源链接
管理层摘要
```

### Gate 3: China Priority Gate

When China sample-grade candidates exist:

```text
finalChinaItems >= min(3, maxItems, chinaCandidateCount)
China modules/items sort before overseas items
```

### Gate 4: Hard-Fact Density Gate

Each selected premium card must have at least 2 objective hard facts from:

```text
authority
document_number
involved_party
violation_behavior
penalty_amount
confiscation_result
legal_basis
product_or_batch
hs_code
effective_date
deadline
feedback_channel
```

At least 3 selected cards must be sample-grade when at least 3 sample-grade cards exist.

### Gate 5: Source-Type Gate

Reject as premium cards:

```text
homepage
topic page
portal page
navigation page
generic consumer safety page
regulatory entry page without a hard event
overseas explainer page without direct legal obligation or enforcement event
```

### Gate 6: Manual Sample Regression Gate

The system must keep tests that prove the following output style:

```text
主体：广州赫姿化妆品有限公司、广州尚美生物科技有限公司
违法行为：冒用爱马仕商标
金额：63.5万元
没收/处置：没收大量侵权货品
依据：《商标法》
影响流程：商标授权、包装设计、达人素材、平台店铺
```

---

## Repair Plan

### Task 1: Freeze Final Markdown As The Only Delivery Product

**Files:**
- Modify: `worker/index.js`
- Test: `worker/test-runner.js`

- [x] **Step 1: Build `premiumDelivery` once in `runPipeline`**

Use:

```js
const premiumDelivery = buildPremiumDingTalkDelivery(report, { candidates });
const previewMessages = premiumDelivery.messages;
const markdown = previewMessages.map(message => message.markdown).join('\n\n---\n\n');
```

- [x] **Step 2: Pass `previewMessages` into `notifyReport`**

Use:

```js
const notification = await notifyReport({
  report,
  reportUrl: '',
  env: { ...env, SOURCE_COVERAGE: coverage },
  messages: previewMessages,
});
```

- [x] **Step 3: Update `notifyReport` to prefer prepared messages**

Use:

```js
export async function notifyReport({ report, reportUrl: latestUrl, env, messages: preparedMessages = null, sendDingTalk = sendToDingTalk, sendFeishu = sendToFeishu }) {
  if (env.DINGTALK_WEBHOOK_URL) {
    const messages = preparedMessages || buildDingTalkWebhookMessages({ ...report, premium_delivery: true }, {
      maxBytes: env.DINGTALK_MAX_BYTES,
    });
    // send messages
  }
}
```

- [x] **Step 4: Add payload equality test**

Test assertion:

```js
assert.equal(sentMarkdown, readyMarkdown);
```

### Task 2: Apply The Same Gates To Finalize

**Files:**
- Modify: `worker/index.js`

- [x] **Step 1: Build `premiumDelivery` in `runFinalizePhase`**

Use:

```js
const premiumDelivery = buildPremiumDingTalkDelivery(report, { candidates: candidatesMeta.candidates || [] });
const markdown = premiumDelivery.messages.map(message => message.markdown).join('\n\n---\n\n');
```

- [x] **Step 2: Validate before notify**

Use:

```js
assertPremiumChinaDelivery(premiumDelivery.audit, {
  allowForeignOnly: env.ALLOW_FOREIGN_ONLY_DELIVERY === '1',
});
assertFinalDingTalkMarkdownQuality(markdown, premiumDelivery.audit);
```

- [x] **Step 3: Pass `premiumDelivery.messages` to `notifyReport`**

Use:

```js
messages: premiumDelivery.messages
```

### Task 3: Add Final Markdown Quality Gate

**Files:**
- Modify: `worker/index.js`

- [x] **Step 1: Reject empty final markdown**

Use:

```js
if (!String(markdown || '').trim()) throw new Error('Final DingTalk markdown is empty');
```

- [x] **Step 2: Reject old wording**

Use:

```js
if (/Crawl4AI|建议动作|法务判断|管理层摘要|来源链接|事实摘要/.test(markdown)) {
  throw new Error('Final DingTalk markdown used legacy or forbidden wording');
}
```

- [x] **Step 3: Require premium sections**

Use:

```js
if (!markdown.includes('- **事实依据**') || !markdown.includes('- **法务观察**') || !markdown.includes('- **业务影响**') || !markdown.includes('- **下一步观察建议**')) {
  throw new Error('Final DingTalk markdown missing premium card sections');
}
```

### Task 4: Add Hard-Fact Sample-Grade Gate

**Files:**
- Modify: `worker/premium-quality.js`
- Test: `worker/premium-hardfacts.test.js`

- [x] **Step 1: Count sample-grade cards**

Use:

```js
finalSampleGradeItems: cards.filter(isSampleGradeCard).length,
finalChinaSampleGradeItems: cards.filter(card => isChinaCard(card) && isSampleGradeCard(card)).length,
requiredSampleGradeItems: Math.min(3, cards.length),
```

- [x] **Step 2: Fail if selected cards are not sample-grade**

Use:

```js
if (Number(audit.finalSampleGradeItems || 0) < Number(audit.requiredSampleGradeItems || 0)) {
  throw new Error(`Premium delivery hard-fact gate failed: requiredSampleGrade=${audit.requiredSampleGradeItems || 0}, finalSampleGrade=${audit.finalSampleGradeItems || 0}`);
}
```

- [x] **Step 3: Define sample-grade**

Use:

```js
function isSampleGradeCard(card = {}) {
  const hardCount = objectiveHardFactCount(card.hard_facts || {});
  if (hardCount < 2) return false;
  if (!hasHardLegalEvent(card)) return false;
  if (isNavigationOrGenericInformationPage(card)) return false;
  if (/Crawl4AI|欢迎访问|专题页|入口页|监管入口|安全使用|消费者提示/i.test(sourceTextForCard(card))) return false;
  return true;
}
```

### Task 5: Generate But Do Not Push A Formal Preview

**Files:**
- Read: `out/latest-report.md`
- Read: `out/latest-report.json`

- [ ] **Step 1: Run local artifact-only formal pipeline**

Command:

```bash
ARTIFACT_ONLY=1 FORCE_DELIVERY=0 node worker/run-local.js
```

Expected:

```text
No DingTalk webhook call.
out/latest-report.md is written.
```

- [ ] **Step 2: Inspect final markdown**

Command:

```bash
rg -n "Crawl4AI|建议动作|法务判断|事实摘要|来源链接|管理层摘要|美国 FDA|欧盟委员会" out/latest-report.md
```

Expected:

```text
No forbidden old wording.
No overseas topic-page filler.
```

- [ ] **Step 3: Show the markdown to the user**

Action:

```text
Paste the generated markdown into the current chat.
Do not push to DingTalk.
```

### Task 6: Only After User Approval, Run One Formal Push

**Files:**
- No code files.

- [ ] **Step 1: Trigger GitHub Actions manually only after user approval**

Command:

```bash
curl -fsS -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  https://api.github.com/repos/zhuxinfei/beauty-legal-bot/actions/workflows/weekly.yml/dispatches \
  -d '{"ref":"codex/content-quality-runtime"}'
```

- [ ] **Step 2: Verify GitHub Actions log**

Required log pattern:

```text
精品卡验收：中国候选 x/y，中国准入 a/b，中国入卡 >=3/n
钉钉推送成功: weekly-report (1/1)
```

- [ ] **Step 3: If the pushed message differs from preview, stop**

Action:

```text
Do not rerun.
Inspect actual webhook payload generation path.
Add a failing test for the mismatch.
```

---

## Self-Review Checklist

- [x] The file identifies why the formal output did not match the approved sample.
- [x] The file names the exact implementation bug: audited markdown and sent markdown diverged.
- [x] The file names the content-quality bug: China count was accepted as quality.
- [x] The file names the source-quality bug: official portal/topic pages were treated as intelligence.
- [x] The file defines forbidden output wording.
- [x] The file defines the exact sections the user wants.
- [x] The file blocks DingTalk pushes until local markdown is inspected.
- [x] The file contains concrete commands and expected outcomes.

---

## Current Rule For All Future Work

Before any future change or run, check the action against this file:

```text
If the action does not improve or verify the exact final DingTalk markdown quality, do not do it.
If the action would send to DingTalk before local preview approval, do not do it.
If the action uses workflow success as quality proof, do not do it.
```
