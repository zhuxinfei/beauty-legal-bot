import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAnalysisPrompt, extractPremiumDeliveryFingerprints } from './index.js';
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

function testCorroboratedMediaCandidateStillNeedsAndPassesPremiumHardFacts() {
  const candidate = {
    title: '广州妍瑟化妆品有限公司侵权玻色因商标并刷单，被罚17万元',
    url: 'https://media-a.example/legal/pro-xylane',
    source_url: 'https://media-a.example/legal/pro-xylane',
    source_name: '专业法务媒体',
    source_type: 'discovered_publisher',
    authority_type: 'media',
    source_scope: 'discovered_article',
    evidence_grade: 'corroborated_fact_ready',
    verification_status: 'corroborated',
    supporting_sources: [
      { host: 'media-a.example', url: 'https://media-a.example/legal/pro-xylane' },
      { host: 'media-b.example', url: 'https://media-b.example/legal/pro-xylane' },
    ],
    agreed_anchors: ['parties', 'amounts', 'products_or_batches'],
    detail_status: 'hydrated',
    module: '知识产权动态',
    country: '中国',
    published_at: '2026-07-24',
    article_text: '市场监管信息显示，广州妍瑟化妆品有限公司侵权使用玻色因相关商标并刷单，被罚17万元，涉及含玻色因卖点的化妆品。',
    hard_facts: {
      authority: '市场监督管理部门',
      involved_party: '广州妍瑟化妆品有限公司',
      violation_behavior: '侵权使用玻色因相关商标并刷单',
      penalty_amount: '17万元',
      legal_basis: '《商标法》',
      product_or_batch: '含玻色因卖点的化妆品',
    },
  };
  const single = buildPremiumDingTalkDelivery({ period: { start: '2026-07-17', end: '2026-07-31' }, sections: [] }, {
    candidates: [{ ...candidate, evidence_grade: 'lead_only', verification_status: 'unverified', supporting_sources: candidate.supporting_sources.slice(0, 1), agreed_anchors: [] }],
    allowSourceOnlyFallback: true,
  });
  assert.equal(single.audit.finalItems, 0);
  const verified = buildPremiumDingTalkDelivery({ period: { start: '2026-07-17', end: '2026-07-31' }, sections: [] }, {
    candidates: [candidate],
    allowSourceOnlyFallback: true,
  });
  assert.equal(verified.audit.finalItems, 1);
  assert.match(verified.messages[0].markdown, /广州妍瑟化妆品有限公司/);
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

function testQualityModeDoesNotShortCircuitAfterHardFactSeeds() {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(source, /const directHardFactMode = env\.HARD_FACT_DIRECT_DELIVERY === '1';/);
  assert.doesNotMatch(source, /qualityMode\s*&&\s*env\.HARD_FACT_DIRECT_DELIVERY/);
}

function testQualityModeUsesStrictSourceOnlyBackfillAndFullModuleCoverage() {
  const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
  assert.match(source, /const DEFAULT_ANALYSIS_BATCHES_PER_MODULE = 6;/);
  assert.match(source, /allowSourceOnlyFallback:\s*qualityMode/);
  const workflow = readFileSync(new URL('../.github/workflows/weekly.yml', import.meta.url), 'utf8');
  assert.match(workflow, /REPORT_TARGET_ITEMS:\s*20/);
}

function testPremiumMarkdownCompactsPageChromeAndOversizedFactLines() {
  const longFact = `## 国家药监局发布化妆品检验方法公告 | 下载 打印 | 分享到微信 | 发布时间：2026-05-29 ${'国家药监局组织起草检验方法并经审查通过后予以发布。'.repeat(18)}`;
  const markdown = buildPremiumDingTalkMarkdown({
    period: { start: '2026-07-25', end: '2026-07-31' },
    cards: [{
      title: '国家药监局发布化妆品检验方法公告',
      module: '新法律法规政策',
      source_url: 'https://www.nmpa.gov.cn/xxgk/ggtg/20260529150154170.html',
      source_name: '国家药品监督管理局',
      published_at: '2026-05-29',
      country: '中国',
      facts: [longFact],
      legal_signal: '检验方法纳入化妆品安全技术规范并设置实施日期。',
      business_impact: '影响化妆品检验方法引用、质量放行和备案资料。',
      recommended_action: '观察2027年3月1日实施后的检验口径和配套问答。',
      hard_facts: {
        authority: '国家药品监督管理局',
        document_number: '2026年第51号',
        product_or_batch: '化妆品中三价铬和六价铬的检验方法',
        effective_date: '2027-03-01',
      },
    }],
  });
  assert.equal(markdown.includes('分享到微信'), false);
  assert.equal(markdown.includes('  - ##'), false);
  assert.ok(Math.max(...markdown.split('\n').map(line => line.length)) <= 260);
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
          product_or_batch: '化妆品标准管理规则',
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
        product_or_batch: '化妆品标准管理规则',
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

function testHardFactReadyEndpointSurvivesNavigationChrome() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-21', end: '2026-07-29' },
    sections: [{
      module: '新法律法规政策',
      items: [{
        title: '化妆品标准栏目',
        source_url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/index.html',
        source_name: '中检院',
        source_type: 'official_site',
        authority_type: 'regulator',
        published_at: '2026-07-21',
        country: '中国',
        fact_summary: ['首页 通知公告 更多 化妆品标准。'],
        legal_signal: '来源信号：新增义务：中国权威来源披露化妆品规则、标准、备案、注册或执行口径的具体变化。',
        business_impact: '影响中国市场美妆产品标签、备案注册、广告素材、平台上架和存量SKU管理。',
        next_observation: ['观察正式文件、执行口径、配套问答和后续监管公开。'],
      }],
    }],
  }, {
    candidates: [{
      title: '中检院关于公开征求《化妆品中铜绿假单胞菌的检验方法（征求意见稿）》等2项化妆品标准意见的通知',
      url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
      source_url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
      source_name: '中检院化妆品标准通知公告',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      country: '中国',
      module: '新规及案例动态',
      published_at: '2026-07-21',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '首页 通知公告 更多 中检院关于公开征求《化妆品中铜绿假单胞菌的检验方法（征求意见稿）》等2项化妆品标准意见的通知。中检院公开征求化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准意见，意见反馈截止日期：2026年8月10日，反馈渠道：中检院化妆品标准制修订联系邮箱。',
      hard_facts: {
        authority: '中检院',
        document_number: '征求意见稿',
        deadline: '2026年8月10日',
        feedback_channel: '中检院化妆品标准制修订联系邮箱',
        product_or_batch: '化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准',
        affected_processes: ['配方开发', '检验标准', '质量放行', '备案资料'],
      },
    }],
    maxItems: 6,
  });

  assert.equal(delivery.audit.candidateChinaItems, 1);
  assert.equal(delivery.audit.finalChinaItems, 1);
  assert.match(delivery.messages[0].markdown, /铜绿假单胞菌/);
  assert.doesNotMatch(delivery.messages[0].markdown, /首页 通知公告 更多/);
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
      ...(index === 0 ? {
        document_number: '征求意见稿',
        product_or_batch: '化妆品标准管理规则',
        deadline: '2026年7月30日',
      } : {}),
      ...(index === 1 ? {
        involved_party: '广州妍瑟化妆品有限公司',
        product_or_batch: '含玻色因卖点的美妆商品',
        violation_behavior: '侵权使用玻色因相关商标并存在刷单行为',
        penalty_amount: '17万元',
      } : {}),
      ...(index === 2 ? {
        document_number: '进口化妆品申报资料核验要求',
        product_or_batch: '进口化妆品',
        hs_code: '3304990099',
      } : {}),
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
  assert.match(markdown, /化妆品标准新规征求意见/);
  assert.match(markdown, /广州市监局披露商家侵权玻色因商标并刷单处罚17万元/);
  assert.doesNotMatch(markdown, /美国 FDA 化妆品监管事项/);
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
          product_or_batch: '化妆品标准管理规则',
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
          product_or_batch: '化妆品标准管理规则',
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
          product_or_batch: '含玻色因卖点的美妆商品',
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

