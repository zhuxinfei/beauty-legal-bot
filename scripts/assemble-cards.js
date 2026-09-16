// Direct card assembly from hydrated records.
// Code handles selection + fact extraction; templates generate narrative.
// Usage: node scripts/assemble-cards.js [hydrated-authority.json] [output.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadSeenEntries, normalizeDedupUrl } from '../worker/dedup-state.js';
import { inferCandidateModule } from '../worker/content-quality.js';
import { normalizeHydratedRecord } from '../worker/source-hydration.js';
import { extractHardFacts, gradeEvidence } from '../worker/hard-fact-extractor.js';
import { corroborateEvidenceCandidates } from '../worker/evidence-corroboration.js';
import {
  premiumCardFromCandidate,
  validatePremiumEvidenceCard,
  buildPremiumDingTalkMarkdown,
} from '../worker/premium-quality.js';
import { cleanArticleEvidence, isIncidentalBeautyMention } from '../worker/article-evidence.js';

const inputPath = resolve(process.argv[2] || 'out/hydrated-authority.json');
const outputPath = resolve(process.argv[3] || 'out/assembled-cards.json');
const FINGERPRINTS_PATH = resolve('docs', 'quality', 'seen-cards.json');

// Cross-week dedup: URL-based. The source URL is the most stable
// identifier — no title matching, eventSig, or AI comparison needed.
// loadSeenEntries tolerates all historical formats and normalizes keys.
const seenUrls = new Set(loadSeenEntries(FINGERPRINTS_PATH).keys());
console.log(`[dedup] loaded ${seenUrls.size} previously delivered URLs`);

console.log(`Loading hydration records from ${inputPath}...`);
const payload = JSON.parse(readFileSync(inputPath, 'utf8'));
const rawRecords = payload.records || [];

// Derive period from hydration data, filtering outliers
const now = new Date();
const dates = rawRecords
  .map(r => r.published_at)
  .filter(d => /^20\d{2}-\d{2}-\d{2}$/.test(d))
  .filter(d => {
    const dt = new Date(d + 'T00:00:00Z');
    const daysAgo = (now - dt) / 86400000;
    return daysAgo > 0 && daysAgo < 60; // last 60 days only
  })
  .sort();
const period = {
  start: dates[0] || new Date(now - 15*86400000).toISOString().slice(0, 10),
  end: dates[dates.length - 1] || now.toISOString().slice(0, 10),
};

// --- Patterns ---
// 美妆品牌词表：标题不含"化妆品"等通用词时（如"薇诺娜…被罚"），靠品牌名兜底召回
const BEAUTY_BRAND_PATTERN = /(?:欧莱雅|雅诗兰黛|兰蔻|珀莱雅|贝泰妮|薇诺娜|花西子|完美日记|韩束|自然堂|百雀羚|上海家化|华熙生物|可复美|润百颜|夸迪|丸美|水羊|逸仙电商|毛戈平|林清轩|植物医生|相宜本草|六神|玉泽|谷雨|半亩花田|冰希黎|KIKO|丝芙兰)/i;
const BEAUTY_PATTERN = /(?:化妆品|美妆|护肤|彩妆|香水|口红|面膜|洗护|防晒|染发|美容|祛斑|美白|功效宣称|玻色因|配方|着色剂|色素|进口化妆品|出口化妆品|化妆品标准|cosmetic|cosmetics|MoCRA|直播带货|直播营销|网售|网络销售|平台治理|平台规则|旗舰店|店铺合规)/i;
// Judge beauty relevance from article body (first 1000 chars), not page chrome.
// Strips known portal/nav text before checking. Returns true if the article's
// primary subject is beauty/cosmetics — not just incidentally mentioned.
// 美妆主体词表：isBeautyArticle 与权威源全文判据共用，避免两处词表漂移。
const BEAUTY_TERM_PATTERN = /(?:化妆品|美妆|护肤|彩妆|香水|防晒|染发|洗护|面膜|口红|精华液|面霜|祛斑|美白|功效宣称|玻色因|配方|着色剂|进口化妆品|出口化妆品|化妆品标准|cosmetic|MoCRA)/i;
function hasBeautySubject(combined) {
  return BEAUTY_TERM_PATTERN.test(combined) || BEAUTY_BRAND_PATTERN.test(combined);
}
// Judge beauty relevance from article body (first 1000 chars), not page chrome.
// Strips known portal/nav text before checking. Returns true if the article's
// primary subject is beauty/cosmetics — not just incidentally mentioned.
// 注意：1000 字窗口是按新闻稿（导语在开头）调的。政务公文的页头是元数据，
// 美妆主体常落在窗口之后——那种情况由 authorityBeautyInFullText 兜底。
function isBeautyArticle(title = '', text = '') {
  const combined = `${title} ${text.slice(0, 1000)}`;
  return hasBeautySubject(combined);
}
const ACADEMIC_IP_PATTERN = /(?:损害赔偿请求权|法理探析|制度研究|案例评析|案例聚焦|知识产权律师网)/i;
const NEWS_CHROME = [
  /要闻\s*北京\s*科技\s*财经\s*AI\s*更多[^。]*/g,
  /正在浏览：[^。]*/g,
  /GPLP\s*游戏\s*应用\s*网页设置[^。]*/g,
  /安装电脑版\s*内容更精彩[^。]*/g,
  /微信\s*随时随地看[^。]*/g,
  /元宝\s*·\s*新闻妹[^。]*/g,
  /文章配图-\d[^。]*/g,
  /链接复制成功[^。]*/g,
  /发布于：[^。]*/g,
];
const FORUM_HOSTS = /(?:wenxuecity\.com|\.tieba\.|\.zhihu\.|\.douban\.|\.weibo\.|vietnam\.vn|reach24h\.com|qianlong\.com|online\.sh\.cn)/i;
const WEAK_TITLE_PATTERN = /(?:举办|召开|培训|会议|活动|论坛|调研|考察|检查指导|工作部署)/;
// 只有媒体/机构名、没有事件信息的标题（页面标题没抓到）。与 WEAK_TITLE_PATTERN 同族，
// 但这类不是"弱"，是"根本不是一篇文章"。
const OUTLET_ONLY_TITLE = /^(?:澎湃新闻|腾讯新闻|网易新闻|新浪财经|新浪新闻|搜狐网|搜狐新闻|凤凰网|凤凰新闻|界面新闻|今日头条|百家号|微信公众号|中国新闻网|中新网|人民网|新华网|央视新闻|第一财经|每日经济新闻|证券时报|21世纪经济报道|经济观察报|虎嗅|钛媒体|36氪|亿邦动力|雨果跨境|东方财富|快科技|雷峰网|站长之家|阿视亚经济|8world|新京报|南方都市报|南方周末|法治日报|中国新闻周刊|财经网|观察者网)$/;
const PORTAL_CHROME = [
  /化妆品审评\s*国家抽检管理\s*医疗器械标准与分类管理[^。]*/g,
  /访问我的专属空间[^。]*/g,
  /无障碍\s*关怀版\s*繁體[^。]*/g,
  /办理流程\s*立案→调查取证→审查→告知→决定→送达→执行/g,
  /返回首页\s*页面放大\s*页面缩小[^。]*/g,
  /移动版\s*本站查询[^。]*/g,
  /主要职责\s*基本信息\s*领导介绍\s*机构设置[^。]*/g,
  /缴纳情况\s*\d{4}年\d{1,2}月\d{1,2}日已缴纳[^。]*/g,
  /智能问答\s*["'][^"']*["'][^。]*/g,
  /返回首页[^。]*/g,
  /智能问答[^。]*/g,
  /访问我的专属空间[^。]*/g,
  /一网通查[^。]*/g,
  /请\s*\d+s\)\s*抱歉[^。]*/g,
  /药品GSP认证公示[^。]*/g,
  /生物制品批签发[^。]*/g,
  /国家标准物质与菌毒种[^。]*/g,
  /阳光采购平台[^。]*/g,
  /补充检验方法管理系统[^。]*/g,
  /业务咨询\s*区[^。]*/g,
  /用户空间\s*海关电邮[^。]*/g,
  /守国门\s*促发展[^。]*/g,
  /当好让党放心[^。]*/g,
  /能力验证\s*进口药品[^。]*/g,
  /仪器设备管理系统[^。]*/g,
];

