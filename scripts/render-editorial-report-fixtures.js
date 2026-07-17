import sampleReport from '../worker/sample-report.json' with { type: 'json' };
import { REPORT_MODULES } from '../worker/report-quality.js';
import { renderEditorialReportPng } from './render-editorial-report-png.js';

const TYPES = ['案例', '动态', 'IP', '法规', '进出口', '召回'];
const COUNTRIES = ['中国', '中国', '欧盟', '美国', '日本', '印尼'];

function fixtureItem(index) {
  const base = structuredClone(sampleReport.sections[index % 2].items[0]);
  const module = REPORT_MODULES[index % REPORT_MODULES.length];
  const country = COUNTRIES[index % COUNTRIES.length];
  const type = TYPES[index % TYPES.length];
  const watch = index % 4 === 3;
  return {
    ...base,
    type,
    module,
    country,
    title: `${country}${module}高价值事项 ${index + 1}`,
    source_name: `${country}公开监管来源 ${index + 1}`,
    source_url: `https://example.com/editorial-fixture/${index + 1}`,
    published_at: `2026-07-${String(17 - (index % 6)).padStart(2, '0')}`,
    report_tier: watch ? 'watch' : 'action',
    quality_score: 10 - (index % 3),
    core_judgement: `${country}近期规则或执法信号将影响集团美妆业务的审核、上架与持续运营流程，需要结合适用范围和正式原文确定执行边界。`,
    facts: ['公开材料披露了新的监管事实和业务场景。', '相关要求涉及线上销售、宣传审核或产品准入。'],
    violation_logic: ['监管机关将经营行为、对外表述与法定材料进行一致性比对。'],
    penalty_or_result: ['相关主体被要求停止问题行为并完成整改。'],
    business_lessons: ['同类业务应保留审查记录，并把证据要求前置到上线流程。'],
    what_changed: ['正式文件调整了适用范围、材料或执行节点。'],
    legal_obligation: ['企业应按适用市场核验产品、标签、宣传和供应链材料。'],
    affected_business: [`${country}市场重点 SKU`, '法务、注册、市场和电商团队'],
    market_access_change: ['市场准入或清关材料要求出现调整。'],
    affected_import_flow: ['影响申报、清关、仓配和平台上架流程。'],
    documents_needed: ['需要核验注册、标签、供应商声明和进口证明文件。'],
    dispute_focus: ['争议集中于品牌标识、包装元素或传播素材的权利边界。'],
    infringement_logic: ['应比较权利基础、使用方式、近似程度和消费者混淆可能性。'],
    impact_on_brand_assets: ['影响品牌素材复用、授权管理和争议处置策略。'],
    regulatory_signal: ['行业或平台出现值得持续跟踪的新治理信号。'],
    compliance_meaning: ['该信号可能改变品牌投放、商品审核或合作方管理方式。'],
    business_impact: ['注册备案', '广告投放', '平台运营'],
    market_scope: [`${country}市场`, '重点渠道与 SKU'],
    recommended_actions: watch ? [] : ['建议法务牵头核对正式原文，并由相关专岗更新适用市场的审核清单和证据留存要求。'],
    owner_teams: ['法务', '注册', '市场'],
    watch_value: watch ? '该变化可能提前反映下一阶段监管或平台治理方向，值得保留为决策信号。' : '',
    next_watch_signal: watch ? '观察正式规则、监管问答、平台通知或代表性执法案例是否落地。' : '',
    next_deadline: type === '法规' ? '2026-10-17' : '',
    confidence: watch ? 'medium' : 'high',
    source_type: watch ? 'industry_media' : 'regulator',
    relevance: watch ? 'indirect' : 'direct',
    risk_level: index % 3 === 0 ? 'high' : 'medium',
  };
}

function fixtureReport(count) {
  return {
    period: { start: '2026-07-11', end: '2026-07-17' },
    summary: [],
    risk_alerts: [],
    sections: REPORT_MODULES.map(module => ({
      module,
      items: Array.from({ length: count }, (_, index) => fixtureItem(index)).filter(item => item.module === module),
    })),
  };
}

for (const count of [8, 10, 12]) {
  const outputPath = `out/editorial-report-${count}.png`;
  const png = await renderEditorialReportPng({ report: fixtureReport(count), outputPath });
  console.log(`Generated ${outputPath} (${png.byteLength} bytes)`);
}
