const MARKDOWN_TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const PAGE_CONTROL_PATTERN = /(?:下载|打印|关闭窗口|字体(?:大小)?|字号|分享到(?:新浪微博|QQ空间|微信|微博)|分享至(?:新浪微博|QQ空间|微信|微博)|收藏本站|返回顶部|视窗|最小化|最大化|还原|loading\.{3}|无障碍|关怀版|繁體|简体|EN(?:\s*$)|扫一扫|复制链接|打开适老|聽|请听|我在听|说话\(|網站地圖)/gi;
const PAGE_SHELL_PATTERN = /^(?:网站首页|首页|主页|当前位置|您的位置|位置[:：]|导航|站点导航|机构概况|信息公开|办事大厅|新闻中心|通知公告|联系我们|登录|注册|搜索|高级检索|友情链接|上一页|下一页|English|Home|Menu|X\b|用户空间|海关电邮|守国门|促发展)(?:\s|[>＞|｜:：/·-]|$)/i;
const EVENT_EVIDENCE_PATTERN = /(?:发布|公布|公告|通告|通报|征求意见|实施|生效|处罚|罚款|罚没|没收|召回|停止销售|抽检|不合格|判决|裁定|侵权|冒用|假冒|商标|专利|著作权|虚假宣传|功效宣称|平台治理|专项治理|治理公告|海关|关税|报关|清关|进口|出口|标准|法规|条例|办法|规定|备案|注册)/i;
const NAVIGATION_TOKEN_PATTERN = /新闻发布厅|时政要闻|媒体聚焦|快捷检索|高级检索|友情链接|返回顶部|上一篇|下一篇|人才队伍|院务动态|党建工作|业务咨询|建言献策|院介绍|院领导|组织机构|能力资质|首席专家|法规政策|公告通知|数据查询|机构简介|领导简介|政府信息公开|依申请公开|办事指南|交流互动|专题专栏|返回主站|网站地图|药监App|监管App|机构|新闻|政务|服务|互动|专题|总局|司局|地方|图片|视频|当|好|让|党|放心/gi;
const SUBSTANTIVE_ACTION_PATTERN = /发布|公布|通报|征求意见|实施|生效|处罚|罚款|罚没|没收|召回|停止销售|抽检|不合格|判决|裁定|侵权|虚假宣传|功效宣称|平台治理|专项治理|调整|修订|要求|决定/;
const FOOTER_PATTERN = /^(?:本站由|本站主办|版权所有|Copyright|备案序号|网站标识码|京ICP备|ICP备|主办单位|承办单位|技术支持|地址[:：]|邮编[:：]|联系电话|All Rights Reserved)/i;
const ATTACHMENT_FILENAME_PATTERN = /^[^。；;]{2,140}?\.(?:docx?|pdf|xlsx?|pptx?)$/i;

function plainText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\[\s*\]\([^)]+\)/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s*⟨\d+⟩/g, '');
}

// --- 导航/页脚剥离：在正文进入任何判据之前做 ---
// 词表法在这件事上必然漏：政务站的菜单标签是无穷的（实测「机构设置/新闻动态/
// 政务公开/互动交流/智能问答」都不在任何词表里），但菜单的**形状**是稳定的——
// 整行都是链接（或链接包着图标与短标签），几乎没有正文残留。
// 反过来，正文里单独的链接行（附件、相关阅读）很常见，所以只丢成片的块（≥3 行）。
// 目的地里允许转义括号：crawl4ai 抓下来的 `[标签](javascript:void\(0\);)`
// 很常见，早期版本按普通括号切会切不干净，整行被误判成正文、打断菜单块。
const MARKDOWN_LINK_PATTERN = /\[[^\]]*\]\((?:[^)\\]|\\.)*\)/g;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\((?:[^)\\]|\\.)*\)/g;
const NAVIGATION_BLOCK_MIN_LINES = 3;
const NAVIGATION_LABEL_BLOCK_MIN_LINES = 4;
const NAVIGATION_LABEL_RESIDUE_LIMIT = 20;