// Step 1: Normalize records with substantive text
console.log(`Normalizing ${rawRecords.length} records...`);
const records = rawRecords
  .map(r => normalizeHydratedRecord(r))
  .filter(r => (r.article_text || '').length > 100);

// Step 2: Pre-clean, extract hard facts, grade evidence
console.log(`Extracting hard facts from ${records.length} records...`);
const candidates = records.map(r => {
  let text = cleanArticleEvidence(r.article_text || '', { title: r.title || '' });
  for (const pattern of PORTAL_CHROME) text = text.replace(pattern, '');
  for (const pattern of NEWS_CHROME) text = text.replace(pattern, '');
  text = text.replace(/\s{2,}/g, ' ');

  const facts = extractHardFacts(text, {
    title: r.title, source_name: r.source_name || r.name,
    source_url: r.final_url || r.url, module: r.module,
    country: r.country || r.region,
  });
  const grade = gradeEvidence({
    text, hard_facts: facts,
    source_url: r.final_url || r.url, title: r.title,
    source_name: r.source_name || r.name,
    country: r.country || r.region,
  });
  return { ...r, article_text: text, hard_facts: facts,
    evidence_grade: grade.evidence_grade, evidence_reason: grade.evidence_reason };
});

// Step 3: Corroborate multi-source events
const corroboration = corroborateEvidenceCandidates(candidates);
console.log(`Corroboration: ${corroboration.audit.records} → ${corroboration.audit.events} events (${corroboration.audit.corroborated} corrob, ${corroboration.audit.primaryVerified} primary)`);

// Step 4: Build cards — accept all grades that have substantive text, let premium gate filter
const corrobUrls = new Set(corroboration.candidates.map(c => c.url));
let pool = [
  ...corroboration.candidates,
  ...candidates.filter(c =>
    !corrobUrls.has(c.url)
    && c.evidence_grade !== 'reject'
    && (c.article_text || '').length > 150
  ),
  // Include lead_only records with good body text (AI will filter relevance)
  ...candidates.filter(c =>
    !corrobUrls.has(c.url)
    && c.evidence_grade === 'lead_only'
    && (c.article_text || '').length > 300
  ),
];
// Deduplicate by URL
const seen_urls = new Set();
pool = pool.filter(c => {
  const key = (c.url || c.source_url || '').trim();
  if (!key || seen_urls.has(key)) return false;
  seen_urls.add(key);
  return true;
});
console.log(`Candidate pool: ${pool.length} records`);

// Known noise: gov column pages, hotlines, 404s — skip before AI calls.
const NOISE_TITLE = /今日海关|12360|通关服务热线|海关热线|服务热线|栏目|首页|平台简介|服务指南|运营公共服务平台|页面不存在|出错了|404|网站导航|政府信息公开|门户网站|商标网\s*$|保护中心\s*$|法规网|法律法规数据库|管理系统\s*$/i;
// Column/nav pages surfaced as "articles" (e.g. list-page titles like
// 化妆品政策法规 / 政策法规及标准 / 通知公告) — no concrete event.
const COLUMN_TITLE = /^(?:政策法规|法规文件|化妆品政策法规|政策法规及标准|标准|通知公告|监管动态|化妆品监管动态|综合要闻|局要闻|信息公开|法定主动公开内容|公告|通告|动态|法规|规章制度|政策解读|法规解读|履职依据|海关法规|规范性文件|部门文件|机构简介|协会简介|研究中心|中企商标发展中心|中企商标鉴定中心|《?中华商标》?(?:杂志社)?|化妆品召回|化妆品处罚|化妆品抽检|化妆品监管)[\s_-]*$/;

