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

function testManualBaselineGetsOnlyConcreteClarifications() {
  const markdown = buildPremiumDingTalkMarkdown({
    period: { start: '2026-07-24', end: '2026-07-24' },
    cards: [
      {
        title: '两家美妆企业冒用爱马仕商标，合计罚63.5万元并没收大量货品',
        module: '知识产权保护或者侵权',
        source_url: 'https://amr.example.gov.cn/case/hermes-20260724',
        source_name: '市场监督管理局',
        source_type: 'official_site',
        authority_type: 'regulator',
        country: '中国',
        published_at: '2026-07-24',
        facts: ['市场监管部门披露两家美妆企业冒用爱马仕商标，合计罚款63.5万元，并没收大量侵权货品。'],
        legal_signal: '高知名度商标被用于美妆产品或包装时，行政处罚会同时指向罚款和货品处置。',
        business_impact: '影响香水、彩妆、礼盒 SKU 的商标授权、包装设计、达人素材和平台店铺审查。',
        recommended_action: '观察高知名度商标在包装装潢、礼盒搭配、详情页展示和达人素材中的行政处罚扩散。',
        hard_facts: {
          authority: '市场监督管理局',
          involved_party: '广州赫姿化妆品有限公司、广州尚美生物科技有限公司',
          product_or_batch: '侵权货品',
          violation_behavior: '冒用爱马仕商标',
          penalty_amount: '63.5万元',
          confiscation_result: '没收大量侵权货品',
          legal_basis: '《商标法》',
          affected_processes: ['商标授权', '包装设计', '达人素材', '平台店铺'],
        },
      },
      {
        title: '商家侵权玻色因商标并刷单，被市场监管部门罚款17万元',
        module: '知识产权保护或者侵权',
        source_url: 'https://amr.example.gov.cn/case/pro-xylane-20260724',
        source_name: '市场监督管理局',
        source_type: 'official_site',
        authority_type: 'regulator',
        country: '中国',
        published_at: '2026-07-24',
        facts: ['市场监管部门披露商家在美妆商品宣传中侵权使用玻色因相关商标，同时存在刷单行为，处罚金额17万元。'],
        legal_signal: '同一经营行为同时暴露商标侵权和虚假交易两类合规风险。',
        business_impact: '影响成分卖点命名、商标授权、平台店铺运营、达人素材和交易数据合规。',
        recommended_action: '观察同类成分商标在商品标题、详情页、直播脚本和平台销量展示中的处罚扩散。',
        hard_facts: {
          authority: '市场监督管理局',
          involved_party: '广州妍瑟化妆品有限公司',
          product_or_batch: '含玻色因卖点的美妆商品',
          violation_behavior: '侵权使用玻色因相关商标，同时存在刷单行为',
          penalty_amount: '17万元',
          legal_basis: '商标法、反不正当竞争相关规则',
          affected_processes: ['成分卖点命名', '商标授权', '平台店铺运营', '达人素材'],
        },
      },
      {
        title: '化妆品标准新规征求意见，明确标准执行、新旧衔接及企业参与渠道',
        module: '新法律法规政策',
        source_url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260724.html',
        source_name: '国家药品监督管理局',
        source_type: 'official_site',
        authority_type: 'regulator',
        country: '中国',
        published_at: '2026-07-24',
        facts: ['国家药监局就化妆品标准管理相关规则公开征求意见，征求意见稿明确标准执行、新旧标准衔接和企业参与标准制修订渠道。'],
        legal_signal: '征求意见稿把标准执行、新旧衔接和企业参与渠道纳入制度化安排。',
        business_impact: '影响化妆品配方开发、标签备案、执行标准选择、存量 SKU 过渡期管理和标准制修订参与。',
        recommended_action: '观察正式稿发布日期、反馈截止日、过渡期安排和企业参与标准制修订的申报入口。',
        hard_facts: {
          authority: '国家药品监督管理局',
          document_number: '征求意见稿',
          deadline: '意见反馈截止日见原文',
          affected_processes: ['配方开发', '标签备案', '执行标准选择', '存量 SKU 过渡期管理'],
        },
      },
    ],
  });

  assert.match(markdown, /广州赫姿化妆品有限公司、广州尚美生物科技有限公司冒用爱马仕商标/);
  assert.match(markdown, /主体：广州赫姿化妆品有限公司、广州尚美生物科技有限公司/);
  assert.match(markdown, /违法行为：冒用爱马仕商标/);
  assert.match(markdown, /没收\/处置：没收大量侵权货品/);
  assert.match(markdown, /广州妍瑟化妆品有限公司侵权玻色因商标并刷单/);
  assert.match(markdown, /违法行为：侵权使用玻色因相关商标，同时存在刷单行为/);
  assert.doesNotMatch(markdown, /截止：意见反馈截止日见原文/);
  assert.doesNotMatch(markdown, /观察对象：/);
  assert.doesNotMatch(markdown, /市场监管部门披露两家美妆企业冒用爱马仕商标/);
  assert.doesNotMatch(markdown, /市场监管部门披露商家在美妆商品宣传中侵权使用玻色因相关商标/);
  assert.match(markdown, /化妆品标准新规征求意见/);
  assert.match(markdown, /征求意见稿明确标准执行、新旧标准衔接和企业参与标准制修订渠道/);
}

