import assert from 'node:assert/strict';
import { sendDingTalkMessages } from './index.js';

async function testRejectsTitleOnlyPremiumMessageBeforeWebhook() {
  let calls = 0;
  const result = await sendDingTalkMessages({
    messages: [{
      id: 'weekly-report',
      title: '美妆法务资讯｜2026-07-28',
      markdown: '# 美妆法务资讯｜2026-07-28',
    }],
    sendMessage: async () => {
      calls += 1;
      return { ok: true, retryable: false, error: '' };
    },
  });

  assert.equal(calls, 0);
  assert.equal(result.ok, false);
  assert.match(result.error, /missing premium content items/);
}

async function testAllowsStructuredPremiumMessage() {
  let calls = 0;
  const result = await sendDingTalkMessages({
    messages: [{
      id: 'weekly-report',
      title: '美妆法务资讯｜2026-07-28',
      markdown: [
        '# 美妆法务资讯精品卡（2026-07-22 至 2026-07-28）',
        '',
        '本期精选 1 条。',
        '',
        '## 新法律法规政策',
        '',
        '### 1. 化妆品标准新规征求意见，明确标准执行和新旧衔接',
        '- **来源**：国家药品监督管理局 / 中国 / 2026-07-24 / [原文](https://www.nmpa.gov.cn/xxgk/zhqyj/20260724.html)',
        '- **事实依据**',
        '  - 机关：国家药品监督管理局',
        '- **法务观察**',
        '  - 征求意见稿把化妆品标准执行和新旧衔接写入制度安排',
        '- **业务影响**',
        '  - 影响化妆品配方开发、标签备案和执行标准选择',
        '- **下一步观察建议**',
        '  - 观察正式稿发布日期、反馈截止日和过渡期安排',
      ].join('\n'),
    }],
    sendMessage: async () => {
      calls += 1;
      return { ok: true, retryable: false, error: '' };
    },
  });

  assert.equal(calls, 1);
  assert.equal(result.ok, true);
}

await testRejectsTitleOnlyPremiumMessageBeforeWebhook();
await testAllowsStructuredPremiumMessage();

console.log('dingtalk quality gate tests passed');