// 菜单项判定（传入前已剥掉图片）：整行是链接，或链接包着短标签。
function isNavigationMenuLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return false;
  const links = raw.match(MARKDOWN_LINK_PATTERN) || [];
  if (!links.length) return false;
  const residue = raw
    .replace(MARKDOWN_LINK_PATTERN, ' ')
    .replace(/[\s*•·|]+/g, '');
  if (!residue) return true;
  if (residue.length > NAVIGATION_LABEL_RESIDUE_LIMIT || /[。！？；]/.test(residue)) return false;
  // 有的站把标签文字包在链接里（`[ 图标 政策文件 图标 ](javascript:;)`），
  // 剥掉链接后仍有短残留；这种链接密集的行同样是菜单项。
  if (links.length >= 2) return true;
  // 栏目索引页的列表行是「一个链接 + 日期」：`[标题](url) 2026-09-01`。
  // 残留里没有汉字就说明它不是句子（正文的「详见《通知》[链接](url)」残留带汉字），
  // 这类行整片出现时就是索引页，必须在这里摘掉——否则它会以「满屏化妆品标题」
  // 的形态喂给 AI，被判成相关文章。
  return !/[一-龥]/.test(residue);
}

// 没有链接的菜单（`## 政策` / `政府信息公开指南` 这类纯标签）：
// 形状是「标题」而非「句子」——短、无句读、无数字（日期/文号/金额都会带数字）、
// 无书名号。菜单项与正文短句的区别就在这里，仍然不看具体词。
const NAVIGATION_LABEL_MAX_LENGTH = 8;
const NAVIGATION_ROW_TOKEN_MAX_LENGTH = 10;

function isNavigationLabelToken(token) {
  if (!token || token.length > NAVIGATION_ROW_TOKEN_MAX_LENGTH) return false;
  // 句读与引号书名号：。！？；，、： 以及 “”‘’《》〈〉〔〕【】
  if (/[。！？；，、：“”‘’《》〈〉〔〕【】]/.test(token)) return false;
  if (/\d/.test(token)) return false;
  return true;
}

function isNavigationLabelLine(line) {
  const raw = String(line || '')
    .trim()
    .replace(/^[#>\-*+]+/, '')
    .replace(/;\)+\s*$/, '')   // 站点脚本残渣 `标签;)`
    .trim();
  if (!raw) return false;
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (!tokens.length || !tokens.every(isNavigationLabelToken)) return false;
  // 一行排开好几个菜单项，是菜单的强特征；单个标签要更短才算，
  // 否则「为进一步完善化妆品技术标准」这种正文短句会被误判成菜单项。
  return tokens.length >= 2 || raw.length <= NAVIGATION_LABEL_MAX_LENGTH;
}

const NAVIGATION_KIND_CONTENT = 'content';
const NAVIGATION_KIND_MENU = 'menu';
const NAVIGATION_KIND_IGNORE = 'ignore';

// 三分类：菜单项 / 透明行（空行、纯图标行）/ 正文行。
// 纯图标行是菜单的内部构件（`![](logo.png)`），既不是正文也不该打断菜单块——
// 早期版本在这里断了块，整片导航因此整片漏过。
function classifyNavigationLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return NAVIGATION_KIND_IGNORE;
  const withoutImages = raw.replace(MARKDOWN_IMAGE_PATTERN, ' ').trim();
  if (!withoutImages) return NAVIGATION_KIND_IGNORE;
  if (isNavigationMenuLine(withoutImages)) return NAVIGATION_KIND_MENU;
  // 纯标签行（`## 政策` / `政府信息公开指南`）同样按菜单项算。
  if (isNavigationLabelLine(withoutImages)) return NAVIGATION_KIND_MENU;
  return NAVIGATION_KIND_CONTENT;
}