// 非美妆领域的政策/服务页（化学品、污染物、食品等）与"服务/代办"类营销页
const NON_COSMETIC_SCOPE = /(?:易制毒|新化学物质|新污染物|危险化学品|农药|兽药|饲料|芥末|食用油|食品添加剂)/;
const SERVICE_PAGE_TITLE = /(?:许可\/备案申请|备案登记|登记服务|法规服务|代办|咨询服务)$/;
// 营销指南/SEO 稿与评论观察类文章：不是法律事件，早期剔除、节省 AI 调用
const COMMENTARY_OR_GUIDE_TITLE = /(?:全指南|一文读懂|一文看懂|避坑|流程、费用|注册攻略|申请攻略|时评|社论|锐评|漫谈|正当其时|成了生意|谁之过|何时休)/;
// 频道页/标签页（「最新的XX相关资讯、品牌动态、行业报道」）与盘点稿（「一周药闻速揽」
// 「新闻8点见」）：正文是标题列表或跨行业汇总，成卡后「法务观察」只能是标题碎片或
// 无关内容，实测是成卡质量最差的一类。2026-09-11 用户要求「保证质量」后加的确定性判据。
const CHANNEL_OR_ROUNDUP_TITLE = /(?:相关资讯|品牌动态|行业报道|资讯汇总|专题汇总|标签页)|(?:\d点见|速揽|速览|一周[药要]闻|要闻盘点|周报盘点)/;

// Non-beauty-entity penalties (drugs/food/medical-device) that mention
// cosmetics incidentally must never reach the report — guards the AI
// fallback path and saves AI calls.
const NON_BEAUTY_ENTITY = /(?:药品|医药|兽药|医疗器械|食品|生猪|饲料|消毒产品|保健食品)/;
// 但监管机构自身的名称必须放行：「X药品监督管理局」的机构名里天然带「药品」，
// 而药监局正是化妆品的主管部门，是本报告最重要的来源类型。
// 实测该词表曾把「云南省药品监督管理局-行政处罚」「公示公告_安徽省药品监督管理局」
// 这类栏目整片打死。
const REGULATOR_NAME = /(?:药品|医药)监督(?:管理)?局/;
// 放行机构名 != 放行该机构的全部内容：药监局同时管药品与医疗器械，
// 「辽宁省药品监督管理局关于注销《医疗器械生产许可证》的公告」不是美妆事件。
// 判据只取标题：正文全扫会被政务站导航栏里的「化妆品」栏目链接骗过
// （实测该词表曾被导航栏带过，放行了医疗器械公告与药品新闻）。
function regulatorExempt(title) {
  return REGULATOR_NAME.test(String(title || '')) && hasBeautySubject(String(title || ''));
}

// Official/authority sources (regulator sites, courts, gov domains) are
// exempt from the regex pre-screen — fixed-format pages like gov.uk
// "Product Safety Report" titles carry no beauty keyword but are valid.
const isAuthoritySource = c => {
  const st = String(c.source_type || '');
  const at = String(c.authority_type || '');
  if (['official_site', 'regulator', 'court', 'official_database'].includes(st)) return true;
  if (['official', 'regulator', 'court'].includes(at)) return true;
  return /(^|\.)gov\.(cn|uk|au|ca|sg|jp|kr|tw|hk)|\.gov$|europa\.eu|pom\.go\.id|moph\.go\.th|dav\.gov/i.test(String(c.url || c.source_url || c.final_url || ''));
};

// Cross-week dedup BEFORE spending AI calls: drop already-delivered URLs.
// Same normalized key used at selection time, so variants of the same
// article (tracking params, hash, trailing slash) map to one key.
const preDedupPool = pool.filter(c => {
  if (NOISE_TITLE.test(c.title || '')) {
    console.log(`  SKIP [noise-title]: ${(c.title || '').slice(0, 40)}`);
    return false;
  }
  if (COLUMN_TITLE.test(String(c.title || '').trim())) {
    console.log(`  SKIP [column-title]: ${(c.title || '').slice(0, 40)}`);
    return false;
  }
  if (NON_COSMETIC_SCOPE.test(String(c.title || '')) && !/(?:化妆品|美妆|护肤|彩妆|香水|口红)/.test(String(c.title || ''))) {
    console.log(`  SKIP [non-cosmetic-scope]: ${(c.title || '').slice(0, 40)}`);
    return false;
  }
  if (SERVICE_PAGE_TITLE.test(String(c.title || '').trim())) {
    console.log(`  SKIP [service-page]: ${(c.title || '').slice(0, 40)}`);
    return false;
  }
  if (COMMENTARY_OR_GUIDE_TITLE.test(String(c.title || ''))) {
    console.log(`  SKIP [commentary-or-guide]: ${(c.title || '').slice(0, 40)}`);
    return false;
  }
  const entityTitle = String(c.title || '');
  if (NON_BEAUTY_ENTITY.test(entityTitle) && !regulatorExempt(entityTitle) && !/(?:化妆品|美妆|护肤|彩妆|香水|口红)/.test(entityTitle)) {
    console.log(`  SKIP [non-beauty-entity]: ${entityTitle.slice(0, 40)}`);
    return false;
  }
  // 频道页/标签页与盘点稿：标题自带签名，不必花 AI 调用，更不该让 AI 的波动决定
  // 它们进出周报。实测这类稿件的成卡质量最差——「法务观察」会变成标题碎片加无关
  // 法规（亿邦动力「出口电商，最新的出口电商相关资讯…」），或把药品盘点包装成美妆。
  if (CHANNEL_OR_ROUNDUP_TITLE.test(String(c.title || ''))) {
    console.log(`  SKIP [channel-or-roundup]: ${(c.title || '').slice(0, 40)}`);
    return false;
  }
  // 「附带提及」的确定性判据：美妆词只出现在商品/品类枚举里就拦掉，不必花 AI 调用。
  // 连标题一起判——标题里出现美妆词就不可能落在枚举里，自然放行。
  // AI 在这条边界上会波动（同一篇稿子这轮进下轮不进），规则能兜住的那部分就不交给它。
  if (isIncidentalBeautyMention(`${c.title || ''}。${c.article_text || ''}`)) {
    console.log(`  SKIP [incidental-beauty-mention]: ${(c.title || '').slice(0, 40)}`);
    return false;
  }
  // Cheap regex pre-screen before spending AI calls: for non-authority
  // candidates, no beauty signal in title or first 1000 chars → not worth
  // an AI judgment.
  if (!isAuthoritySource(c) && !isBeautyArticle(c.title || '', c.article_text || '')) {
    console.log(`  SKIP [regex-not-beauty]: ${(c.title || '').slice(0, 40)}`);
    return false;
  }
  const key = normalizeDedupUrl(c.source_url || c.final_url || c.url || '');
  if (key && seenUrls.has(key)) {
    console.log(`  SKIP [url-dup]: ${(c.title || '').slice(0, 40)}`);
    return false;
  }
  return true;
});
console.log(`After cross-week dedup: ${preDedupPool.length} records`);

