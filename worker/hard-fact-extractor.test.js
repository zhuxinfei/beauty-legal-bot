import assert from 'node:assert/strict';
import { extractHardFacts, gradeEvidence } from './hard-fact-extractor.js';
import { mergeHydratedCandidates, normalizeHydratedRecord } from './source-hydration.js';

function testPenaltyCaseExtractsNamedPartiesAndDisposition() {
  const text = [
    '处罚机关：广州市市场监督管理局。',
    '当事人：广州赫姿化妆品有限公司、广州尚美生物科技有限公司。',
    '违法事实：当事人在香水、彩妆和礼盒商品上冒用爱马仕文字及图形商标。',
    '依据《中华人民共和国商标法》第六十条，罚款63.5万元，没收侵权香水、彩妆及礼盒货品。',
  ].join('');
  const facts = extractHardFacts(text, { source_name: '广州市市场监督管理局', module: '知识产权保护或者侵权' });
  const grade = gradeEvidence({
    text,
    hard_facts: facts,
    source_url: 'https://amr.example.gov.cn/case/hermes-20260724',
    title: '广州赫姿化妆品有限公司、广州尚美生物科技有限公司冒用爱马仕商标，合计罚63.5万元并没收大量货品',
    source_name: '广州市市场监督管理局',
    country: '中国',
  });

  assert.equal(facts.authority, '广州市市场监督管理局');
  assert.equal(facts.involved_party, '广州赫姿化妆品有限公司、广州尚美生物科技有限公司');
  assert.equal(facts.product_or_batch, '香水、彩妆、礼盒商品');
  assert.equal(facts.violation_behavior, '当事人在香水、彩妆和礼盒商品上冒用爱马仕文字及图形商标');
  assert.equal(facts.penalty_amount, '63.5万元');
  assert.match(facts.confiscation_result, /没收侵权香水、彩妆及礼盒货品/);
  assert.match(facts.legal_basis, /《中华人民共和国商标法》第六十条/);
  assert.deepEqual(facts.affected_processes, ['商标授权', '包装设计', '达人素材', '平台店铺']);
  assert.equal(grade.evidence_grade, 'hard_fact_ready');
  assert.match(grade.evidence_quotes.involved_party, /广州赫姿化妆品有限公司/);
}

function testProXylaneCaseExtractsTrademarkAndBrushing() {
  const text = '广州市市场监督管理局披露，当事人广州妍瑟化妆品有限公司在美妆商品宣传中侵权使用玻色因相关商标，同时存在刷单行为，依据《商标法》《反不正当竞争法》处罚金额17万元。';
  const facts = extractHardFacts(text, { source_name: '广州市市场监督管理局', module: '知识产权保护或者侵权' });
  const grade = gradeEvidence({
    text,
    hard_facts: facts,
    source_url: 'https://amr.example.gov.cn/case/pro-xylane-20260724',
    title: '广州妍瑟化妆品有限公司侵权玻色因商标并刷单，被市场监管部门罚款17万元',
    source_name: '广州市市场监督管理局',
    country: '中国',
  });

  assert.equal(facts.involved_party, '广州妍瑟化妆品有限公司');
  assert.match(facts.violation_behavior, /玻色因相关商标/);
  assert.match(facts.violation_behavior, /刷单/);
  assert.equal(facts.penalty_amount, '17万元');
  assert.match(facts.legal_basis, /《商标法》/);
  assert.deepEqual(facts.affected_processes, ['成分卖点命名', '商标授权', '平台店铺运营', '达人素材']);
  assert.equal(grade.evidence_grade, 'hard_fact_ready');
}

function testPolicyExtractsDeadlineFeedbackAndTransition() {
  const text = [
    '国家药品监督管理局就《化妆品标准管理规定（征求意见稿）》公开征求意见。',
    '征求意见稿明确化妆品强制性标准执行、新旧标准衔接和企业参与标准制修订渠道。',
    '意见反馈截止日期：2026年7月30日。',
    '反馈渠道：国家药监局政务服务门户意见征集栏目。',
  ].join('');
  const facts = extractHardFacts(text, { source_name: '国家药品监督管理局', module: '新法律法规政策' });
  const grade = gradeEvidence({
    text,
    hard_facts: facts,
    source_url: 'https://www.nmpa.gov.cn/xxgk/zhqyj/20260724.html',
    title: '化妆品标准新规征求意见，明确标准执行、新旧衔接及企业参与渠道',
    source_name: '国家药品监督管理局',
    country: '中国',
  });

  assert.equal(facts.authority, '国家药品监督管理局');
  assert.equal(facts.document_number, '征求意见稿');
  assert.equal(facts.deadline, '2026年7月30日');
  assert.equal(facts.feedback_channel, '国家药监局政务服务门户意见征集栏目');
  assert.deepEqual(facts.affected_processes, ['配方开发', '标签备案', '执行标准选择', '存量SKU过渡期管理']);
  assert.equal(grade.evidence_grade, 'hard_fact_ready');
}

