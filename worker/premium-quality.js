import { extractHardFacts } from './hard-fact-extractor.js';
import { cleanArticleEvidence, compactEvidenceText, perLineText, firstEvidenceSentence as extractFirstEvidenceSentence } from './article-evidence.js';
import { hasVerifiedCorroboration } from './evidence-corroboration.js';

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

const GENERIC_PATTERNS = /建议关注|持续关注|企业应留意|可能产生影响|后续观察|待进一步明确|视情况|适时|建议进一步核实|存在合规关注价值|进一步核实原文|需持续跟踪/i;
// 执法动作词与 article-evidence.js 的 EVENT_EVIDENCE_PATTERN 保持同族：
// 只认「处罚/罚款」这类正式文书词，会把执法通报（查封/查扣/查获/制假/售假）
// 判成「没有硬事实」而整批拒掉。
const CONCRETE_PATTERNS = /(20\d{2}|发布|公布|通报|处罚|罚款|召回|判决|裁定|征求意见|公开征求|生效|实施|备案|注册|禁用|限用|进口|出口|海关|监管|法院|委员会|药监|市场监管|制假|售假|造假|假货|查封|查扣|查获|缴获|立案|抓获|停职|查处|整治|快速预警|危险非食品|rapid alert|dangerous non-food|Safety Gate|FDA|FTC|BPOM|MFDS|EUIPO|WIPO|\d+(?:\.\d+)?\s*(?:万|亿|元|美元|欧元|件|批|天|%|％))/i;
const OWNER_PATTERN = /法务|合规|法规|质量|研发|供应链|采购|电商|广告|品牌|市场|知识产权|IP|进出口|关务|注册|备案|产品|渠道|海外|本地团队/;
const REPUBLISHER_HOST_PATTERN = /(?:^|\.)((?:sohu|163|sina|qq|toutiao|baijiahao|thepaper|jiemian|36kr)\.com|(?:baijiahao|mp)\.baidu\.com)$/i;
const MEDIA_SOURCE_TYPES = new Set(['industry_media', 'media', 'wechat_lead', 'wechat_public_account', 'discovered_publisher']);
const NAVIGATION_TITLE_PATTERN = /^(?:(?:欢迎访问|欢迎来到).+|(?:网站首页|首页|站点导航|登录|注册|搜索|联系我们|栏目|专题|新闻中心|通知公告|工作动态|化妆品|Cosmetics|Home|Welcome|Menu|Search)(?:$|[\s｜|:：_-].*))/i;
const GENERIC_INFO_PAGE_PATTERN = /(?:安全使用|消费者提示|消费提示|使用提示|科普|常见问题|指南页面|Q&A|questions?\s+and\s+answers?|how\s+to\s+use|safe\s+use|cosmetics\s+safety)/i;
const PORTAL_EVIDENCE_PATTERN = /(?:\* \[新闻\]|\* \[首页\]|javascript:void|司局介绍|时政要闻|地方\]\(|媒体聚焦|重要政策举措及实施效果|召回查询|信息查询平台|注册管理信息系统|数据查询|产业创新|统计监控|快捷检索|高级检索|友情链接|用户需求与满意度调查|证明商标使用申请表|填写说明|查看更多|通知公告\s*更多)/i;
const HARD_LEGAL_EVENT_PATTERN = /(?:文号|公告|通告|通报|征求意见|反馈截止|截止日期|截止|生效|实施|过渡期|新旧衔接|行政处罚|处罚决定|罚款|罚没|没收|违法所得|责令改正|吊销|停止销售|召回|警示信|warning\s+letter|判决|裁定|赔偿|侵权|冒用|假冒|刷单|虚假交易|虚假宣传|功效宣称|平台治理|专项治理|治理公告|商标|专利|著作权|海关|口岸|报关|清关|HS\s*编码|进口|出口|禁用|限用|15\s*个?工作日|serious\s+adverse\s+event|mandatory\s+report)/i;
const BEAUTY_RELEVANCE_PATTERN = /(?:化妆品|美妆|护肤|彩妆|香水|口红|面膜|洗护|防晒|染发|染眉|染睫|美容|医美|祛斑|美白|功效宣称|玻色因|爱马仕|配方|着色剂|色素|进口化妆品|出口化妆品|化妆品标准|cosmetic|cosmetics|MoCRA|color additives?)/i;
const GENERIC_NON_BEAUTY_PATTERN = /(?:在线酒店|酒店预订|机票|旅游|平台经济|外卖|网约车|金融监管|证券|外汇|房地产|教育培训|医疗器械|药品集采|保险|银行|携程|美团|阿里巴巴|腾讯|京东|滴滴|易制毒|新化学物质|新污染物|危险化学品|农药|兽药|饲料|芥末|食用油|纺织品|家具)/i;
const PREMIUM_JUNK_EVIDENCE_PATTERN = /(?:欢迎访问|通知公告\s*更多|首页\s+资讯中心|栏目导航|工作委员会|专业委员会名单|证明商标使用申请表|填写说明|粤港澳知识产权大数据综合服务平台|快捷检索|高级检索|友情链接|用户需求与满意度调查问卷|政府侧应用与数据需求调研问卷)/i;
// 技术垃圾值（undefined/null/NaN）必须按**整词**认：这几个串在英文正文里到处都是
// 子串——实测 Safety Gate 的风险描述「…should not be used by pregnant and breastfeeding
// women…」里的「pregnan**t**」被 /NaN/i 命中，整段风险描述被判成坏字段丢掉，
// 法务观察随之退回字段倒出。加 \b 只认独立的裸值，判据本意不变。
const BROKEN_FIELD_PATTERN = /(?:\[\s*\]\s*\(|\]\($|\(\s*$|\[\s*$|javascript:void|\bundefined\b|\bnull\b|\bNaN\b|>\s*$|<\s*$)/i;
const FRAGMENT_FIELD_PATTERN = /^(?:的|和|及|并|依法|予以|进行|相关|上述|该|此|其|对|将|已|了)[，,、；;\s]*(?:依法)?(?:严肃查处|处理|监管|处罚|执行|实施|发布|通告|公告)?$/;
const DOCUMENT_TITLE_AS_PRODUCT_PATTERN = /(?:关于)?(?:\d+\s*批次)?(?:不符合规定)?化妆品的(?:公告|通告)[（(]20\d{2}年第\d+号[）)](?:\s|$)/;
const MIXED_NOTICE_CHROME_PATTERN = /20\d{2}[-年]\d{1,2}[-月]\d{1,2}.*(?:召开|工作动态|监管动态|新闻|会议|活动|培训|论坛|检查)/;
const GENERIC_NAVIGATION_TITLE_PATTERN = /^(?:全文页|政策解读|法规解读|政策法规|法规文件|化妆品政策法规|政策法规及标准|履职依据|海关法规|法律法规|规章|规范性文件|部门文件|文件通知|通知公告|政府信息公开|政府信息公开制度|信息公开指南|首页|网站首页|信息公示|信用信息|商标公告|行政执法结果|工作动态|监管动态|新闻中心|最新动态|栏目页|专题页|信息发布|公示公告|机构简介|协会简介|商会简介|研究中心|门户网站|网站地图|中企商标发展中心|中企商标鉴定中心|《?中华商标》?杂志社?|化妆品召回|化妆品处罚|化妆品抽检|化妆品监管|法规网.*数据库)$/;
// 营销指南/SEO 稿与评论观察类文章：不是法律事件，不进正式报告
const COMMENTARY_OR_GUIDE_PATTERN = /(?:全指南|一文读懂|一文看懂|避坑|流程、费用|注册攻略|申请攻略|时评|社论|锐评|漫谈|正当其时|成了生意|谁之过|何时休)/;
const JUNK_DATE_PATTERN = /^20(?:0\d|1[0-9]|2[01])/;
const GOVERNMENT_FOOTER_PATTERN = /(?:中国政府网|国家政务服务平台|国家市场监督管理总局|©|版权所有|党政机关|政府网站|站点地图|主办单位|通信地址|滇ICP|网站标识码|无障碍浏览|适老化|隐私保护|法律声明|返回首页|页面放大|页面缩小|移动版|本站查询|一网通查|主要职责|基本信息|领导介绍|机构设置|按主题分类|按时间分类|药品GSP|化妆品审评\s*国家抽检管理|办理流程\s*立案|缴纳情况\s*\d{4}年|请\s*\d+s\)\s*抱歉|信息中心|网站声明|智能问答|业务咨询|關閉|esc键)/i;

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function utf8Bytes(value) {
  return UTF8_ENCODER.encode(String(value || '')).length;
}

function sanitizeBriefingText(value) {
  return text(cleanArticleEvidence(value))
    .replace(/\[([^\]]*)\]\(\s*javascript:void\([^)]*\)\s*\)/gi, '$1')
    .replace(/\[\s*\]\([^)]*\)/g, '')
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
  if (BROKEN_FIELD_PATTERN.test(source) || FRAGMENT_FIELD_PATTERN.test(source) || /^的[，,、；;：:]/.test(source) || /^的[，,、；;：:].*按照相关法律、行政法规的规定处理/.test(source)) return '';
  if (DOCUMENT_TITLE_AS_PRODUCT_PATTERN.test(source) || MIXED_NOTICE_CHROME_PATTERN.test(source)) return '';
  if (GOVERNMENT_FOOTER_PATTERN.test(source)) return '';
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
    // 结构化通报字段（EU Safety Gate 等）：风险与处置是「法务观察」的分析素材，
    // 没有它们就只能把 key：value 抄一遍。见 hard-fact-extractor.js 的
    // structuredAlertFacts。
    alert_reference: hardText(input.alert_reference),
    notifying_country: hardText(input.notifying_country),
    origin_country: hardText(input.origin_country),
    brand: hardText(input.brand),
    risk_type: hardText(input.risk_type),
    risk_level: hardText(input.risk_level),
    risk_description: hardText(input.risk_description),
    measure_category: hardText(input.measure_category),
    measure_operator: hardText(input.measure_operator),
    measure_date: hardText(input.measure_date),
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