function testFormalRunPortalAndFormPagesCannotEnterPremiumDelivery() {
  const candidates = [
    {
      title: '粤港澳知识产权大数据综合服务平台',
      url: 'https://www.gpic.gd.cn/',
      source_name: '广东省知识产权保护中心',
      source_type: 'official_site',
      authority_type: 'regulator',
      country: '中国',
      module: '知识产权动态',
      published_at: '2026-07-28',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '粤港澳知识产权大数据综合服务平台 数据查询 产业创新 统计监控 教育培训 欧盟商标查询系统 外观专利检索 快捷检索 高级检索 全部 专利 商标 地理标志 集成电路 友情链接 国家知识产权局。',
      hard_facts: {
        authority: '国家知识产权局',
        involved_party: '原文未披露',
      },
    },
    {
      title: '证明商标使用申请表',
      url: 'https://member.cta.org.cn/application/read',
      source_name: '中华商标协会',
      source_type: 'official_site',
      authority_type: 'association',
      country: '中国',
      module: '知识产权动态',
      published_at: '本期',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '证明商标使用申请表 证明商标使用申请表 填写说明 一、建立代理流程情况 说明建立了委托代理、立案建档、案件经办、复核纠错、官文回馈等商标代理服务流程相关情况。',
      hard_facts: {
        authority: '中华商标协会',
        involved_party: '原文未披露',
      },
    },
    {
      title: '浙江省市场监管发展研究中心（浙江省平台经济监测中心/浙江省广告监测中心）',
      url: 'http://www.zjmyjj.cn/portalnews/index.html',
      source_name: '浙江省广告监测中心',
      source_type: 'official_site',
      authority_type: 'regulator',
      country: '中国',
      module: '美妆动态',
      published_at: '本期',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '通知公告 人才招聘 首页 资讯中心 平台经济监测 广告监测 newstype=1005 浙江方圆检测集团股份有限公司。',
      hard_facts: {
        authority: '国家市场监督管理总局',
        involved_party: '浙江方圆检测集团股份有限公司',
      },
    },
  ];
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [],
  }, { candidates, maxItems: 6 });

  assert.equal(delivery.audit.candidateChinaItems, 0);
  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testStaticCosmeticsReferencePagesCannotEnterPremiumDeliveryWithoutFreshEvent() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [{
      module: '新法律法规政策',
      items: [{
        title: 'Modernization of Cosmetics Regulation Act of 2022 (MoCRA)',
        source_url: 'https://www.fda.gov/cosmetics/cosmetics-laws-regulations/modernization-cosmetics-regulation-act-2022-mocra',
        source_name: '美国 FDA Cosmetics',
        source_type: 'official_site',
        authority_type: 'regulator',
        country: '美国',
        published_at: '本期',
        fact_summary: ['Background on the Modernization of Cosmetics Regulation Act of 2022 (MoCRA). On average people use 6 to 12 cosmetics products daily. Key Terms Adverse Event Facility Responsible Person Serious Adverse Event.'],
        legal_signal: '来源信号：新增义务：中国权威来源披露化妆品规则、标准、备案、注册或执行口径的具体变化。',
        business_impact: '影响中国市场美妆产品标签、备案注册、广告素材、平台上架和存量SKU管理。',
        next_observation: ['观察正式文件、执行口径、配套问答和后续监管公开。'],
        evidence_excerpt: 'Background on the Modernization of Cosmetics Regulation Act of 2022 (MoCRA). Key Terms Adverse Event Facility Responsible Person Serious Adverse Event.',
        hard_facts: {
          authority: '美国 FDA Cosmetics',
          affected_processes: ['标签', '备案/注册', '不良事件监测'],
        },
      }],
    }],
  }, { candidates: [], maxItems: 6 });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
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
      product_or_batch: '化妆品标准管理规则',
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

