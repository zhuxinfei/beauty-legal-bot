import assert from 'node:assert/strict';
import { assertReportQualityGate } from './quality-gate.js';

assert.throws(
  () => assertReportQualityGate({ period: { start: '2026-07-21', end: '2026-08-04' }, sections: [] }),
  /Premium portfolio gate failed/
);

const modules = [
  '新法律法规政策',
  '广告处罚案例',
  '知识产权保护或者侵权',
  '进出口',
  '产品质量/召回与安全风险',
  '美妆动态',
];
const report = {
  period: { start: '2026-07-21', end: '2026-08-04' },
  sections: modules.map((module, moduleIndex) => ({
    module,
    items: Array.from({ length: 4 }, (_, index) => {
      const eventText = {
        '新法律法规政策': '监管部门发布化妆品标准管理办法，明确2026年8月4日实施和备案过渡期要求。',
        '广告处罚案例': '市场监管部门通报化妆品虚假功效宣传处罚，责令改正并罚款。',
        '知识产权保护或者侵权': '知识产权法院判决化妆品企业侵犯注册商标权，责令停止侵权并赔偿。',
        '进出口': '海关更新进口化妆品清关要求，明确HS编码330499和申报文件。',
        '产品质量/召回与安全风险': '监管部门通报化妆品抽检不合格，责令停止销售并召回相关批次。',
        '美妆动态': '电商平台发布美妆商品治理公告，要求整改功效宣称和店铺素材。',
      }[module];
      return {
      title: `${module}化妆品事项${index + 1}`,
      module,
      source_url: `https://official.example.gov.cn/${moduleIndex}/${index}.html`,
      source_name: '监管公开信息',
      source_type: 'official_site',
      authority_type: 'regulator',
      source_scope: 'hard_fact_endpoint',
      evidence_grade: 'hard_fact_ready',
      detail_status: 'hydrated',
      published_at: '2026-07-30',
      country: '中国',
      facts: [`2026年7月30日，${eventText}`],
      legal_signal: `该事项形成${module}的具体监管要求和法律责任边界。`,
      business_impact: '影响化妆品SKU、标签备案、平台店铺、品牌资产和供应链流程。',
      recommended_action: '法务团队本周核对原文要求，业务团队更新台账并保留整改证据。',
      evidence_text: `2026年7月30日，${eventText}`,
      hard_facts: {
        authority: '监管部门',
        document_number: `2026年第${moduleIndex + 1}-${index + 1}号`,
        involved_party: `测试化妆品企业${moduleIndex}-${index}`,
        product_or_batch: `化妆品批次${moduleIndex}-${index}`,
        violation_behavior: module === '知识产权保护或者侵权' ? '侵犯注册商标权' : '涉及化妆品合规要求',
        penalty_amount: `${index + 1}万元`,
        confiscation_result: '责令改正并停止销售相关批次',
        legal_basis: module === '知识产权保护或者侵权' ? '《商标法》' : '化妆品监管规定',
        hs_code: '330499',
        effective_date: '2026-07-30',
        deadline: '2026-08-04',
        affected_processes: ['标签备案', '平台店铺', '供应链'],
      },
    };
    }),
  })),
};

const passed = assertReportQualityGate(report);
assert.equal(passed.pass, true);
assert.equal(passed.audit.finalItems, 24);
assert.equal(Object.values(passed.audit.finalItemsByModule).every(count => count === 4), true);

console.log('quality gate tests passed');
