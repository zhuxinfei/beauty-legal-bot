import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAnalysisPrompt } from './index.js';
import { buildPremiumDingTalkMarkdown, buildPremiumDingTalkMessages } from './premium-quality.js';
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

function testPremiumMarkdownInfersAffectedProcessesFromEvidence() {
  const markdown = buildPremiumDingTalkMarkdown({
    period: { start: '2026-07-19', end: '2026-07-25' },
    cards: [{
      title: '化妆品标准新规征求意见，明确标准执行和新旧衔接',
      module: '新法律法规政策',
      source_url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260724.html',
      source_name: '国家药品监督管理局',
      source_type: 'official_site',
      authority_type: 'regulator',
      country: '中国',
      published_at: '2026-07-24',
      facts: ['国家药监局就化妆品标准管理规则征求意见，正文涉及标准执行、新旧标准衔接和企业参与标准制修订渠道。'],
      legal_signal: '征求意见稿把化妆品标准执行、新旧衔接和企业参与标准制修订渠道写入制度安排。',
      business_impact: '影响配方开发、检验依据、标签备案引用标准、质量放行和进口备案资料引用标准。',
      recommended_action: '观察正式稿发布日期、反馈截止日、过渡期安排和企业参与标准制修订的申报入口。',
      hard_facts: {
        authority: '国家药品监督管理局',
        document_number: '征求意见稿',
        deadline: '2026年7月30日',
        feedback_channel: '国家药监局政务服务门户意见征集栏目',
      },
    }],
  });

  assert.match(markdown, /化妆品标准新规征求意见/);
  assert.match(markdown, /\n  - 影响流程：标签、备案\/注册、配方\/检验标准/);
  assert.doesNotMatch(markdown, /涉及团队|法规团队|质量团队|建议动作/);
}

function testManualWorkflowRunsAreNotArtifactOnlyByDefault() {
  const source = readFileSync(new URL('./run-local.js', import.meta.url), 'utf8');
  assert.ok(source.includes("const defaultArtifactOnly = '0';"));
}

function testPremiumDeliveryFallsBackInsteadOfSendingEmptyCard() {
  const messages = buildPremiumDingTalkMessages({
    period: { start: '2026-07-20', end: '2026-07-26' },
    sections: [{
      module: '新规及案例动态',
      items: [{
        title: '化妆品标准新规征求意见，明确标准执行和新旧衔接',
        source_url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260724.html',
        source_name: '国家药品监督管理局',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '未知',
        country: '中国',
        fact_summary: ['国家药监局就化妆品标准管理规则征求意见，正文涉及标准执行、新旧标准衔接和企业参与标准制修订渠道。'],
        legal_signal: '征求意见稿把化妆品标准执行、新旧衔接和企业参与标准制修订渠道写入制度安排。',
        business_impact: '影响配方开发、检验依据、标签备案引用标准、质量放行和进口备案资料引用标准。',
        next_observation: ['观察正式稿发布日期、反馈截止日、过渡期安排和企业参与标准制修订的申报入口。'],
        hard_facts: {
          authority: '国家药品监督管理局',
          document_number: '征求意见稿',
          deadline: '2026年7月30日',
          feedback_channel: '国家药监局政务服务门户意见征集栏目',
        },
      }],
    }],
  });

  assert.equal(messages.length, 1);
  assert.match(messages[0].markdown, /本期精选 1 条/);
  assert.match(messages[0].markdown, /化妆品标准新规征求意见/);
  assert.doesNotMatch(messages[0].markdown, /本期没有达到精品证据门槛/);
}

testHydrationExtractsActionableHardFacts();
testFormalPromptsRequireAllPremiumHardFactFields();
testPremiumMarkdownRendersNewHardFactsInFormalCard();
testPremiumMarkdownInfersAffectedProcessesFromEvidence();
testManualWorkflowRunsAreNotArtifactOnlyByDefault();
testPremiumDeliveryFallsBackInsteadOfSendingEmptyCard();

console.log('premium hard facts tests passed');