function testCandidateBackfillCannotUseTemplateLegalObservation() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [],
  }, {
    maxItems: 1,
    candidates: [{
      title: '中检院公开征求2项化妆品检验方法标准意见',
      url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
      source_name: '中检院化妆品标准通知公告',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      country: '中国',
      module: '新规及案例动态',
      published_at: '2026-07-21',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '中检院公开征求化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准意见，意见反馈截止日期：2026年8月10日，反馈渠道：中检院化妆品标准制修订联系邮箱。标准涉及化妆品检验方法、质量放行、备案资料和存量SKU过渡期管理。',
      hard_facts: {
        authority: '中检院',
        document_number: '征求意见稿',
        deadline: '2026年8月10日',
        feedback_channel: '中检院化妆品标准制修订联系邮箱',
        product_or_batch: '化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准',
        affected_processes: ['检验标准', '质量放行', '备案资料', '存量SKU过渡期管理'],
      },
    }],
  });

  assert.equal(delivery.audit.finalItems, 1);
  const markdown = delivery.messages[0].markdown;
  assert.match(markdown, /意见反馈截止日期：2026年8月10日|截止：2026年8月10日/);
  assert.doesNotMatch(markdown, /来源信号|中国权威来源披露|中国来源披露|监管信息披露|当前仅能确认|待核验/);
  assert.match(markdown, /反馈截止/);
  assert.match(markdown, /检验标准|质量放行|备案资料/);
}

