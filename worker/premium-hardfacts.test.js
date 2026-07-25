import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAnalysisPrompt } from './index.js';
import { buildPremiumDingTalkMarkdown } from './premium-quality.js';
import { normalizeHydratedRecord } from './source-hydration.js';

function testHydrationExtractsActionableHardFacts() {
  const record = normalizeHydratedRecord({
    url: 'https://amr.example.gov.cn/case/hermes-20260724',
    title: '行政处罚决定书',
    fit_markdown: `
      处罚机关：广州市市场监督管理局。
      当事人：广州赫姿化妆品有限公司、广州尚美生物科技有限公司。
      违法事实：当事人在香水、彩妆和礼盒商品上冒用爱马仕文字及图形商标。
      依据《中华人民共和国商标法》第六十条，罚款63.5万元，没收侵权香水、彩妆及礼盒货品。
      反馈渠道：电子邮箱 cosmetics-standards@nmpa.gov.cn。
    `,
  });

  assert.equal(record.hard_facts.involved_party, '广州赫姿化妆品有限公司、广州尚美生物科技有限公司');
  assert.equal(record.hard_facts.violation_behavior, '当事人在香水、彩妆和礼盒商品上冒用爱马仕文字及图形商标');
  assert.equal(record.hard_facts.penalty_amount, '63.5万元');
  assert.match(record.hard_facts.confiscation_result, /没收侵权香水、彩妆及礼盒货品/);
  assert.equal(record.hard_facts.feedback_channel, '电子邮箱 cosmetics-standards@nmpa.gov.cn');
}

function testFormalPromptsRequireAllPremiumHardFactFields() {
  const prompt = buildAnalysisPrompt({
    candidates: [],
    leads: [],
    sources: [],
    period: { start: '2026-07-19', end: '2026-07-25' },
  });
  for (const field of ['violation_behavior', 'confiscation_result', 'feedback_channel']) {
    assert.ok(prompt.includes(`"${field}"`), `analysis prompt missing ${field}`);
  }
  assert.ok(prompt.includes('必须使用具体名称'));

  const indexSource = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  for (const field of ['violation_behavior', 'confiscation_result', 'feedback_channel']) {
    assert.ok(indexSource.includes(`"${field}"`), `rescue prompt missing ${field}`);
  }
  assert.ok(indexSource.includes('不得退回“商家”“两家公司”“涉案主体”“相关企业”等泛称'));
}

function testPremiumMarkdownRendersNewHardFactsInFormalCard() {
  const markdown = buildPremiumDingTalkMarkdown({
    period: { start: '2026-07-19', end: '2026-07-25' },
    cards: [{
      title: '广州赫姿化妆品有限公司、广州尚美生物科技有限公司冒用爱马仕商标被罚63.5万元',
      module: '知识产权保护或者侵权',
      source_url: 'https://amr.example.gov.cn/case/hermes-20260724',
      source_name: '广州市市场监督管理局',
      source_type: 'official_site',
      authority_type: 'regulator',
      country: '中国',
      published_at: '2026-07-24',
      facts: ['广州市市场监督管理局披露两家公司在香水、彩妆和礼盒商品上冒用爱马仕文字及图形商标，罚款63.5万元并没收侵权货品。'],
      legal_signal: '高知名度商标用于美妆产品、包装或礼盒组合时，行政处罚会同时覆盖罚款和侵权货品处置。',
      business_impact: '影响香水、彩妆、礼盒 SKU 的商标授权、包装设计、达人素材和平台店铺审查。',
      recommended_action: '观察同类商标在包装装潢、礼盒搭配、详情页展示和达人素材中的行政处罚扩散。',
      hard_facts: {
        authority: '广州市市场监督管理局',
        involved_party: '广州赫姿化妆品有限公司、广州尚美生物科技有限公司',
        violation_behavior: '在香水、彩妆和礼盒商品上冒用爱马仕文字及图形商标',
        penalty_amount: '63.5万元',
        confiscation_result: '没收侵权香水、彩妆及礼盒货品',
        legal_basis: '《中华人民共和国商标法》第六十条',
        product_or_batch: '香水、彩妆、礼盒商品',
        affected_processes: ['商标授权', '包装设计', '达人素材', '平台店铺'],
      },
    }],
  });

  assert.match(markdown, /\n  - 违法行为：在香水、彩妆和礼盒商品上冒用爱马仕文字及图形商标/);
  assert.match(markdown, /\n  - 没收\/处置：没收侵权香水、彩妆及礼盒货品/);
  assert.doesNotMatch(markdown, /分级：|类型：|建议动作|Crawl4AI|我们|我/);
}

testHydrationExtractsActionableHardFacts();
testFormalPromptsRequireAllPremiumHardFactFields();
testPremiumMarkdownRendersNewHardFactsInFormalCard();

console.log('premium hard facts tests passed');
