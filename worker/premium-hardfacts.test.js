import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAnalysisPrompt } from './index.js';
import { buildPremiumDingTalkDelivery, buildPremiumDingTalkMarkdown, buildPremiumDingTalkMessages, assertPremiumChinaDelivery } from './premium-quality.js';
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

function testPremiumDeliveryBuildsChinaCardFromCandidateWhenAiReportDropsChina() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-20', end: '2026-07-26' },
    sections: [{
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
    }],
  }, {
    candidates: [{
      title: '化妆品标准新规征求意见，明确标准执行和新旧衔接',
      url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260724.html',
      source_name: '国家药品监督管理局',
      source_type: 'official_site',
      authority_type: 'regulator',
      country: '中国',
      module: '新规及案例动态',
      published_at: '2026-07-24',
      detail_status: 'hydrated',
      article_text: '国家药监局就化妆品标准管理规则公开征求意见，征求意见稿明确化妆品强制性标准必须执行，被法规引用的推荐性标准内容同样必须执行。新标准过渡期一般不超过2年，实施前可选择执行新标准或原标准，影响标签备案、执行标准选择、配方开发和存量SKU过渡期管理。',
      hard_facts: {
        authority: '国家药品监督管理局',
        document_number: '征求意见稿',
        deadline: '2026年7月30日',
        affected_processes: ['配方开发', '标签备案', '执行标准选择', '存量SKU过渡期管理'],
      },
    }],
  });

  assert.equal(delivery.audit.finalChinaItems, 1);
  assert.doesNotThrow(() => assertPremiumChinaDelivery(delivery.audit));
  assert.match(delivery.messages[0].markdown, /化妆品标准新规征求意见/);
  assert.match(delivery.messages[0].markdown, /国家药品监督管理局/);
}

function testPremiumDeliveryRequiresMultipleChinaCardsWhenCandidatesAreAvailable() {
  const foreignItems = Array.from({ length: 5 }, (_, index) => ({
    title: `美国 FDA 化妆品监管事项 ${index + 1}`,
    source_url: `https://www.fda.gov/cosmetics/${index + 1}`,
    source_name: '美国 FDA',
    source_type: 'official_site',
    authority_type: 'regulator',
    published_at: '2026-07-24',
    country: '美国',
    fact_summary: [`美国 FDA 披露化妆品监管事项 ${index + 1}，涉及企业义务、标签、报告、召回和渠道处置。`],
    legal_signal: '美国渠道化妆品监管事项。',
    business_impact: '影响美国渠道 SKU、标签、召回、质量放行和平台店铺。',
    next_observation: ['观察 FDA 后续正式文件和执行口径。'],
    hard_facts: {
      authority: '美国 FDA',
      effective_date: '2026-07-24',
      affected_processes: ['美国渠道', '标签', '质量放行'],
    },
  }));
  const chinaCandidates = [
    ['化妆品标准新规征求意见，明确标准执行和新旧衔接', '国家药品监督管理局', '国家药监局就化妆品标准管理规则公开征求意见，明确强制性标准执行、新旧标准衔接、反馈截止日和企业参与标准制修订渠道，影响标签备案、执行标准选择、配方开发和存量SKU过渡期管理。'],
    ['广州市监局披露商家侵权玻色因商标并刷单处罚17万元', '广州市市场监督管理局', '广州市市场监管部门披露广州妍瑟化妆品有限公司侵权使用玻色因相关商标并存在刷单行为，处罚金额17万元，影响成分卖点命名、商标授权、平台店铺运营和达人素材。'],
    ['海关发布进口化妆品申报资料核验要求', '海关总署', '海关发布进口化妆品申报资料核验要求，涉及中文标签、备案注册资料、原产地文件、HS编码和口岸清关资料，影响进口申报、清关、供应链履约和存量SKU资料复核。'],
  ].map(([title, sourceName, articleText], index) => ({
    title,
    url: `https://gov.example.cn/beauty/${index + 1}`,
    source_name: sourceName,
    source_type: 'official_site',
    authority_type: 'regulator',
    country: '中国',
    module: index === 1 ? '知识产权动态' : index === 2 ? '进出口动态' : '新规及案例动态',
    published_at: '2026-07-24',
    detail_status: 'hydrated',
    article_text: articleText,
    hard_facts: {
      authority: sourceName,
      affected_processes: ['标签备案', '商标授权', '进口申报'],
    },
  }));

  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-20', end: '2026-07-26' },
    sections: [{ module: '产品质量/召回与安全风险', items: foreignItems }],
  }, { candidates: chinaCandidates, maxItems: 6 });

  assert.equal(delivery.audit.requiredChinaItems, 3);
  assert.equal(delivery.audit.finalChinaItems, 3);
  assert.doesNotThrow(() => assertPremiumChinaDelivery(delivery.audit));
  const markdown = delivery.messages[0].markdown;
  assert.ok(markdown.indexOf('化妆品标准新规征求意见') < markdown.indexOf('美国 FDA 化妆品监管事项'));
  assert.match(markdown, /广州市监局披露商家侵权玻色因商标并刷单处罚17万元/);
  assert.match(markdown, /海关发布进口化妆品申报资料核验要求/);
}