function testSourceOnlyFallbackIsDisabledForFormalDingTalkDelivery() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [],
  }, {
    maxItems: 3,
    candidates: [{
      title: '中国化妆品监管线索汇总',
      url: 'https://example.gov.cn/cosmetics/signals/20260729',
      source_name: '监管部门',
      source_type: 'official_site',
      authority_type: 'regulator',
      country: '中国',
      module: '新规及案例动态',
      published_at: '2026-07-29',
      detail_status: 'hydrated',
      evidence_grade: 'lead_only',
      article_text: '监管部门出现化妆品标准、标签备案、配方开发、执行标准选择、存量SKU过渡期管理等多个信号，企业应持续关注正式文件、执行口径、配套问答和后续监管公开。',
      hard_facts: {
        authority: '监管部门',
        document_number: '征求意见稿',
        deadline: '2026年8月10日',
        affected_processes: ['配方开发', '标签备案', '执行标准选择'],
      },
    }],
  });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.audit.sourceOnlyFallbackItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testNifdcCosmeticStandardNoticeDoesNotRenderNavigationOrWrongModule() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [{
      module: '进出口动态',
      items: [{
        title: '中检院关于公开征求《化妆品中铜绿假单胞菌的检验方法（征求意见稿）》等2项化妆品标准意见的通知',
        source_url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
        source_name: '中检院化妆品微生物标准征求意见',
        source_type: 'official_site',
        authority_type: 'regulator',
        source_scope: 'hard_fact_endpoint',
        evidence_grade: 'hard_fact_ready',
        country: '中国',
        published_at: '2026-07-21',
        fact_summary: [
          '中检院关于公开征求《化妆品中铜绿假单胞菌的检验方法（征求意见稿）》《化妆品中乙醇等40种原料的检验方法（征求意见稿）》意见。',
          '[https://www.nifdc.org.cn/directory/web/nifdc/index.html](https://www.nifdc.org.cn/directory/web/nifdc/index.html) 网站首页 机构概况 人才队伍 党群工作 信息公开 办事大厅 业务咨询 建言献策 院介绍 院领导 组织机构 能力资质 联系方式 院士 首席专家 药检菁英 党建要闻 党风廉政 群团统战 纪检举报 法规政策 公告通知 数据查询 化妆品审评 国家抽检管理 医疗器械标准与分类管理。',
        ],
        legal_signal: '来源信号：新增义务：中国来源披露进口、出口、海关、清关或市场准入相关事项。',
        business_impact: '影响中国市场美妆业务的配方开发、标签备案、执行标准选择、存量SKU过渡期管理。',
        next_observation: ['观察正式稿发布日期、反馈截止日、过渡期安排和执行口径。'],
        hard_facts: {
          authority: '国家市场监督管理总局',
          document_number: '征求意见稿',
          legal_basis: '《化妆品中铜绿假单胞菌的检验方法（征求意见稿）》《化妆品中乙醇等40种原料的检验方法（征求意见稿）》',
        },
      }],
    }],
  }, { candidates: [], maxItems: 3 });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testQualifiedNifdcCosmeticStandardNoticeRendersCleanPolicyCard() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [{
      module: '新规及案例动态',
      items: [{
        title: '中检院公开征求2项化妆品检验方法标准意见',
        source_url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
        source_name: '中检院化妆品标准通知公告',
        source_type: 'official_site',
        authority_type: 'regulator',
        source_scope: 'hard_fact_endpoint',
        evidence_grade: 'hard_fact_ready',
        country: '中国',
        published_at: '2026-07-21',
        fact_summary: [
          '中检院公开征求化妆品中铜绿假单胞菌、耐热大肠菌群检验方法等2项标准意见，反馈截止日期为2026年8月10日。',
          '[https://www.nifdc.org.cn/directory/web/nifdc/index.html](https://www.nifdc.org.cn/directory/web/nifdc/index.html) 网站首页 机构概况 人才队伍 党群工作 信息公开 办事大厅 业务咨询 数据查询 化妆品审评 国家抽检管理 医疗器械标准与分类管理。',
        ],
        legal_signal: '化妆品检验方法标准进入公开征求意见阶段，微生物检验和原料检验方法会影响备案资料、检验标准和质量放行。',
        business_impact: '影响化妆品配方开发、检验标准选择、质量放行、备案资料和存量 SKU 过渡期管理。',
        next_observation: ['观察正式稿发布日期、反馈截止日、标准过渡期安排和检验机构执行口径。'],
        hard_facts: {
          authority: '中检院',
          document_number: '征求意见稿',
          product_or_batch: '化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准',
          deadline: '2026年8月10日',
          feedback_channel: '中检院化妆品标准制修订联系邮箱',
          affected_processes: ['配方开发', '检验标准选择', '质量放行', '备案资料', '存量SKU过渡期管理'],
        },
      }],
    }],
  }, { candidates: [], maxItems: 3 });

  assert.equal(delivery.audit.finalItems, 1);
  const markdown = delivery.messages[0].markdown;
  assert.match(markdown, /## 新法律法规政策/);
  assert.match(markdown, /机关：中检院/);
  assert.match(markdown, /截止：2026年8月10日/);
  assert.doesNotMatch(markdown, /国家市场监督管理总局/);
  assert.doesNotMatch(markdown, /进出口/);
  assert.doesNotMatch(markdown, /directory\/web\/nifdc\/index\.html|网站首页|机构概况|人才队伍|党群工作|信息公开|办事大厅|医疗器械标准与分类管理/);
  assert.doesNotMatch(markdown, /来源信号|中国权威来源披露|中国来源披露|监管信息披露/);
}