function inferPolicySpecificProcesses(value) {
  const source = text(value);
  if (/新原料注册备案.*资料管理|注册备案资料管理规定/.test(source)) {
    return ['配方开发', '新原料注册备案资料', '备案资料管理', '存量SKU过渡期管理'];
  }
  if (/三价铬和六价铬|检验方法.*安全技术规范|安全技术规范.*检验方法/.test(source)) {
    return ['检验方法引用', '配方合规评估', '质量放行', '备案资料'];
  }
  return [];
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
    const normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const parsed = new Date(`${normalized}T00:00:00Z`);
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day
      ? normalized
      : '';
  }
  const cn = source.match(/(20\d{2})年(\d{1,2})月(\d{1,2})日?/);
  if (cn) {
    const year = Number(cn[1]);
    const month = Number(cn[2]);
    const day = Number(cn[3]);
    const normalized = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const parsed = new Date(`${normalized}T00:00:00Z`);
    return parsed.getUTCFullYear() === year && parsed.getUTCMonth() + 1 === month && parsed.getUTCDate() === day
      ? normalized
      : '';
  }
  const compact = source.match(/(?:^|[^\d])(20\d{2})(\d{2})(\d{2})(?:\d{4,}|[^\d]|$)/);
  if (compact) return isoDate(`${compact[1]}-${compact[2]}-${compact[3]}`);
  return '';
}

// 官方站点详情页 URL 常内嵌发布时间戳（如 NMPA 的 /20260529150154170.html）。
// 仅对政府/官方域名启用，避免把无关数字串误当日期。
function compactDateFromOfficialUrl(value = '') {
  const raw = text(value);
  if (!/(?:\.gov\.cn|\.gov|\.org\.cn)(?:[:/]|$)/i.test(raw)) return '';
  let path = '';
  try {
    path = new URL(raw).pathname;
  } catch {
    return '';
  }
  const match = path.match(/(20\d{2})(\d{2})(\d{2})/);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 2020 || year > 2035 || month < 1 || month > 12 || day < 1 || day > 31) return '';
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function candidateDisplayDate(candidate = {}, hardFacts = {}, source = '') {
  return isoDate(candidate.published_at)
    || isoDate(candidate.updated_at)
    || isoDate(candidate.created_at)
    || isoDate(candidate.date)
    || isoDate(hardFacts.effective_date)
    || isoDate(hardFacts.deadline)
    || isoDate(candidate.source_url || candidate.url)
    || compactDateFromOfficialUrl(candidate.source_url || candidate.url)
    || isoDate(source);
}

function inferViolationBehavior(value) {
  const source = text(value);
  return firstMatch(source, [
    /(?:违法事实|违法行为|主要违法事实|侵权行为|违法情形)[：:\s]*([^。；;\n]{6,120})/,
    /([^。；;\n]{4,120}(?:侵权|冒用|假冒|刷单|虚假交易|虚假宣传|未经授权|擅自使用)[^。；;\n]{0,80})/,
  ]);
}

// 「违法行为」抽到标题本身 = 标题倒灌：标题在 facts 里已单独占位，这里没有新增信息。
// 「违法行为」抽到处罚措辞（「并处以罚款1万元」）说明它抓的是另一句里的处罚结果，
// 不是违法事实——句子会读成「因并处以罚款1万元被公开处理」。
const PENALTY_PHRASE_PATTERN = /^(?:并|且|同时|另)?(?:处以|被处以|予以|给予|处以)?(?:罚款|罚没|没收|罚款人民币)/;
function rejectPenaltyPhrase(value) {
  return PENALTY_PHRASE_PATTERN.test(text(value)) ? '' : value;
}

function rejectTitleEcho(value, title) {
  const norm = item => text(item).replace(/[\s。；;，,、：:！!？“”''「」（）()\-—|｜]+/g, '');
  const act = norm(value);
  const headline = norm(text(title).split(/\s+[—\-|]\s+/)[0]);
  if (!act || !headline) return value;
  return (act === headline || headline.startsWith(act) || act.startsWith(headline)) ? '' : value;
}

function inferConfiscationResult(value) {
  return firstMatch(value, [
    /((?:没收|罚没|销毁|责令下架|下架|停止销售|召回)[^。；;\n]{2,120})/,
  ]);
}

// 站点的「联系方式条」不是本文档的意见反馈渠道。实测中新网一条把页脚的
// 「违法和不良信息举报平台 举报邮箱：jubao@chinanews.com.cn 举报受理和处置管理办法
// 总机：86-10-87826688」当成反馈渠道，印进了「下一步观察建议」：
// 「通过jubao@chinanews.com.cn 举报受理和处置管理办法 总机：86-10-87826688在截止日前提交…」。
// 判据：带站点服务标记（举报/总机/客服/违法和不良信息/版权/广告服务/人才招聘/联系我们）
// 或过长（>60 字，跨字段粘连）的一律不算。
const SITE_CONTACT_STRIP_PATTERN = /举报|总机|客服|违法和不良信息|版权|广告服务|人才招聘|联系我们/;
function inferFeedbackChannel(value) {
  const channel = firstMatch(value, [
    /(?:反馈渠道|反馈方式|意见反馈|提交方式|电子邮箱|邮箱|联系人|邮寄地址)[：:\s]*([^。；;\n]{4,120})/,
    /((?:电子邮箱|邮箱|邮寄地址|联系人)[：:\s]*[^。；;\n]{4,120})/,
  ]);
  if (!channel) return ;
  if (SITE_CONTACT_STRIP_PATTERN.test(channel) || channel.length > 60) return ;
  return channel;
}

function inferPolicyProductOrRule(value) {
  const source = text(value);
  if (/化妆品标准管理|标准执行|新旧标准衔接|标准制修订/.test(source)) return '化妆品标准管理规则';
  if (/新原料注册备案.*资料管理|注册备案资料管理规定/.test(source)) return '化妆品新原料注册备案资料管理规定';
  if (/三价铬和六价铬/.test(source)) return '化妆品中三价铬和六价铬的检验方法';
  return '';
}

