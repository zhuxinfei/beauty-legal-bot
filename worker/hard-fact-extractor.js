function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clean(value) {
  return text(value).replace(/[。；;，,]$/, '');
}

function firstMatch(value, patterns = []) {
  const source = String(value || '');
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match?.[1]) return clean(match[1]);
  }
  return '';
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

function stripMarkdown(value) {
  return text(value)
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/`+/g, '')
    .trim();
}

function extractCompanyNames(value = '') {
  const source = stripMarkdown(value);
  const companyPattern = /([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,48}?(?:有限责任公司|股份有限公司|有限公司|个体工商户|工作室|商行|公司))/g;
  const matches = Array.from(source.matchAll(companyPattern))
    .map(match => match[1].replace(/^.*?(?:披露|通报|认定|处罚|当事人|被处罚人|涉案主体)/, ''))
    .filter(name => !/市场监督管理局|市场监管局|药品监督管理局|国家知识产权局|海关|人民法院|委员会|协会|监管部门/.test(name));
  return uniqueValues(matches).slice(0, 5);
}

function extractAuthority(source, context = {}) {
  return firstMatch(source, [
    /(?:处罚机关|发布机关|发文机关|监管部门|执法机关)[：:]\s*([^。；;\n]{3,50})/,
    /(国家药品监督管理局|国家市场监督管理总局|国家知识产权局|海关总署|[\u4e00-\u9fa5]{2,24}市场监督管理局|[\u4e00-\u9fa5]{2,24}市场监管局|[\u4e00-\u9fa5]{2,24}药品监督管理局|[\u4e00-\u9fa5]{2,24}海关)/,
  ]) || text(context.source_name);
}

function extractDocumentNumber(source) {
  return firstMatch(source, [
    /(?:文号|决定书文号|公告编号|编号)[：:\s]*([^\s。；;，,]{2,50}(?:〔20\d{2}〕\d+号|20\d{2}年第\d+号|第\d+号))/,
    /(?:公告|通告)(20\d{2}年第\d+号)/,
    /(20\d{2}年第\d+号)/,
    /([^\s。；;，,]{0,20}〔20\d{2}〕\d+号)/,
    /(征求意见稿)/,
  ]) || (/征求意见/.test(source) ? '征求意见稿' : '');
}

function extractInvolvedParty(source) {
  const labelled = firstMatch(source, [
    /(?:当事人|涉案主体|被处罚人|申请人|被告|原告)[：:\s]*([^。；;\n]{2,120})/,
  ]);
  const fromLabel = extractCompanyNames(labelled);
  if (fromLabel.length) return fromLabel.join('、');
  return extractCompanyNames(source).join('、');
}

function extractPenaltyAmount(source) {
  return firstMatch(source, [
    /(?:合计)?(?:罚款|处罚金额|罚没金额)[：:\s]*([0-9]+(?:\.[0-9]+)?\s*(?:万|亿)?元)/,
    /(?:被罚|罚款|处罚金额)([0-9]+(?:\.[0-9]+)?\s*(?:万|亿)?元)/,
    /([0-9]+(?:\.[0-9]+)?\s*(?:万|亿)?元)/,
  ]);
}

function extractViolationBehavior(source) {
  const labelled = firstMatch(source, [
    /(?:违法事实|违法行为|主要违法事实|侵权行为|违法情形)[：:\s]*([^。；;\n]{6,140})/,
  ]);
  if (labelled) return labelled;
  return firstMatch(source, [
    /([^。；;\n]{4,160}(?:侵权使用|侵权|冒用|假冒|刷单|虚假交易|虚假宣传|未经授权|擅自使用)[^。；;\n]{0,100})/,
  ]);
}

function extractConfiscationResult(source) {
  return firstMatch(source, [
    /((?:没收|罚没|销毁|责令下架|下架|停止销售|召回)[^。；;\n]{2,120})/,
  ]);
}

function extractLegalBasis(source) {
  const laws = uniqueValues(Array.from(source.matchAll(/《[^》]{2,50}》(?:第[一二三四五六七八九十百零\d]+条(?:第[一二三四五六七八九十百零\d]+款)?)?/g)).map(match => match[0]));
  return laws.join('、');
}

function extractProductOrBatch(source) {
  const labelled = firstMatch(source, [
    /(?:涉及产品|产品名称|产品\/批次|批号|批次)[：:\s]*([^。；;\n]{2,80})/,
  ]);
  if (labelled) return labelled;
  const buckets = [
    [/香水/, '香水'],
    [/彩妆/, '彩妆'],
    [/礼盒/, '礼盒商品'],
    [/玻色因|成分卖点/, '含玻色因卖点的美妆商品'],
    [/进口化妆品/, '进口化妆品'],
  ];
  return uniqueValues(buckets.filter(([pattern]) => pattern.test(source)).map(([, label]) => label)).join('、');
}

function extractHsCode(source) {
  return firstMatch(source, [
    /(?:HS\s*编码|HS Code|商品编码)[：:\s]*([0-9]{6,10})/i,
    /商品编码([0-9]{6,10})/,
  ]);
}

function extractEffectiveDate(source) {
  return firstMatch(source, [
    /(?:自|于)(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)(?:起)?(?:实施|生效|执行)/,
    /(?:生效日期|实施日期|执行日期)[：:\s]*(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)/,
  ]);
}

function extractDeadline(source) {
  return firstMatch(source, [
    /(?:意见反馈截止日期|反馈截止日期|反馈截止日|截止日期|截止|截至|过渡期至|应于|须于)[：:\s]*(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)/,
  ]);
}

function extractFeedbackChannel(source) {
  return firstMatch(source, [
    /(?:反馈渠道|反馈方式|提交方式)[：:\s]*([^。；;\n]{4,120})/,
    /((?:电子邮箱|邮箱|邮寄地址|联系人)[：:\s]*[^。；;\n]{4,120})/,
  ]);
}

function inferAffectedProcesses(source, facts = {}, context = {}) {
  const module = text(context.module);
  const combined = `${source} ${Object.values(facts).flat().join(' ')}`;
  if (/玻色因|成分卖点|刷单|平台店铺/.test(combined)) {
    return ['成分卖点命名', '商标授权', '平台店铺运营', '达人素材'];
  }
  if (/爱马仕|商标|冒用|假冒|包装装潢|礼盒/.test(combined) || /知识产权/.test(module)) {
    return ['商标授权', '包装设计', '达人素材', '平台店铺'];
  }
  if (/标准|征求意见|新旧衔接|制修订|执行标准/.test(combined)) {
    return ['配方开发', '标签备案', '执行标准选择', '存量SKU过渡期管理'];
  }
  if (/海关|进口|出口|HS\s*编码|商品编码|清关|原产地|中文标签/.test(combined) || /进出口/.test(module)) {
    return ['进口申报', '清关', '原产地文件', '中文标签', '供应链履约'];
  }
  const rules = [
    [/标签|中文标签/, '标签'],
    [/备案|注册/, '备案/注册'],
    [/广告|宣传|直播|达人|详情页/, '达人素材/广告宣传'],
    [/SKU|批次|召回|下架|停止销售/, 'SKU/批次管理'],
  ];
  return uniqueValues(rules.filter(([pattern]) => pattern.test(combined)).map(([, label]) => label));
}

function inferSignalType(source) {
  if (/处罚|罚款|行政处罚|判决|裁定|侵权|违法|冒用|假冒|刷单/.test(source)) return '风险案例';
  if (/征求意见|公告|办法|规定|标准|生效|实施|备案|注册|海关|进口|出口|HS\s*编码/.test(source)) return '新增义务';
  if (/入口|监测|预警/.test(source)) return '观察入口';
  return '执法趋势';
}

function inferRiskTier(source) {
  if (/处罚|罚款|行政处罚|召回|不合格|截止|生效|违法|没收/.test(source)) return '立即处理';
  if (/公告|办法|规定|海关|进口|出口|商标|知识产权|征求意见/.test(source)) return '本周排查';
  return '持续监测';
}

export function extractHardFacts(value = '', context = {}) {
  const source = stripMarkdown(value);
  if (!source) return {};
  const facts = {
    authority: extractAuthority(source, context),
    document_number: extractDocumentNumber(source),
    involved_party: extractInvolvedParty(source),
    product_or_batch: extractProductOrBatch(source),
    violation_behavior: extractViolationBehavior(source),
    penalty_amount: extractPenaltyAmount(source),
    confiscation_result: extractConfiscationResult(source),
    legal_basis: extractLegalBasis(source),
    hs_code: extractHsCode(source),
    effective_date: extractEffectiveDate(source),
    deadline: extractDeadline(source),
    feedback_channel: extractFeedbackChannel(source),
  };
  facts.affected_processes = inferAffectedProcesses(source, facts, context);
  facts.signal_type = inferSignalType(source);
  facts.risk_tier = inferRiskTier(source);
  return Object.fromEntries(Object.entries(facts).filter(([, value]) => Array.isArray(value) ? value.length : text(value)));
}

function objectiveHardFactCount(facts = {}) {
  return [
    facts.authority,
    facts.document_number,
    facts.involved_party,
    facts.violation_behavior,
    facts.penalty_amount,
    facts.confiscation_result,
    facts.legal_basis,
    facts.product_or_batch,
    facts.hs_code,
    facts.effective_date,
    facts.deadline,
    facts.feedback_channel,
  ].filter(value => text(value)).length;
}

function hasHardLegalEvent(textValue = '', facts = {}) {
  const source = text(textValue);
  return Boolean(
    facts.document_number
    || facts.penalty_amount
    || facts.legal_basis
    || facts.hs_code
    || facts.deadline
    || facts.effective_date
    || /行政处罚|处罚决定|罚款|没收|征求意见|新旧衔接|实施|生效|海关|进口|出口|HS\s*编码|商标|侵权|冒用|假冒|刷单/.test(source)
  );
}

function isLeadPage({ title = '', text: textValue = '', source_url = '' } = {}) {
  const combined = `${title} ${textValue} ${source_url}`;
  return /欢迎访问|首页|专题页|栏目页|监管入口|信息入口|搜索|导航|协会|专业委员会|品牌评价|价值测评/.test(combined)
    && !/行政处罚|处罚决定|罚款|没收|征求意见|公告20\d{2}年第\d+号|HS\s*编码|商品编码|侵权|冒用|假冒/.test(combined);
}

function isRootOrIndexUrl(value = '') {
  try {
    const url = new URL(String(value || ''));
    const path = url.pathname.replace(/\/+/g, '/');
    return path === '/' || /^\/(?:index\.html?)?$/i.test(path) || /\/(?:xw|ggjgs|zwgk|hdjl|bsfw|xxgk)\/(?:index\.html?)?$/i.test(path);
  } catch {
    return false;
  }
}

function isPortalDump({ title = '', text: textValue = '', source_url = '', source_name = '' } = {}) {
  const source = stripMarkdown(`${title} ${source_name} ${textValue}`);
  const navHits = [
    /新闻|时政要闻|媒体聚焦|司局介绍|政策法规|通知公告/,
    /首页|站点导航|搜索|联系我们|地方|总局/,
    /召回查询|缺陷线索|信息查询平台|注册管理信息系统/,
    /1\s+2\s+3\s+4\s+5/,
  ].filter(pattern => pattern.test(source)).length;
  const mixedIndustryHits = [
    /携程|酒店预订|旅游行业|平台经济|反垄断/,
    /食品抽检|保健食品|特殊食品|婴幼儿配方乳粉/,
    /电动自行车|汽车|航空公司|基础教育|金融产品|殡葬/,
  ].filter(pattern => pattern.test(source)).length;
  const manyDatedLinks = (source.match(/\b(?:0?[1-9]|1[0-2])-[0-3]?\d\b/g) || []).length >= 6;
  const titleIsAgency = title && source_name && text(title) === text(source_name);
  return (navHits >= 2 && (isRootOrIndexUrl(source_url) || titleIsAgency || manyDatedLinks))
    || (navHits >= 1 && mixedIndustryHits >= 2)
    || (mixedIndustryHits >= 2 && titleIsAgency);
}

function quoteForField(source, value) {
  const needle = text(value);
  if (!needle) return '';
  const index = source.indexOf(needle);
  if (index < 0) return '';
  return source.slice(Math.max(0, index - 28), Math.min(source.length, index + needle.length + 40));
}

function evidenceQuotes(source, facts = {}) {
  const result = {};
  for (const key of [
    'authority',
    'document_number',
    'involved_party',
    'violation_behavior',
    'penalty_amount',
    'confiscation_result',
    'legal_basis',
    'product_or_batch',
    'hs_code',
    'effective_date',
    'deadline',
    'feedback_channel',
  ]) {
    const value = facts[key];
    const quote = quoteForField(source, value);
    if (quote) result[key] = quote;
  }
  return result;
}

export function gradeEvidence({ text: textValue = '', hard_facts: hardFacts = {}, source_url = '', title = '', source_name = '', country = '' } = {}) {
  const source = stripMarkdown(textValue);
  const facts = hardFacts && typeof hardFacts === 'object' ? hardFacts : {};
  if (!source && !text(title)) {
    return { evidence_grade: 'reject', evidence_reason: 'empty-evidence', evidence_quotes: {} };
  }
  if (isPortalDump({ title, text: source, source_url, source_name })) {
    return { evidence_grade: 'reject', evidence_reason: 'portal-or-mixed-industry-dump', evidence_quotes: evidenceQuotes(source, facts) };
  }
  if (isLeadPage({ title, text: source, source_url })) {
    return { evidence_grade: 'lead_only', evidence_reason: 'lead-or-navigation-page', evidence_quotes: evidenceQuotes(source, facts) };
  }
  if (/\.(?:pdf|docx?|xlsx?|csv)(?:$|[?#])/i.test(source_url) && !source) {
    return { evidence_grade: 'attachment_pending', evidence_reason: 'attachment-without-text', evidence_quotes: {} };
  }
  const hardCount = objectiveHardFactCount(facts);
  if (hardCount >= 1 && hasHardLegalEvent(`${title} ${source} ${source_name} ${country}`, facts)) {
    return { evidence_grade: 'hard_fact_ready', evidence_reason: `hard-facts=${hardCount}`, evidence_quotes: evidenceQuotes(source, facts) };
  }
  if (/征求意见|行政处罚|公告|附件|处罚决定|海关|进口|商标|侵权/.test(`${title} ${source}`)) {
    return { evidence_grade: 'lead_only', evidence_reason: `insufficient-hard-facts=${hardCount}`, evidence_quotes: evidenceQuotes(source, facts) };
  }
  return { evidence_grade: 'reject', evidence_reason: `insufficient-legal-evidence=${hardCount}`, evidence_quotes: evidenceQuotes(source, facts) };
}