function testHardFactCandidateBackfillsWhenAiReportItemsAreNavigationOnly() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [{
      module: '进出口动态',
      items: [{
        title: '中检院关于公开征求《化妆品中铜绿假单胞菌的检验方法（征求意见稿）》等2项化妆品标准意见的通知',
        source_url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
        source_name: '中检院化妆品微生物标准征求意见',
        source_type: 'official_site',
        authority_type: 'regulator',
        country: '中国',
        published_at: '2026-07-21',
        fact_summary: ['[https://www.nifdc.org.cn/directory/web/nifdc/index.html](https://www.nifdc.org.cn/directory/web/nifdc/index.html) 网站首页 机构概况 人才队伍 党群工作 信息公开 办事大厅 化妆品审评 国家抽检管理 医疗器械标准与分类管理。'],
        legal_signal: '来源信号：中国来源披露进口、出口、海关、清关或市场准入相关事项。',
        business_impact: '影响中国市场美妆业务的进口开发、标签备案、出口清关、清关资料和市场准入相关事项。',
        next_observation: ['观察正式文件、执行口径、配套问答和后续监管公开。'],
        hard_facts: {
          authority: '国家市场监督管理总局',
          document_number: '征求意见稿',
        },
      }],
    }],
  }, {
    maxItems: 3,
    candidates: [{
      title: '中检院公开征求2项化妆品检验方法标准意见',
      url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
      source_name: '中检院化妆品标准通知公告',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      country: '中国',
      module: '新规及案例动态',
      published_at: '2026-07-21',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '中检院公开征求化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准意见，意见反馈截止日期：2026年8月10日，反馈渠道：中检院化妆品标准制修订联系邮箱。标准涉及化妆品检验方法、质量放行、备案资料和存量SKU过渡期管理。',
      hard_facts: {
        authority: '中检院',
        document_number: '征求意见稿',
        product_or_batch: '化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准',
        deadline: '2026年8月10日',
        feedback_channel: '中检院化妆品标准制修订联系邮箱',
        affected_processes: ['检验标准', '质量放行', '备案资料', '存量SKU过渡期管理'],
      },
    }],
  });

  assert.equal(delivery.audit.finalItems, 1);
  assert.equal(delivery.audit.finalChinaItems, 1);
  const markdown = delivery.messages[0].markdown;
  assert.match(markdown, /## 新法律法规政策/);
  assert.match(markdown, /机关：中检院/);
  assert.match(markdown, /截止：2026年8月10日/);
  assert.doesNotMatch(markdown, /进出口|国家市场监督管理总局|来源信号|网站首页|机构概况|医疗器械标准与分类管理/);
}

function testHardFactCandidateReplacesSameKeyWeakReportCard() {
  const title = '中检院公开征求2项化妆品检验方法标准意见';
  const url = 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html';
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [{
      module: '新规及案例动态',
      items: [{
        title,
        source_url: url,
        source_name: '中检院化妆品标准通知公告',
        source_type: 'official_site',
        authority_type: 'regulator',
        country: '中国',
        published_at: '2026-07-21',
        fact_summary: ['中检院公开征求2项化妆品检验方法标准意见。'],
        legal_signal: '监管信息披露：需要关注相关标准变化。',
        business_impact: '影响中国市场美妆业务的备案/注册。',
        next_observation: ['观察正式文件、执行口径和配套问答。'],
        hard_facts: {
          authority: '中检院',
          document_number: '征求意见稿',
        },
      }],
    }],
  }, {
    maxItems: 3,
    candidates: [{
      title,
      url,
      source_name: '中检院化妆品标准通知公告',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      country: '中国',
      module: '新规及案例动态',
      published_at: '2026-07-21',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '中检院公开征求化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准意见，意见反馈截止日期：2026年8月10日，反馈渠道：中检院化妆品标准制修订联系邮箱。标准涉及化妆品检验方法、质量放行、备案资料和存量SKU过渡期管理。',
      hard_facts: {
        authority: '中检院',
        document_number: '征求意见稿',
        product_or_batch: '化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准',
        deadline: '2026年8月10日',
        feedback_channel: '中检院化妆品标准制修订联系邮箱',
        affected_processes: ['检验标准', '质量放行', '备案资料', '存量SKU过渡期管理'],
      },
    }],
  });

  assert.equal(delivery.audit.finalItems, 1);
  const markdown = delivery.messages[0].markdown;
  assert.match(markdown, /反馈渠道：中检院化妆品标准制修订联系邮箱/);
  assert.doesNotMatch(markdown, /监管信息披露|影响中国市场美妆业务的备案\/注册/);
}

function testHardFactCandidatesCanRenderDirectlyWithoutAiReportItems() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [],
  }, {
    maxItems: 6,
    candidates: [{
      title: '中检院公开征求2项化妆品检验方法标准意见，反馈截止至2026年8月10日',
      url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
      source_url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
      source_name: '中检院化妆品标准通知公告',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      country: '中国',
      module: '新法律法规政策',
      published_at: '2026-07-21',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '中检院公开征求化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准意见，意见反馈截止日期：2026年8月10日，反馈渠道：中检院化妆品标准制修订联系邮箱。标准涉及化妆品检验方法、质量放行、备案资料和存量SKU过渡期管理。',
      hard_facts: {
        authority: '中检院',
        document_number: '征求意见稿',
        product_or_batch: '化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准',
        deadline: '2026年8月10日',
        feedback_channel: '中检院化妆品标准制修订联系邮箱',
        affected_processes: ['检验标准', '质量放行', '备案资料', '存量SKU过渡期管理'],
      },
    }],
  });

  assert.equal(delivery.audit.reportItems, 0);
  assert.equal(delivery.audit.finalItems, 1);
  assert.equal(extractPremiumDeliveryFingerprints(delivery.cards).length, 1);
  const markdown = delivery.messages[0].markdown;
  assert.match(markdown, /本期精选 1 条/);
  assert.ok(markdown.includes('- **事实依据**'));
  assert.match(markdown, /机关：中检院/);
  assert.match(markdown, /反馈渠道：中检院化妆品标准制修订联系邮箱/);
  assert.doesNotMatch(markdown, /Crawl4AI|建议动作|法务判断|来源信号|待核验|网站首页/);
}

