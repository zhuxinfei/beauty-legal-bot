import { perLineText } from './article-evidence.js';

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function clean(value) {
  return text(value)
    .replace(/^[，,、；;：:\s]+/, '')
    .replace(/^(?:将|把|对)(?=[^\s])/, '')
    .replace(/[。；;，,]$/, '');
}

function isUsableFact(value) {
  const source = text(value);
  return Boolean(source)
    && !/^(?:的|和|及|并|按照|依据|根据)[，,、；;：:\s]*(?:按照)?(?:相关法律、行政法规的规定)?(?:处理|执行|处罚)?$/.test(source)
    && !/^的[，,、；;：:]/.test(source);
}

function isValidDate(value = '') {
  const match = text(value).match(/(20\d{2})[-年](\d{1,2})[-月](\d{1,2})日?/);
  if (!match) return false;
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day;
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

// 逐行归一空白、**保留换行**。原先是 text(value) 整篇压平，等于把下面所有抽取正则里
// 的 `[^。；;\n]` 收口全部作废——那些字符类是特意排除换行的（防跨行抓取），压平之后
// 就没有换行可排，chrome 于是混进硬事实：实测 Medicube 一条的「没收/处置」抓成
// 「召回 2:10分钟 UH-OH! 难免有故障」（视频播放器报错条），儿童国标一条的
// 「反馈渠道」抓成「jubao@chinanews.com.cn 举报受理和处置管理办法 总机：86-10-87826688」
// （页脚联系方式）。逐行归一后，这些都在行末被切开。
function stripMarkdown(value) {
  return perLineText(String(value || '')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/`+/g, ''));
}

function extractCompanyNames(value = '') {
  const source = stripMarkdown(value);
  const companyPattern = /([\u4e00-\u9fa5A-Za-z0-9（）()·]{2,48}?(?:有限责任公司|股份有限公司|有限公司|个体工商户|工作室|商行))/g;
  const matches = Array.from(source.matchAll(companyPattern))
    .map(match => match[1].replace(/^.*?(?:披露|通报|认定|处罚|当事人|被处罚人|涉案主体)/, ''))
    .filter(name => !/市场监督管理局|市场监管局|药品监督管理局|国家知识产权局|海关|人民法院|委员会|协会|监管部门/.test(name));
  return uniqueValues(matches).slice(0, 5);
}

function extractAuthority(source, context = {}) {
  return firstMatch(source, [
    /(?:处罚机关|发布机关|发文机关|监管部门|执法机关)[：:]\s*([^。；;\n]{3,50})/,
    // 地名前缀限长 10：原先 {2,24} 会把整句话吞进来——实测儿童化妆品国标一条抽成
    // 「儿童化妆品应当在销售包装展示面标注国家药品监督管理局」（18 字前缀+机构名）。
    // 合法机构名的地名部分最长是「广东汕头市潮阳区」(8)，10 够用、又挡得住句子。
    /(国家药品监督管理局|国家市场监督管理总局|国家知识产权局|海关总署|[\u4e00-\u9fa5]{2,10}市场监督管理局|[\u4e00-\u9fa5]{2,10}市场监管局|[\u4e00-\u9fa5]{2,10}药品监督管理局|[\u4e00-\u9fa5]{2,10}海关)/,
  ]) || text(context.source_name);
}

function extractDocumentNumber(source) {
  return firstMatch(source, [
    /(?:文号|决定书文号|公告编号|编号)[：:\s]*([^\s。；;，,]{2,50}(?:〔20\d{2}〕\d+号|20\d{2}年第\d+号|第\d+号))/,
    /(?:公告|通告)(20\d{2}年第\d+号)/,
    /(20\d{2}年第\d+号)/,
    /([^\s。；;，,]{0,20}〔20\d{2}〕\d+号)/,
    /((?:总局|部|委员会|政府)[^。；;\n]{0,12}?令第\s*\d+\s*号)/,
    /(令第\s*\d+\s*号)/,
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
  if (!/(?:罚款|处罚金额|罚没金额|被罚|处罚|罚没|没收|责令改正)/.test(source)) return '';
  return firstMatch(source, [
    /(?:合计)?(?:罚款|处罚金额|罚没金额)[：:\s]*([0-9]+(?:\.[0-9]+)?\s*(?:万|亿)?元)/,
    /(?:被罚|罚款|处罚金额)([0-9]+(?:\.[0-9]+)?\s*(?:万|亿)?元)/,
  ]);
}

function extractViolationBehavior(source) {
  const labelled = firstMatch(source, [
    /(?:违法事实|违法行为|主要违法事实|侵权行为|违法情形)[：:\s]*([^。；;\n]{6,140})/,
  ]);
  if (isUsableFact(labelled)) return labelled;
  const inferred = firstMatch(source, [
    /([^。；;\n]{4,160}(?:侵权使用|侵权|冒用|假冒|刷单|虚假交易|虚假宣传|未经授权|擅自使用)[^。；;\n]{0,100})/,
  ]);
  return isUsableFact(inferred) ? inferred : '';
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
  const extracted = firstMatch(source, [
    /(?:自|于)?(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)(?:起)?(?:实施|施行|实行|试行|生效|执行)/,
    /(?:生效日期|实施日期|施行日期|执行日期|生效时间)[：:\s]*(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)/,
  ]);
  return isValidDate(extracted) ? extracted : '';
}

function extractDeadline(source) {
  const extracted = firstMatch(source, [
    /(?:意见反馈截止(?:时间|日期|日)?|反馈截止(?:时间|日期|日)?|截止(?:时间|日期|日)?|截至|过渡期至|应于|须于|请于)[：:\s]*(?:为|到|至)?[：:\s]*(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)/,
    /(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)(?:前|之前)(?:[，,]?\s*(?:反馈|提交|报送|提出|书面|将|向))/,
    /(?:公示期|征求意见(?:期限|时间)|反馈期限)(?:为)?[^。；;\n]{0,12}?(20\d{2}[-年]\d{1,2}[-月]\d{1,2}日?)/,
  ]);
  return isValidDate(extracted) ? extracted : '';
}

function extractFeedbackChannel(source) {
  return firstMatch(source, [
    /(?:反馈渠道|反馈方式|反馈途径|意见反馈方式|提交方式|反馈邮箱|反馈电话|意见反馈邮箱)[：:\s]*([^。；;\n]{4,120})/,
  ]);
}

function inferAffectedProcesses(source, facts = {}, context = {}) {
  const module = text(context.module);
  const combined = `${source} ${Object.values(facts).flat().join(' ')}`;
  if (/玻色因|成分卖点|刷单|平台店铺/.test(combined)) {
    return ['成分卖点命名', '商标授权', '平台店铺运营', '达人素材'];
  }
  // 这条分支原先只认「商标」「礼盒」这类**话题词**，于是把约束性表述与产品描述误判成 IP 事件：
  // 儿童化妆品强制国标一文里的「不得利用商标、图案…暗示」「卡通联名礼盒」把它挤掉了标准
  // 分支，业务影响被写成「商标授权、包装设计、达人素材、平台店铺」（应为配方/标签/备案）。
  // 改判据为**权利受侵害的事件词**。注意不能补裸「侵权」——内容农场的页脚免责声明
  // （「无法杜绝所有侵权行为，如有侵权烦请联系我们」）就带这两个字，实测会把加拿大关税
  // 一条从海关分支翻到 IP 分支；「商标权」既能认下北仑海关的「侵犯其…商标权」，又不误伤。
  if (/爱马仕|假冒|冒用|仿冒|山寨|傍名牌|商标权|商标侵权|不正当竞争|包装装潢/.test(combined) || /知识产权/.test(module)) {
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

// --- 结构化通报（key：值 块）的字段读取 ---
// Safety Gate 一类官方通报的正文本身就是一段 `标签：值` 块（通报国/原产国/品牌/
// 风险类型/风险等级/风险描述/处置措施/在线销售商/案号）。压平与不压平在这儿都成立，
// 所以判据只看「一行里连着几个标签：」这个形状。
// 原先的唯一入口是 extractProductOrBatch 的 `[^。；;\n]{2,80}`——它既跨字段溢出
// （实测产品名抓成「…PROFUMO AROMATICO 产品描述：Eau de pa」），又被 80 字截断，
// 于是法务观察退化成把字段倒出来（「涉及Tesori… 产品描述：…，通报国：Greece…」）。
// 这里按**下一个字段标签**收口，拿到干净的单字段值。
const STRUCTURED_ALERT_LABELS = ['通报国', '原产国', '品牌', '产品类别', '产品名称', '产品描述', '型号', '条码', '批号', '风险类型', '风险等级', '风险描述', '处置措施', '在线销售商', '案号'];
// 光有「品牌：/批号：」这种通用标签不算通报，必须带风险或处置字段——否则
// 普通政务页里偶然出现的标签对会被当成通报处理。
const STRUCTURED_ALERT_DECISIVE = ['风险描述', '风险等级', '风险类型', '处置措施'];
// 取值上界只决定「愿意往后找多远才遇到下一个标签」，不决定值本身的长度
// （值在第一个终止符处就停了）。实测 `处置措施` 一栏在正文里重复了两遍，
// 值到下一个标签相距 657 字——600 的旧上界让那一条取值为空，处置措施整段丢失。
const STRUCTURED_ALERT_VALUE_PATTERN = '[\\s\\S]{0,1200}?';
const STRUCTURED_ALERT_MIN_LABELS = 3;

// 预编译：extractHardFacts 每轮要跑数百次（source-hydration 每条一次 + assemble 每条一次
// + 每张卡再抽一次），而标签表与值模板都是模块级常量——原实现每次调用都 filter+join 拼
// alternation 再 new RegExp（15 个标签 × 每次），isStructuredAlert 还对 15 个标签各构造一次。
const STRUCTURED_ALERT_FIELD_RES = new Map([...STRUCTURED_ALERT_LABELS]
  .sort((a, b) => b.length - a.length)   // 长标签优先，避免前缀互相遮蔽
  .map(label => {
    const others = STRUCTURED_ALERT_LABELS.filter(item => item !== label).join('|');
    return [label, new RegExp(`${label}\\s*[:：]\\s*(${STRUCTURED_ALERT_VALUE_PATTERN})(?=\\s*(?:${others})\\s*[:：]|[。]|$)`)];
  }));
const STRUCTURED_ALERT_LABEL_RE = new RegExp(`(${[...STRUCTURED_ALERT_LABELS].sort((a, b) => b.length - a.length).join('|')})\\s*[:：]`, 'g');

function structuredAlertField(source, label) {
  const match = String(source || '').match(STRUCTURED_ALERT_FIELD_RES.get(label));
  return match ? clean(match[1]) : '';
}

function isStructuredAlert(source) {
  const hits = new Set([...String(source || '').matchAll(STRUCTURED_ALERT_LABEL_RE)].map(match => match[1]));
  return hits.size >= STRUCTURED_ALERT_MIN_LABELS
    && [...hits].some(label => STRUCTURED_ALERT_DECISIVE.includes(label));
}

// 处置措施是三个子字段拼在一行的（发出对象 / 措施类别 / 生效日），分开取。
function parseStructuredMeasure(value) {
  const source = text(value);
  if (!source) return {};
  return {
    operator: clean(source.match(/Type of economic operator [^:]*:\s*(.*?)(?:Category of measure|Date of entry|$)/)?.[1] || ''),
    category: clean(source.match(/Category of measure\(s\):\s*(.*?)(?:Date of entry into force|Type of economic operator|$)/)?.[1] || ''),
    date: source.match(/Date of entry into force:\s*(\d{2}\/\d{2}\/\d{4})/)?.[1] || '',
  };
}

function structuredAlertFacts(source) {
  if (!isStructuredAlert(source)) return {};
  const measure = parseStructuredMeasure(structuredAlertField(source, '处置措施'));
  return {
    alert_reference: structuredAlertField(source, '案号'),
    notifying_country: structuredAlertField(source, '通报国'),
    origin_country: structuredAlertField(source, '原产国'),
    brand: structuredAlertField(source, '品牌'),
    risk_type: structuredAlertField(source, '风险类型'),
    risk_level: structuredAlertField(source, '风险等级'),
    risk_description: structuredAlertField(source, '风险描述'),
    measure_category: measure.category,
    measure_operator: measure.operator,
    measure_date: measure.date,
  };
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
  // 通报类的产品名取自专用字段，别让 extractProductOrBatch 的宽抓取跨字段溢出。
  const alert = structuredAlertFacts(source);
  if (alert.risk_description) {
    Object.assign(facts, alert);
    const alertProduct = structuredAlertField(source, '产品名称') || alert.brand;
    if (alertProduct) facts.product_or_batch = alertProduct;
  }
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
    // 召回/下架/撤回 2026-09-11 补：EU Safety Gate 的官方召回通报有品牌、批次、
    // 风险类型、处置措施等硬信息，但一个都不沾「处罚/罚款/文号」，原表把它判成
    // insufficient-legal-evidence 直接 reject。
    || /行政处罚|处罚决定|罚款|没收|征求意见|新旧衔接|实施|生效|海关|进口|出口|HS\s*编码|商标|侵权|冒用|假冒|刷单|召回|下架|撤回|风险警示|通报/.test(source)
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
  // Strong legal content overrides portal noise: a page with a real
  // administrative penalty decision, court judgment, or detailed regulatory
  // notice is not a portal dump even if gov-chrome patterns are present.
  if (/(?:行政处罚决定书|判决书|裁定书|〔20\d{2}〕\d+号|依法立案|违反《[^》]+》第[一二三四五六七八九十百零\d]+条|责令.*停止|没收违法所得|处以?罚款|警告.*并处罚)/.test(source)
      && /(?:化妆品|美妆|护肤|彩妆|香水|防晒|染发|洗护|标签|备案|功效|广告)/.test(source)) {
    return false;
  }
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
  const combined = `${title} ${source}`;
  if (/product safety alerts,? reports and recalls/i.test(combined)
    && /search recalls|product category/i.test(combined)) {
    // OPSS/FDA recall listing pages contain individual product entries
    // with dates and names — useful as lead_only watch items
    return { evidence_grade: 'lead_only', evidence_reason: 'generic-recall-index', evidence_quotes: {} };
  }
  if (!source && !text(title)) {
    return { evidence_grade: 'reject', evidence_reason: 'empty-evidence', evidence_quotes: {} };
  }
  if (isPortalDump({ title, text: source, source_url, source_name })) {
    return { evidence_grade: 'reject', evidence_reason: 'portal-or-mixed-industry-dump', evidence_quotes: evidenceQuotes(source, facts) };
  }
  if (/(?:食品|餐饮|农产品|食用)/.test(combined) && !/(?:化妆品|美妆|护肤|彩妆|香水|cosmetic)/i.test(combined)) {
    return { evidence_grade: 'reject', evidence_reason: 'food-only-event', evidence_quotes: {} };
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
  // Beauty-company business events (IPO, bankruptcy, M&A) are valid intelligence
  // even without classic legal-event patterns
  if (hardCount >= 2 && /(?:上市|IPO|挂牌|招股|退市|破产|清算|收购|并购|重组|融资|财报|业绩)/.test(`${title} ${source}`)
      && /(?:化妆品|美妆|护肤|彩妆|香水|防晒|洗护|美容)/i.test(`${title} ${source}`)) {
    return { evidence_grade: 'hard_fact_ready', evidence_reason: `beauty-biz-event=${hardCount}`, evidence_quotes: evidenceQuotes(source, facts) };
  }
  if (/征求意见|行政处罚|公告|附件|处罚决定|海关|进口|商标|侵权|召回|下架|撤回|风险警示|通报/.test(`${title} ${source}`)) {
    return { evidence_grade: 'lead_only', evidence_reason: `insufficient-hard-facts=${hardCount}`, evidence_quotes: evidenceQuotes(source, facts) };
  }
  return { evidence_grade: 'reject', evidence_reason: `insufficient-legal-evidence=${hardCount}`, evidence_quotes: evidenceQuotes(source, facts) };
}
