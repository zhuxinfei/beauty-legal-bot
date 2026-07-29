import { extractHardFacts } from './hard-fact-extractor.js';

const UTF8_ENCODER = new TextEncoder();
const MODULE_ORDER = [
  '新法律法规政策',
  '广告处罚案例',
  '知识产权保护或者侵权',
  '进出口',
  '产品质量/召回与安全风险',
  '美妆动态',
];

const MODULE_ALIAS = {
  '新规及案例动态': '新法律法规政策',
  '广告合规及处罚案例': '广告处罚案例',
  '知识产权动态': '知识产权保护或者侵权',
  '进出口动态': '进出口',
};

const GENERIC_PATTERNS = /建议关注|持续关注|企业应留意|可能产生影响|后续观察|待进一步明确|视情况|适时/i;
const CONCRETE_PATTERNS = /(20\d{2}|发布|公布|通报|处罚|罚款|召回|判决|裁定|征求意见|生效|实施|备案|注册|禁用|限用|进口|出口|海关|监管|法院|委员会|药监|市场监管|快速预警|危险非食品|rapid alert|dangerous non-food|Safety Gate|FDA|FTC|BPOM|MFDS|EUIPO|WIPO|\d+(?:\.\d+)?\s*(?:万|亿|元|美元|欧元|件|批|天|%|％))/i;
const OWNER_PATTERN = /法务|合规|法规|质量|研发|供应链|采购|电商|广告|品牌|市场|知识产权|IP|进出口|关务|注册|备案|产品|渠道|海外|本地团队/;
const REPUBLISHER_HOST_PATTERN = /(?:^|\.)((?:sohu|163|sina|qq|toutiao|baijiahao|thepaper|jiemian|36kr)\.com|(?:baijiahao|mp)\.baidu\.com)$/i;
const MEDIA_SOURCE_TYPES = new Set(['industry_media', 'media', 'wechat_lead', 'wechat_public_account']);
const NAVIGATION_TITLE_PATTERN = /^(?:(?:欢迎访问|欢迎来到).+|(?:网站首页|首页|站点导航|登录|注册|搜索|联系我们|栏目|专题|新闻中心|通知公告|工作动态|化妆品|Cosmetics|Home|Welcome|Menu|Search)(?:$|[\s｜|:：_-].*))/i;
const GENERIC_INFO_PAGE_PATTERN = /(?:安全使用|消费者提示|消费提示|使用提示|科普|问答|常见问题|指南页面|专题页|栏目页|监管入口|信息入口|Q&A|questions?\s+and\s+answers?|how\s+to\s+use|safe\s+use|cosmetics\s+safety)/i;
const PORTAL_EVIDENCE_PATTERN = /(?:\* \[新闻\]|\* \[首页\]|javascript:void|司局介绍|时政要闻|地方\]\(|媒体聚焦|重要政策举措及实施效果|召回查询|信息查询平台|注册管理信息系统|数据查询|产业创新|统计监控|快捷检索|高级检索|友情链接|用户需求与满意度调查|证明商标使用申请表|填写说明|查看更多|通知公告\s*更多)/i;
const HARD_LEGAL_EVENT_PATTERN = /(?:文号|公告|通告|通报|征求意见|反馈截止|截止日期|截止|生效|实施|过渡期|新旧衔接|行政处罚|处罚决定|罚款|罚没|没收|违法所得|责令改正|吊销|停止销售|召回|警示信|warning\s+letter|判决|裁定|赔偿|侵权|冒用|假冒|刷单|虚假交易|商标|专利|著作权|海关|口岸|报关|清关|HS\s*编码|进口|出口|禁用|限用|15\s*个?工作日|serious\s+adverse\s+event|mandatory\s+report)/i;
const BEAUTY_RELEVANCE_PATTERN = /(?:化妆品|美妆|护肤|彩妆|香水|口红|面膜|洗护|防晒|染发|染眉|染睫|美容|医美|祛斑|美白|功效宣称|玻色因|爱马仕|配方|着色剂|色素|进口化妆品|出口化妆品|化妆品标准|cosmetic|cosmetics|MoCRA|color additives?)/i;
const GENERIC_NON_BEAUTY_PATTERN = /(?:在线酒店|酒店预订|机票|旅游|平台经济|外卖|网约车|金融监管|证券|外汇|房地产|教育培训|医疗器械|药品集采|保险|银行|携程|美团|阿里巴巴|腾讯|京东|滴滴)/i;
const PREMIUM_JUNK_EVIDENCE_PATTERN = /(?:欢迎访问|通知公告\s*更多|首页\s+资讯中心|栏目导航|工作委员会|专业委员会名单|证明商标使用申请表|填写说明|粤港澳知识产权大数据综合服务平台|快捷检索|高级检索|友情链接|用户需求与满意度调查问卷|政府侧应用与数据需求调研问卷)/i;
const BROKEN_FIELD_PATTERN = /(?:\[\s*\]\s*\(|\]\($|\(\s*$|\[\s*$|javascript:void|undefined|null|NaN|>\s*$|<\s*$)/i;
const FRAGMENT_FIELD_PATTERN = /^(?:的|和|及|并|依法|予以|进行|相关|上述|该|此|其|对|将|已|了)[，,、；;\s]*(?:依法)?(?:严肃查处|处理|监管|处罚|执行|实施|发布|通告|公告)?$/;
const DOCUMENT_TITLE_AS_PRODUCT_PATTERN = /(?:关于)?(?:\d+\s*批次)?(?:不符合规定)?化妆品的(?:公告|通告)[（(]20\d{2}年第\d+号[）)](?:\s|$)/;
const MIXED_NOTICE_CHROME_PATTERN = /20\d{2}[-年]\d{1,2}[-月]\d{1,2}.*(?:召开|工作动态|监管动态|新闻|会议|活动|培训|论坛|检查)/;

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function utf8Bytes(value) {
  return UTF8_ENCODER.encode(String(value || '')).length;
}

function sanitizeBriefingText(value) {
  return text(value)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label) => /^https?:\/\//i.test(label) ? '' : label)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bbegin-->\s*/gi, '')
    .replace(/\s*end-->\b/gi, '')
    .replace(/Crawl4AI\s*(?:抓取到|提取到|发现|显示|返回)?/gi, '')
    .replace(/(?:本工具|本系统|本文|笔者|本人)(?:认为|判断|看到|发现|建议)?/g, '')
    .replace(/(?:我们|咱们)(?:认为|判断|看到|发现|注意到|建议|可)?/g, '')
    .replace(/对我们的/g, '对')
    .replace(/我们的/g, '')
    .replace(/我国/g, '中国')
    .replace(/\bI\b|\bwe\b|\bour\b|\bmy\b|\bme\b/gi, '')
    .replace(/\s+/g, ' ')
    .replace(/^[，,。；;：:\s]+/, '')
    .trim();
}

function normalizeModule(value) {
  const module = text(value);
  return MODULE_ALIAS[module] || module || '美妆动态';
}

function list(value) {
  return (Array.isArray(value) ? value : [value]).map(text).filter(Boolean);
}

function uniqueValues(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values.map(text).filter(Boolean)) {
    const key = value.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function extractCompanyNames(value = '') {
  const source = text(value);
  const companyPattern = /([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,40}?(?:有限责任公司|股份有限公司|有限公司|个体工商户|工作室|商行|公司))/g;
  const matches = [
    ...Array.from(source.matchAll(new RegExp(`(?:^|[，,。；;\\s：:、])${companyPattern.source}`, 'g'))).map(match => ({ name: match[1], index: match.index })),
    ...Array.from(source.matchAll(new RegExp(`(?:当事人|被处罚人|涉案主体|原告|被告|申请人|被申请人|披露|认定|处罚|罚没|没收)[：:\\s]*${companyPattern.source}`, 'g'))).map(match => ({ name: match[1], index: match.index })),
  ]
    .sort((a, b) => a.index - b.index)
    .map(match => text(match.name)
      .replace(/^.*?(?:披露|通报|认定|处罚)/, '')
      .replace(/^(?:当事人|被处罚人|涉案主体|原告|被告|申请人|被申请人)[：:\s]*/, ''))
    .filter(name => !/市场监督管理局|药品监督管理局|国家知识产权局|海关|人民法院|委员会|协会|监管部门/.test(name));
  return uniqueValues(matches).slice(0, 4);
}

function isVagueInvolvedParty(value = '') {
  const source = text(value);
  return !source
    || /原文未披露|未披露|未明确|待明确|未知/.test(source)
    || /^(?:涉案|相关|部分|多家|两家|若干|某些|有关)?(?:主体|商家|企业|公司|经营者|经营主体|美妆企业|化妆品企业)$/.test(source);
}

function meaningfulInvolvedParty(value = '') {
  const source = hardText(value);
  return source && !isVagueInvolvedParty(source) ? source : '';
}

function hardText(value) {
  const source = text(value);
  if (!source || /见原文|未知|待核验|未披露|未明确|待明确|空$/.test(source)) return '';
  if (BROKEN_FIELD_PATTERN.test(source) || FRAGMENT_FIELD_PATTERN.test(source)) return '';
  if (DOCUMENT_TITLE_AS_PRODUCT_PATTERN.test(source) || MIXED_NOTICE_CHROME_PATTERN.test(source)) return '';
  return source;
}

function normalizeHardFacts(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  return {
    document_number: hardText(input.document_number),
    authority: hardText(input.authority),
    penalty_amount: hardText(input.penalty_amount),
    confiscation_result: hardText(input.confiscation_result),
    legal_basis: hardText(input.legal_basis),
    violation_behavior: hardText(input.violation_behavior),
    involved_party: hardText(input.involved_party),
    product_or_batch: hardText(input.product_or_batch),
    hs_code: hardText(input.hs_code),
    effective_date: hardText(input.effective_date),
    deadline: hardText(input.deadline),
    feedback_channel: hardText(input.feedback_channel),
    risk_tier: text(input.risk_tier),
    signal_type: text(input.signal_type),
    affected_processes: list(input.affected_processes),
    owner_teams: list(input.owner_teams),
    action_deadline: text(input.action_deadline),
  };
}

function inferSignalType(value) {
  const source = text(value);
  if (/规划|计划|专项行动|工作方案|会议审议/i.test(source)) return '执法趋势';
  if (/处罚|罚款|行政处罚|判决|裁定|侵权行为|构成侵权|违法|召回|不合格/i.test(source)) return '风险案例';
  if (/海关|关税|HS\s*编码|进口|出口|清关|报关|备案|注册|禁用|限用|生效|实施|征求意见|办法|规定|公告/i.test(source)) return '新增义务';
  if (/入口|监测|预警|Safety Gate|rapid alert/i.test(source)) return '观察入口';
  return '执法趋势';
}

function inferRiskTier(value) {
  const source = text(value);
  if (/处罚|罚款|行政处罚|召回|不合格|立即|3日内|三日内|截止|生效|违法/i.test(source)) return '立即处理';
  if (/海关|关税|HS\s*编码|进口|出口|清关|报关|备案|注册|商标|知识产权|判决|裁定|公告|办法|规定|本周/i.test(source)) return '本周排查';
  return '持续监测';
}

function inferAffectedProcesses(value) {
  const source = text(value);
  const rules = [
    [/标签|标识|包装标注|中文标签/i, '标签'],
    [/备案|注册|备案资料|注册资料/i, '备案/注册'],
    [/进口申报|报关|清关|口岸|海关|检验检疫|原产地/i, '进口申报/清关'],
    [/达人|直播|脚本|种草|短视频|广告素材|详情页|功效宣称|宣传/i, '达人素材/广告宣传'],
    [/商标|授权|品牌授权|包装装潢|礼盒/i, '商标授权/包装设计'],
    [/SKU|批次|召回|下架|停止销售|抽检|不合格/i, 'SKU/批次管理'],
    [/配方|成分|禁用|限用|标准|检验|质量放行/i, '配方/检验标准'],
    [/平台店铺|电商|跨境|渠道|天猫|抖音|小红书|亚马逊/i, '平台店铺/渠道运营'],
  ];
  return uniqueValues(rules.filter(([pattern]) => pattern.test(source)).map(([, label]) => label));
}

function firstMatch(value, patterns) {
  const source = String(value || '');
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return text(match[1]).replace(/[。；;，,]$/, '');
  }
  return '';
}

function isoDate(value = '') {
  const source = text(value);
  const iso = source.match(/20\d{2}-\d{1,2}-\d{1,2}/)?.[0];
  if (iso) {
    const [year, month, day] = iso.split('-').map(Number);
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  const cn = source.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日?/);
  if (cn) {
    return `${cn[1]}-${String(Number(cn[2])).padStart(2, '0')}-${String(Number(cn[3])).padStart(2, '0')}`;
  }
  const compact = source.match(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:\d{4,}|[^\d]|$)/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return '';
}

function candidateDisplayDate(candidate = {}, hardFacts = {}, source = '') {
  return isoDate(candidate.published_at)
    || isoDate(candidate.updated_at)
    || isoDate(candidate.created_at)
    || isoDate(candidate.date)
    || isoDate(hardFacts.effective_date)
    || isoDate(hardFacts.deadline)
    || isoDate(source);
}

function inferViolationBehavior(value) {
  const source = text(value);
  return firstMatch(source, [
    /(?:违法事实|违法行为|主要违法事实|侵权行为|违法情形)[：:\s]*([^。；;\n]{6,120})/,
    /([^。；;\n]{4,120}(?:侵权|冒用|假冒|刷单|虚假交易|虚假宣传|未经授权|擅自使用)[^。；;\n]{0,80})/,
  ]);
}

function inferConfiscationResult(value) {
  return firstMatch(value, [
    /((?:没收|罚没|销毁|责令下架|下架|停止销售|召回)[^。；;\n]{2,120})/,
  ]);
}

function inferFeedbackChannel(value) {
  return firstMatch(value, [
    /(?:反馈渠道|反馈方式|意见反馈|提交方式|电子邮箱|邮箱|联系人|邮寄地址)[：:\s]*([^。；;\n]{4,120})/,
    /((?:电子邮箱|邮箱|邮寄地址|联系人)[：:\s]*[^。；;\n]{4,120})/,
  ]);
}

function withInferredHardFacts(hardFacts, card) {
  const source = [
    card.evidence_text,
    card.title,
    card.facts,
    card.business_impact,
  ].flat().join('。');
  const companyNames = extractCompanyNames(source);
  const needsPartyDisclosure = ['广告处罚案例', '知识产权保护或者侵权'].includes(normalizeModule(card.module));
  const involvedParty = isVagueInvolvedParty(hardFacts.involved_party)
    ? (companyNames.length ? companyNames.join('、') : needsPartyDisclosure ? '原文未披露' : '')
    : hardFacts.involved_party;
  return {
    ...hardFacts,
    involved_party: involvedParty,
    signal_type: hardFacts.signal_type || inferSignalType(source),
    risk_tier: hardFacts.risk_tier || inferRiskTier(source),
    affected_processes: hardFacts.affected_processes.length ? hardFacts.affected_processes : inferAffectedProcesses(source),
    violation_behavior: hardFacts.violation_behavior || inferViolationBehavior(source),
    confiscation_result: hardFacts.confiscation_result || inferConfiscationResult(source),
    feedback_channel: hardFacts.feedback_channel || inferFeedbackChannel(source),
  };
}

function authorityFromCanonicalSource(candidate = {}) {
  const url = text(candidate.source_url || candidate.url);
  const title = text(candidate.title);
  if (/nmpa\.gov\.cn/i.test(url) || /^国家药监局/.test(title)) return '国家药品监督管理局';
  if (/nifdc\.org\.cn/i.test(url) || /^中检院/.test(title)) return '中检院';
  if (/customs\.gov\.cn/i.test(url) || /^海关/.test(title)) return '海关总署';
  return '';
}

function sourceNameFromCanonicalSource(candidate = {}) {
  const url = text(candidate.source_url || candidate.url);
  const title = text(candidate.title);
  if (/nmpa\.gov\.cn/i.test(url) || /^国家药监局/.test(title)) return '国家药品监督管理局';
  if (/nifdc\.org\.cn/i.test(url) || /^中检院/.test(title)) return '中检院';
  if (/fda\.gov/i.test(url)) return '美国食品药品监督管理局';
  if (/ftc\.gov/i.test(url)) return '美国联邦贸易委员会';
  if (/gov\.uk/i.test(url)) return '英国政府产品安全通报';
  if (/recalls-rappels\.canada\.ca|healthycanadians\.gc\.ca/i.test(url)) return '加拿大卫生部';
  if (/fda\.gov\.tw/i.test(url)) return '台湾卫福部食药署';
  if (/customs\.gov\.cn/i.test(url) || /^海关/.test(title)) return '海关总署';
  return text(candidate.source_name || candidate.name);
}

function policyProductFromTitle(title = '') {
  const source = text(title);
  return firstMatch(source, [
    /关于发布《([^》]{4,80})》的(?:公告|通告|通知)/,
    /关于公开征求《([^》]{4,80})》(?:等\d+项)?(?:化妆品)?(?:标准)?意见的通知/,
    /关于发布([^，。]{4,80}?(?:规定|办法|标准|规范|要求|清单|目录|检验方法))的(?:公告|通告|通知)/,
  ]);
}

function normalizeCandidateHardFacts(candidate = {}, facts = {}) {
  const titleProduct = policyProductFromTitle(candidate.title);
  const authority = authorityFromCanonicalSource(candidate);
  const next = { ...facts };
  if (authority) next.authority = authority;
  if (titleProduct && (!hardText(next.product_or_batch) || DOCUMENT_TITLE_AS_PRODUCT_PATTERN.test(text(next.product_or_batch)))) {
    next.product_or_batch = titleProduct;
  }
  if (authority === '国家药品监督管理局' && /化妆品监督管理条例|化妆品生产经营监督管理办法|化妆品抽样检验管理办法/.test(text(candidate.article_text || candidate.full_text || candidate.evidence_text))) {
    next.legal_basis = firstMatch(text(candidate.article_text || candidate.full_text || candidate.evidence_text), [
      /(《化妆品监督管理条例》(?:、《化妆品生产经营监督管理办法》)?(?:、《化妆品抽样检验管理办法》)?)/,
    ]) || next.legal_basis;
  }
  return normalizeHardFacts(next);
}

function compactHardFacts(facts = {}, keys = []) {
  return keys
    .map(([key, label]) => facts[key] ? `${label}：${facts[key]}` : '')
    .filter(Boolean);
}

function objectiveHardFactCount(hardFacts = {}) {
  return [
    hardFacts.document_number,
    hardFacts.authority,
    hardFacts.penalty_amount,
    hardFacts.confiscation_result,
    hardFacts.legal_basis,
    hardFacts.violation_behavior,
    meaningfulInvolvedParty(hardFacts.involved_party),
    hardFacts.product_or_batch,
    hardFacts.hs_code,
    hardFacts.effective_date,
    hardFacts.deadline,
    hardFacts.feedback_channel,
  ].filter(value => hardText(value)).length;
}

function hasConcreteDateAnchor(card = {}) {
  const hard = card.hard_facts || {};
  return /(?:20\d{2}[-年/.]\d{1,2}(?:[-月/.]\d{1,2})?|20\d{6})/.test(text([
    card.published_at,
    card.source_url,
    hard.effective_date,
    hard.deadline,
    card.evidence_text,
    card.facts,
  ].flat().join(' ')));
}

function hasSampleGradeHardFactBundle(card = {}) {
  const hard = card.hard_facts || {};
  const module = normalizeModule(card.module);
  const source = factualEvidenceTextForCard(card);
  const hasAuthority = Boolean(hardText(hard.authority) || hardText(card.source_name));
  const hasParty = Boolean(meaningfulInvolvedParty(hard.involved_party) || extractCompanyNames(source).length);
  const hasAct = Boolean(hardText(hard.violation_behavior) || /违法事实|侵权使用|刷单|冒用|假冒|虚假交易|违反|被处罚|处罚金额|罚款/.test(source));
  const hasOutcome = Boolean(hardText(hard.penalty_amount) || hardText(hard.confiscation_result));
  const hasRuleBasis = Boolean(hardText(hard.legal_basis) || hardText(hard.document_number));
  const hasPolicyNode = Boolean(hardText(hard.document_number) || hardText(hard.effective_date) || hardText(hard.deadline) || hardText(hard.feedback_channel));
  const hasProduct = Boolean(hardText(hard.product_or_batch));
  const hasProductOrFlow = Boolean(hasProduct || hard.affected_processes?.length);

  if (!hasAuthority || !hasConcreteDateAnchor(card)) return false;
  if (['广告处罚案例', '知识产权保护或者侵权'].includes(module)) {
    return hasParty && hasAct && (hasOutcome || hasRuleBasis) && hasProduct;
  }
  if (module === '产品质量/召回与安全风险') {
    return hasProduct && (hasOutcome || hasAct || hasPolicyNode) && /召回|停止销售|抽检|不合格|污染|警示|warning|recall|adverse|contamination/i.test(source);
  }
  if (module === '新法律法规政策') {
    return hasPolicyNode && hasProduct && /征求意见|反馈截止|生效|实施|过渡期|新旧衔接|发布|公告|通告|修订|标准|规则|办法|条例|法案|requirement|regulation|rule/i.test(source);
  }
  if (module === '进出口') {
    return (hasPolicyNode || hardText(hard.hs_code) || hasOutcome) && (hasProduct || hardText(hard.hs_code)) && /海关|进口|出口|口岸|报关|清关|HS\s*编码|扣留|detention/i.test(source);
  }
  return (hasPolicyNode || hasOutcome) && hasProductOrFlow;
}

function hasHardLegalEvent(card) {
  const hard = card.hard_facts || {};
  const source = factualEvidenceTextForCard(card);
  if (hasSampleGradeHardFactBundle(card)) return true;
  if ((hard.penalty_amount || hard.confiscation_result) && meaningfulInvolvedParty(hard.involved_party) && hard.violation_behavior) return true;
  if ((hard.document_number || hard.effective_date || hard.deadline || hard.hs_code) && objectiveHardFactCount(hard) >= 3 && HARD_LEGAL_EVENT_PATTERN.test(source)) return true;
  return false;
}

function isNavigationOrGenericInformationPage(card) {
  const title = text(card.title);
  if (NAVIGATION_TITLE_PATTERN.test(title)) return true;
  const source = sourceTextForCard(card);
  if (isHardFactReadyDetailCard(card)) return false;
  if (PORTAL_EVIDENCE_PATTERN.test(source)) return true;
  if (!GENERIC_INFO_PAGE_PATTERN.test([title, source].join(' '))) return false;
  return !hasHardLegalEvent(card);
}

function isHardFactReadyDetailCard(card = {}) {
  if (!isHardFactReadyDetailCandidate(card)) return false;
  return hasSampleGradeHardFactBundle(card);
}

function isHardFactReadyDetailCandidate(card = {}) {
  const scope = text(card.source_scope);
  const grade = text(card.evidence_grade);
  const url = text(card.source_url || card.url);
  const isDetailUrl = /\/20\d{12,}\.html?$|\/20\d{2}\/\d{1,2}\/\d{1,2}\/|\/xxgk\/.+\/20\d{12,}\.html?$/i.test(url)
    && !/\/index\.html?$/i.test(url);
  if (grade !== 'hard_fact_ready' && scope !== 'hard_fact_endpoint') return false;
  if (scope !== 'hard_fact_endpoint' && !isDetailUrl) return false;
  return true;
}

function isHttpUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function hostOf(value) {
  try {
    return new URL(String(value || '')).hostname;
  } catch {
    return '';
  }
}

function isNonAuthoritativeRepublisher(card = {}) {
  return REPUBLISHER_HOST_PATTERN.test(hostOf(card.source_url || card.url))
    || MEDIA_SOURCE_TYPES.has(text(card.source_type))
    || text(card.authority_type) === 'media'
    || /搜狐|转载|综合自|公众号线索|行业媒体/.test(text(card.source_name));
}

function isChinaCard(card) {
  return /中国|China|CN|内地|大陆/i.test(text(card.country));
}

function moduleRank(module) {
  const index = MODULE_ORDER.indexOf(normalizeModule(module));
  return index >= 0 ? index : MODULE_ORDER.length;
}

function comparePremiumCards(a, b) {
  return Number(isChinaCard(b)) - Number(isChinaCard(a))
    || b.score - a.score
    || moduleRank(a.module) - moduleRank(b.module);
}

function compareSelectionCards(a, b) {
  return Number(isChinaCard(b)) - Number(isChinaCard(a))
    || b.score - a.score
    || moduleRank(a.module) - moduleRank(b.module);
}

function amountScore(value) {
  const source = text(value).replace(/,/g, '');
  const match = source.match(/(\d+(?:\.\d+)?)\s*(万|亿)?元/);
  if (!match) return 0;
  const amount = Number(match[1]) * (match[2] === '亿' ? 10000 : match[2] === '万' ? 1 : 0.0001);
  if (amount >= 50) return 45;
  if (amount >= 10) return 32;
  if (amount > 0) return 18;
  return 0;
}

function impactSignalScore(card) {
  const hard = card.hard_facts || {};
  const source = [
    card.title,
    card.facts,
    card.legal_signal,
    card.business_impact,
    card.recommended_action,
    hard.penalty_amount,
    hard.legal_basis,
    hard.product_or_batch,
  ].flat().join(' ');
  let score = 0;
  score += amountScore(`${hard.penalty_amount} ${source}`);
  if (/没收|罚没|销毁|下架|召回|停止销售|责令改正/i.test(source)) score += 22;
  if (/商标|专利|著作权|知识产权|侵权|冒用|假冒|仿冒/i.test(source)) score += 18;
  if (/处罚|罚款|行政处罚|判决|裁定|典型案例|违法/i.test(source)) score += 18;
  if (/强制性标准|禁用|限用|生效|截止|征求意见|备案|注册|海关|HS\s*编码|进口|出口/i.test(source)) score += 12;
  if (meaningfulInvolvedParty(hard.involved_party)) score += 8;
  if (hard.legal_basis) score += 8;
  if (hard.product_or_batch) score += 8;
  if ((hard.affected_processes || []).length) score += Math.min(12, hard.affected_processes.length * 3);
  return score;
}

function sourceTextForCard(card) {
  return [
    card.evidence_text,
    card.title,
    card.facts,
    card.legal_signal,
    card.business_impact,
    card.recommended_action,
  ].flat().join('。');
}

function factualEvidenceTextForCard(card) {
  return [
    card.evidence_text,
    card.title,
    card.facts,
  ].flat().join('。');
}

function sourceEvidenceTextForRelevance(card = {}) {
  const hard = card.hard_facts || {};
  return [
    card.title,
    card.facts,
    card.evidence_text,
    hard.product_or_batch,
    hard.legal_basis,
    hard.hs_code,
    hard.feedback_channel,
  ].flat().join(' ');
}

function isBeautyRelevantCard(card = {}) {
  const sourceEvidence = sourceEvidenceTextForRelevance(card);
  if (GENERIC_NON_BEAUTY_PATTERN.test(sourceEvidence) && !BEAUTY_RELEVANCE_PATTERN.test(sourceEvidence)) return false;
  if (BEAUTY_RELEVANCE_PATTERN.test(sourceEvidence)) return true;
  return false;
}

function validateTypeHardFacts(card) {
  const hard = card.hard_facts || {};
  const source = factualEvidenceTextForCard(card);
  const module = normalizeModule(card.module);

  if (module === '新法律法规政策') {
    const hasPolicyNode = Boolean(hard.effective_date || hard.deadline || hard.action_deadline || hard.document_number || hard.feedback_channel);
    if (!hasPolicyNode) {
      return 'policy-missing-effective-or-deadline';
    }
    if (!/(办法|规定|公告|标准|新规|名单|管理|征求意见|生效|实施|过渡期|条款|执行|备案|注册|禁用|限用)/.test(source)) {
      return 'policy-missing-concrete-change';
    }
  }

  if (module === '广告处罚案例') {
    const hasResult = Boolean(hard.penalty_amount || hard.legal_basis || meaningfulInvolvedParty(hard.involved_party) || hard.product_or_batch)
      || /(罚款|处罚|没收|罚没|责令|违法所得|吊销|停止发布|停止销售)/.test(source);
    if (!hasResult) return 'case-missing-hard-result';
  }

  if (module === '知识产权保护或者侵权') {
    const hasParty = Boolean(meaningfulInvolvedParty(hard.involved_party)) || /(权利人|当事人|公司|企业|品牌|原告|被告)/.test(source);
    const hasRight = /(商标|专利|著作权|版权|外观设计|爱马仕|PRO-XYLANE|玻色因)/i.test(source);
    const hasResult = Boolean(hard.penalty_amount || hard.legal_basis) || /(罚款|处罚|没收|判决|裁定|赔偿|侵权|冒用|假冒)/.test(source);
    if (!hasParty || !hasRight || !hasResult) return 'ip-missing-right-or-result';
  }

  if (module === '进出口') {
    const hasClearanceDetail = Boolean(hard.hs_code || hard.product_or_batch || hard.legal_basis || hard.document_number)
      || /(HS\s*编码|口岸|报关单|清关文件|通关单|准入文件|检验检疫|关税税则|原产地证)/i.test(source);
    if (!hasClearanceDetail) return 'trade-missing-clearance-detail';
  }

  return '';
}

function scoreCard(card) {
  let score = 0;
  score += Math.max(0, 12 - MODULE_ORDER.indexOf(normalizeModule(card.module)) * 2);
  score += impactSignalScore(card);
  if (isChinaCard(card)) score += 20;
  if (/gov|gob|europa\.eu|fda\.gov|ftc\.gov|wipo\.int|euipo\.europa\.eu/i.test(text(card.source_url))) score += 30;
  if (/监管|药监|市场监督|市场监管|法院|海关|委员会|总局|FDA|FTC|BPOM|MFDS|EUIPO|WIPO/i.test(text(card.source_name))) score += 25;
  if (/处罚|罚款|召回|判决|裁定|禁用|限用|生效|征求意见|备案|注册|进口|出口|海关/i.test([card.title, card.legal_signal, card.business_impact, card.recommended_action].join(' '))) score += 18;
  if (OWNER_PATTERN.test(text(card.recommended_action))) score += 12;
  const hardFactCount = objectiveHardFactCount(card.hard_facts || {});
  score += Math.min(30, hardFactCount * 5);
  return score;
}

export function validatePremiumEvidenceCard(card = {}) {
  const evidenceSource = [
    card.evidence_text,
    card.article_text,
    card.full_text,
    card.snippet,
    card.facts,
    card.title,
  ].flat().join('。');
  const hardFacts = withInferredHardFacts(normalizeHardFacts(card.hard_facts), card);
  const normalized = {
    ...card,
    title: text(card.title),
    module: normalizeModule(card.module),
    source_url: text(card.source_url || card.url),
    source_name: text(card.source_name || card.name),
    source_type: text(card.source_type),
    authority_type: text(card.authority_type),
    source_scope: text(card.source_scope),
    evidence_grade: text(card.evidence_grade),
    published_at: candidateDisplayDate(card, hardFacts, evidenceSource),
    country: text(card.country || card.region || '未知'),
    facts: list(card.facts),
    legal_signal: text(card.legal_signal),
    business_impact: text(card.business_impact),
    recommended_action: text(card.recommended_action),
    evidence_text: text(card.evidence_text),
    hard_facts: hardFacts,
  };

  if (!normalized.title) return { accepted: false, reason: 'missing-title', card: normalized };
  if (!isHttpUrl(normalized.source_url)) return { accepted: false, reason: 'missing-source-url', card: normalized };
  if (isNonAuthoritativeRepublisher(normalized)) return { accepted: false, reason: 'non-authoritative-source', card: normalized };
  if (isNavigationOrGenericInformationPage(normalized)) return { accepted: false, reason: 'navigation-or-generic-page', card: normalized };
  if (!isBeautyRelevantCard(normalized)) return { accepted: false, reason: 'not-beauty-relevant', card: normalized };
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(normalized.published_at)) return { accepted: false, reason: 'missing-date', card: normalized };
  if (!normalized.facts.length || !CONCRETE_PATTERNS.test(normalized.facts.join(' '))) {
    return { accepted: false, reason: 'weak-facts', card: normalized };
  }
  if (!normalized.legal_signal || GENERIC_PATTERNS.test(normalized.legal_signal)) {
    return { accepted: false, reason: 'weak-legal-signal', card: normalized };
  }
  if (!normalized.business_impact || GENERIC_PATTERNS.test(normalized.business_impact)) {
    return { accepted: false, reason: 'weak-business-impact', card: normalized };
  }
  if (!normalized.recommended_action || GENERIC_PATTERNS.test(normalized.recommended_action)) {
    return { accepted: false, reason: 'generic-action', card: normalized };
  }
  const typeHardFactReason = validateTypeHardFacts(normalized);
  if (typeHardFactReason) {
    return { accepted: false, reason: typeHardFactReason, card: normalized };
  }
  const hasObservationObject = normalized.hard_facts.affected_processes.length > 0;
  const hasObservationWindow = Boolean(normalized.hard_facts.action_deadline || normalized.hard_facts.deadline || normalized.hard_facts.effective_date);
  if (!OWNER_PATTERN.test(normalized.recommended_action) && !hasObservationObject && !hasObservationWindow) {
    return { accepted: false, reason: 'missing-owner-action', card: normalized };
  }
  return {
    accepted: true,
    tier: scoreCard(normalized) >= 95 ? 'action' : 'watch',
    score: scoreCard(normalized),
    card: normalized,
  };
}

export function selectPremiumEvidenceCards(cards = [], { maxItems = 8, minItems = 4 } = {}) {
  const accepted = [];
  const seen = new Set();
  for (const input of cards) {
    const decision = validatePremiumEvidenceCard(input);
    if (!decision.accepted) continue;
    const card = decision.card;
    const key = `${card.source_url.toLowerCase()}|${card.title.replace(/\s+/g, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({ ...card, tier: decision.tier, score: decision.score });
  }

  accepted.sort(compareSelectionCards);
  const selected = [];
  const moduleLeaders = MODULE_ORDER
    .map(module => accepted.find(card => card.module === module))
    .filter(Boolean)
    .sort(compareSelectionCards);
  for (const card of moduleLeaders) {
    if (selected.length >= maxItems) break;
    selected.push(card);
  }
  for (const card of accepted) {
    if (selected.length >= maxItems) break;
    if (!selected.includes(card)) selected.push(card);
  }
  return selected.slice(0, Math.max(minItems, Math.min(maxItems, selected.length)));
}

export function auditPremiumEvidenceCards(cards = []) {
  const reasons = {};
  const decisions = [];
  for (const input of cards) {
    const decision = validatePremiumEvidenceCard(input);
    if (!decision.accepted) reasons[decision.reason] = (reasons[decision.reason] || 0) + 1;
    decisions.push({
      accepted: decision.accepted,
      reason: decision.accepted ? '' : decision.reason,
      score: decision.score || 0,
      title: text(decision.card?.title || input.title),
      module: normalizeModule(decision.card?.module || input.module),
      card: decision.card,
    });
  }
  return { input: cards.length, accepted: decisions.filter(item => item.accepted).length, reasons, decisions };
}

function fallbackScore(card) {
  const hard = card.hard_facts || {};
  let score = scoreCard(card);
  if (hasHardLegalEvent(card)) score += 30;
  if (objectiveHardFactCount(hard) >= 2) score += 20;
  if (isChinaCard(card)) score += 15;
  if (card.facts.length && card.legal_signal && card.business_impact && card.recommended_action) score += 15;
  return score;
}

function fallbackEvidenceCards(cards = [], maxItems = 6) {
  const seen = new Set();
  return cards
    .map(card => validatePremiumEvidenceCard(card).card)
    .filter(card => card.title && isHttpUrl(card.source_url))
    .filter(card => !isNonAuthoritativeRepublisher(card))
    .filter(card => !isNavigationOrGenericInformationPage(card))
    .filter(card => isBeautyRelevantCard(card))
    .filter(card => card.facts.length && CONCRETE_PATTERNS.test(card.facts.join(' ')))
    .filter(card => card.legal_signal && card.business_impact && card.recommended_action)
    .filter(card => hasHardLegalEvent(card) || objectiveHardFactCount(card.hard_facts || {}) >= 2)
    .map(card => ({ ...card, score: fallbackScore(card), tier: 'watch' }))
    .sort(compareSelectionCards)
    .filter(card => {
      const key = `${card.source_url.toLowerCase()}|${card.title.replace(/\s+/g, '')}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function esc(value) {
  return sanitizeBriefingText(value).replace(/\|/g, '\\|');
}

function cleanBriefPart(value) {
  return text(value).replace(/[。；;,\s]+$/g, '');
}

function briefParts(parts = []) {
  return parts
    .map(cleanBriefPart)
    .filter(Boolean)
    .map(esc);
}

function isRedundantFactLine(value, hardFacts = {}) {
  const line = text(value);
  if (!line) return true;
  const hardValues = [
    hardFacts.involved_party,
    hardFacts.violation_behavior,
    hardFacts.penalty_amount,
    hardFacts.confiscation_result,
    hardFacts.legal_basis,
    hardFacts.product_or_batch,
  ].map(text).filter(Boolean);
  const covered = hardValues.filter(value => line.includes(value) || value.includes(line));
  if (covered.length >= 2) return true;
  const hasPenaltyResult = hardFacts.penalty_amount && line.includes(hardFacts.penalty_amount);
  const hasViolation = hardFacts.violation_behavior && (
    line.includes(hardFacts.violation_behavior)
    || /侵权|冒用|假冒|刷单|虚假交易|虚假宣传|违法/.test(line)
  );
  const hasDisposition = hardFacts.confiscation_result && /没收|罚没|销毁|下架|召回|停止销售/.test(line);
  return Boolean(hasPenaltyResult && (hasViolation || hasDisposition));
}

function isNavigationFactLine(value = '') {
  const line = text(value);
  if (!line) return true;
  if (/https?:\/\/|\/directory\/web\/|javascript:void/i.test(line)) return true;
  if (PORTAL_EVIDENCE_PATTERN.test(line)) return true;
  const navHits = [
    /网站首页|首页|机构概况|人才队伍|党群工作|信息公开|办事大厅|业务咨询|建言献策/,
    /院介绍|院领导|组织机构|能力资质|联系方式|院士|首席专家|药检菁英/,
    /党建要闻|党风廉政|群团统战|纪检举报|法规政策|公告通知|数据查询/,
    /化妆品审评|国家抽检管理|医疗器械标准与分类管理|友情链接|快捷检索|高级检索/,
  ].filter(pattern => pattern.test(line)).length;
  return navHits >= 1 && !HARD_LEGAL_EVENT_PATTERN.test(line);
}

function renderFactLines(card) {
  const hard = compactHardFacts(card.hard_facts, [
    ['authority', '机关'],
    ['document_number', '文号'],
    ['involved_party', '主体'],
    ['product_or_batch', '产品/批次'],
    ['violation_behavior', '违法行为'],
    ['penalty_amount', '金额'],
    ['confiscation_result', '没收/处置'],
    ['legal_basis', '依据'],
    ['hs_code', 'HS编码'],
    ['effective_date', '生效'],
    ['deadline', '截止'],
    ['feedback_channel', '反馈渠道'],
  ]);
  const facts = card.facts
    .filter(value => !isNavigationFactLine(value))
    .filter(value => !isRedundantFactLine(value, card.hard_facts));
  return briefParts([...hard, ...facts]);
}

function renderJudgementLines(card) {
  return briefParts([card.legal_signal]);
}

function renderImpactLines(card) {
  const processLine = card.hard_facts.affected_processes.length
    ? `影响流程：${card.hard_facts.affected_processes.join('、')}`
    : '';
  return briefParts([card.business_impact, processLine]);
}

function renderActionLines(card) {
  return briefParts([card.recommended_action]);
}

function renderFieldBlock(label, values = []) {
  const lines = [`- **${label}**`];
  const list = values.length ? values : ['原文未披露足够结构化信息'];
  for (const value of list) lines.push(`  - ${value}`);
  return lines;
}

function concretePartyForTitle(card) {
  const party = text(card.hard_facts?.involved_party);
  if (!party || isVagueInvolvedParty(party) || party === '原文未披露') return '';
  return party;
}

function displayTitle(card) {
  const title = text(card.title);
  const party = concretePartyForTitle(card);
  if (!party) return title;
  return title
    .replace(/^两家美妆企业/, party)
    .replace(/^涉案商家/, party)
    .replace(/^商家/, party)
    .replace(/^相关企业/, party)
    .replace(/^两家公司/, party);
}

function premiumCardFromItem(item, sectionModule) {
  const module = normalizeModule(item.module || sectionModule);
  const evidenceText = text(item.evidence_excerpt || item.article_text || item.full_text || item.snippet);
  const hardFactsInput = normalizeHardFacts(item.hard_facts || item.extraction?.hard_facts || item.extraction?.legal_facts || {});
  const baseCard = {
    title: text(item.title),
    module,
    source_url: text(item.source_url),
    source_name: sourceNameFromCanonicalSource(item),
    source_type: text(item.source_type),
    authority_type: text(item.authority_type),
    source_scope: text(item.source_scope),
    evidence_grade: text(item.evidence_grade),
    published_at: candidateDisplayDate(item, hardFactsInput, evidenceText || [
      item.what_changed,
      item.facts,
      item.fact_summary,
      item.dispute_focus,
      item.market_access_change,
      item.regulatory_signal,
      item.title,
    ].flat().join('。')),
    country: text(item.country || item.region || '未知'),
    facts: list(item.what_changed || item.facts || item.fact_summary || item.dispute_focus || item.market_access_change || item.regulatory_signal),
    legal_signal: text(item.legal_signal || item.legal_obligation || item.compliance_meaning || item.violation_logic || item.infringement_logic || item.documents_needed || item.core_judgement),
    business_impact: text(item.business_impact || item.affected_business || item.impact_on_brand_assets || item.affected_import_flow || item.why_it_matters || item.risk_pattern || item.business_lessons || item.penalty_or_result),
    recommended_action: text(item.next_observation || item.recommended_action || item.recommended_actions || item.possible_follow_up),
    evidence_text: evidenceText,
  };
  return {
    ...baseCard,
    hard_facts: withInferredHardFacts(hardFactsInput, baseCard),
  };
}

export function buildPremiumDingTalkMarkdown({ period = {}, cards = [], preselected = false } = {}) {
  const selected = preselected
    ? [...cards]
    : selectPremiumEvidenceCards(cards, { maxItems: cards.length || 8, minItems: 0 });
  const start = text(period.start);
  const end = text(period.end);
  const lines = [
    `# 美妆法务资讯精品卡${start || end ? `（${start} 至 ${end}）` : ''}`,
    '',
    selected.length
      ? `本期精选 ${selected.length} 条。`
      : '本期没有达到精品证据门槛的事项，宁缺毋滥。',
  ];

  let number = 0;
  const modules = [...new Set(selected.map(card => card.module))]
    .sort((a, b) => {
      const aHasChina = selected.some(card => card.module === a && isChinaCard(card));
      const bHasChina = selected.some(card => card.module === b && isChinaCard(card));
      const aTop = Math.max(...selected.filter(card => card.module === a).map(card => card.score));
      const bTop = Math.max(...selected.filter(card => card.module === b).map(card => card.score));
      return Number(bHasChina) - Number(aHasChina) || bTop - aTop || moduleRank(a) - moduleRank(b);
    });

  for (const module of modules) {
    const items = selected
      .filter(card => card.module === module)
      .sort(comparePremiumCards);
    if (!items.length) continue;
    lines.push('', `## ${module}`);
    for (const card of items) {
      number += 1;
      lines.push(
        '',
        `### ${number}. ${esc(displayTitle(card))}`,
        `- **来源**：${esc(card.source_name)} / ${esc(card.country)} / ${esc(card.published_at)} / [原文](${card.source_url})`,
        ...renderFieldBlock('事实依据', renderFactLines(card)),
        ...renderFieldBlock('法务观察', renderJudgementLines(card)),
        ...renderFieldBlock('业务影响', renderImpactLines(card)),
        ...renderFieldBlock('下一步观察建议', renderActionLines(card)),
      );
    }
  }

  return `${lines.join('\n')}\n`;
}

function orderCardsForPremiumMarkdown(cards = []) {
  const modules = [...new Set(cards.map(card => card.module))]
    .sort((a, b) => {
      const aHasChina = cards.some(card => card.module === a && isChinaCard(card));
      const bHasChina = cards.some(card => card.module === b && isChinaCard(card));
      const aTop = Math.max(...cards.filter(card => card.module === a).map(card => card.score));
      const bTop = Math.max(...cards.filter(card => card.module === b).map(card => card.score));
      return Number(bHasChina) - Number(aHasChina) || bTop - aTop || moduleRank(a) - moduleRank(b);
    });
  return modules.flatMap(module => cards.filter(card => card.module === module).sort(comparePremiumCards));
}

function buildPremiumDingTalkMessageChunks(report, cards = [], maxBytes = 18000) {
  const byteLimit = Math.max(1200, Number(maxBytes || 18000));
  const orderedCards = orderCardsForPremiumMarkdown(cards);
  const chunks = [];
  let current = [];
  for (const card of orderedCards) {
    const candidate = [...current, card];
    const candidateMarkdown = buildPremiumDingTalkMarkdown({ period: report.period || {}, cards: candidate, preselected: true });
    if (current.length && utf8Bytes(candidateMarkdown) > byteLimit) {
      chunks.push(current);
      current = [card];
      continue;
    }
    current = candidate;
  }
  if (current.length) chunks.push(current);
  const total = chunks.length;
  return chunks.map((chunk, index) => {
    const markdown = buildPremiumDingTalkMarkdown({ period: report.period || {}, cards: chunk, preselected: true });
    const bytes = utf8Bytes(markdown);
    if (bytes > byteLimit) throw new Error(`Premium DingTalk message exceeds byte budget: ${bytes}/${byteLimit}`);
    return {
      id: total > 1 ? `weekly-report-${index + 1}` : 'weekly-report',
      title: `美妆法务资讯｜${text(report.period?.end || '本期')}${total > 1 ? `（${index + 1}/${total}）` : ''}`,
      markdown,
      bytes,
      itemCount: chunk.length,
      displayedItemCount: chunk.length,
      omittedItemCount: 0,
    };
  });
}

export function buildPremiumDingTalkDelivery(report, options = {}) {
  const reportCards = (report.sections || []).flatMap(section =>
    (section.items || []).map(item => premiumCardFromItem(item, section.module))
  );
  const maxItems = Number(options.maxItems || 18);
  const premiumCards = cardsForPremiumDelivery(reportCards, maxItems);
  let cards = premiumCards.length ? premiumCards : fallbackEvidenceCards(reportCards, maxItems);
  cards = backfillChinaFromCandidates(cards, options.candidates || [], maxItems);
  if (!premiumCards.length && reportCards.length) {
    const audit = auditPremiumEvidenceCards(reportCards);
    console.log(`[premium-card] strict gate accepted 0/${audit.input}; fallback=${cards.length}; reasons=${Object.entries(audit.reasons).map(([reason, count]) => `${reason}=${count}`).join(', ') || 'none'}`);
  }
  const eligibleCandidates = (options.candidates || []).filter(isPremiumCandidateSource);
  const eligibleCandidateCards = eligibleCandidates.map(premiumCardFromCandidate);
  if (options.logCandidateAudit === true) {
    const candidateAudit = auditPremiumEvidenceCards(eligibleCandidateCards);
    console.log(`[premium-card] candidate gate accepted ${candidateAudit.accepted}/${candidateAudit.input}; reasons=${Object.entries(candidateAudit.reasons).map(([reason, count]) => `${reason}=${count}`).join(', ') || 'none'}`);
    for (const decision of candidateAudit.decisions.filter(item => !item.accepted).slice(0, 8)) {
      console.log(`[premium-card] reject ${decision.reason}: ${decision.module} | ${decision.title}`);
    }
  }
  const backfillableCandidateCards = fallbackEvidenceCards(
    eligibleCandidateCards,
    Math.max(eligibleCandidates.length, maxItems)
  );
  const strictCandidateCards = cardsForPremiumDelivery(
    eligibleCandidateCards,
    Math.max(eligibleCandidates.length, maxItems)
  );
  const sourceOnlyCandidateCards = options.allowSourceOnlyFallback === true
    ? sourceOnlyFallbackCards(options.candidates || [], maxItems)
    : [];
  const candidateCards = uniqueCardsBySelectionKey([
    ...strictCandidateCards,
    ...backfillableCandidateCards,
    ...sourceOnlyCandidateCards,
  ]);
  const sampleCandidateCards = candidateCards.filter(isSampleGradeCard);
  const backfillableChinaCandidateItems = sampleCandidateCards.filter(isChinaCard).length;
  const candidateChinaItems = sampleCandidateCards.filter(isChinaCard).length;
  const requiredChinaItems = requiredChinaItemCount(sampleCandidateCards, maxItems);
  if (cards.length < maxItems) {
    const selectedKeys = new Set(cards.map(cardSelectionKey));
    for (const candidateCard of [...strictCandidateCards, ...backfillableCandidateCards, ...sourceOnlyCandidateCards]) {
      if (cards.length >= maxItems) break;
      const key = cardSelectionKey(candidateCard);
      if (selectedKeys.has(key)) continue;
      cards.push(candidateCard);
      selectedKeys.add(key);
    }
    cards.sort(compareSelectionCards);
  }
  cards = cards.filter(isSampleGradeCard).slice(0, maxItems).sort(compareSelectionCards);
  const audit = {
    reportItems: reportCards.length,
    reportChinaItems: reportCards.filter(isChinaCard).length,
    candidateItems: sampleCandidateCards.length,
    candidateChinaItems,
    backfillableChinaCandidateItems,
    finalItems: cards.length,
    finalChinaItems: cards.filter(isChinaCard).length,
    finalSampleGradeItems: cards.filter(isSampleGradeCard).length,
    finalChinaSampleGradeItems: cards.filter(card => isChinaCard(card) && isSampleGradeCard(card)).length,
    sourceOnlyFallbackItems: cards.filter(card => card.source_only_fallback === true).length,
    requiredChinaItems,
    requiredSampleGradeItems: Math.min(3, cards.length),
    chinaShortfall: candidateChinaItems > cards.filter(isChinaCard).length || backfillableChinaCandidateItems > cards.filter(isChinaCard).length,
  };
  if (!cards.length) return { messages: [], cards, audit };
  return {
    messages: buildPremiumDingTalkMessageChunks(report, cards, options.maxBytes),
    cards,
    audit,
  };
}

export function buildPremiumDingTalkMessages(report, options = {}) {
  return buildPremiumDingTalkDelivery(report, options).messages;
}

export function assertPremiumChinaDelivery(audit = {}, { allowForeignOnly = false } = {}) {
  const hasChinaInput = Number(audit.candidateChinaItems || 0) > 0 || Number(audit.reportChinaItems || 0) > 0;
  if (hasChinaInput && !Number(audit.finalItems || 0) && !allowForeignOnly) {
    throw new Error(`Premium delivery item gate failed: candidateChina=${audit.candidateChinaItems || 0}, reportChina=${audit.reportChinaItems || 0}, finalItems=${audit.finalItems || 0}`);
  }
  if (hasChinaInput && !Number(audit.finalChinaItems || 0) && !allowForeignOnly) {
    throw new Error(`Premium delivery China gate failed: candidateChina=${audit.candidateChinaItems || 0}, reportChina=${audit.reportChinaItems || 0}, finalChina=${audit.finalChinaItems || 0}`);
  }
  if (hasChinaInput && Number(audit.finalChinaItems || 0) < Number(audit.requiredChinaItems || 0) && !allowForeignOnly) {
    throw new Error(`Premium delivery China minimum failed: candidateChina=${audit.candidateChinaItems || 0}, requiredChina=${audit.requiredChinaItems || 0}, finalChina=${audit.finalChinaItems || 0}`);
  }
  if (Number(audit.finalSampleGradeItems || 0) < Number(audit.requiredSampleGradeItems || 0)) {
    throw new Error(`Premium delivery hard-fact gate failed: requiredSampleGrade=${audit.requiredSampleGradeItems || 0}, finalSampleGrade=${audit.finalSampleGradeItems || 0}`);
  }
  return audit;
}

function cardsForPremiumDelivery(cards, maxItems = 18) {
  const selected = selectPremiumEvidenceCards(cards, { maxItems, minItems: 0 });
  return backfillChinaCoverage(selected, cards, maxItems);
}

function backfillChinaCoverage(selected = [], sourceCards = [], maxItems = 6) {
  if (!selected.length) return selected;
  const requiredChinaItems = requiredChinaItemCount(
    sourceCards
      .filter(card => isSampleGradeCard(card))
      .map(card => ({ country: card.country })),
    maxItems || sourceCards.length || selected.length
  );
  if (!requiredChinaItems || selected.filter(isChinaCard).length >= requiredChinaItems) return selected;
  const selectedKeys = new Set(selected.map(card => `${card.source_url.toLowerCase()}|${card.title.replace(/\s+/g, '')}`));
  const chinaFallbacks = fallbackEvidenceCards(sourceCards, sourceCards.length || 1)
    .filter(isChinaCard)
    .filter(card => !selectedKeys.has(`${card.source_url.toLowerCase()}|${card.title.replace(/\s+/g, '')}`));
  if (!chinaFallbacks.length) return selected;
  const combined = [...selected];
  for (const chinaFallback of chinaFallbacks) {
    if (combined.filter(isChinaCard).length >= requiredChinaItems) break;
    combined.push(chinaFallback);
    selectedKeys.add(`${chinaFallback.source_url.toLowerCase()}|${chinaFallback.title.replace(/\s+/g, '')}`);
  }
  return combined.sort(compareSelectionCards);
}

function candidateEvidenceText(candidate = {}) {
  return text([
    candidate.evidence_text,
    candidate.article_text,
    candidate.full_text,
    candidate.body,
    candidate.text,
    candidate.snippet,
    candidate.title,
  ].filter(Boolean).join('。'));
}

function firstEvidenceSentence(value = '') {
  const source = text(value);
  const sentences = source
    .split(/(?<=[。！？!?；;])\s*/)
    .map(sentence => text(sentence).replace(/^(?:首页|主页|通知公告|新闻中心|当前位置|网站首页|更多|>>|\s)+/g, '').trim())
    .map(sentence => sentence.replace(/^(?:首页\s*)?(?:通知公告|新闻中心)\s*更多\s*/g, '').trim())
    .filter(sentence => sentence.length >= 16);
  return sentences.find(sentence => HARD_LEGAL_EVENT_PATTERN.test(sentence))
    || sentences[0]
    || source.slice(0, 180);
}

function candidateLegalSignal(module, source, hardFacts = {}) {
  const hard = hardFacts || {};
  const product = hardText(hard.product_or_batch);
  const deadline = hardText(hard.deadline || hard.action_deadline);
  const effective = hardText(hard.effective_date);
  const party = meaningfulInvolvedParty(hard.involved_party);
  const act = hardText(hard.violation_behavior);
  const amount = hardText(hard.penalty_amount);
  const disposition = hardText(hard.confiscation_result);
  const basis = hardText(hard.legal_basis || hard.document_number);

  if (module === '新法律法规政策') {
    if (deadline && product) return `${product}已经进入意见反馈或过渡安排窗口，企业需要在${deadline}前判断是否提交意见并评估标准切换。`;
    if (effective && product) return `${product}已有明确生效或执行日期，配方、标签、备案和质量放行口径需要按${effective}倒排更新。`;
    if (basis && product) return `${basis}把${product}纳入规则或标准管理，后续执行口径会直接影响产品资料和检验依据。`;
  }
  if (module === '广告处罚案例' || module === '知识产权保护或者侵权') {
    const result = [amount, disposition, basis].filter(Boolean).join('、');
    if (party && act && result) return `${party}因${act}被公开处理，结果包含${result}，同类美妆素材和店铺运营需要按同一风险链条复核。`;
    if (party && act) return `${party}的${act}已经形成公开执法或权利保护信号，不能再按普通宣传或授权瑕疵处理。`;
  }
  if (module === '进出口') {
    const node = hardText(hard.hs_code || hard.document_number || hard.legal_basis);
    if (node && product) return `${product}涉及${node}等通关或准入节点，进口申报和清关资料需要逐项核验。`;
  }
  if (module === '产品质量/召回与安全风险') {
    if (product && (disposition || act)) return `${product}已经出现${disposition || act}，批次放行、召回和渠道处置需要同步校验。`;
  }
  const sentence = firstEvidenceSentence(source);
  return sentence ? `${sentence.replace(/[。；;]+$/g, '')}，该事项已具备可追踪的事实节点。` : '';
}

function candidateBusinessImpact(module, hardFacts = {}, source = '') {
  const processes = hardFacts.affected_processes?.length
    ? hardFacts.affected_processes
    : inferAffectedProcesses(source);
  if (processes.length) return `影响中国市场美妆业务的${processes.join('、')}。`;
  if (module === '知识产权保护或者侵权') return '影响中国市场美妆品牌授权、商标使用、包装设计、达人素材和平台店铺审查。';
  if (module === '进出口') return '影响中国市场美妆产品进口申报、清关资料、标签备案和供应链履约。';
  return '影响中国市场美妆产品标签、备案注册、广告素材、平台上架和存量SKU管理。';
}

function candidateObservation(module, source = '', hardFacts = {}) {
  const hard = hardFacts || {};
  const product = hardText(hard.product_or_batch);
  const party = meaningfulInvolvedParty(hard.involved_party);
  const processes = hard.affected_processes?.length ? hard.affected_processes.join('、') : '';
  if (/征求意见|反馈截止|截止/.test(source) || hardText(hard.deadline)) {
    return `观察${product || '相关化妆品规则'}正式稿发布日期、反馈截止日、过渡期安排，以及${processes || '标签备案和执行标准'}是否需要同步调整。`;
  }
  if (/处罚|罚款|没收|侵权|冒用|假冒|商标/.test(source)) {
    return `观察${party || '同类主体'}在处罚决定、行政复议、诉讼和平台治理中的后续公开，并复核${processes || '商标授权、包装设计和达人素材'}。`;
  }
  if (/海关|进口|出口|清关|HS\s*编码/i.test(source)) return `观察${product || '相关化妆品'}的口岸执行口径、申报字段、HS编码适用和配套清关说明。`;
  if (module === '产品质量/召回与安全风险') return '观察后续抽检、召回、停止销售、整改公告和同类产品风险扩散。';
  return processes
    ? `观察${processes}对应的正式文件、执行口径和配套问答。`
    : '观察正式文件、执行口径和配套问答。';
}

function premiumCardFromCandidate(candidate = {}) {
  const source = candidateEvidenceText(candidate);
  const module = normalizeModule(candidate.module);
  const extractedFacts = extractHardFacts(source, {
    title: candidate.title,
    source_name: candidate.source_name || candidate.name,
    source_url: candidate.source_url || candidate.url,
    module,
    country: candidate.country || candidate.region,
  });
  const providedHardFacts = candidate.hard_facts && typeof candidate.hard_facts === 'object' ? candidate.hard_facts : {};
  const mergedHardFacts = {
    ...extractedFacts,
    ...providedHardFacts,
    affected_processes: Array.isArray(providedHardFacts.affected_processes) && providedHardFacts.affected_processes.length
      ? providedHardFacts.affected_processes
      : extractedFacts.affected_processes,
  };
  const hardFacts = withInferredHardFacts(normalizeCandidateHardFacts(candidate, mergedHardFacts), {
    title: text(candidate.title),
    module,
    evidence_text: source,
    facts: uniqueValues([firstEvidenceSentence(source), text(candidate.title)]).filter(Boolean),
    business_impact: candidate.business_impact || '',
  });
  const baseCard = {
    title: text(candidate.title),
    module,
    source_url: text(candidate.source_url || candidate.url),
    source_name: sourceNameFromCanonicalSource(candidate),
    source_type: text(candidate.source_type),
    authority_type: text(candidate.authority_type),
    source_scope: text(candidate.source_scope),
    evidence_grade: text(candidate.evidence_grade),
    published_at: candidateDisplayDate(candidate, { ...(candidate.hard_facts || {}), ...extractedFacts }, source),
    country: text(candidate.country || candidate.region || '未知'),
    facts: [firstEvidenceSentence(source)].filter(Boolean),
    legal_signal: candidateLegalSignal(module, source, hardFacts),
    business_impact: '',
    recommended_action: candidateObservation(module, source, hardFacts),
    evidence_text: source,
  };
  return {
    ...baseCard,
    business_impact: candidateBusinessImpact(module, hardFacts, source),
    hard_facts: hardFacts,
  };
}

function sourceOnlyFallbackCard(candidate = {}) {
  const card = premiumCardFromCandidate(candidate);
  const source = sourceTextForCard(card);
  return {
    ...card,
    published_at: card.published_at || text(candidate.published_at) || '本期',
    country: /中国/.test(text(candidate.country || candidate.region)) || candidate.china_relevant === true ? '中国' : card.country,
    source_only_fallback: true,
    tier: 'watch',
    score: fallbackScore(card) + (isChinaCard(card) ? 10 : 0),
    facts: card.facts.length ? card.facts : [firstEvidenceSentence(source)].filter(Boolean),
    legal_signal: candidateLegalSignal(card.module, source, card.hard_facts || {}),
    business_impact: card.business_impact || candidateBusinessImpact(card.module, card.hard_facts || {}, source),
    recommended_action: card.recommended_action || candidateObservation(card.module, source, card.hard_facts || {}),
  };
}

function isSourceOnlyFallbackEligible(candidate = {}) {
  if (text(candidate.evidence_grade) === 'reject') return false;
  if (candidate.detail_status && candidate.detail_status !== 'hydrated') return false;
  const card = premiumCardFromCandidate(candidate);
  if (!card.title || !isHttpUrl(card.source_url)) return false;
  if (isNonAuthoritativeRepublisher(card)) return false;
  const source = sourceTextForCard(card);
  if (source.length < 80) return false;
  if (!BEAUTY_RELEVANCE_PATTERN.test(source) && !MODULE_ORDER.includes(normalizeModule(card.module))) return false;
  return isSampleGradeCard(card);
}

function sourceOnlyFallbackCards(candidates = [], maxItems = 18) {
  const seen = new Set();
  return candidates
    .filter(isSourceOnlyFallbackEligible)
    .map(sourceOnlyFallbackCard)
    .sort(compareSelectionCards)
    .filter(card => {
      const key = cardSelectionKey(card);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, maxItems);
}

function uniqueCardsBySelectionKey(cards = []) {
  const seen = new Set();
  const result = [];
  for (const card of cards) {
    const key = cardSelectionKey(card);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(card);
  }
  return result;
}

function fallbackChinaCandidateCards(candidates = [], maxItems = 3) {
  const cards = candidates
    .filter(isPremiumCandidateSource)
    .filter(candidate => /中国/.test(text(candidate.country || candidate.region)) || candidate.china_relevant === true)
    .map(premiumCardFromCandidate);
  return fallbackEvidenceCards(cards, maxItems).filter(isChinaCard);
}

function isPremiumCandidateSource(candidate = {}) {
  const grade = text(candidate.evidence_grade);
  if (grade === 'reject') return false;
  const scope = text(candidate.source_scope);
  if (grade && grade !== 'hard_fact_ready') return false;
  if (!grade && scope && !['hard_fact_endpoint', 'hard_fact_list'].includes(scope)) return false;
  return true;
}

function isSampleGradeCard(card = {}) {
  const hardCount = objectiveHardFactCount(card.hard_facts || {});
  if (hardCount < 2) return false;
  if (!hasSampleGradeHardFactBundle(card)) return false;
  if (BROKEN_FIELD_PATTERN.test(JSON.stringify(card.hard_facts || {}))) return false;
  if (BROKEN_FIELD_PATTERN.test(sourceTextForCard(card))) return false;
  if (!isBeautyRelevantCard(card)) return false;
  if (isNavigationOrGenericInformationPage(card)) return false;
  if (isHardFactReadyDetailCandidate(card)) return true;
  if (/Crawl4AI|欢迎访问|专题页|入口页|监管入口|安全使用|消费者提示/i.test(sourceTextForCard(card))) return false;
  if (PREMIUM_JUNK_EVIDENCE_PATTERN.test(sourceTextForCard(card))) return false;
  return true;
}

function requiredChinaItemCount(candidateCards = [], maxItems = 6) {
  const chinaCandidates = candidateCards.filter(isChinaCard).length;
  if (!chinaCandidates) return 0;
  return Math.min(3, maxItems, chinaCandidates);
}

function cardSelectionKey(card = {}) {
  return `${text(card.source_url || card.url).toLowerCase()}|${text(card.title).replace(/\s+/g, '')}`;
}

function backfillChinaFromCandidates(cards = [], candidates = [], maxItems = 6) {
  const requiredChinaItems = requiredChinaItemCount(
    candidates.map(candidate => ({ country: text(candidate.country || candidate.region) })),
    maxItems
  );
  if (!requiredChinaItems || cards.filter(isChinaCard).length >= requiredChinaItems) {
    return cards.sort(compareSelectionCards).slice(0, maxItems);
  }

  const selectedKeys = new Set(cards.map(cardSelectionKey));
  const chinaFallbacks = fallbackChinaCandidateCards(candidates, Math.max(requiredChinaItems, maxItems))
    .filter(card => !selectedKeys.has(cardSelectionKey(card)));
  if (!chinaFallbacks.length) return cards.sort(compareSelectionCards).slice(0, maxItems);

  let combined = [...cards];
  for (const chinaCard of chinaFallbacks) {
    if (combined.filter(isChinaCard).length >= requiredChinaItems) break;
    combined.push(chinaCard);
    selectedKeys.add(cardSelectionKey(chinaCard));
  }

  combined = combined.sort(compareSelectionCards);
  while (combined.length > maxItems) {
    const removableIndex = [...combined]
      .map((card, index) => ({ card, index }))
      .reverse()
      .find(item => !isChinaCard(item.card))?.index;
    if (removableIndex === undefined) break;
    combined.splice(removableIndex, 1);
  }
  combined = combined.slice(0, maxItems).sort(compareSelectionCards);
  if (combined.filter(isChinaCard).length < requiredChinaItems) {
    return combined.filter(isChinaCard).slice(0, maxItems).sort(compareSelectionCards);
  }
  return combined;
}