// 丢掉成片的菜单/页脚行。透明行不打断块（菜单行之间常夹空行与图标行），
// 正文行一定打断块——所以只有连续成片的菜单才会被摘掉。
function stripNavigationBlocks(value) {
  const lines = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .split('\n');
  const dropped = new Array(lines.length).fill(false);
  let run = [];
  let runHasLink = false;
  const flush = () => {
    // 带链接的菜单块 ≥3 行即可判定；纯标签块要求更长，避免误吃正文里
    // 连续几行短句（公告的小标题、落款等）。
    const isBlock = runHasLink ? run.length >= NAVIGATION_BLOCK_MIN_LINES : run.length >= NAVIGATION_LABEL_BLOCK_MIN_LINES;
    if (isBlock) for (const index of run) dropped[index] = true;
    run = [];
    runHasLink = false;
  };
  lines.forEach((line, index) => {
    const kind = classifyNavigationLine(line);
    if (kind === NAVIGATION_KIND_IGNORE) return;
    if (kind === NAVIGATION_KIND_MENU) {
      run.push(index);
      if (isNavigationMenuLine(String(line).trim().replace(MARKDOWN_IMAGE_PATTERN, ' ').trim())) runHasLink = true;
      return;
    }
    flush();
  });
  flush();
  return lines.filter((_, index) => !dropped[index]).join('\n');
}

function cleanLine(value) {
  let line = String(value || '').trim();
  if (!line || MARKDOWN_TABLE_SEPARATOR.test(line)) return '';
  line = line
    .replace(/^\s{0,3}#{1,6}\s*/, '')
    .replace(/^\s{0,3}>+\s*/, '')
    .replace(/^\s{0,3}(?:[-*+] |\d+[.)]\s+)/, '')
    .replace(/\*\*|__|`+/g, '')
    .replace(PAGE_CONTROL_PATTERN, ' ')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[>＞|｜:：/·\s-]+|[>＞|｜:：/·\s-]+$/g, '')
    .trim();
  if (!line) return '';
  if (PAGE_SHELL_PATTERN.test(line) && !EVENT_EVIDENCE_PATTERN.test(line)) return '';
  if (FOOTER_PATTERN.test(line) && !SUBSTANTIVE_ACTION_PATTERN.test(line)) return '';
  if (ATTACHMENT_FILENAME_PATTERN.test(line)) return '';
  const navigationHits = line.match(NAVIGATION_TOKEN_PATTERN)?.length || 0;
  const withoutNavigationLabels = line.replace(NAVIGATION_TOKEN_PATTERN, ' ');
  if (navigationHits >= 2 && !SUBSTANTIVE_ACTION_PATTERN.test(withoutNavigationLabels)) return '';
  if (/^[\p{P}\p{S}\s]+$/u.test(line)) return '';
  if (/^(?:新浪微博|QQ空间|微信|微博|复制链接)(?:\s+(?:新浪微博|QQ空间|微信|微博|复制链接))*$/i.test(line)) return '';
  return line;
}

export function cleanArticleEvidence(value) {
  // 先按链接形状剥掉导航/页脚，再压成纯文本：plainText 会把 [标签](url)
  // 拍平成标签，菜单的结构信号随之消失，之后就再也分不出导航和正文了。
  const lines = stripNavigationBlocks(value)
    .split(/\n+/)
    .map(line => cleanLine(plainText(line)))
    .filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const line of lines) {
    const key = line.replace(/\s+/g, '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(line);
  }
  return unique.join('\n');
}

export function compactEvidenceText(value, maxLength = 220) {
  const cleaned = cleanArticleEvidence(value).replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length <= maxLength) return cleaned;
  const window = cleaned.slice(0, maxLength + 1);
  const boundaries = [...window.matchAll(/[。！？!?；;，,]/g)].map(match => match.index + 1);
  const boundary = boundaries.filter(index => index >= Math.floor(maxLength * 0.55) && index <= maxLength).pop();
  return `${window.slice(0, boundary || maxLength).replace(/[，,；;\s]+$/g, '')}...`;
}

const GENERIC_INTRO_PATTERN = /(?:引发关注|备受关注|引起热议|引发热议|受到关注|引发讨论|引人注目)/i;

export function firstEvidenceSentence(value, maxLength = 220) {
  const cleaned = cleanArticleEvidence(value);
  const sentences = cleaned
    .split(/\n+|(?<=[。！？!?；;])\s*/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 16);
  const selected = sentences.find(sentence =>
    EVENT_EVIDENCE_PATTERN.test(sentence) && !GENERIC_INTRO_PATTERN.test(sentence)
  )
    || sentences.find(sentence => EVENT_EVIDENCE_PATTERN.test(sentence))
    || sentences[0]
    || cleaned;
  return compactEvidenceText(selected, maxLength);
}