// --- AI content review ---
const indexModule = await import('../worker/index.js');
const { requestAiChat } = indexModule;
const aiKey = process.env.AI_API_KEY;
const aiBaseUrl = process.env.AI_API_BASE_URL || 'https://api.deepseek.com/v1';
const aiModel = process.env.AI_MODEL || 'deepseek-chat';

// 「问一次 → 空就再问一次 → 仍然空就放弃 → 剥掉围栏 → parse」。
// 空响应是本仓库踩过的坑（实测同一提示词 10 次 9 次返回空，见 aiReview 的注释），
// 两处 AI 调用共用这一套，避免下次调预算/超时或改围栏剥离方式时只改一处——
// 那两处里有一处走的正是空响应兜底路径，漏改会表现为「AI 明明答了却被判成解析失败」。
async function askAiJson(askOnce) {
  const first = String(await askOnce() || '').trim();
  const content = first || String(await askOnce() || '').trim();
  if (!content) throw new Error('empty AI response');
  return JSON.parse(content.replace(/```json\s*|\s*```/g, '').trim());
}

// 兜底判据必须与前面那道 regex 预筛（preDedupPool）口径一致：预筛对权威源是豁免的
// （政务固定格式页面的标题常无美妆词），而 aiReview 原先无论来源一律套 isBeautyArticle，
// 且只看正文前 1000 字——政务公文的美妆词大量落在页头元数据之后（实测兖州区一份
// 行政处罚送达公告，美妆主体出现在第 2100 字的受送达人清单里）。
// 后果：CI 里 AI 调用一旦失败走 catch，权威公文会被这条正则误杀。
async function aiReview(c) {
  const title = c.title || '';
  const text = c.article_text || '';
  // 权威源（政务站多为固定格式）页头是元数据栏，只扫前 1000 字会漏判；
  // 改为在全文里找美妆主体词。全文都找不到的仍按非美妆拒——例如海关
  // 「进口柬埔寨鲜食龙眼植物检疫要求」这类与美妆无关的公告。
  const fallbackRelevant = () =>
    isAuthoritySource(c)
      ? hasBeautySubject(`${title} ${text}`)
      : isBeautyArticle(title, text);
  if (!aiKey) {
    const ok = fallbackRelevant();
    return { relevant: ok, reason: ok ? 'regex-pass' : 'regex-reject' };
  }
  const excerpt = (text || '').slice(0, 4000);
  // ⚠️ 空响应 ≠ 不相关。requestAiChat 对 deepseek 模型强制 reasoning_effort:'high'，
  // 而这里原先只给 maxTokens:200——推理还没结束预算就没了，content 回空串。
  // 实测同一提示词 10 次里 9 次返回空，随后 JSON.parse('') 抛错、catch 走
  // fallbackRelevant()，而权威源在兜底里一律判 relevant=true。后果不是「判错一条」，
  // 而是**哪些卡进周报由这个竞态决定**：同一证据包四次真实跑出 13/13/11/14 张，
  // 其中 11 张那次 coreItems=6 撞死质量闸门、整轮不推送（开天窗）。
  // 修法：给足预算 + 把空响应当成可重试，而不是当成一个判定结果。
  const askOnce = () => requestAiChat({
      apiKey: aiKey, baseUrl: aiBaseUrl, model: aiModel,
      messages: [
        { role: 'system', content: '判断文章是否与美妆/化妆品行业的法律合规事务实质相关。仅接受：法规标准与监管新规、行政处罚与虚假宣传、质量抽检不合格与召回、商标/专利/著作权侵权与诉讼、进出口与跨境电商监管执法、电商/直播/网售渠道合规处罚与平台治理、许可证注销与整改处罚、化妆品行业协会的合规治理/标准制定/国际合作动态、监管部门的专项检查/整治行动/飞行检查/核查处置动态、明确聚焦美妆品类的平台治理或电商乱象专项报道。明确拒绝：企业IPO/上市/融资/并购/破产清算等财经新闻、营销新品代言与业绩类报道、行业趋势分析、非化妆品主体（美发/美容院/综合商超/药品/医疗器械/综合电商平台）的法律事件、仅附带提及化妆品的综合新闻与泛行业盘点、政府或协会的栏目索引页/机构介绍页/网站地图/联系方式页、评论与观察类报道。海关/进出口类必须与化妆品直接相关（化妆品通关、准入、退运、跨境化妆品监管）；通用贸易便利化政策、非化妆品商品的口岸政策一律拒绝。主体必须是化妆品/美妆企业、产品或监管事件，附带提及不算。本报告面向美妆电商法务：判相关时必须确认该事件与美妆/化妆品的电商经营相关（平台店铺、直播带货、跨境电商、网售抽检、平台治理、店铺合规、达人素材、商品宣传、线上销售），或属于直接约束电商卖家的化妆品法规/标准/抽检/召回/处罚。药品、医疗器械、非化妆品品类，以及纯生产端/原料端且不影响电商经营的内容一律拒绝。另外，正文主体不是化妆品的一律拒绝，即使文中出现了「化妆品」字样：贸易关税/物流/口岸便利化等综合新闻（哪怕提到化妆品可能涨价）、行业日报/周报/综述/盘点（哪怕其中一条是化妆品）、媒体频道页或标签页/索引页/聚合页（正文是一串文章标题或摘要列表）、以及企业营收/收购/转型/趋势分析类稿件，全部判 false。判据是「换掉化妆品这个词，这条新闻还成立吗」——成立就说明化妆品只是附带提及，判 false。仅回复JSON：{"relevant":true或false,"reason":"一句话"}' },
        { role: 'user', content: `标题：${title}\n正文：${excerpt}` },
      ],
      // 2000：实测 800 时三条长提示词稳定返回空/截断（推理吃满预算），1500 仍偶发，
      // 2000 明显更稳。仍保留下面的空响应重试 + WARN 兜底——推理长度本身有波动，
      // 预算只能降低概率、消不掉。
      temperature: 0, maxTokens: 2000, timeoutMs: 60000, maxAttempts: 1,
    });
  try {
    const j = await askAiJson(askOnce);
    return { relevant: Boolean(j.relevant), reason: j.reason || '' };
  } catch (error) {
    // 两次都拿不到内容才退回正则。**必须出声**：这条路径是 fail-open 的（权威源一律放行），
    // 静默时「哪些卡进周报」就由 API 抖动决定（2026-09-14 排查过：同一证据包四次跑出
    // 13/13/11/14 张）。日志里看得见，事后才能分辨「这期薄」和「AI 没答上」。
    const ok = fallbackRelevant();
    console.warn(`  WARN [ai-review-fallback] ${String(error.message || error).slice(0, 40)} | ${title.slice(0, 30)}`);
    return { relevant: ok, reason: ok ? 'regex-fallback-authority' : 'regex-fallback' };
  }
}