function testAcceptedHardFactCandidateIsNotDroppedBySecondSampleGate() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [],
  }, {
    maxItems: 3,
    candidates: [{
      title: '中检院公开征求2项化妆品检验方法标准意见，反馈截止至2026年8月10日',
      url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
      source_name: '中检院化妆品标准通知公告',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      country: '中国',
      module: '新法律法规政策',
      published_at: '2026-07-21',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '中检院公开征求化妆品检验方法标准意见，反馈截止日期为2026年8月10日。[](javascript:void(0)) 标准涉及质量放行、备案资料和存量SKU过渡期管理。',
      hard_facts: {
        authority: '中检院',
        document_number: '征求意见稿',
        product_or_batch: '化妆品检验方法标准',
        deadline: '2026年8月10日',
        affected_processes: ['质量放行', '备案资料', '存量SKU过渡期管理'],
      },
    }],
  });

  assert.equal(delivery.audit.candidateChinaItems, 1);
  assert.equal(delivery.audit.finalChinaItems, 1);
  assert.equal(delivery.audit.finalItems, 1);
  assert.match(delivery.messages[0].markdown, /化妆品检验方法标准/);
  assert.doesNotMatch(delivery.messages[0].markdown, /javascript:void|\[\]\(/);
  assert.doesNotThrow(() => assertPremiumChinaDelivery(delivery.audit));
}

function testHardFactCandidateUsesTitleWhenCrawlTextStartsWithNavigation() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [],
  }, {
    maxItems: 3,
    candidates: [{
      title: '中检院关于公开征求《化妆品中铜绿假单胞菌的检验方法（征求意见稿）》等2项化妆品标准意见的通知',
      url: 'https://www.nifdc.org.cn/directory/web/nifdc/bshff/hzhpbzh/hzhpbzhtzgg/202607211930582131911.html',
      source_name: '中检院化妆品标准通知公告',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      country: '中国',
      module: '新规及案例动态',
      published_at: '2026-07-21',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '首页 通知公告 更多 网站首页 机构概况 人才队伍 党群工作 信息公开 办事大厅 业务咨询 建言献策 院介绍 院领导 组织机构 能力资质 联系方式 院士 首席专家 药检菁英 党建要闻 党风廉政 群团统战 纪检举报 法规政策 公告通知 数据查询 化妆品审评 国家抽检管理 医疗器械标准与分类管理',
      hard_facts: {
        authority: '中检院',
        document_number: '征求意见稿',
        product_or_batch: '化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准',
        deadline: '2026年8月10日',
        feedback_channel: '中检院化妆品标准制修订联系邮箱',
        affected_processes: ['检验标准', '质量放行', '备案资料', '存量SKU过渡期管理'],
      },
    }],
  });

  assert.equal(delivery.audit.finalItems, 1);
  const markdown = delivery.messages[0].markdown;
  assert.match(markdown, /## 新法律法规政策/);
  assert.match(markdown, /机关：中检院/);
  assert.match(markdown, /产品\/批次：化妆品中铜绿假单胞菌、耐热大肠菌群检验方法标准/);
  assert.doesNotMatch(markdown, /来源信号|待核验|网站首页|机构概况|医疗器械标准与分类管理/);
}

function testBrokenHardFactFragmentsCannotEnterPremiumCard() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [],
  }, {
    maxItems: 6,
    candidates: [{
      title: '国家药监局关于40批次不符合规定化妆品的通告（2026年第19号）',
      url: 'https://www.nmpa.gov.cn/xxgk/ggtg/hzhpggtg/hzhpchjgg/hzhpcjgjj/20260522162510165.html',
      source_url: 'https://www.nmpa.gov.cn/xxgk/ggtg/hzhpggtg/hzhpchjgg/hzhpcjgjj/20260522162510165.html',
      source_name: '福建省药监局化妆品监管动态',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      country: '中国',
      module: '新法律法规政策',
      published_at: '2026-07-17',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '国家药监局关于40批次不符合规定化妆品的通告（2026年第19号） [](javascript:void(0)) 经广东省药品监督管理局 的，依法严肃查处。',
      hard_facts: {
        authority: '经广东省药品监督管理局',
        document_number: '2026年第19号',
        product_or_batch: '不符合规定化妆品的通告（2026年第19号） [](',
        violation_behavior: '的，依法严肃查处',
        legal_basis: '《化妆品监督管理条例》、《化妆品生产经营监督管理办法》、《化妆品抽样检验管理办法》',
        affected_processes: ['标签', '备案/注册', 'SKU/批次管理'],
      },
    }],
  });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testNoticeTitleCannotBeUsedAsProductBatch() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [],
  }, {
    maxItems: 6,
    candidates: [{
      title: '国家药监局关于40批次不符合规定化妆品的通告（2026年第19号）',
      url: 'https://www.nmpa.gov.cn/xxgk/ggtg/hzhpggtg/hzhpchjgg/hzhpcjgjj/20260522162510165.html',
      source_url: 'https://www.nmpa.gov.cn/xxgk/ggtg/hzhpggtg/hzhpchjgg/hzhpcjgjj/20260522162510165.html',
      source_name: '福建省药监局化妆品监管动态',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      country: '中国',
      module: '新法律法规政策',
      published_at: '2026-07-17',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '国家药监局关于40批次不符合规定化妆品的通告（2026年第19号）。2026-05-22 福建省药监局召开药品精透监管会议。',
      hard_facts: {
        authority: '福建省药监局化妆品监管动态',
        document_number: '2026年第19号',
        product_or_batch: '不符合规定化妆品的通告（2026年第19号） 2026-05-22 福建省药监局召开药品“精透监管”',
        legal_basis: '《化妆品监督管理条例》',
        affected_processes: ['标签', '备案/注册', 'SKU/批次管理'],
      },
    }],
  });

  assert.equal(delivery.audit.finalItems, 0);
  assert.equal(delivery.messages.length, 0);
}

