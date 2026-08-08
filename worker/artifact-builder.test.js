import assert from 'node:assert/strict';
import { buildArtifactAndAudit, buildSelectedSourceProof } from './artifact-builder.js';

const candidate = {
  title: '某省药监局通报化妆品抽检结果',
  url: 'https://publisher.example/notices/quality-20260717',
  published_at: '2026-07-17',
  source_name: '监管信息报',
  article_text: [
    '2026年7月17日，某省药品监督管理局通报100批次化妆品抽检结果，其中5批次不符合规定，并责令相关单位整改。',
    '公告逐项列明产品名称、备案人、生产企业、批号、检验机构、检验依据和不符合规定项目。监管部门要求属地单位依法调查处理，督促经营者停止销售并落实风险控制措施。',
    '本次抽检覆盖洗发、护发、面部护理等类别，检验项目包括菌落总数、霉菌和酵母菌总数以及禁限用物质。相关企业需要完成原因排查、召回处置和整改复核。',
    '监管部门将继续跟踪涉事单位整改情况，复核进货查验、生产记录和质量管理制度，并依法公开后续行政处理结果。消费者如发现涉事批次仍在销售，可通过监管投诉渠道反映。',
    '公告附件保留了每一批次的注册备案编号和抽样单位，便于企业、渠道和消费者核对产品身份。所有处置要求均以监管部门后续执法文书为准。',
  ].join('').repeat(2),
  detail_status: 'hydrated',
};

function selection(items) {
  return {
    period: { start: '2026-07-13', end: '2026-07-20' },
    thresholds: { items: 1, china_items: 1, modules: 1 },
    items,
  };
}

function testBuildsProofFromUniqueCompleteBodyMatches() {
  const result = buildSelectedSourceProof(
    { candidates: [candidate] },
    selection([{
      url_contains: 'quality-20260717',
      module: '产品质量/召回与安全风险',
      china_relevant: true,
      event_identity: 'cn-province-cosmetics-inspection-20260717',
    }]),
  );

  assert.equal(result.counts.manifest, 1);
  assert.equal(result.counts.primary_count, 1);
  assert.equal(result.counts.china_count, 1);
  assert.equal(result.counts.active_module_count, 1);
  assert.equal(result.proof.pass, true);
  assert.equal(result.candidates[0].article_text, candidate.article_text);
}

function testRejectsMissingOrAmbiguousManifestMatches() {
  assert.throws(
    () => buildSelectedSourceProof(
      { candidates: [candidate] },
      selection([{ url_contains: 'missing', module: '新规及案例动态', china_relevant: false }]),
    ),
    /matched 0 candidates/,
  );

  assert.throws(
    () => buildSelectedSourceProof(
      { candidates: [candidate, { ...candidate, title: '转载标题' }] },
      selection([{ url_contains: 'quality-20260717', module: '新规及案例动态', china_relevant: false }]),
    ),
    /matched 2 candidates/,
  );
}

function testArtifactAuditRequiresBodyBackedEditorialFacts() {
  const sourceProof = buildSelectedSourceProof(
    { candidates: [candidate] },
    selection([{
      url_contains: 'quality-20260717',
      module: '产品质量/召回与安全风险',
      china_relevant: true,
      event_identity: 'cn-province-cosmetics-inspection-20260717',
    }]),
  );
  const editorial = {
    generated_at: '2026-07-20T12:00:00+08:00',
    items: [{
      event_identity: 'cn-province-cosmetics-inspection-20260717',
      title_zh: '某省通报100批次化妆品抽检结果',
      source_zh: '监管信息报',
      summary_zh: '某省药监局通报100批次化妆品抽检结果，5批次不符合规定，并责令相关单位整改。',
      actor: '某省药品监督管理局',
      action: '组织抽检并通报结果',
      result: '100批次中5批次不符合规定，相关单位被责令整改',
      evidence_quotes: ['100批次化妆品抽检结果', '5批次不符合规定', '责令相关单位整改'],
      china_evidence_quotes: ['某省药品监督管理局'],
      follow_up: '关注后续立案处置和整改复检结果。',
    }],
  };

  const { artifact, audit } = buildArtifactAndAudit(sourceProof, editorial, {
    minItems: 1,
    minChinaItems: 1,
    minModules: 1,
  });
  assert.equal(artifact.counts.items, 1);
  assert.equal(audit.proof.pass, true);
  assert.equal(audit.items[0].checks.body_evidence, true);
  assert.equal(artifact.modules['产品质量/召回与安全风险'][0].article_text, candidate.article_text);

  const unsupported = structuredClone(editorial);
  unsupported.items[0].evidence_quotes = ['100批次化妆品抽检结果', '正文里不存在的处罚金额'];
  assert.throws(() => buildArtifactAndAudit(sourceProof, unsupported), /unsupported evidence quote/);
}

testBuildsProofFromUniqueCompleteBodyMatches();
testRejectsMissingOrAmbiguousManifestMatches();
testArtifactAuditRequiresBodyBackedEditorialFacts();
console.log('artifact builder tests ok');