function testPremiumReportItemUsesHardFactDateWhenPublishedAtMissing() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-22', end: '2026-07-28' },
    sections: [{
      module: '新规及案例动态',
      items: [{
        title: '化妆品标准新规征求意见，明确标准执行和新旧衔接',
        source_url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260724.html',
        source_name: '国家药品监督管理局',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '',
        country: '中国',
        fact_summary: ['国家药监局就化妆品标准管理规则征求意见，正文涉及标准执行、新旧标准衔接、反馈截止日和企业参与标准制修订渠道。'],
        legal_signal: '征求意见稿把化妆品标准执行、新旧衔接和企业参与标准制修订渠道写入制度安排。',
        business_impact: '影响配方开发、检验依据、标签备案引用标准、质量放行和进口备案资料引用标准。',
        next_observation: ['观察正式稿发布日期、反馈截止日、过渡期安排和企业参与标准制修订的申报入口。'],
        evidence_excerpt: '国家药监局就化妆品标准管理规则公开征求意见，反馈截止日期为2026年7月30日，影响标签备案、执行标准选择、配方开发和存量SKU过渡期管理。',
        hard_facts: {
          authority: '国家药品监督管理局',
          document_number: '征求意见稿',
          deadline: '2026年7月30日',
          affected_processes: ['配方开发', '标签备案', '执行标准选择'],
        },
      }],
    }],
  }, { candidates: [], maxItems: 3 });

  assert.equal(delivery.audit.finalChinaItems, 1);
  assert.doesNotThrow(() => assertPremiumChinaDelivery(delivery.audit));
  assert.match(delivery.messages[0].markdown, /国家药品监督管理局 \/ 中国 \/ 2026-07-30/);
}

function testPremiumChinaMinimumTracksBackfillableAndSourceOnlyChinaCandidates() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-22', end: '2026-07-28' },
    sections: [],
  }, {
    maxItems: 6,
    candidates: [
      {
        title: '化妆品标准新规征求意见，明确标准执行和新旧衔接',
        url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260724.html',
        source_name: '国家药品监督管理局',
        source_type: 'official_site',
        authority_type: 'regulator',
        country: '中国',
        module: '新规及案例动态',
        published_at: '2026-07-24',
        detail_status: 'hydrated',
        evidence_grade: 'hard_fact_ready',
        article_text: '国家药监局就化妆品标准管理规则公开征求意见，明确强制性标准执行、新旧标准衔接、反馈截止日和企业参与标准制修订渠道，影响标签备案、执行标准选择、配方开发和存量SKU过渡期管理。',
        hard_facts: {
          authority: '国家药品监督管理局',
          document_number: '征求意见稿',
          deadline: '2026年7月30日',
          affected_processes: ['配方开发', '标签备案', '执行标准选择'],
        },
      },
      {
        title: '广州市监局披露商家侵权玻色因商标并刷单处罚17万元',
        url: 'https://amr.example.gov.cn/case/pro-xylane-20260724',
        source_name: '广州市市场监督管理局',
        source_type: 'official_site',
        authority_type: 'regulator',
        country: '中国',
        module: '知识产权动态',
        published_at: '2026-07-24',
        detail_status: 'hydrated',
        evidence_grade: 'hard_fact_ready',
        article_text: '广州市市场监管部门披露广州妍瑟化妆品有限公司侵权使用玻色因相关商标并存在刷单行为，处罚金额17万元，影响成分卖点命名、商标授权、平台店铺运营和达人素材。',
        hard_facts: {
          authority: '广州市市场监督管理局',
          involved_party: '广州妍瑟化妆品有限公司',
          violation_behavior: '侵权使用玻色因相关商标并存在刷单行为',
          penalty_amount: '17万元',
          legal_basis: '《商标法》',
          affected_processes: ['成分卖点命名', '商标授权', '平台店铺运营', '达人素材'],
        },
      },
      {
        title: '中国化妆品监管线索页面',
        url: 'https://example.gov.cn/beauty/lead-only',
        source_name: '监管部门',
        country: '中国',
        module: '新规及案例动态',
        evidence_grade: 'hard_fact_ready',
      },
    ],
  });

  assert.equal(delivery.audit.candidateChinaItems, 2);
  assert.equal(delivery.audit.backfillableChinaCandidateItems, 2);
  assert.equal(delivery.audit.requiredChinaItems, 2);
  assert.equal(delivery.audit.finalChinaItems, 2);
  assert.equal(delivery.audit.chinaShortfall, false);
  assert.doesNotThrow(() => assertPremiumChinaDelivery(delivery.audit));
}