// Step 5: AI review + build cards (4 concurrent calls)
const cards = [];
const reviews = [];
for (let i = 0; i < preDedupPool.length; i += 4) {
  const batch = preDedupPool.slice(i, i + 4);
  const results = await Promise.all(batch.map(async c => {
    const r = await aiReview(c);
    return { c, ...r };
  }));
  reviews.push(...results);
}

for (const { c, relevant, reason } of reviews) {
  if (!relevant) {
    console.log(`  SKIP [ai-not-beauty]: ${(reason||'').slice(0,50)} | ${(c.title||'').slice(0,30)}`);
    continue;
  }
  // URL-based cross-week dedup (pool is pre-filtered; keep as defense)
  const dedupKey = normalizeDedupUrl(c.source_url || c.final_url || c.url || '');
  if (dedupKey && seenUrls.has(dedupKey)) {
    console.log(`  SKIP [url-dup]: ${(c.title||'').slice(0,40)}`);
    continue;
  }
  const host = String(c.final_url || c.url || '');
  if (FORUM_HOSTS.test(host)) { console.log(`  SKIP [forum]: ${(c.title||'').slice(0,40)}`); continue; }

  const card = premiumCardFromCandidate({
    ...c, detail_status: 'hydrated',
    source_scope: c.source_scope || 'discovered_article',
  });
  const validation = validatePremiumEvidenceCard(card);
  if (!validation.accepted) {
    // When AI confirms beauty relevance, bypass structural/source/title gates
    // 'navigation-or-generic-page' 不再参与绕过：该判据判的就是「这页是导航/栏目页」，
    // 而 AI 恰恰最容易被这种页面骗过——索引页的正文就是一串化妆品标题，AI 看满屏
    // 化妆品词就判相关（实测：逸仙电商转型、蹭《狂飙》卖酒两张垃圾卡都由它放行）。
    // 该判据自身已为政务固定格式页留了出口（isHardFactReadyDetailCard 等），无需再绕。
    const bypassReasons = ['non-authoritative-source', 'missing-chinese-display-title'];
    if (bypassReasons.includes(validation.reason) && relevant) {
      console.log(`  AI-OVERRIDE [${validation.reason}]: ${card.title.slice(0, 30)}...`);
      // fall through — accept the card
    } else {
      console.log(`  SKIP [${validation.reason}]: ${card.title.slice(0, 50)}`);
      continue;
    }
  }

  const titleText = card.title || '';

  // Skip academic IP theory articles (not beauty-specific case law)
  if (ACADEMIC_IP_PATTERN.test(titleText)) {
    // Academic IP articles are only valid if they discuss specific beauty brands or products
    const beautyEvidence = (c.evidence_text || '') + ' ' + titleText;
    if (!/(?:化妆品|美妆|护肤|彩妆|香水|防晒|面膜|口红|精华液)/i.test(beautyEvidence) && !BEAUTY_BRAND_PATTERN.test(beautyEvidence)) {
      console.log(`  SKIP [academic-ip]: ${card.title.slice(0, 50)}`);
      continue;
    }
  }

  // 标题就是媒体/机构名本身 —— 页面没抓到真标题（crawl 残渣），不是一篇稿子。
  // 实测「澎湃新闻」一条以 outlet 名当标题、混进了知产模块（source_url 是 thepaper 的
  // 正文详情页，说明正文在、标题没取到）。这类稿子没有可交付的信息，直接丢。
  if (OUTLET_ONLY_TITLE.test(titleText.trim())) {
    console.log(`  SKIP [outlet-only-title]: ${titleText.slice(0, 50)}`);
    continue;
  }

  // Skip weak cards
  if (WEAK_TITLE_PATTERN.test(titleText) && !/(?:处罚|罚款|召回|不合格|通告|公告|标准|法规|办法)/.test(titleText)) {
    console.log(`  SKIP [weak-content]: ${card.title.slice(0, 50)}`);
    continue;
  }

  // Reject clearly non-beauty businesses regardless of what regulations they violated.
  // 同样要放行监管机构自身：「云南省药品监督管理局-行政处罚」这类栏目名会被
  // 词表里的「药品」误伤（REGULATOR_NAME 见上）。
  if (/(?:五金|建材|食品|餐饮|药品|医疗器械|汽车|房地产|保险|银行|教育培训|网吧|歌厅|浴池|洗浴|理发店|便利店)/i.test(titleText) && !regulatorExempt(titleText) && !/(?:化妆品|美妆|护肤|彩妆|香水|防晒|面膜|口红|品牌)/i.test(titleText) && !BEAUTY_BRAND_PATTERN.test(titleText)) {
    console.log(`  SKIP [non-beauty-biz]: ${card.title.slice(0, 50)}`);
    continue;
  }

  console.log(`  OK  ${card.module.slice(0, 8)} | score=${validation.score} | ${card.title.slice(0, 40)}`);

  // AI polish: refine legal_signal and business_impact for action-tier cards
  if (validation.score >= 100 && aiKey) {
    try {
      const polishResp = await requestAiChat({
        apiKey: aiKey, baseUrl: aiBaseUrl, model: aiModel,
        messages: [
          { role: 'system', content: '润色以下法务情报卡片的两段文字，使其更自然专业。只润色表达，不改动任何事实、数据、主体名称、法律条款。输出纯JSON：{"legal_signal":"...","business_impact":"..."}' },
          { role: 'user', content: `模块：${card.module}\n原标题：${card.title}\n事实：${(card.facts||[]).join('；')}\n法务观察：${card.legal_signal}\n业务影响：${card.business_impact}` },
        ],
        temperature: 0.2, maxTokens: 500, timeoutMs: 30000, maxAttempts: 1,
      });
      const polished = JSON.parse(polishResp.replace(/```json\s*|\s*```/g, '').trim());
      if (polished.legal_signal && polished.legal_signal.length > 20) card.legal_signal = polished.legal_signal;
      if (polished.business_impact && polished.business_impact.length > 15) card.business_impact = polished.business_impact;
    } catch (_) { /* keep original if AI fails */ }
  }

  // Module re-inference: list-page-derived cards inherit the list's module
  // (e.g. all NMPA announcements land in 美妆动态). Re-classify by title so
  // 征求意见/标准 → 新规, 抽检/不合格 → 产品安全, 处罚 → 广告合规 etc.
  const inferredModule = inferCandidateModule(card);
  if (inferredModule && inferredModule !== card.module) {
    console.log(`  RE-MODULE ${card.module.slice(0, 8)} → ${inferredModule.slice(0, 8)}: ${card.title.slice(0, 30)}`);
    card.module = inferredModule;
  }
  cards.push({ ...card, score: validation.score, tier: validation.tier });
}