function withInferredHardFacts(hardFacts, card) {
  const source = [
    card.evidence_text,
    card.title,
    card.facts,
    card.business_impact,
  ].flat().join('。');
  // 剔除与来源同名的公司：`extractCompanyNames` 会把页脚版权声明里的**出版方**收进来
  // （实测「本文的内容与版权均归杭州瑞欧科技有限公司…」被当成当事人），而发布方不是当事人。
  const sourceNameKey = text(card.source_name).replace(/[（(].*$/, '');
  const isPublisher = name => Boolean(sourceNameKey) && (name.includes(sourceNameKey) || sourceNameKey.includes(name));
  const companyNames = extractCompanyNames(source).filter(name => !isPublisher(name));
  const needsPartyDisclosure = ['广告处罚案例', '知识产权保护或者侵权'].includes(normalizeModule(card.module));
  // 发布方不是当事人——过滤要作用在**两条来源**上：抽取层给的 involved_party 同样会
  // 把页脚版权声明里的出版公司收进来（只挡 fallback 那条会被短路）。
  const dropPublisher = value => text(value).split('、').filter(name => !isPublisher(name)).join('、');
  const involvedParty = dropPublisher(isVagueInvolvedParty(hardFacts.involved_party)
    ? (companyNames.length ? companyNames.join('、') : needsPartyDisclosure ? '原文未披露' : '')
    : hardFacts.involved_party);
  return {
    ...hardFacts,
    product_or_batch: hardFacts.product_or_batch || inferPolicyProductOrRule(source),
    involved_party: involvedParty,
    signal_type: hardFacts.signal_type || inferSignalType(source),
    risk_tier: hardFacts.risk_tier || inferRiskTier(source),
    affected_processes: hardFacts.affected_processes.length ? hardFacts.affected_processes : inferAffectedProcesses(source),
    // 两个来源都要过守卫：抽取层给的 violation_behavior 同样会复读标题（短路掉守卫）
    violation_behavior: rejectPenaltyPhrase(rejectTitleEcho(hardFacts.violation_behavior || inferViolationBehavior(source), card.title)),
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
  const sourceText = text(candidate.article_text || candidate.evidence_text || '');
  // Official government/court sources by domain
  if (/nmpa\.gov\.cn/i.test(url) || /^国家药监局/.test(title)) return '国家药品监督管理局';
  if (/nifdc\.org\.cn/i.test(url) || /^中检院/.test(title)) return '中检院';
  if (/fda\.gov/i.test(url)) return '美国食品药品监督管理局（FDA）';
  if (/ftc\.gov/i.test(url)) return '美国联邦贸易委员会（FTC）';
  if (/gov\.uk/i.test(url)) return '英国产品安全与标准办公室（OPSS）';
  if (/recalls-rappels\.canada\.ca|healthycanadians\.gc\.ca/i.test(url)) return '加拿大卫生部';
  if (/customs\.gov\.cn/i.test(url) || /^海关/.test(title)) return '海关总署';
  // Local government — extract authority name from page title or URL
  if (/\.gov\.cn/i.test(url)) {
    if (/scjgj|市场监督|市场监管局/i.test(title + url)) {
      const city = (title.match(/([一-龥]{2,6}(?:市|区|县|省))/)?.[0] || '');
      return city ? `${city}市场监督管理局` : '地方市场监督管理局';
    }
    if (/yjj|药品监督|药监局/i.test(title + url)) return '地方药品监督管理局';
    if (/人民法院|court/i.test(title + url)) return title.match(/([一-龥]{2,10}(?:市|区|县)人民法院)/)?.[0] || '人民法院';
    return '政府网站';
  }
  // Republisher fallback — try to find original source in article text
  if (REPUBLISHER_HOST_PATTERN.test(hostOf(url)) || /搜狐|腾讯|网易|新浪|凤凰|头条/i.test(text(candidate.source_name))) {
    if (/国家药监局|国家药品监督管理局/.test(sourceText)) return '国家药品监督管理局（转载）';
    if (/中检院|中国食品药品检定研究院/.test(sourceText)) return '中检院（转载）';
    if (/海关总署|海关发布/.test(sourceText)) return '海关总署（转载）';
    if (/市场监督管理局/.test(sourceText)) {
      const m = sourceText.match(/([一-龥]{2,10}(?:市|区|县)市场监督管理局)/);
      return m ? `${m[1]}（转载）` : '地方市场监管局（转载）';
    }
    // Map known republisher names to cleaner labels
    const name = text(candidate.source_name || candidate.name);
    if (/搜狐/i.test(name)) return '搜狐财经';
    if (/腾讯/i.test(name)) return '腾讯新闻';
    if (/网易/i.test(name)) return '网易新闻';
    if (/凤凰/i.test(name)) return '凤凰网';
    if (/新浪/i.test(name)) return '新浪财经';
  }
  // Clean common raw-domain names
  const name = text(candidate.source_name || candidate.name);
  if (/haiwaiwai\.com/i.test(name)) return '海外外媒';
  if (/nfplus\.nfnews/i.test(name)) return '南方+';
  if (/reach24h|瑞欧/i.test(name)) return '瑞欧科技';
  return text(candidate.source_name || candidate.name);
}

// Clean ugly titles: strip domain prefixes, multi-separator suffixes, etc.
function cleanDisplayTitle(rawTitle = '') {
  let t = rawTitle;
  // Strip leading domain prefixes like "www.haiwaiwai.com"
  t = t.replace(/^(?:https?:\/\/)?(?:www\.)?[a-z0-9.-]+\.(?:com|cn|org|net)\s*/i, '');
  // Strip trailing " - 来源名" or "| 来源名" or "_来源名"
  t = t.replace(/\s*[-|_→]\s*(?:搜狐|腾讯|网易|新浪|凤凰|QQ|头条|百度|南方\+|南方plus|财富号|东方财富|界面新闻|36氪|澎湃新闻|新京报|每日经济新闻|第一财经)[^]*$/i, '');
  // Strip "老字号陨落 |" style multi-title prefixes
  t = t.replace(/^[^|]{2,20}\s*\|\s*/, '');
  // Collapse whitespace
  t = t.replace(/\s+/g, ' ').trim();
  return t || rawTitle;
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
  const candidateSource = text([candidate.title, candidate.article_text, candidate.full_text, candidate.evidence_text].filter(Boolean).join('。'));
  if (authority) next.authority = authority;
  if (titleProduct && (!hardText(next.product_or_batch) || DOCUMENT_TITLE_AS_PRODUCT_PATTERN.test(text(next.product_or_batch)))) {
    next.product_or_batch = titleProduct;
  }
  if (/新原料注册备案.*资料管理|注册备案资料管理规定/.test(text(next.product_or_batch))
    && /三价铬和六价铬/.test(text(next.legal_basis))) {
    next.legal_basis = '';
  }
  const specificProcesses = inferPolicySpecificProcesses([candidateSource, next.product_or_batch].join('。'));
  if (specificProcesses.length) {
    const genericProcessPattern = /^(?:备案\/注册|配方\/检验标准)$/;
    next.affected_processes = uniqueValues([
      ...specificProcesses,
      ...(Array.isArray(next.affected_processes) ? next.affected_processes.filter(item => !genericProcessPattern.test(text(item))) : []),
    ]);
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
    const hasPolicyEvent = /征求意见|公开征求|发布|公告|通告|修订|标准|规则|办法|条例|法案|认证要求|合规要求|requirement|regulation|rule/i.test(source);
    const hasConcreteChange = /明确|要求|规定|调整|更新|新增|删除|修订|执行|衔接|过渡期|反馈截止|生效|实施|禁用|限用|纳入|替代/i.test(source);
    const hasStructuredPolicyDetail = hasProduct && Boolean(hardText(hard.effective_date) || hardText(hard.deadline) || hardText(hard.feedback_channel));
    return hasPolicyNode && hasPolicyEvent && (hasConcreteChange || hasStructuredPolicyDetail);
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
  // Judge the page by factual evidence only. Generated fields
  // (legal_signal/business_impact/recommended_action) are templates that can
  // contain generic-page vocabulary like "配套问答" and must not mark a real
  // detail page as navigation.
  const source = factualEvidenceTextForCard(card);
  // Hard-fact endpoint or corroborated sources are always valid pages
  if (isHardFactReadyDetailCard(card)) return false;
  // Substantive beauty regulatory content on government/industry portals
  // should not be rejected even if the page has some portal chrome.
  if (/(?:化妆品|美妆|护肤|彩妆|防晒|染发|洗护|香水|备案|注册|标准|检验方法|行政处罚|处罚决定|通告|公告|征求意见|安全技术规范)/.test(source)
      && /(?:国家药监局|药监局|中检院|市场监督管理局|海关|nmpa|nifdc|customs)/i.test(source)) {
    return false;
  }
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
  const detailStatus = text(card.detail_status);
  const hydrationSource = text(card.hydration_source);
  const url = text(card.source_url || card.url);
  const isDetailUrl = /\/20\d{12,}\.html?$|\/20\d{2}\/\d{1,2}\/\d{1,2}\/|\/xxgk\/.+\/20\d{12,}\.html?$/i.test(url)
    && !/\/index\.html?$/i.test(url);
  const trustedGrade = ['hard_fact_ready', 'corroborated_fact_ready'].includes(grade);
  const trustedAuthority = ['official_site', 'regulator', 'court', 'official_database'].includes(text(card.source_type))
    || ['official', 'regulator', 'court'].includes(text(card.authority_type));
  const hydratedDetail = detailStatus === 'hydrated'
    && (hydrationSource === 'crawl4ai' || trustedAuthority);
  if (!trustedGrade && scope !== 'hard_fact_endpoint' && !(hydratedDetail && trustedAuthority)) return false;
  return scope === 'hard_fact_endpoint' || isDetailUrl || hydratedDetail;
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
  if (hasVerifiedCorroboration(card)) return false;
  // Industry media with concrete beauty legal content is acceptable
  const source = factualEvidenceTextForCard(card);
  if ((MEDIA_SOURCE_TYPES.has(text(card.source_type)) || text(card.authority_type) === 'media')
      && BEAUTY_RELEVANCE_PATTERN.test(source)
      && HARD_LEGAL_EVENT_PATTERN.test(source)) {
    return false;
  }
  return REPUBLISHER_HOST_PATTERN.test(hostOf(card.source_url || card.url))
    || MEDIA_SOURCE_TYPES.has(text(card.source_type))
    || text(card.authority_type) === 'media'
    || /搜狐|转载|综合自|公众号线索|行业媒体/.test(text(card.source_name));
}

function isRepublisherIdentity(card = {}) {
  return REPUBLISHER_HOST_PATTERN.test(hostOf(card.source_url || card.url))
    || /搜狐|转载|综合自|公众号线索/.test(text(card.source_name));
}

function isConcreteDiscoveredPublisherCard(card = {}) {
  if (text(card.source_scope) !== 'discovered_article') return false;
  if (isRepublisherIdentity(card)) return false;
  if (text(card.detail_status) && text(card.detail_status) !== 'hydrated') return false;
  const evidenceGrade = text(card.evidence_grade);
  const trustedEvidence = ['hard_fact_ready', 'corroborated_fact_ready'].includes(evidenceGrade)
    || text(card.verification_status) === 'corroborated';
  if (text(card.editorial_status) !== 'accepted' && !trustedEvidence) return false;
  const source = factualEvidenceTextForCard(card);
  const hardCount = objectiveHardFactCount(card.hard_facts || {});
  return BEAUTY_RELEVANCE_PATTERN.test(source)
    && HARD_LEGAL_EVENT_PATTERN.test(source)
    && (hardCount >= 2 || hasHardLegalEvent(card));
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

function primaryBeautySignalText(card = {}) {
  const hard = card.hard_facts || {};
  return [
    card.title,
    card.facts,
    card.evidence_text,
    hard.product_or_batch,
    hard.violation_behavior,
  ].flat().join(' ');
}

function isCrossDomainPenaltyNoise(card = {}) {
  const primarySignal = primaryBeautySignalText(card);
  return /(?:食品|餐饮|农产品|食用)/.test(primarySignal) && !BEAUTY_RELEVANCE_PATTERN.test(primarySignal);
}

function isBeautyRelevantCard(card = {}) {
  const sourceEvidence = sourceEvidenceTextForRelevance(card);
  if (isCrossDomainPenaltyNoise(card)) return false;
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
      // 真实法规页经常只有正文：标题/正文已明确指向某部法规/标准/公告，且引用了
      // 具体法律依据（《…》）时，不再以"缺少生效日/文号"为由拒收。
      const basisInTitleOrSource = /(办法|规定|公告|标准|征求意见|条例|通知|通告|规范|细则|指南)/.test(`${card.title} ${source}`);
      if (!(hard.legal_basis && basisInTitleOrSource)) return 'policy-missing-effective-or-deadline';
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
    // 执法通报单开判据（2026-09-11 用户确认）：查封/查扣/立案类通报没有「裁判结果」，
    // 原先与知产诉讼共用判据而被整批拒掉——实测汕头化妆品制假售假系列约 10 条全灭
    // 在这里。判据是「执法机关 + 当事人 + 处置结果」。诉讼类稿件的既有标准不变，
    // 下面这条命中才放行，命中不了仍走原来的三要素判据。
    const enforcementBlob = `${card.title || ''} ${source}`;
    const hasEnforcementAgency = /(市场监督管理局|市场监管|药监局|药品监督管理局|公安局|公安机关|综合执法|行政执法|执法工作组|执法组)/.test(enforcementBlob);
    const hasSeizureResult = /(查封|查扣|查获|缴获|立案|抓获|停职|查处|整治|责令|吊销|控制)/.test(enforcementBlob);
    const hasEnforcementParty = Boolean(meaningfulInvolvedParty(hard.involved_party))
      || /(涉事|当事人|相关人员|人员|公司|企业|商家|店铺|网店|窝点|工厂)/.test(enforcementBlob);
    if (hasEnforcementAgency && hasSeizureResult && hasEnforcementParty) return '';

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
    detail_status: text(card.detail_status),
    editorial_status: text(card.editorial_status),
    evidence_grade: text(card.evidence_grade),
    verification_status: text(card.verification_status),
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
  if (normalized.source_candidate && !/[\u4e00-\u9fff]/.test(normalized.title)) {
    return { accepted: false, reason: 'missing-chinese-display-title', card: normalized };
  }
  if (GENERIC_NAVIGATION_TITLE_PATTERN.test(normalized.title)) {
    return { accepted: false, reason: 'navigation-title', card: normalized };
  }
  if (COMMENTARY_OR_GUIDE_PATTERN.test(normalized.title)) {
    return { accepted: false, reason: 'commentary-or-guide', card: normalized };
  }
  if (!isHttpUrl(normalized.source_url)) return { accepted: false, reason: 'missing-source-url', card: normalized };
  if (isNonAuthoritativeRepublisher(normalized) && !isConcreteDiscoveredPublisherCard(normalized)) return { accepted: false, reason: 'non-authoritative-source', card: normalized };
  if (isNavigationOrGenericInformationPage(normalized)) return { accepted: false, reason: 'navigation-or-generic-page', card: normalized };
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(normalized.published_at)) return { accepted: false, reason: 'missing-date', card: normalized };
  // Reject garbage dates: month > 12, month = 0, day > 31, day = 0, year < 2020
  {
    const [y, m, d] = (normalized.published_at || '').split('-').map(Number);
    if (!y || y < 2020 || m < 1 || m > 12 || d < 1 || d > 31) {
      return { accepted: false, reason: 'invalid-date', card: normalized };
    }
  }
  if (isCrossDomainPenaltyNoise(normalized)) return { accepted: false, reason: 'case-not-beauty-specific', card: normalized };
  if (!isBeautyRelevantCard(normalized)) return { accepted: false, reason: 'not-beauty-relevant', card: normalized };
  // 官方/监管来源的治理动态卡（行业协会动态、专项检查、整治行动、备案试点）
  // 没有文号/金额/批次等硬事实锚点，weak-facts 放宽到 facts 非空即可；
  // 非官方来源保持严格，防止自媒体拼凑内容放水。
  const authoritySourceCard = ['official_site', 'regulator', 'court', 'official_database'].includes(text(normalized.source_type))
    || ['official', 'regulator', 'court'].includes(text(normalized.authority_type))
    || /(^|\.)gov\.(cn|uk|au|ca|sg|jp|kr|tw|hk)|\.gov$|europa\.eu|pom\.go\.id|moph\.go\.th|dav\.gov/i.test(String(normalized.source_url || ''));
  if (!normalized.facts.length) return { accepted: false, reason: 'weak-facts', card: normalized };
  // 具体性检查同时看 facts 与 hard_facts 锚点：媒体源报道的处罚案例，事实要点
  // 可能只落在 hard_facts（处罚机关/金额/法律依据/文号），不在 facts 文案里。
  const concreteEvidence = [
    normalized.facts.join(' '),
    normalized.hard_facts.authority,
    normalized.hard_facts.penalty_amount,
    normalized.hard_facts.confiscation_result,
    normalized.hard_facts.legal_basis,
    normalized.hard_facts.document_number,
    normalized.hard_facts.effective_date,
    normalized.hard_facts.deadline,
  ].filter(Boolean).join(' ');
  if (!authoritySourceCard && !CONCRETE_PATTERNS.test(concreteEvidence)) {
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

export function selectPremiumPortfolio(cards = [], {
  targetItems = 20,
  minimumPerModule = 2,
  maximumPerModule = 5,
} = {}) {
  const accepted = selectablePremiumPortfolioCards(cards);
  accepted.sort(compareSelectionCards);

  const selected = [];
  const selectedKeys = new Set();
  const moduleCounts = new Map();
  const take = card => {
    if (!card || selected.length >= targetItems) return false;
    const key = cardSelectionKey(card);
    if (selectedKeys.has(key) || (moduleCounts.get(card.module) || 0) >= maximumPerModule) return false;
    selected.push(card);
    selectedKeys.add(key);
    moduleCounts.set(card.module, (moduleCounts.get(card.module) || 0) + 1);
    return true;
  };

  for (let round = 0; round < minimumPerModule; round += 1) {
    const roundCards = MODULE_ORDER
      .map(module => accepted.filter(card => card.module === module)[round])
      .filter(Boolean)
      .sort(compareSelectionCards);
    for (const card of roundCards) take(card);
  }
  for (const card of accepted) take(card);
  return selected;
}

function selectablePremiumPortfolioCards(cards = []) {
  const seen = new Set();
  const accepted = [];
  for (const input of cards) {
    const decision = validatePremiumEvidenceCard(input);
    if (!decision.accepted || !isSampleGradeCard(decision.card)) continue;
    const key = `${decision.card.source_url.toLowerCase()}|${decision.card.title.replace(/\s+/g, '')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    accepted.push({ ...decision.card, tier: decision.tier, score: decision.score });
  }
  return accepted;
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
    .filter(card => !isNonAuthoritativeRepublisher(card) || isConcreteDiscoveredPublisherCard(card))
    .filter(card => !isNavigationOrGenericInformationPage(card))
    .filter(card => isBeautyRelevantCard(card))
    .filter(card => /^20\d{2}-\d{2}-\d{2}$/.test(card.published_at))
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

function translateBriefText(value) {
  return text(value)
    .replace(/Product Safety Alerts, Reports and Recalls/gi, '英国化妆品产品安全通报')
    .replace(/Product Safety Report:/gi, '产品安全报告：')
    .replace(/Product Recall:/gi, '产品召回：')
    .replace(/The product has been withdrawn from the market\./gi, '该产品已被采取撤出市场措施。')
    .replace(/withdrawn from the market/gi, '已撤出市场')
    .replace(/Risk case/gi, '风险案例')
    .replace(/Risk level:?\s*Serious/gi, '风险等级：严重')
    .replace(/Risk type:?\s*Chemical/gi, '风险类型：化学')
    .replace(/Risk type:?\s*Microbiological/gi, '风险类型：微生物')
    .replace(/present a serious chemical risk/gi, '构成严重化学风险')
    .replace(/Impacts market sales/gi, '影响市场销售')
    .replace(/Quality team should/gi, '质量团队应')
    .replace(/market sales/gi, '市场销售')
    .replace(/monitor follow-up defect and batch information/gi, '跟踪后续缺陷和批次信息')
    .replace(/UK product safety service/gi, '英国产品安全服务')
    .replace(/official recall/gi, '正式召回')
    .replace(/withdrawal/gi, '撤出市场')
    .replace(/The product presents a serious chemical risk/gi, '该产品构成严重化学风险')
    .replace(/The product has been recalled from end users/gi, '该产品已从终端用户召回')
    .replace(/recalled from end users/gi, '已从终端用户召回')
    .replace(/alert number:?\s*/gi, '通报编号：')
    .replace(/notifying country:?\s*/gi, '通报国家：')
    .replace(/Product category:?\s*Cosmetics/gi, '产品类别：化妆品')
    .replace(/Corrective measures:?\s*/gi, '整改措施：')
    .replace(/Recall of the product from end users/gi, '从终端用户召回产品')
    .replace(/Withdrawal of the product from the market/gi, '产品撤出市场')
    .replace(/Removal of the product listings/gi, '下架产品链接');
}

function cleanBriefPart(value) {
  return compactEvidenceText(translateBriefText(value), 220).replace(/[。；;,\s]+$/g, '');
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
  const title = cleanDisplayTitle(translateBriefText(card.title));
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
  const evidenceText = text(item.evidence_excerpt || item.article_text || item.full_text || item.snippet || item.evidence_text);
  const hardFactsInput = normalizeHardFacts(item.hard_facts || item.extraction?.hard_facts || item.extraction?.legal_facts || {});
  const baseCard = {
    title: cleanDisplayTitle(text(item.title)),
    module,
    source_url: text(item.source_url),
    source_name: sourceNameFromCanonicalSource(item),
    source_type: text(item.source_type),
    authority_type: text(item.authority_type),
    source_scope: text(item.source_scope),
    evidence_grade: text(item.evidence_grade),
    verification_status: text(item.verification_status),
    supporting_sources: Array.isArray(item.supporting_sources) ? item.supporting_sources : [],
    agreed_anchors: Array.isArray(item.agreed_anchors) ? item.agreed_anchors : [],
    detail_status: text(item.detail_status),
    hydration_source: text(item.hydration_source),
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
  const actionCount = selected.filter(card => card.tier === 'action').length;
  const watchCount = selected.filter(card => card.tier !== 'action').length;
  const moduleCount = [...new Set(selected.map(card => card.module))].length;
  const lines = [
    `# 美妆法务资讯周报${start || end ? `（${start} 至 ${end}）` : ''}`,
    '',
    `> 本期共 ${selected.length} 条，覆盖 ${moduleCount} 个模块。🔴 行动事项 ${actionCount} 条，🔵 关注事项 ${watchCount} 条。`,
    '',
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
      .sort((a, b) => (b.tier === 'action' ? 1 : 0) - (a.tier === 'action' ? 1 : 0) || comparePremiumCards(a, b));
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

export function buildPremiumDingTalkMessageChunks(report, cards = [], maxBytes = 18000) {
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
  const maxItems = Number(options.maxItems || options.targetItems || 20);
  const minimumPerModule = Number(options.minimumPerModule ?? 2);
  const maximumPerModule = Number(options.maximumPerModule ?? 5);
  const premiumCards = cardsForPremiumDelivery(reportCards, maxItems);
  let cards = premiumCards.length ? premiumCards : fallbackEvidenceCards(reportCards, maxItems);
  cards = backfillChinaFromCandidates(cards, options.candidates || [], maxItems);
  if (!premiumCards.length && reportCards.length) {
    const audit = auditPremiumEvidenceCards(reportCards);
    console.log(`[premium-card] strict gate accepted 0/${audit.input}; fallback=${cards.length}; reasons=${Object.entries(audit.reasons).map(([reason, count]) => `${reason}=${count}`).join(', ') || 'none'}`);
  }
  const eligibleCandidates = (options.candidates || []).filter(isPremiumCandidateSource);
  const eligibleCandidateCards = eligibleCandidates.map(premiumCardFromCandidate);
  const candidateAudit = auditPremiumEvidenceCards(eligibleCandidateCards);
  const acceptedCandidateCards = candidateAudit.decisions
    .filter(item => item.accepted)
    .map(item => ({ ...item.card, score: item.score || scoreCard(item.card), tier: (item.score || 0) >= 95 ? 'action' : 'watch' }));
  if (options.logCandidateAudit === true) {
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
    ...acceptedCandidateCards,
    ...strictCandidateCards,
    ...backfillableCandidateCards,
    ...sourceOnlyCandidateCards,
  ]);
  const sampleCandidateCards = candidateCards.filter(isSampleGradeCard);
  const backfillableChinaCandidateItems = sampleCandidateCards.filter(isChinaCard).length;
  const candidateChinaItems = sampleCandidateCards.filter(isChinaCard).length;
  const requiredChinaItems = requiredChinaItemCount(sampleCandidateCards, maxItems);
  const portfolioInputCards = uniqueCardsBySelectionKey([
    ...cards,
    ...reportCards,
    ...acceptedCandidateCards,
    ...strictCandidateCards,
    ...backfillableCandidateCards,
    ...sourceOnlyCandidateCards,
  ]);
  const selectablePortfolioCards = selectablePremiumPortfolioCards(portfolioInputCards);
  const selectablePortfolioItemsByModule = Object.fromEntries(MODULE_ORDER.map(module => [
    module,
    selectablePortfolioCards.filter(card => card.module === module).length,
  ]));
  const portfolioGateAchievable = selectablePortfolioCards.length >= Number(options.minimumItems || 20)
    && MODULE_ORDER.every(module => selectablePortfolioItemsByModule[module] >= minimumPerModule);
  cards = selectPremiumPortfolio(portfolioInputCards, {
    targetItems: maxItems,
    minimumPerModule,
    maximumPerModule,
  }).sort(compareSelectionCards);
  const finalItemsByModule = Object.fromEntries(MODULE_ORDER.map(module => [
    module,
    cards.filter(card => card.module === module).length,
  ]));
  const missingModules = MODULE_ORDER.filter(module => !finalItemsByModule[module]);
  const underfilledModules = MODULE_ORDER.filter(module => finalItemsByModule[module] < minimumPerModule);
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
    finalItemsByModule,
    missingModules,
    underfilledModules,
    selectablePortfolioItems: selectablePortfolioCards.length,
    selectablePortfolioItemsByModule,
    portfolioGateAchievable,
    targetItems: maxItems,
    minimumItems: Number(options.minimumItems || 20),
    maximumItems: Number(options.maximumItems || 24),
    minimumPerModule,
    maximumPerModule,
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

export function assertPremiumPortfolioDelivery(audit = {}, options = {}) {
  const minimumItems = Number(options.minimumItems ?? audit.minimumItems ?? 20);
  const maximumItems = Number(options.maximumItems ?? audit.maximumItems ?? 24);
  const minimumPerModule = Number(options.minimumPerModule ?? audit.minimumPerModule ?? 2);
  const allowPartial = options.allowPartial === true;
  const finalItems = Number(audit.finalItems || 0);
  const counts = audit.finalItemsByModule || {};
  const missingModules = MODULE_ORDER.filter(module => !Object.hasOwn(counts, module) || Number(counts[module] || 0) === 0);
  const underfilledModules = MODULE_ORDER.filter(module => Number(counts[module] || 0) < minimumPerModule);
  if (allowPartial && finalItems > 0 && finalItems <= maximumItems) {
    return {
      ...audit,
      partialPortfolio: finalItems < minimumItems || missingModules.length > 0 || underfilledModules.length > 0,
      missingModules,
      underfilledModules,
    };
  }
  if (finalItems < minimumItems || finalItems > maximumItems || missingModules.length || underfilledModules.length) {
    throw new Error(`Premium portfolio gate failed: finalItems=${finalItems}, required=${minimumItems}-${maximumItems}, missingModules=${missingModules.join(',') || 'none'}, underfilledModules=${underfilledModules.join(',') || 'none'}, minimumPerModule=${minimumPerModule}`);
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
  return cleanArticleEvidence([
    candidate.evidence_text,
    candidate.article_text,
    candidate.full_text,
    candidate.body,
    candidate.text,
    candidate.snippet,
    candidate.title,
  ].filter(Boolean).join('。'), { title: text(candidate.title) });
}

function firstEvidenceSentence(value = '') {
  return extractFirstEvidenceSentence(value, 220);
}

// --- 召回/通报类卡片的呈现 ---
// 措施类别与发出对象是欧盟通报的受控词表，量小且固定；翻成中文才谈得上「给法务看的
// 判断」，没收录的保持原文——不臆造、不扩写。
const MEASURE_LABELS = {
  'Withdrawal of the product from the market': '撤出市场',
  'Recall of the product from end users': '从消费者端召回',
  'Ban on the marketing of the product and any accompanying measures': '禁售并采取配套措施',
  'Stop of sales': '停止销售',
  'Removal of this product listing by the online marketplace': '电商平台下架商品链接',
  'Destruction of the product': '销毁产品',
  'Import rejected': '拒绝进口',
};
const OPERATOR_LABELS = {
  Distributor: '经销商',
  Retailer: '零售商',
  Manufacturer: '制造商',
  Importer: '进口商',
  Other: '',   // 空串=不当前缀（原先靠比较译文串来判断，改中译名会静默改变行为）
};
const RISK_LEVEL_LABELS = {
  'Serious risk': '严重风险',
  'Serious risk / other': '严重风险',
  'Medium risk': '中等风险',
  'Low risk': '低风险',
};

function measureLabel(value = '') {
  const source = hardText(value);
  return source ? MEASURE_LABELS[source] || source : '';
}

// 通报类卡片的事实要点：识别信息一行 + 风险描述一行。
// 原先这里走 firstEvidenceSentence 的兜底，压平之后抓到的是一整段 key：value
// 倒出且被 220 字截断（「…产品描述：Eau de pa」），既不是句子也不完整。
function alertFactLines(hardFacts = {}) {
  const hard = hardFacts || {};
  const riskDescription = hardText(hard.risk_description);
  if (!riskDescription) return [];
  // 复用既有的 compactHardFacts（硬事实标签表的唯一拼装处），别再内联一套标签；
  // 传进来的 hardFacts 已过 normalizeHardFacts，值都是干净的，无需再 hardText 一次。
  const identity = compactHardFacts(hard, [
    ['notifying_country', '通报国'],
    ['origin_country', '原产国'],
    ['brand', '品牌'],
    ['alert_reference', '案号'],
  ]).join('；');
  const measure = measureLabel(hard.measure_category);
  const disposal = measure
    ? `处置措施：${measure}${hardText(hard.measure_date) ? `（${hardText(hard.measure_date)} 生效）` : ''}`
    : '';
  return [
    [identity, disposal].filter(Boolean).join('；'),
    `风险描述：${riskDescription}`,
  ].filter(Boolean);
}

// evidenceSource：切掉标题、保留换行的正文。关键词判据仍看 source（含标题，行为不变），
// 但**取证据句**的兜底必须用它——否则会抓到「{标题} 新京报 2026-09-07 09:10 {正文}」
// 这种标题+页面元数据的粘连行（实测「地下工厂」系列把法务观察写成「因{整个标题}…」）。
// 句子里的主体只列前两家：`extractCompanyNames` 会把长文里**所有**公司名都收进来
// （实测贝泰妮一条列出 5 家、102 字，读不成句），而头条主体通常排在最先。
function compactParty(value = '') {
  return text(value)
    .replace(/^(?:将|对|把)(?=[^\s])/, '')   // 句子主语前残留的连接词
    .split('、').filter(Boolean).slice(0, 2).join('、');
}

function candidateLegalSignal(module, source, hardFacts = {}, evidenceSource = '') {
  const hard = hardFacts || {};
  const evidenceText = evidenceSource || source;
  const product = hardText(hard.product_or_batch);
  const deadline = hardText(hard.deadline || hard.action_deadline);
  const effective = hardText(hard.effective_date);
  const party = compactParty(meaningfulInvolvedParty(hard.involved_party));
  const act = hardText(hard.violation_behavior);
  const amount = hardText(hard.penalty_amount);
  const disposition = hardText(hard.confiscation_result);
  const basis = hardText(hard.legal_basis || hard.document_number);

  // 召回/通报类：法务观察要落在「这条通报对同类产品的合规含义」上。原先没有这条分支，
  // 落到末尾的通用拼装——把 product_or_batch 里的 key：value 原样倒出来，
  // 「涉及Tesori… 产品描述：Eau de pa，通报国：Greece…，已形成公开执法或监管信号」。
  const riskDescription = hardText(hard.risk_description);
  if (riskDescription) {
    const authority = hardText(hard.authority) || '官方';
    const level = RISK_LEVEL_LABELS[hardText(hard.risk_level)] || hardText(hard.risk_level);
    const riskType = hardText(hard.risk_type);
    const measure = measureLabel(hard.measure_category);
    const operator = hardText(hard.measure_operator);
    const operatorPrefix = OPERATOR_LABELS[operator] ?? operator;   // ?? 保留空串（Other），未知值回落原文
    const date = hardText(hard.measure_date);
    const market = /safety\s*gate|rapex/i.test(`${authority} ${source}`) ? '欧盟' : '该市场';
    const head = `${product || hardText(hard.brand) || '该产品'}因${riskType ? `${riskType} ` : ''}风险经${authority}通报为${level}`;
    const disposal = measure ? `，处置措施为${operatorPrefix}${measure}${date ? `（${date} 生效）` : ''}` : '';
    return `${head}${disposal}；同类出口${market}的化妆品需按同一口径复核成分与标签一致性，并预置下架与召回应对。`;
  }

  if (module === '新法律法规政策') {
    if (/新原料注册备案.*资料管理|注册备案资料管理规定/.test(product)) {
      return `${product}把新原料注册备案资料要求单独成规，企业需要按公告文号复核配方开发、备案资料和存量SKU过渡安排。`;
    }
    if (/三价铬和六价铬|检验方法/.test(product) && /安全技术规范|三价铬和六价铬|检验方法/.test(source)) {
      return `${product}被纳入化妆品安全技术规范体系，检验方法引用、质量放行和备案资料中的检测依据需要同步更新。`;
    }
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
  // Build a concrete legal signal from available hard facts instead of
  // the generic "该事项已具备可追踪的事实节点" placeholder.
  const parts = [];
  if (party) parts.push(party);
  if (act) parts.push(`因${act}`);
  if (amount) parts.push(`被处罚${amount}`);
  if (disposition && !amount) parts.push(`处置措施：${disposition}`);
  if (basis) parts.push(`依据${basis}`);
  if (product) parts.push(`涉及${product}`);
  if (parts.length >= 2) {
    return `${parts.join('，')}，已形成公开执法或监管信号，需要法务团队评估合规影响。`;
  }
  if (parts.length === 1) {
    // 只填到一个槽位时不要退回套话模板——「该事项存在合规关注价值，建议进一步
    // 核实原文细节」正好命中 GENERIC_PATTERNS，会把卡片判成空话拒掉。用证据句
    // 收尾，既具体又同样有信息量。（实测执法通报类稿全灭在这一步。）
    const evidence = firstEvidenceSentence(evidenceText);
    const tail = evidence ? evidence.replace(/[。；;]+$/g, '').slice(0, 90) : '';
    if (tail && !tail.includes(parts[0].slice(0, 8))) {
      return `${parts[0]}，${tail}，已形成公开执法或监管信号，需要法务团队评估合规影响。`;
    }
    return `${parts[0]}已形成公开执法或监管信号，需要法务团队评估合规影响。`;
  }
  const sentence = firstEvidenceSentence(evidenceText);
  return sentence
    ? `${sentence.replace(/[。；;]+$/g, '').slice(0, 100)}`
    : '原文未披露足够的结构化信息，建议直接查阅原文评估合规风险。';
}

// 模块级业务链条：人工梳理，比关键词抽出来的进程完整（见下方注释）。模块常量，勿在函数内重建。
const BUSINESS_IMPACT_DEFAULTS = {
  '知识产权保护或者侵权': '商标授权、包装设计、达人素材、平台店铺',
  '进出口': '进口申报、清关、原产地文件、供应链履约',
  '产品质量/召回与安全风险': 'SKU/批次管理、库存隔离、渠道下架、消费者通知',
  '广告处罚案例': '达人素材/广告宣传、平台店铺/渠道运营',
  '新法律法规政策': '配方开发、备案资料、标签审核、存量SKU管理',
};

function candidateBusinessImpact(module, hardFacts = {}, source = '') {
  const processes = hardFacts.affected_processes?.length
    ? hardFacts.affected_processes
    : inferAffectedProcesses(hardFacts.product_or_batch ? `${source} ${hardFacts.product_or_batch}` : source, {}, { module });
  const labels = processes.length ? processes : inferAffectedProcesses(source, {}, { module });
  const defaults = BUSINESS_IMPACT_DEFAULTS;
  if (labels.length) return `影响中国市场美妆业务的${labels.join('、')}。`;
  const fallback = defaults[module] || '标签、备案注册、广告素材、平台上架';
  return `影响中国市场美妆业务的${fallback}。`;
}

function candidateObservation(module, source = '', hardFacts = {}, evidenceSource = '') {
  const hard = hardFacts || {};
  const evidenceText = evidenceSource || source;
  const product = hardText(hard.product_or_batch);
  const party = meaningfulInvolvedParty(hard.involved_party);
  const deadline = hardText(hard.deadline);
  const effective = hardText(hard.effective_date);
  const processes = hard.affected_processes?.length ? hard.affected_processes.join('、') : '';

  // Concrete, time-bound observations from hard facts
  if (deadline) {
    return `在${deadline}前完成${product || '相关要求'}的${processes || '合规评估和流程调整'}。`;
  }
  if (effective) {
    return `在${effective}前评估${product || '新规'}对${processes || '现有业务流程'}的影响，制定过渡方案。`;
  }
  if (/征求意见|反馈截止/.test(source) || hardText(hard.feedback_channel)) {
    const channel = hardText(hard.feedback_channel) || '官方反馈渠道';
    return `通过${channel}在截止日前提交企业反馈意见。`;
  }
  if (party && /处罚|罚款|没收|侵权|冒用|假冒|商标/.test(source)) {
    return `跟踪${party}的后续行政处罚执行、行政复议或诉讼进展，同步复核内部${processes || '合规流程'}。`;
  }
  if (/海关|进口|出口|清关|HS\s*编码/i.test(source)) {
    return `核查${product || '相关化妆品'}的最新口岸执行口径、HS编码适用和申报要求。`;
  }
  if (module === '产品质量/召回与安全风险') {
    return `跟踪后续抽检结果、召回进度、批次处置和同类产品风险扩散情况。`;
  }
  if (product) {
    return `关注${product}的正式发布、执行口径和配套文件更新。`;
  }
  if (party) {
    return `跟踪${party}相关事项的后续监管动态和公开进展。`;
  }
  // Extract a concrete observation from the first factual sentence
  const firstFact = firstEvidenceSentence(evidenceText, 120);
  if (firstFact && firstFact.length > 20) {
    return `关注该事项的后续进展：${firstFact.replace(/[。；;]+$/g, '')}。`;
  }
  return '查阅原文获取完整细节，评估对企业合规义务的具体影响。';
}

export function premiumCardFromCandidate(candidate = {}) {
  const source = candidateEvidenceText(candidate);
  const module = normalizeModule(candidate.module);
  // 证据句不能取到标题本身：标题在 facts 里已单独占一位，证据句若是标题，
  // facts 就退化成「标题复读」，weak-facts 的具体性锚点随之失效
  // （实测执法通报类稿——汕头化妆品制假售假系列约 10 条——全灭在这）。
  // 去掉「标题 — 媒体名」的尾巴后再切：只切前 20 字会在正文里留下标题残尾
  // （「假，线上销售高频换店 民房制假，…」这种半截话）。
  const titleCore = text(candidate.title).split(/\s+[—\-|]\s+/)[0].replace(/\s+/g, '');
  const titleProbe = titleCore.slice(0, Math.min(20, titleCore.length));
  // 按标题串整体切除，而不是按行过滤：candidateEvidenceText 把多个字段用「。」
  // 拼成一整坨，标题会和下一行黏在同一「行」里，按行删会连正文句一起删掉；
  // 而且标题在拼接结果里会出现多次（字段拼接 + 末尾附加 candidate.title）。
  // 逐行归一空白，**不要整篇压平**。text() 把 \s+ 全换成空格，行结构一没，
  // 页面组件行（分享栏／取色器／播放器读数）就和后文粘成一句，行级清洗随之失效，
  // 再被 compactEvidenceText 截成 220 字的半截话——「事实要点」印到 PDF 上就是它
  // （实测汕头联合执法组那条印的是取色器 Text ColorWhite…）。
  const bodySource = titleCore
    ? perLineText(source).split(titleCore).join('\n').split(titleProbe).join('\n')
    : source;
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
  // 事实要点分两段拼：先出「来源证据段」，再拼通报字段段。
  // 关键：withInferredHardFacts 的推断（当事人、业务环节、违规行为）只能看**来源证据段**。
  // 通报字段段是本卡自己生成的文案，喂回去会自我强化——实测「处置措施：停止销售」
  // 「电商平台下架商品链接」这两句把自己算成了业务环节，把召回场景人工梳理的
  // 「库存隔离、渠道下架、消费者通知」挤掉（Caro White、Sun screen 三条实测）。
  // 证据句在「一行一个字段」的通报正文里取不到东西，所以通报类的事实要点
  // 由它自己的结构化字段提供（alertFactLines）。
  const evidenceFacts = uniqueValues([firstEvidenceSentence(bodySource || source), text(candidate.title)]).filter(Boolean);
  const normalizedHardFacts = normalizeCandidateHardFacts(candidate, mergedHardFacts);
  const hardFacts = withInferredHardFacts(normalizedHardFacts, {
    title: text(candidate.title),
    module,
    evidence_text: source,
    source_name: sourceNameFromCanonicalSource(candidate),   // 发布方守卫要用
    facts: evidenceFacts,
    business_impact: candidate.business_impact || '',
  });
  const candidateFacts = uniqueValues([...alertFactLines(hardFacts), ...evidenceFacts]).filter(Boolean);
  const baseCard = {
    title: cleanDisplayTitle(text(candidate.display_title_zh || candidate.title_zh || candidate.title)),
    source_candidate: true,
    module,
    // 发现阶段判定的模块必须带进 card：assemble-cards 的 RE-MODULE 会调
    // inferCandidateModule(card)，而它的兜底（标题/正文都分类不中时保留「声明模块」，
    // 避免一切挤进美妆动态）读的就是这个字段。原先没带 → 兜底恒不触发 → 实测
    // 5 张 EU Safety Gate 召回通报被记成「美妆动态」（非核心），报告分区错、
    // 闸门 coreItems 少 5。
    discovery_module: text(candidate.discovery_module || candidate.module || ''),
    source_url: text(candidate.source_url || candidate.url),
    source_name: sourceNameFromCanonicalSource(candidate),
    source_type: text(candidate.source_type),
    authority_type: text(candidate.authority_type),
    source_scope: text(candidate.source_scope),
    detail_status: text(candidate.detail_status),
    editorial_status: text(candidate.editorial_status),
    evidence_grade: text(candidate.evidence_grade),
    verification_status: text(candidate.verification_status),
    supporting_sources: Array.isArray(candidate.supporting_sources) ? candidate.supporting_sources : [],
    agreed_anchors: Array.isArray(candidate.agreed_anchors) ? candidate.agreed_anchors : [],
    published_at: candidateDisplayDate(candidate, { ...(candidate.hard_facts || {}), ...extractedFacts }, source),
    country: text(candidate.country || candidate.region || '未知'),
    facts: candidateFacts,
    legal_signal: candidateLegalSignal(module, source, hardFacts, bodySource || source),
    business_impact: '',
    recommended_action: candidateObservation(module, source, hardFacts, bodySource || source),
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
  if (isNonAuthoritativeRepublisher(card) && !isConcreteDiscoveredPublisherCard(card)) return false;
  const source = sourceTextForCard(card);
  const displayChinese = [candidate.display_title_zh, candidate.title_zh, candidate.fact_summary_zh, candidate.legal_signal_zh]
    .map(text)
    .join(' ');
  const sourceHasChinese = /[\u4e00-\u9fff]/.test(`${candidate.title || ''} ${candidate.article_text || candidate.full_text || candidate.snippet || ''}`);
  if (!sourceHasChinese && !/[\u4e00-\u9fff]/.test(displayChinese)) return false;
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
  const byKey = new Map();
  for (const card of cards) {
    const key = cardSelectionKey(card);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, card);
      continue;
    }
    // Strongest card wins the key. A sample-grade card (corroborated or
    // hard-fact-endpoint evidence) must replace a weak same-key card that
    // only survived the fallback filters; otherwise a weak report item can
    // suppress the hard-fact candidate that should replace it.
    if (!isSampleGradeCard(existing) && isSampleGradeCard(card)) {
      byKey.set(key, card);
    }
  }
  return [...byKey.values()];
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
  if (BROKEN_FIELD_PATTERN.test(JSON.stringify(candidate.hard_facts || {}))) return false;
  const providedProduct = text(candidate.hard_facts?.product_or_batch);
  if (providedProduct && !hardText(providedProduct) && !policyProductFromTitle(candidate.title)) return false;
  const scope = text(candidate.source_scope);
  if (grade && !['hard_fact_ready', 'corroborated_fact_ready'].includes(grade)) return false;
  if (!grade && scope && !['hard_fact_endpoint', 'hard_fact_list'].includes(scope)) return false;
  return true;
}

function isSampleGradeCard(card = {}) {
  const hardCount = objectiveHardFactCount(card.hard_facts || {});
  if (hardCount < 2) return false;
  if (BROKEN_FIELD_PATTERN.test(JSON.stringify(card.hard_facts || {}))) return false;
  if (BROKEN_FIELD_PATTERN.test(sourceTextForCard(card))) return false;
  if (!isBeautyRelevantCard(card)) return false;
  if (isNavigationOrGenericInformationPage(card)) return false;
  const evidenceDecision = validatePremiumEvidenceCard(card);
  if (evidenceDecision.accepted
    && isHardFactReadyDetailCandidate(evidenceDecision.card)
    && !DOCUMENT_TITLE_AS_PRODUCT_PATTERN.test(text(evidenceDecision.card?.hard_facts?.product_or_batch))) {
    return true;
  }
  if (evidenceDecision.accepted && isConcreteDiscoveredPublisherCard(evidenceDecision.card)) {
    return true;
  }
  if (!hasSampleGradeHardFactBundle(card)) return false;
  if (isHardFactReadyDetailCandidate(card)) {
    return !DOCUMENT_TITLE_AS_PRODUCT_PATTERN.test(text(card.hard_facts?.product_or_batch));
  }
  if (/Crawl4AI|欢迎访问|专题页|入口页|监管入口|安全使用|消费者提示/i.test(sourceTextForCard(card))) return false;
  if (PREMIUM_JUNK_EVIDENCE_PATTERN.test(sourceTextForCard(card))) return false;
  return true;
}

function requiredChinaItemCount(candidateCards = [], maxItems = 6) {
  const chinaCandidates = candidateCards.filter(isChinaCard).length;
  if (!chinaCandidates) return 0;
  return Math.min(2, maxItems, chinaCandidates);
}

function cardSelectionKey(card = {}) {
  const identity = text(card.event_identity || card.event_id || card.title)
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return identity || `${text(card.source_url || card.url).toLowerCase()}|${text(card.title).replace(/\s+/g, '')}`;
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