function testLeadOnlyNavigationPagesCannotBackfillSourceOnlyPremiumCard() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-20', end: '2026-07-26' },
    sections: [{
      module: '产品质量/召回与安全风险',
      items: [{
        title: '美国 FDA 公布化妆品召回和安全警示',
        source_url: 'https://www.fda.gov/safety/recalls/cosmetic-20260724',
        source_name: '美国 FDA',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '2026-07-24',
        country: '美国',
        fact_summary: ['美国 FDA 公布化妆品召回信息，涉及停止销售、召回批次和消费者退货安排。'],
        legal_signal: '召回信息显示美国渠道对化妆品继续采取批次召回和停止销售处置。',
        business_impact: '影响美国渠道 SKU、批次召回、质量放行、平台店铺和售后沟通。',
        next_observation: ['观察 FDA 后续召回进展、企业整改公告和同类产品警示扩散。'],
        hard_facts: {
          authority: '美国 FDA',
          product_or_batch: '化妆品批次',
          confiscation_result: '停止销售并召回',
          affected_processes: ['SKU/批次管理', '质量放行'],
        },
      }],
    }],
  }, {
    candidates: [
      {
        title: '欢迎访问中华商标网',
        url: 'https://example.org/topic/cosmetics-brand',
        source_name: '中华商标协会',
        country: '中国',
        module: '知识产权动态',
        published_at: '2026-07-24',
        detail_status: 'hydrated',
        evidence_grade: 'lead_only',
        article_text: '欢迎访问中华商标网。化妆品产业专业委员会拟建立品牌指数和商标品牌价值评估体系。',
        hard_facts: {
          authority: '中华商标协会',
        },
      },
      {
        title: '通知公告 更多>>',
        url: 'https://example.org/notices',
        source_name: '广西知识产权局',
        country: '中国',
        module: '知识产权动态',
        published_at: '2026-07-24',
        detail_status: 'hydrated',
        evidence_grade: 'lead_only',
        article_text: '通知公告 更多>> 首页 资讯中心 办事服务 商标法 知识产权公共服务 化妆品商标申请和注册数量等导航列表。',
        hard_facts: {
          authority: '国家知识产权局',
        },
      },
    ],
  });

  assert.equal(delivery.audit.candidateChinaItems, 0);
  assert.equal(delivery.audit.requiredChinaItems, 0);
  assert.equal(delivery.audit.sourceOnlyFallbackItems, 0);
  assert.doesNotMatch(delivery.messages[0].markdown, /欢迎访问中华商标网|通知公告 更多/);
}

function testPremiumDeliveryDoesNotFillChinaShortfallWithForeignCards() {
  const chinaItem = {
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
      deadline: '2026年7月30日',
      affected_processes: ['配方开发', '标签备案', '执行标准选择'],
    },
  };
  const foreignItems = [1, 2].map(index => ({
    title: `美国 FDA 化妆品监管事项 ${index}`,
    source_url: `https://www.fda.gov/cosmetics/${index}`,
    source_name: '美国 FDA',
    source_type: 'official_site',
    authority_type: 'regulator',
    published_at: '2026-07-24',
    country: '美国',
    fact_summary: [`美国 FDA 披露化妆品监管事项 ${index}，涉及标签、报告、召回和渠道处置。`],
    legal_signal: '美国渠道化妆品监管事项。',
    business_impact: '影响美国渠道 SKU、标签、召回、质量放行和平台店铺。',
    next_observation: ['观察 FDA 后续正式文件和执行口径。'],
    hard_facts: {
      authority: '美国 FDA',
      effective_date: '2026-07-24',
      affected_processes: ['美国渠道', '标签', '质量放行'],
    },
  }));

  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-22', end: '2026-07-28' },
    sections: [{ module: '新规及案例动态', items: [chinaItem, ...foreignItems] }],
  }, { candidates: [chinaItem], maxItems: 3 });

  assert.equal(delivery.audit.finalChinaItems, 1);
  assert.equal(delivery.audit.finalItems, 1);
  assert.equal(delivery.audit.chinaShortfall, false);
  assert.doesNotMatch(delivery.messages[0].markdown, /美国 FDA 化妆品监管事项/);
}

