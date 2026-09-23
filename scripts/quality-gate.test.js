import assert from 'node:assert/strict';
import { assertReportQualityGate, assertCiReportGate } from './quality-gate.js';

// --- CI 硬门槛（assertCiReportGate）---
// 这个函数决定客户最终收不收得到报告（返回即渲染 PDF + 推钉钉，抛错则整期不推送），
// 原先没有单测覆盖。2026-09-15 把硬门槛从「核心类目」改成「总量下限」后补上。
const ciCard = (module, index) => ({
  module,
  title: `测试卡片 ${index}`,
  source_url: `https://example.com/${index}`,
  legal_signal: '测试法务观察内容足够长以通过最小长度校验。',
  business_impact: '测试业务影响内容足够长以通过最小长度校验。',
  recommended_action: '测试行动建议内容足够长以通过最小长度校验。',
  facts: ['测试事实要点一', '测试事实要点二'],
});
const ciCards = count => Array.from({ length: count }, (_, index) => ciCard(
  index % 2 === 0 ? '新法律法规政策' : '产品质量/召回与安全风险',
  index,
));

// 低于硬下限 → 必须抛错（否则会推一份空壳报告给客户）
assert.throws(
  () => assertCiReportGate({ cards: ciCards(5) }, { minItems: 8, warnItems: 15, minLegalItems: 2, minCoreItems: 8 }),
  /items=5 < 8/,
);
// 低于目标值但高于硬下限 → 放行 + low-supply 告警
const thin = assertCiReportGate({ cards: ciCards(10) }, { minItems: 8, warnItems: 15, minLegalItems: 2, minCoreItems: 8 });
assert.equal(thin.pass, true);
assert.ok(thin.warnings.some(w => w.includes('low-supply')));
assert.equal(thin.warnItems, 15);
// 核心类目不足只告警、不再抛错（2026-09-15 起 core 降为参考）：
// 9 张全在非核心模块（美妆动态）→ core 0 < 8，但 items 9 ≥ 硬下限 8，必须放行。
const lowCore = assertCiReportGate(
  { cards: Array.from({ length: 9 }, (_, index) => ciCard('美妆动态', index)) },
  { minItems: 8, warnItems: 15, minLegalItems: 2, minCoreItems: 8 },
);
assert.equal(lowCore.pass, true);
assert.ok(lowCore.warnings.some(w => w.includes('core-items')));
// 达到目标值 → 无 low-supply 告警
const full = assertCiReportGate({ cards: ciCards(16) }, { minItems: 8, warnItems: 15, minLegalItems: 2, minCoreItems: 8 });
assert.equal(full.pass, true);
assert.equal(full.warnings.some(w => w.includes('low-supply')), false);

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