function testFormalReportItemUsesEvidenceTextForFinalQuality() {
  const messages = buildPremiumDingTalkMessages({
    period: { start: '2026-07-20', end: '2026-07-26' },
    sections: [{
      module: '知识产权动态',
      items: [{
        title: '两家美妆企业冒用爱马仕商标，合计罚63.5万元并没收大量货品',
        source_url: 'https://amr.example.gov.cn/case/hermes-20260724',
        source_name: '市场监督管理局',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '2026-07-24',
        country: '中国',
        fact_summary: ['市场监管部门披露两家美妆企业冒用爱马仕商标，合计罚款63.5万元，并没收大量侵权货品。'],
        legal_signal: '高知名度商标被用于美妆产品或包装时，行政处罚会同时指向罚款和货品处置。',
        business_impact: '影响香水、彩妆、礼盒 SKU 的商标授权、包装设计、达人素材和平台店铺审查。',
        next_observation: ['观察高知名度商标在包装装潢、礼盒搭配、详情页展示和达人素材中的行政处罚扩散。'],
        evidence_excerpt: '处罚机关：市场监督管理局。当事人：广州赫姿化妆品有限公司、广州尚美生物科技有限公司。违法事实：在香水、彩妆、礼盒商品上冒用爱马仕商标。罚款63.5万元，没收大量侵权货品。依据《商标法》。',
        hard_facts: {
          authority: '市场监督管理局',
          involved_party: '两家美妆企业',
          product_or_batch: '侵权货品',
          penalty_amount: '63.5万元',
          legal_basis: '《商标法》',
          affected_processes: ['商标授权', '包装设计', '达人素材', '平台店铺'],
        },
      }],
    }],
  });

  assert.equal(messages.length, 1);
  const markdown = messages[0].markdown;
  assert.match(markdown, /广州赫姿化妆品有限公司、广州尚美生物科技有限公司冒用爱马仕商标/);
  assert.match(markdown, /主体：广州赫姿化妆品有限公司、广州尚美生物科技有限公司/);
  assert.match(markdown, /违法行为：在香水、彩妆、礼盒商品上冒用爱马仕商标/);
  assert.match(markdown, /没收\/处置：没收大量侵权货品/);
  assert.doesNotMatch(markdown, /主体：两家美妆企业/);
  assert.doesNotMatch(markdown, /市场监管部门披露两家美妆企业冒用爱马仕商标/);
  assert.doesNotMatch(markdown, /观察对象：/);
}

function testPremiumSelectionKeepsChinaAheadOfHigherScoredForeignItems() {
  const messages = buildPremiumDingTalkMessages({
    period: { start: '2026-07-20', end: '2026-07-26' },
    sections: [
      {
        module: '新规及案例动态',
        items: [{
          title: '化妆品标准新规征求意见，明确标准执行和新旧衔接',
          source_url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260724.html',
          source_name: '国家药品监督管理局',
          source_type: 'official_site',
          authority_type: 'regulator',
          published_at: '2026-07-24',
          country: '中国',
          fact_summary: ['国家药监局就化妆品标准管理规则征求意见，正文涉及标准执行、新旧标准衔接和企业参与标准制修订渠道。'],
          legal_signal: '征求意见稿把化妆品标准执行、新旧衔接和企业参与标准制修订渠道写入制度安排。',
          business_impact: '影响配方开发、检验依据、标签备案引用标准、质量放行和进口备案资料引用标准。',
          next_observation: ['观察正式稿发布日期、反馈截止日、过渡期安排和企业参与标准制修订的申报入口。'],
          hard_facts: {
            authority: '国家药品监督管理局',
            document_number: '征求意见稿',
            affected_processes: ['配方开发', '标签备案', '执行标准选择'],
          },
        }],
      },
      {
        module: '产品质量/召回与安全风险',
        items: [{
          title: '美国 FDA 公布化妆品召回和安全警示',
          source_url: 'https://www.fda.gov/safety/recalls/cosmetic-20260724',
          source_name: '美国 FDA',
          source_type: 'official_site',
          authority_type: 'regulator',
          published_at: '2026-07-24',
          country: '美国',
          fact_summary: ['美国 FDA 公布化妆品召回信息，涉及微生物污染、停止销售、召回批次和消费者退货安排。'],
          legal_signal: '召回信息显示美国渠道对微生物污染化妆品继续采取批次召回和停止销售处置。',
          business_impact: '影响美国渠道 SKU、批次召回、质量放行、平台店铺和售后沟通。',
          next_observation: ['观察 FDA 后续召回进展、企业整改公告和同类产品警示扩散。'],
          hard_facts: {
            authority: '美国 FDA',
            product_or_batch: '微生物污染化妆品批次',
            confiscation_result: '停止销售并召回',
            affected_processes: ['SKU/批次管理', '质量放行', '平台店铺'],
          },
        }],
      },
    ],
  });

  assert.equal(messages.length, 1);
  const markdown = messages[0].markdown;
  assert.ok(markdown.indexOf('化妆品标准新规征求意见') < markdown.indexOf('美国 FDA 公布化妆品召回和安全警示'));
}