// --- Event-level dedup: the same story syndicated across media (different
// URLs, near-identical titles) must not occupy multiple slots. Keep only the
// highest-scored card per normalized title, before portfolio selection.
const MEDIA_SUFFIX = /[-_|·\s]*(搜狐|腾讯|网易|新浪|凤凰|界面|澎湃|36氪|36kr|21财经|21世纪经济报道|虎嗅|钛媒体|每日经济新闻|证券时报|第一财经|中国网|人民网|新华网|央视|今日头条|东方财富|快科技|雷峰网|亿邦动力|雨果跨境|盖世汽车|站长之家)(网)?[^一-龥A-Za-z0-9]*$/;
const NOISE_PREFIX = /^(冲上热搜[!！]?|曾风靡全国[，,]?|重磅[!！]?|突发[!！]?|速看|注意[!！]?|快讯[|：:]|刚刚)/;
function normalizeTitleKey(title = '') {
  return String(title)
    .replace(MEDIA_SUFFIX, '')
    .replace(NOISE_PREFIX, '')
    .replace(/[^一-龥A-Za-z0-9]/g, '');
}
// 跨媒体改写标题的同一事件：归一化标题不同（上面那把锁锁不住），但**带单位的特征数字**
// 相同。实测本周报告里「奉贤区化妆品出口+34.1%」被海关总署与科技日报各报一次，
// 两张卡同时进了报告（normalizeTitleKey 之后一个是「…劲增34.1%图」、一个是
// 「…一年增长34.1%」）。特征数字是改写标题时不会变的那部分。
function distinctiveNumbers(title = '') {
  // 只认带**强单位**的数字，且数值至少两位或带小数点——挡掉「3个」「5倍」这类
  // 满篇都是、无法充当事件指纹的数字。
  const matches = String(title).match(/\d+(?:\.\d+)?\s*(?:%|％|亿欧元|亿美元|亿元|万元|亿|万吨|吨)/g) || [];
  return new Set(matches.map(item => item.replace(/\s+/g, '')).filter(item => /\d{2,}|\./.test(item)));
}
const seenTitles = new Map();
// 特征数字 → 已入选的同事件卡（只为跨媒体改写标题兜底，命中时保留分高者）
const seenEventNumbers = new Map();
const titleDeduped = [];
// 去重三层（归一标题 / 特征数字 / AI 事件归组）共用这一条「保留分高者」规则——
// 原先三处各写一遍，将来要加 tie-break（同分优先权威源）必然漏改其中一处。
const keepHigher = (card, existing, tag) => {
  if ((card.score || 0) > (existing.score || 0)) {
    const idx = titleDeduped.indexOf(existing);
    if (idx >= 0) titleDeduped[idx] = card;
    console.log(`  ${tag} keep-higher: ${existing.title.slice(0, 40)} → ${card.title.slice(0, 40)}`);
    return card;
  }
  console.log(`  ${tag}: ${card.title.slice(0, 40)}`);
  return existing;
};
for (const card of cards) {
  const tk = normalizeTitleKey(card.title || '');
  if (!tk) { titleDeduped.push(card); continue; }
  const eventTokens = distinctiveNumbers(card.title || '');
  const eventMatch = [...eventTokens].map(token => seenEventNumbers.get(token)).find(Boolean);
  if (eventMatch) {
    const kept = keepHigher(card, eventMatch, 'DEDUP-EVENT');
    for (const token of eventTokens) seenEventNumbers.set(token, kept);
    continue;
  }
  const existing = seenTitles.get(tk);
  if (!existing) {
    seenTitles.set(tk, card);
    for (const token of eventTokens) seenEventNumbers.set(token, card);
    titleDeduped.push(card);
    continue;
  }
  if (keepHigher(card, existing, 'DEDUP-TITLE') === card) seenTitles.set(tk, card);
}