function testNonBeautyPlatformPenaltyCannotEnterPremiumCard() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-21', end: '2026-07-27' },
    sections: [{
      module: '广告处罚案例',
      items: [{
        title: '依法查处平台企业垄断行为 推动平台经济高质量发展',
        source_url: 'https://www.samr.gov.cn/xw/mtjj/art/2026/art_platform.html',
        source_name: '国家市场监督管理总局',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '2026-07-25',
        country: '中国',
        fact_summary: ['市场监管总局依法对携程集团有限公司在线酒店预订平台服务市场垄断行为作出行政处罚，没收违法所得16.58亿元，处以罚款35.21亿元。'],
        legal_signal: '风险案例：中国监管信息披露平台反垄断执法风险。',
        business_impact: '影响平台经济经营者竞争合规和渠道治理。',
        next_observation: ['观察同类事项在处罚决定、行政复议、诉讼和平台治理中的后续公开。'],
        hard_facts: {
          authority: '国家市场监督管理总局',
          involved_party: '携程集团有限公司',
          violation_behavior: '在线酒店预订平台服务市场垄断行为',
          penalty_amount: '35.21亿元',
          confiscation_result: '没收违法所得16.58亿元',
          legal_basis: '《反垄断法》',
        },
      }],
    }],
  }, { candidates: [], maxItems: 6 });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testAiInjectedBeautyWordingCannotMakeNonBeautyPenaltyRelevant() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-22', end: '2026-07-28' },
    sections: [{
      module: '广告处罚案例',
      items: [{
        title: '依法查处平台企业垄断行为 推动平台经济高质量发展',
        source_url: 'https://www.samr.gov.cn/xw/mtjj/art/2026/art_65a35a1016e84e3f996bae4d07736e4d.html',
        source_name: '国家市场监督管理总局',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '2026-07-25',
        country: '中国',
        fact_summary: ['市场监管总局依法对携程集团有限公司在线酒店预订平台服务市场垄断行为作出行政处罚，没收违法所得16.58亿元，处以罚款35.21亿元，罚没款合计51.79亿元。'],
        legal_signal: '风险案例：中国监管信息披露化妆品广告、功效宣称、直播或虚假宣传相关执法风险。',
        business_impact: '影响中国市场美妆业务的达人素材/广告宣传、平台店铺/渠道运营。',
        next_observation: ['观察同类事项在处罚决定、行政复议、诉讼和平台治理中的后续公开。'],
        hard_facts: {
          authority: '国家市场监督管理总局',
          involved_party: '携程集团有限公司',
          violation_behavior: '在线酒店预订平台服务市场垄断行为',
          penalty_amount: '35.21亿元',
          confiscation_result: '没收违法所得16.58亿元',
          legal_basis: '《反垄断法》',
        },
      }],
    }],
  }, { candidates: [], maxItems: 6 });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testPortalPageCannotEnterPremiumCardEvenWithInjectedBeautyTerms() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-22', end: '2026-07-28' },
    sections: [{
      module: '广告处罚案例',
      items: [{
        title: '国家市场监督管理总局',
        source_url: 'https://www.samr.gov.cn/',
        source_name: '国家市场监督管理总局',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '2026-07-25',
        country: '中国',
        fact_summary: ['* [新闻](https://www.samr.gov.cn/xw/index.html) * [总局](https://www.samr.gov.cn/xw/zj/index.html) * [市场监管总局依法对携程集团有限公司实施垄断行为作出行政处罚](https://www.samr.gov.cn/xw/zj/art/2026/art_46.html) 07-25 * 召回查询 * 特殊食品信息查询平台 * 注册管理信息系统'],
        legal_signal: '执法趋势：中国监管信息披露化妆品广告、功效宣称、直播或虚假宣传相关执法风险。',
        business_impact: '影响中国市场美妆业务的配方开发、标签备案、执行标准选择、存量SKU过渡期管理。',
        next_observation: ['观察正式稿发布日期、反馈截止日、过渡期安排和执行口径。'],
        hard_facts: {
          authority: '国家市场监督管理总局',
          involved_party: '市场监管总局依法对携程集团有限公司',
          product_or_batch: '食品抽检不合格情况的通报',
          violation_behavior: '执法趋势：中国监管信息披露化妆品广告、功效宣称、直播或虚假宣传相关执法风险',
          penalty_amount: '51.79亿元',
          legal_basis: '《中华人民共和国电子商务法（修正草案征求意见稿）》',
        },
      }],
    }],
  }, { candidates: [], maxItems: 6 });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testSamrPortalDumpCannotEnterPremiumCardWithMixedIndustries() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-22', end: '2026-07-28' },
    sections: [{
      module: '广告处罚案例',
      items: [{
        title: '国家市场监督管理总局',
        source_url: 'https://www.samr.gov.cn/',
        source_name: '国家市场监督管理总局',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '2026-07-25',
        country: '中国',
        fact_summary: [
          '市场监管总局依法对携程集团有限公司实施垄断行为作出行政处罚并责令其全面整改 07-25。市场监管总局公布四起旅游行业不正当竞争典型案件 07-22。北京大兴开展暑期旅游产品质量监督抽查。食品抽检不合格情况的通报。北京市电动自行车产品目录。10家航空公司。',
          '新闻 时政要闻 总局 地方 媒体聚焦 司局介绍 政策法规 通知公告 召回查询 特殊食品信息查询平台 国产进口保健食品注册管理信息系统。',
        ],
        legal_signal: '风险案例：中国监管信息披露化妆品广告、功效宣称、直播或虚假宣传相关执法风险。',
        business_impact: '影响中国市场美妆业务的配方开发、标签备案、执行标准选择、存量SKU过渡期管理。',
        next_observation: ['观察正式稿发布日期、反馈截止日、过渡期安排和执行口径。'],
        evidence_excerpt: [
          '新闻 时政要闻 总局 地方 媒体聚焦 司局介绍 政策法规 通知公告。',
          '市场监管总局依法对携程集团有限公司实施垄断行为作出行政处罚并责令其全面整改。',
          '市场监管总局公布四起旅游行业不正当竞争典型案件。',
          '食品抽检不合格情况的通报。北京市电动自行车产品目录。10家航空公司。',
          '召回查询 缺陷线索报告 特殊食品信息查询平台 国产进口保健食品注册管理信息系统。',
        ].join(' '),
        hard_facts: {
          authority: '国家市场监督管理总局',
          document_number: '征求意见稿',
          involved_party: '市场监管总局依法对携程集团有限公司、推动平台企业赋能个体工商户、肇庆小鹏新能源投资有限公司、斯泰兰蒂斯（上海）汽车有限公司、捷尼赛思汽车销售（上海）有限公司',
          product_or_batch: '食品抽检不合格情况的通报；北京市电动自行车产品目录',
          violation_behavior: '执法趋势：中国监管信息披露化妆品广告、功效宣称、直播或虚假宣传相关执法风险',
          penalty_amount: '51.79亿元',
          confiscation_result: '召回查询；特殊食品信息查询平台；保健食品注册管理信息系统',
          legal_basis: '《中华人民共和国电子商务法（修正草案征求意见稿）》、《金融产品网络营销管理办法》、《殡葬领域明码标价规定（试行）》',
          affected_processes: ['配方开发', '标签备案', '执行标准选择', '存量SKU过渡期管理'],
        },
      }],
    }],
  }, { candidates: [], maxItems: 6 });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testGenericTrademarkCampaignCannotEnterWithoutBeautyEvidence() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-22', end: '2026-07-28' },
    sections: [{
      module: '知识产权动态',
      items: [{
        title: 'begin-->内蒙古自治区市场监督管理局（知识产权局）在全区开展商标行政保护专项行动 end-->',
        source_url: 'https://www.cnipa.gov.cn/art/2026/7/22/art_57_207337.html',
        source_name: '国家知识产权局',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '2026-07-22',
        country: '中国',
        fact_summary: ['自今年7月起，内蒙古自治区市场监督管理局（知识产权局）在全区开展商标行政保护专项行动，全面筑牢商标行政保护屏障。'],
        legal_signal: '执法趋势：中国来源披露商标、专利、著作权或品牌资产保护相关风险。',
        business_impact: '影响中国市场美妆业务的商标授权、包装设计、达人素材、平台店铺。',
        next_observation: ['观察同类事项在处罚决定、行政复议、诉讼和平台治理中的后续公开。'],
        hard_facts: {
          authority: '国家知识产权局',
          legal_basis: '《2026年内蒙古自治区商标行政保护专项行动方案》',
          affected_processes: ['商标授权', '包装设计', '达人素材', '平台店铺'],
        },
      }],
    }],
  }, { candidates: [], maxItems: 6 });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testGenericTrademarkLawTextCannotEnterWithoutBeautyEvidence() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-22', end: '2026-07-28' },
    sections: [{
      module: '知识产权动态',
      items: [{
        title: '中华人民共和国商标法',
        source_url: 'https://www.gippc.com.cn/ippc/zcfg/202607/f6e90f0c88c448128af8a8874920e011.shtml',
        source_name: '广东省知识产权保护中心',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '2026-07-20',
        country: '中国',
        fact_summary: ['中华人民共和国商标法规定，没收侵权商品和主要用于制造侵权商品、伪造注册商标标识的工具，违法经营额五万元以上的，可以并处违法经营额五倍以下的罚款。'],
        legal_signal: '风险案例：中国来源披露商标、专利、著作权或品牌资产保护相关风险。',
        business_impact: '影响中国市场美妆业务的商标授权、包装设计、达人素材、平台店铺。',
        next_observation: ['观察同类事项在处罚决定、行政复议、诉讼和平台治理中的后续公开。'],
        hard_facts: {
          authority: '广东省知识产权保护中心',
          violation_behavior: '任何单位或者个人有权向负责商标管理工作、商标执法的部门投诉、举报',
          confiscation_result: '没收侵权商品和主要用于制造侵权商品、伪造注册商标标识的工具',
          legal_basis: '《中华人民共和国商标法》',
          affected_processes: ['商标授权', '包装设计', '达人素材', '平台店铺'],
        },
      }],
    }],
  }, { candidates: [], maxItems: 6 });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testWeakLabelPackagingWordsCannotCreateBeautyRelevance() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-22', end: '2026-07-28' },
    sections: [{
      module: '知识产权动态',
      items: [{
        title: '中华人民共和国商标法',
        source_url: 'https://www.gippc.com.cn/ippc/zcfg/202607/f6e90f0c88c448128af8a8874920e011.shtml',
        source_name: '广东省知识产权保护中心',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '2026-07-20',
        country: '中国',
        fact_summary: ['商标法涉及商品包装、标签、注册、备案、服务质量和商标管理，违法经营额五万元以上的，可以并处违法经营额五倍以下的罚款。'],
        legal_signal: '风险案例：中国来源披露商标、专利、著作权或品牌资产保护相关风险。',
        business_impact: '影响中国市场美妆业务的商标授权、包装设计、达人素材、平台店铺。',
        next_observation: ['观察同类事项在处罚决定、行政复议、诉讼和平台治理中的后续公开。'],
        hard_facts: {
          authority: '广东省知识产权保护中心',
          violation_behavior: '商标管理相关投诉举报',
          product_or_batch: '商品包装、标签、注册、备案',
          confiscation_result: '没收侵权商品和工具',
          legal_basis: '《中华人民共和国商标法》',
          affected_processes: ['商标授权', '包装设计', '达人素材', '平台店铺'],
        },
      }],
    }],
  }, { candidates: [], maxItems: 6 });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
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
testPremiumDeliveryBuildsChinaCardFromCandidateWhenAiReportDropsChina();
testPremiumDeliveryRequiresMultipleChinaCardsWhenCandidatesAreAvailable();
testPremiumReportItemUsesHardFactDateWhenPublishedAtMissing();
testPremiumChinaMinimumTracksBackfillableAndSourceOnlyChinaCandidates();
testLeadOnlyNavigationPagesCannotBackfillSourceOnlyPremiumCard();
testPremiumDeliveryDoesNotFillChinaShortfallWithForeignCards();
testNonBeautyPlatformPenaltyCannotEnterPremiumCard();
testAiInjectedBeautyWordingCannotMakeNonBeautyPenaltyRelevant();
testPortalPageCannotEnterPremiumCardEvenWithInjectedBeautyTerms();
testSamrPortalDumpCannotEnterPremiumCardWithMixedIndustries();
testGenericTrademarkCampaignCannotEnterWithoutBeautyEvidence();
testGenericTrademarkLawTextCannotEnterWithoutBeautyEvidence();
testWeakLabelPackagingWordsCannotCreateBeautyRelevance();

console.log('premium hard facts tests passed');