function testCustomsExtractsHsCodeAndImportProcess() {
  const text = '海关总署公告2026年第18号明确进口化妆品申报资料核验要求，涉及商品编码3304990099、中文标签、备案注册资料、原产地文件和口岸清关资料，自2026年8月1日起实施。';
  const facts = extractHardFacts(text, { source_name: '海关总署', module: '进出口' });
  const grade = gradeEvidence({
    text,
    hard_facts: facts,
    source_url: 'https://www.customs.gov.cn/customs/302249/302266/20260724.html',
    title: '海关发布进口化妆品申报资料核验要求',
    source_name: '海关总署',
    country: '中国',
  });

  assert.equal(facts.authority, '海关总署');
  assert.equal(facts.document_number, '2026年第18号');
  assert.equal(facts.hs_code, '3304990099');
  assert.equal(facts.effective_date, '2026年8月1日');
  assert.deepEqual(facts.affected_processes, ['进口申报', '清关', '原产地文件', '中文标签', '供应链履约']);
  assert.equal(grade.evidence_grade, 'hard_fact_ready');
}

function testLeadOnlyAndGenericPagesCannotEnterPremiumEvidence() {
  const leadText = '欢迎访问中华商标网。中华商标协会化妆品产业专业委员会拟搭建企业国际合作平台，建立品牌指数和商标品牌价值评估体系。';
  const facts = extractHardFacts(leadText, { source_name: '中华商标协会', module: '知识产权保护或者侵权' });
  const grade = gradeEvidence({
    text: leadText,
    hard_facts: facts,
    source_url: 'https://example.org/topic/cosmetics-brand',
    title: '欢迎访问中华商标网',
    source_name: '中华商标协会',
    country: '中国',
  });

  assert.notEqual(grade.evidence_grade, 'hard_fact_ready');
  assert.equal(grade.evidence_grade, 'lead_only');
}

function testHydrationRecordCarriesEvidenceGradeAndQuotes() {
  const record = normalizeHydratedRecord({
    source_url: 'https://amr.example.gov.cn/case/pro-xylane-20260724',
    title: '广州妍瑟化妆品有限公司侵权玻色因商标并刷单，被罚17万元',
    source_name: '广州市市场监督管理局',
    country: '中国',
    module: '知识产权保护或者侵权',
    fit_markdown: '当事人广州妍瑟化妆品有限公司侵权使用玻色因相关商标，同时存在刷单行为，依据《商标法》《反不正当竞争法》处罚金额17万元。',
    attachment_records: [{
      url: 'https://amr.example.gov.cn/case/pro-xylane-20260724.pdf',
      title: '行政处罚决定书附件',
      article_text: '处罚机关：广州市市场监督管理局。',
    }],
  });

  assert.equal(record.evidence_grade, 'hard_fact_ready');
  assert.match(record.evidence_reason, /hard-facts=/);
  assert.equal(record.hard_facts.involved_party, '广州妍瑟化妆品有限公司');
  assert.match(record.evidence_quotes.penalty_amount, /17万元/);
  assert.equal(record.attachment_records[0].extraction_status, 'hydrated');
}

function testHydrationMergeAuditReportsEvidenceGrades() {
  const merged = mergeHydratedCandidates([{
    url: 'https://amr.example.gov.cn/case/pro-xylane-20260724',
    title: '候选',
    country: '中国',
  }, {
    url: 'https://example.org/topic/cosmetics-brand',
    title: '线索',
    country: '中国',
  }], [{
    source_url: 'https://amr.example.gov.cn/case/pro-xylane-20260724',
    title: '广州妍瑟化妆品有限公司侵权玻色因商标并刷单，被罚17万元',
    source_name: '广州市市场监督管理局',
    country: '中国',
    module: '知识产权保护或者侵权',
    article_text: '当事人广州妍瑟化妆品有限公司侵权使用玻色因相关商标，同时存在刷单行为，依据《商标法》《反不正当竞争法》处罚金额17万元。',
  }, {
    source_url: 'https://example.org/topic/cosmetics-brand',
    title: '欢迎访问中华商标网',
    source_name: '中华商标协会',
    country: '中国',
    module: '知识产权保护或者侵权',
    article_text: '欢迎访问中华商标网。化妆品产业专业委员会拟建立品牌指数和商标品牌价值评估体系。',
  }]);

  assert.equal(merged.audit.hardFactReady, 1);
  assert.equal(merged.audit.chinaHardFactReady, 1);
  assert.equal(merged.audit.leadOnly, 1);
  assert.equal(merged.candidates[0].evidence_grade, 'hard_fact_ready');
}

testPenaltyCaseExtractsNamedPartiesAndDisposition();
testProXylaneCaseExtractsTrademarkAndBrushing();
testPolicyExtractsDeadlineFeedbackAndTransition();
testCustomsExtractsHsCodeAndImportProcess();
testLeadOnlyAndGenericPagesCannotEnterPremiumEvidence();
testHydrationRecordCarriesEvidenceGradeAndQuotes();
testHydrationMergeAuditReportsEvidenceGrades();

console.log('hard fact extractor tests passed');