// Step 5.5: AI 事件归组 —— 同一事件被多家媒体报道时只留一条
//
// 为什么必须用 AI：三种确定性判据都实测失败（都在同一个 pack 上量过）——
//   ① 特征数字：汕头打假四条标题里没有任何数字，抓不到；
//   ② 标题 2-gram 相似度：得分最高的反而是 5 条 Safety Gate（0.41–0.60，模板相同、
//      事件不同），真正同一事件的汕头四条只有 0.25 —— 按阈值合并会把召回通报全并掉、
//      却漏掉汕头；
//   ③ 最长公共中文串（≥6 字）：会被「国家药监局关于」这类**模板前缀**误命中，
//      7 个命中里只有 2 个是同一事件。
// 而「这四条讲的是不是同一件事」恰恰是 AI 擅长的，也是代码库历史上做过的
// （见 5b94b78「dual dedup — AI eventSig + hard-fact anchors」）。
//
// 必要性：这条重复原先被一个 bug 意外压住——模块分区修好前，这类稿子全被
// RE-MODULE 丢进「美妆动态」，而该模块被 Safety Gate 占满、上限 5 把它们挤掉了；
// 分区归位后它们进「知识产权」并占满上限，重复就露出来了（实测一期 4 张同一事件）。
//
// 预算必须给足：这个任务模型要两两比对（16 条 = 120 对），reasoning_effort:'high' 下
// 实测 2000/4000 全部烧在推理上（finish_reason=length、content 为空），8000 才出结果
// （29s、推理 5449 tokens）。每周只调一次，这点开销可接受；给不足就等于这个功能不存在。
// 失败即跳过（保持现状），绝不因此少发卡。
async function groupSameEventCards(cards = []) {
  if (!aiKey || cards.length < 3) return null;
  const numbered = cards.map((card, index) => `${index + 1}. ${card.title}`).join('\n');
  const askOnce = () => requestAiChat({
    apiKey: aiKey, baseUrl: aiBaseUrl, model: aiModel,
    messages: [
      {
        role: 'system',
        content: '下面是一份周报的候选卡片标题。请找出其中**报道同一件事**的多条（同一执法行动、同一次召回、同一份判决、同一份公告被多家媒体分别报道），每组列出全部编号。'
          + '注意区分「同一事件的多家报道」与「同一主题的不同事件」：不同产品的召回、不同法规的公告、不同企业的处罚，各自是不同事件，不要合并；'
          + '标题共用的模板前缀（如「国家药监局关于…」）不代表同一事件。'
          + '只回复 JSON：{"groups":[[编号,编号],[编号]]}，没有重复则回复 {"groups":[]}。',
      },
      { role: 'user', content: numbered },
    ],
    temperature: 0, maxTokens: 8000, timeoutMs: 120000, maxAttempts: 1,
  });
  try {
    const parsed = await askAiJson(askOnce);
    const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
    return groups
      .map(group => (Array.isArray(group) ? group.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= cards.length) : []))
      .filter(group => new Set(group).size >= 2);
  } catch (error) {
    console.warn(`  WARN [ai-event-dedup] 跳过：${String(error.message || error).slice(0, 60)}`);
    return null;
  }
}

const eventGroups = await groupSameEventCards(titleDeduped);
let eventDeduped = titleDeduped;
if (eventGroups?.length) {
  const drop = new Set();
  for (const group of eventGroups) {
    const members = group.map(n => titleDeduped[n - 1]).filter(Boolean);
    if (members.length < 2) continue;
    // 组内保留分最高的那条（同分保留先出现的）
    const keep = members.reduce((best, card) => ((card.score || 0) > (best.score || 0) ? card : best), members[0]);
    for (const card of members) if (card !== keep) drop.add(card);
    console.log(`  DEDUP-AI-EVENT 保留「${keep.title.slice(0, 30)}」，合并 ${members.length - 1} 条同事件报道`);
  }
  eventDeduped = titleDeduped.filter(card => !drop.has(card));
}

// Step 6: Select balanced portfolio
// Official/authority sources fill slots first; portal/self-media cards only
// backfill module gaps. Same scoring within each tier.
const sorted = eventDeduped.sort((a, b) => {
  const aa = isAuthoritySource(a) ? 1 : 0;
  const bb = isAuthoritySource(b) ? 1 : 0;
  if (aa !== bb) return bb - aa;
  return (b.score || 0) - (a.score || 0);
});
const selected = [];
const moduleCounts = new Map();
const seen = new Set();
const MODULES = ['新法律法规政策', '广告处罚案例', '知识产权保护或者侵权', '进出口', '产品质量/召回与安全风险', '美妆动态'];
const MODULE_MAP = {
  '新规及案例动态': '新法律法规政策', '广告合规及处罚案例': '广告处罚案例',
  '知识产权动态': '知识产权保护或者侵权', '进出口动态': '进出口',
  '产品质量/召回与安全风险': '产品质量/召回与安全风险',
};
const TARGET = 24;
const MIN_PER_MODULE = 2;
const MAX_PER_MODULE = 5;

// 组合选择统一去重键：归一化 URL 优先，无 URL 时退回标题（去空白）。
// 主循环、IP seed、min 补位、cross-module 补位共用同一把锁，防止同一张卡被选入两次。
const selectionKey = c => normalizeDedupUrl(c.source_url || c.url || '') || (c.title || '').replace(/\s+/g, '');

for (const card of sorted) {
  const mod = MODULE_MAP[card.module] || card.module;
  const key = selectionKey(card);
  if (seen.has(key)) { console.log(`  DEDUP ${card.title.slice(0, 40)}`); continue; }
  if ((moduleCounts.get(mod) || 0) >= MAX_PER_MODULE) continue;
  if (selected.length >= TARGET) break;
  seen.add(key);
  moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
  selected.push({ ...card, module: mod });
}