function testNmpaTitleRepairsRepublishedListChrome() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [],
  }, {
    maxItems: 6,
    candidates: [{
      title: '国家药监局关于发布化妆品新原料注册备案及资料管理规定的公告（2026年第59号）',
      url: 'https://www.nmpa.gov.cn/xxgk/fgwj/xzhgfxwj/20260626114523130.html',
      source_url: 'https://www.nmpa.gov.cn/xxgk/fgwj/xzhgfxwj/20260626114523130.html',
      source_name: '福建省药监局化妆品监管动态',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      country: '中国',
      module: '新法律法规政策',
      published_at: '2026-07-17',
      detail_status: 'hydrated',
      evidence_grade: 'hard_fact_ready',
      article_text: '国家药监局关于发布化妆品新原料注册备案及资料管理规定的公告（2026年第59号）。2026-05-22 福建省药监局召开药品“精透监管”。',
      hard_facts: {
        authority: '福建省药监局化妆品监管动态',
        document_number: '2026年第59号',
        product_or_batch: '不符合规定化妆品的通告（2026年第19号） 2026-05-22 福建省药监局召开药品“精透监管”',
        legal_basis: '《化妆品中三价铬和六价铬的检验方法》',
        affected_processes: ['备案/注册'],
      },
    }],
  });

  assert.equal(delivery.audit.finalItems, 1);
  const markdown = delivery.messages[0].markdown;
  assert.match(markdown, /机关：国家药品监督管理局/);
  assert.match(markdown, /产品\/批次：化妆品新原料注册备案及资料管理规定/);
  assert.match(markdown, /配方开发|备案资料|资料管理|存量SKU过渡期管理/);
  assert.doesNotMatch(markdown, /福建省药监局召开|不符合规定化妆品的通告/);
  assert.doesNotMatch(markdown, /纳入规则或标准管理|影响中国市场美妆业务的备案\/注册/);
}

function testCandidateSourceAndDateAreCanonicalizedFromOfficialUrl() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-23', end: '2026-07-29' },
    sections: [],
  }, {
    candidates: [{
      title: '关于发布《化妆品新原料注册备案资料管理规定》的公告',
      url: 'https://www.nmpa.gov.cn/xxgk/fgwj/xzhgfxwj/20260626114523130.html',
      source_url: 'https://www.nmpa.gov.cn/xxgk/fgwj/xzhgfxwj/20260626114523130.html',
      source_name: '福建省药监局化妆品监管动态',
      source_scope: 'hard_fact_endpoint',
      source_type: 'official_site',
      authority_type: 'regulator',
      country: '中国',
      module: '新规及案例动态',
      evidence_grade: 'hard_fact_ready',
      article_text: '国家药监局发布《化妆品新原料注册备案资料管理规定》，自2026年8月1日起施行，涉及化妆品新原料注册备案资料、过渡期和新旧衔接安排。',
      hard_facts: {
        authority: '国家药品监督管理局',
        document_number: '公告',
        product_or_batch: '化妆品新原料注册备案资料管理规定',
        effective_date: '2026-08-01',
        affected_processes: ['配方开发', '备案/注册', '存量SKU过渡期管理'],
      },
    }],
    maxItems: 1,
  });
  assert.equal(delivery.audit.finalItems, 1);
  const markdown = delivery.messages[0].markdown;
  assert.match(markdown, /来源\*\*：国家药品监督管理局 \/ 中国 \/ 2026-08-01/);
  assert.doesNotMatch(markdown, /来源\*\*：福建省药监局化妆品监管动态/);
}