function testPremiumDeliveryBackfillsQualifiedChinaItemWhenStrictSelectionIsForeignOnly() {
  const messages = buildPremiumDingTalkMessages({
    period: { start: '2026-07-20', end: '2026-07-26' },
    sections: [
      {
        module: '产品质量/召回与安全风险',
        items: [{
          title: '美国 FDA 公布化妆品召回和安全警示',
          source_url: 'https://www.fda.gov/safety/recalls/cosmetic-20260724',
          source_name: '美国 FDA',
          source_type: 'official_site',
          authority_type: 'regulator',
          published_at: '2026-07-24',
          country: '美国',
          fact_summary: ['美国 FDA 公布化妆品召回信息，涉及微生物污染、停止销售、召回批次和消费者退货安排。'],
          legal_signal: '召回信息显示美国渠道对微生物污染化妆品继续采取批次召回和停止销售处置。',
          business_impact: '影响美国渠道 SKU、批次召回、质量放行、平台店铺和售后沟通。',
          next_observation: ['观察 FDA 后续召回进展、企业整改公告和同类产品警示扩散。'],
          hard_facts: {
            authority: '美国 FDA',
            product_or_batch: '微生物污染化妆品批次',
            confiscation_result: '停止销售并召回',
            affected_processes: ['SKU/批次管理', '质量放行', '平台店铺'],
          },
        }],
      },
      {
        module: '知识产权动态',
        items: [{
          title: '商家侵权玻色因商标并刷单，被市场监管部门罚款17万元',
          source_url: 'https://amr.example.gov.cn/case/pro-xylane-20260724',
          source_name: '市场监督管理局',
          source_type: 'official_site',
          authority_type: 'regulator',
          published_at: '未知',
          country: '中国',
          fact_summary: ['市场监管部门披露商家在美妆商品宣传中侵权使用玻色因相关商标，同时存在刷单行为，处罚金额17万元。'],
          legal_signal: '同一经营行为同时暴露商标侵权和虚假交易两类合规风险。',
          business_impact: '影响成分卖点命名、商标授权、平台店铺运营、达人素材和交易数据合规。',
          next_observation: ['观察同类成分商标在商品标题、详情页、直播脚本和平台销量展示中的处罚扩散。'],
          evidence_excerpt: '当事人：广州妍瑟化妆品有限公司。违法事实：侵权使用玻色因相关商标，同时存在刷单行为。处罚金额17万元。依据商标法、反不正当竞争相关规则。',
          hard_facts: {
            authority: '市场监督管理局',
            involved_party: '涉案商家',
            product_or_batch: '含玻色因卖点的美妆商品',
            penalty_amount: '17万元',
            legal_basis: '商标法、反不正当竞争相关规则',
            affected_processes: ['成分卖点命名', '商标授权', '平台店铺运营', '达人素材'],
          },
        }],
      },
    ],
  });

  assert.equal(messages.length, 1);
  const markdown = messages[0].markdown;
  assert.match(markdown, /广州妍瑟化妆品有限公司侵权玻色因商标并刷单/);
  assert.match(markdown, /主体：广州妍瑟化妆品有限公司/);
  assert.ok(markdown.indexOf('广州妍瑟化妆品有限公司侵权玻色因商标并刷单') < markdown.indexOf('美国 FDA 公布化妆品召回和安全警示'));
}

testHydrationExtractsActionableHardFacts();
testFormalPromptsRequireAllPremiumHardFactFields();
testPremiumMarkdownRendersNewHardFactsInFormalCard();
testPremiumMarkdownInfersAffectedProcessesFromEvidence();
testManualWorkflowRunsAreNotArtifactOnlyByDefault();
testPremiumDeliveryFallsBackInsteadOfSendingEmptyCard();
testManualBaselineGetsOnlyConcreteClarifications();
testFormalReportItemUsesEvidenceTextForFinalQuality();
testPremiumSelectionKeepsChinaAheadOfHigherScoredForeignItems();
testPremiumDeliveryBackfillsQualifiedChinaItemWhenStrictSelectionIsForeignOnly();

console.log('premium hard facts tests passed');