// IP seed cases — persistent corpus of known beauty IP cases from broader time windows
// Injected when the discovery channel produces < 2 beauty-specific IP cards.
const IP_SEED_PATH = resolve('docs/quality/ip-seed-cases.json');
let ipSeedCases = [];
try {
  ipSeedCases = JSON.parse(readFileSync(IP_SEED_PATH, 'utf8'));
  console.log(`Loaded ${ipSeedCases.length} IP seed cases from ${IP_SEED_PATH}`);
} catch (err) {
  console.warn(`IP seed file not found or unreadable: ${err.message.slice(0, 80)}`);
}

// Validate and inject IP seed cases when IP module is underfilled
const ipSelected = selected.filter(c => (MODULE_MAP[c.module] || c.module) === '知识产权保护或者侵权');
if (ipSelected.length < MIN_PER_MODULE && ipSeedCases.length) {
  const now = new Date();
  for (const seed of ipSeedCases) {
    const seedDate = new Date(seed.published_at + 'T00:00:00Z');
    const daysAgo = (now - seedDate) / 86400000;
    if (daysAgo > 90) continue;
    // Check cross-week dedup: skip if this seed URL was already delivered
    const seedKey = normalizeDedupUrl(seed.source_url || seed.url || '');
    if (seedKey && seenUrls.has(seedKey)) {
      console.log(`  IP SEED SKIP [url-dup]: ${seed.title.slice(0, 40)}`);
      continue;
    }
    const card = premiumCardFromCandidate({
      ...seed, url: seed.source_url, final_url: seed.source_url,
      article_text: seed.evidence_text,
      detail_status: 'hydrated', source_scope: 'discovered_article',
      evidence_grade: 'hard_fact_ready',
    });
    const validation = validatePremiumEvidenceCard(card);
    if (!validation.accepted) {
      console.log(`  IP SEED SKIP [${validation.reason}]: ${seed.title.slice(0, 50)}`);
      continue;
    }
    const key = selectionKey(card);
    if (seen.has(key)) continue;
    seen.add(key);
    const mod = '知识产权保护或者侵权';
    if ((moduleCounts.get(mod) || 0) >= MAX_PER_MODULE) continue;
    moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
    selected.push({ ...card, module: mod, score: validation.score, tier: validation.tier });
    console.log(`  IP SEED + ${card.title.slice(0, 40)}`);
    if (ipSelected.length + 1 >= MIN_PER_MODULE) break;
  }
}

// Fill minimums — for IP module, re-classify ad-penalty cards with trademark/IP content
for (const mod of MODULES) {
  while ((moduleCounts.get(mod) || 0) < MIN_PER_MODULE && selected.length < TARGET) {
    const fallback = sorted.find(c => {
      const m = MODULE_MAP[c.module] || c.module;
      return m === mod && !seen.has(selectionKey(c));
    });
    if (fallback) {
      seen.add(selectionKey(fallback));
      moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
      selected.push({ ...fallback, module: mod });
      continue;
    }
    // Cross-module fill: ad-penalty cards with trademark/IP keywords → IP module
    if (mod === '知识产权保护或者侵权') {
      const crossCard = sorted.find(c => {
        const m = MODULE_MAP[c.module] || c.module;
        if (m !== '广告处罚案例') return false;
        const combined = `${c.title} ${c.legal_signal} ${c.evidence_text}`;
        if (!/商标|专利|著作权|冒用|假冒|仿冒|包装装潢/i.test(combined)) return false;
        return !seen.has(selectionKey(c));
      });
      if (crossCard) {
        seen.add(selectionKey(crossCard));
        moduleCounts.set(mod, (moduleCounts.get(mod) || 0) + 1);
        selected.push({ ...crossCard, module: mod });
        continue;
      }
    }
    break;
  }
}

// Build report
const sections = MODULES.map(mod => ({
  module: mod,
  items: selected.filter(c => (MODULE_MAP[c.module] || c.module) === mod),
}));

const report = { period, sections };
// 低供给标注：分级门槛下总量不足仍会发布，但必须在报告正文里显式说明，
// 避免法务读者误以为这就是本期全部可用信息。
const supplyFloor = Number(process.env.REPORT_MIN_ITEMS || 15);
const supplyNote = selected.length < supplyFloor
  ? `\n> ⚠️ 本期供给偏低：合格条目 ${selected.length} 条，低于常规门槛 ${supplyFloor} 条。已按分级门槛放行发布，缺口主要来自官方站正文抓取受限。\n`
  : '';
// preselecteded: true avoids re-validating every card inside the markdown builder
const markdown = buildPremiumDingTalkMarkdown({ period, cards: selected, preselected: true })
  .replace(/^(>[^\n]*\n)/m, match => match + supplyNote);

// Emit the URLs actually selected for delivery. The dedup state file
// (docs/quality/seen-cards.json) is only updated after the DingTalk push
// succeeds — see deliver-report.js. Failed or no-delivery runs therefore
// never pollute the fingerprint state.
const deliveredPath = resolve('out', 'delivered-urls.json');
const deliveredUrls = selected
  .map(c => ({
    u: normalizeDedupUrl(c.source_url || c.url || ''),
    t: now.toISOString().slice(0, 10),
    module: c.module,
    title: (c.title || '').slice(0, 80),
  }))
  .filter(e => e.u);
writeFileSync(deliveredPath, `${JSON.stringify(deliveredUrls, null, 2)}\n`);
console.log(`[dedup] wrote ${deliveredUrls.length} delivered URLs to ${deliveredPath} (state file updated only after real delivery)`);

const serialized = JSON.stringify({ report, cards: selected }, null, 2) + '\n';
writeFileSync(outputPath, serialized);
writeFileSync(outputPath.replace('.json', '.md'), markdown, 'utf8');
// Overwrite the pipeline report so CI produces a single consolidated output
writeFileSync(resolve('out', 'latest-report.md'), markdown, 'utf8');
writeFileSync(resolve('out', 'latest-report.json'), serialized);

console.log(`\n=== FINAL ===`);
console.log(`Period: ${period.start} → ${period.end}`);
console.log(`Cards: ${selected.length}`);
sections.forEach(s => console.log(`  ${s.module}: ${s.items.length}`));
console.log(`Wrote: ${outputPath.replace('.json', '.md')}`);