function testCandidateDateFallsBackToOfficialUrlDateInsteadOfBlankSourceDate() {
  const delivery = buildPremiumDingTalkDelivery({
    period: { start: '2026-07-24', end: '2026-07-30' },
    sections: [],
  }, {
    candidates: [{
      title: '国家药监局关于发布化妆品新原料注册备案及资料管理规定的公告（2026年第59号）',
      url: 'https://www.nmpa.gov.cn/xxgk/fgwj/xzhgfxwj/20260626114523130.html',
      source_name: '福建省药监局化妆品监管动态',
      source_scope: 'hard_fact_endpoint',
      source_type: 'official_site',
      authority_type: 'regulator',
      country: '中国',
      module: '新规及案例动态',
      evidence_grade: 'hard_fact_ready',
      article_text: '国家药监局发布化妆品新原料注册备案及资料管理规定，涉及化妆品新原料注册备案资料、配方开发、备案注册、资料管理和存量SKU过渡期管理。',
      hard_facts: {
        authority: '国家药品监督管理局',
        document_number: '2026年第59号',
        product_or_batch: '化妆品新原料注册备案及资料管理规定',
        affected_processes: ['配方开发', '备案注册', '资料管理', '存量SKU过渡期管理'],
      },
    }],
    maxItems: 1,
  });

  assert.equal(delivery.audit.finalItems, 1);
  const markdown = delivery.messages[0].markdown;
  assert.match(markdown, /来源\*\*：国家药品监督管理局 \/ 中国 \/ 2026-06-26/);
  assert.match(markdown, /新原料注册备案资料|配方开发|备案资料|资料管理|存量SKU过渡期管理/);
  assert.doesNotMatch(markdown, /来源\*\*：[^\\n]+ \/ 中国 \/  \/ \[原文\]/);
  assert.doesNotMatch(markdown, /纳入规则或标准管理|影响中国市场美妆业务的备案\/注册/);
}

testHydrationExtractsActionableHardFacts();
testFormalPromptsRequireAllPremiumHardFactFields();
testPremiumMarkdownRendersNewHardFactsInFormalCard();
testCorroboratedMediaCandidateStillNeedsAndPassesPremiumHardFacts();
testPremiumMarkdownInfersAffectedProcessesFromEvidence();
testManualWorkflowRunsAreNotArtifactOnlyByDefault();
testQualityModeDoesNotShortCircuitAfterHardFactSeeds();
testQualityModeUsesStrictSourceOnlyBackfillAndFullModuleCoverage();
testPremiumMarkdownCompactsPageChromeAndOversizedFactLines();
testPremiumDeliveryFallsBackInsteadOfSendingEmptyCard();
testManualBaselineGetsOnlyConcreteClarifications();
testFormalReportItemUsesEvidenceTextForFinalQuality();
testPremiumSelectionKeepsChinaAheadOfHigherScoredForeignItems();
testPremiumDeliveryBackfillsQualifiedChinaItemWhenStrictSelectionIsForeignOnly();
testPremiumDeliveryBuildsChinaCardFromCandidateWhenAiReportDropsChina();
testHardFactReadyEndpointSurvivesNavigationChrome();
testPremiumDeliveryRequiresMultipleChinaCardsWhenCandidatesAreAvailable();
testPremiumReportItemUsesHardFactDateWhenPublishedAtMissing();
testPremiumChinaMinimumTracksBackfillableAndSourceOnlyChinaCandidates();
testLeadOnlyNavigationPagesCannotBackfillSourceOnlyPremiumCard();
testFormalRunPortalAndFormPagesCannotEnterPremiumDelivery();
testStaticCosmeticsReferencePagesCannotEnterPremiumDeliveryWithoutFreshEvent();
testPremiumDeliveryDoesNotFillChinaShortfallWithForeignCards();
testNonBeautyPlatformPenaltyCannotEnterPremiumCard();
testAiInjectedBeautyWordingCannotMakeNonBeautyPenaltyRelevant();
testPortalPageCannotEnterPremiumCardEvenWithInjectedBeautyTerms();
testSamrPortalDumpCannotEnterPremiumCardWithMixedIndustries();
testGenericTrademarkCampaignCannotEnterWithoutBeautyEvidence();
testGenericTrademarkLawTextCannotEnterWithoutBeautyEvidence();
testWeakLabelPackagingWordsCannotCreateBeautyRelevance();
testCandidateBackfillCannotUseTemplateLegalObservation();
testSourceOnlyFallbackIsDisabledForFormalDingTalkDelivery();
testNifdcCosmeticStandardNoticeDoesNotRenderNavigationOrWrongModule();
testQualifiedNifdcCosmeticStandardNoticeRendersCleanPolicyCard();
testHardFactCandidateBackfillsWhenAiReportItemsAreNavigationOnly();
testHardFactCandidateReplacesSameKeyWeakReportCard();
testHardFactCandidatesCanRenderDirectlyWithoutAiReportItems();
testAcceptedHardFactCandidateIsNotDroppedBySecondSampleGate();
testHardFactCandidateUsesTitleWhenCrawlTextStartsWithNavigation();
testBrokenHardFactFragmentsCannotEnterPremiumCard();
testNoticeTitleCannotBeUsedAsProductBatch();
testNmpaTitleRepairsRepublishedListChrome();
testCandidateSourceAndDateAreCanonicalizedFromOfficialUrl();
testCandidateDateFallsBackToOfficialUrlDateInsteadOfBlankSourceDate();

console.log('premium hard facts tests passed');
