const MARKDOWN_TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const PAGE_CONTROL_PATTERN = /(?:下载|打印|关闭窗口|字体(?:大小)?|字号|分享到(?:新浪微博|QQ空间|微信|微博)|分享至(?:新浪微博|QQ空间|微信|微博)|收藏本站|返回顶部|视窗|最小化|最大化|还原|loading\.{3}|无障碍|关怀版|繁體|简体|EN(?:\s*$)|扫一扫|复制链接|打开适老|聽|请听|我在听|说话\(|網站地圖)/gi;
const PAGE_SHELL_PATTERN = /^(?:网站首页|首页|主页|当前位置|您的位置|位置[:：]|导航|站点导航|机构概况|信息公开|办事大厅|新闻中心|通知公告|联系我们|登录|注册|搜索|高级检索|友情链接|上一页|下一页|English|Home|Menu|X\b|用户空间|海关电邮|守国门|促发展)(?:\s|[>＞|｜:：/·-]|$)/i;
// 执法动作词（制假/售假/查封/查扣/查获/立案/抓获/停职/查处/整治）2026-09-11 补：
// 原表只认「假冒」，漏掉「制假售假」整族，导致本周最大的汕头化妆品打假系列
// （约 10 条）提不出证据句——facts 退化成标题复读、legal_signal 退化成模板
// 套话，随后被 weak-facts / weak-legal-signal 正确拒掉。稿子没问题，是词表不认识
// 「执法通报」这种事件类型。
const EVENT_EVIDENCE_PATTERN = /(?:发布|公布|公告|通告|通报|征求意见|实施|生效|处罚|罚款|罚没|没收|召回|停止销售|抽检|不合格|判决|裁定|侵权|冒用|假冒|制假|售假|造假|假货|查封|查扣|查获|缴获|立案|抓获|停职|查处|整治|商标|专利|著作权|虚假宣传|功效宣称|平台治理|专项治理|治理公告|海关|关税|报关|清关|进口|出口|标准|法规|条例|办法|规定|备案|注册)/i;
const NAVIGATION_TOKEN_PATTERN = /新闻发布厅|时政要闻|媒体聚焦|快捷检索|高级检索|友情链接|返回顶部|上一篇|下一篇|人才队伍|院务动态|党建工作|业务咨询|建言献策|院介绍|院领导|组织机构|能力资质|首席专家|法规政策|公告通知|数据查询|机构简介|领导简介|政府信息公开|依申请公开|办事指南|交流互动|专题专栏|返回主站|网站地图|药监App|监管App|机构|新闻|政务|服务|互动|专题|总局|司局|地方|图片|视频|当|好|让|党|放心/gi;
const SUBSTANTIVE_ACTION_PATTERN = /发布|公布|通报|征求意见|实施|生效|处罚|罚款|罚没|没收|召回|停止销售|抽检|不合格|判决|裁定|侵权|虚假宣传|功效宣称|平台治理|专项治理|调整|修订|要求|决定/;
// 版权行以 © 开头是常见写法（gov.uk 的「© Crown copyright。」），
// 而这条判据原先只认「版权所有 / Copyright」开头，于是那行活到选择层被当成证据句。
// 同理补上「All content is available under…」这类授权声明。
const FOOTER_PATTERN = /^(?:©|本站由|本站主办|版权所有|Copyright|备案序号|网站标识码|京ICP备|ICP备|主办单位|承办单位|技术支持|地址[:：]|邮编[:：]|联系电话|All content is available under|All Rights Reserved)/i;
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

// 页面组件（无障碍工具栏 / 登录墙 / 分享栏 / 天气条）的形状：
// 去掉 ASCII 字母数字与标点后，剩下的中文很少。实测这类块比菜单更毒——
// 卡片生成器会拿它当正文去填 facts 与 legal_signal，于是弱事实卡把
// 真正的好稿拒掉（新京报「地下工厂」调查、上海家化六神维权案都死在这）。
// 例：`; "重新设置Shift+1") 重置` → 只剩「重新设置重置」6 字。
const NAVIGATION_CHROME_MAX_CJK = 12;
const NAVIGATION_CHROME_MIN_PUNCTUATION = 2;
const NAVIGATION_CHROME_MAX_LENGTH = 26;
const NAVIGATION_CHROME_MAX_ASCII_LENGTH = 45;
const ASCII_NOISE_PATTERN = /[A-Za-z0-9]|[ -/:-@[-`{-~]/g;

function isChromeLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return false;
  // 光看「CJK 少」会误伤「标签：值」型正文——EU Safety Gate 的通报正文就是
  // 「通报国：Greece」这种结构，值是英文，CJK 天然少，整片会被当成 chrome 删光
  // （实测 11 条记录正文全变 0）。真 chrome 行另外带脚本残渣：引号、括号、分号。
  // 整行没有任何汉字且很短 → 播放器/时间戳/统计条一类组件：
  // `2026-09-07 18:30 Current Time 0:00`、`Duration 0:34 Loaded: 29.09%`。
  // 这类行会落进 firstEvidenceSentence 的兜底分支（没有句子匹配事件词时取第一句），
  // 于是「事实要点」印到 PDF 上变成播放器读数（实测汕头联合执法组那条）。
  // 长度上限保证不误伤英文正文——Safety Gate 的风险描述是整句长英文，远长于此。
  if (raw.length <= NAVIGATION_CHROME_MAX_ASCII_LENGTH && !/[一-龥]/.test(raw)) return true;
  const asciiPunctuation = (raw.match(/["'();:,.]/g) || []).length;
  if (asciiPunctuation < NAVIGATION_CHROME_MIN_PUNCTUATION) return false;
  // 还要短。长行哪怕 CJK 少也是正文——EU Safety Gate 的「风险描述：The product
  // contains benzyl alcohol…」就是这样被误删的；chrome 行都是短标签。
  if (raw.length > NAVIGATION_CHROME_MAX_LENGTH) return false;
  const cjkOnly = raw.replace(ASCII_NOISE_PATTERN, ' ').replace(/\s+/g, '');
  return cjkOnly.length <= NAVIGATION_CHROME_MAX_CJK;
}

const NAVIGATION_KIND_CONTENT = 'content';
const NAVIGATION_KIND_MENU = 'menu';
const NAVIGATION_KIND_CHROME = 'chrome';
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
  if (isChromeLine(withoutImages)) return NAVIGATION_KIND_CHROME;
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
  let runHasChrome = false;
  const flush = () => {
    // 带链接或页面组件的块 ≥3 行即可判定；纯标签块要求更长，避免误吃正文里
    // 连续几行短句（公告的小标题、落款等）。
    const threshold = (runHasLink || runHasChrome) ? NAVIGATION_BLOCK_MIN_LINES : NAVIGATION_LABEL_BLOCK_MIN_LINES;
    if (run.length >= threshold) for (const index of run) dropped[index] = true;
    run = [];
    runHasLink = false;
    runHasChrome = false;
  };
  lines.forEach((line, index) => {
    const kind = classifyNavigationLine(line);
    if (kind === NAVIGATION_KIND_IGNORE) return;
    if (kind === NAVIGATION_KIND_MENU || kind === NAVIGATION_KIND_CHROME) {
      run.push(index);
      if (kind === NAVIGATION_KIND_CHROME) runHasChrome = true;
      else if (isNavigationMenuLine(String(line).trim().replace(MARKDOWN_IMAGE_PATTERN, ' ').trim())) runHasLink = true;
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

// 正文从标题处开始：页头组件（无障碍工具栏、登录墙、分享栏）千站千面，
// 逐个加形状判据永远补不完，但它们的**位置**是固定的——都在标题之前。
// 只要标题出现在文本里，把标题之前的行整段切掉即可，与站点无关。
// 安全边界：被切掉的部分不含句末标点（。！？），也就是绝不丢真正的正文句子。
const TITLE_ANCHOR_MIN_LENGTH = 10;

function stripHeadBeforeTitle(lines, title) {
  const needle = String(title || '').replace(/[\s　]+/g, '');
  if (needle.length < TITLE_ANCHOR_MIN_LENGTH) return lines;
  const probe = needle.slice(0, Math.max(TITLE_ANCHOR_MIN_LENGTH, Math.min(24, needle.length)));
  const index = lines.findIndex(line => line.replace(/[\s　]+/g, '').includes(probe));
  if (index <= 0) return lines;
  const dropped = lines.slice(0, index);
  if (dropped.length > 40) return lines;
  // 安全网：被切掉的部分不该含真正的句子。只数「。」——页头组件里
  // 「提示：该链接属站外链接…！」这类带叹号的提示很常见，用 ！？ 当护栏会把它挡下。
  if (dropped.filter(line => /。/.test(line)).length > 1) return lines;
  return lines.slice(index);
}

// 逐行归一空白、**保留换行**。任何一次全篇压平都会把已经洗好的行结构重新弄脏
// （页面组件判据、硬事实里的 [^。；;\n] 收口都依赖行边界）。三个消费方共用这一份，
// 免得各写一套之后在"要不要保留空行 / 要不要处理 \r\n"上悄悄分叉。
export function perLineText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n');
}

export function cleanArticleEvidence(value, { title = '' } = {}) {
  // 先按链接形状剥掉导航/页脚，再压成纯文本：plainText 会把 [标签](url)
  // 拍平成标签，菜单的结构信号随之消失，之后就再也分不出导航和正文了。
  const cleaned = stripNavigationBlocks(value)
    .split(/\n+/)
    .map(line => cleanLine(plainText(line)))
    .filter(Boolean);
  const lines = stripHeadBeforeTitle(cleaned, title);
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

// --- 「附带提及」的确定性判据 ---
// 美妆词只出现在商品/品类枚举里（关税新闻里的「…乳制品、五金工具、美妆化妆品、
// 电子设备等」），而不是文章主体。AI 在这条边界上不稳定——同一篇稿子这轮判不相关、
// 下轮判相关（实测加拿大对美反制关税一篇），所以用规则兜住，别把波动带进周报。
const BEAUTY_MENTION_PATTERN = /化妆品|美妆|护肤|彩妆|香水|防晒|染发|洗护|面膜|口红/g;
// 安全阀：只认「长枚举」。真文章里也会列举品类（「化妆品、护肤品、彩妆等」），
// 那种只有 1–2 个顿号，不判附带提及；贸易/关税类新闻的品类清单通常有 3 个以上。
const ENUMERATION_WINDOW = 60;
const ENUMERATION_MIN_SEPARATORS = 3;

export function isIncidentalBeautyMention(value) {
  const source = String(value || '');
  const matches = [...source.matchAll(BEAUTY_MENTION_PATTERN)];
  if (!matches.length) return false;
  // 合并相邻匹配：「美妆化妆品」会被拆成「美妆」+「化妆品」两段，只看前一段会误判
  // （它后面紧跟着汉字，判不出枚举边界）。
  const spans = [];
  for (const match of matches) {
    const last = spans[spans.length - 1];
    if (last && match.index === last.end) last.end = match.index + match[0].length;
    else spans.push({ start: match.index, end: match.index + match[0].length });
  }
  for (const span of spans) {
    const start = span.start;
    const end = span.end;
    const before = source.slice(Math.max(0, start - 14), start);
    const after = source.slice(end, end + 14);
    const insideEnumeration = /[、，,]\s*$/.test(before) && /^\s*(?:[、，,]|等)/.test(after);
    if (!insideEnumeration) return false; // 只要有一处出现在正文里，就不是附带提及
    const window = source.slice(Math.max(0, start - ENUMERATION_WINDOW), end + ENUMERATION_WINDOW);
    const separators = (window.match(/[、，,]/g) || []).length;
    if (separators < ENUMERATION_MIN_SEPARATORS) return false;
  }
  return true;
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

// 兜底句也必须是「句子」：没有句读、只由 UI 标签拼起来的行是页面组件。
// 原先的 `|| sentences[0]` 会把它们当成证据句——「事实要点」印到 PDF 上就变成
// 播放器读数（`Current Time 0:00 Duration 0:34`）、取色器（`Text ColorWhite…`）
// 或分享栏（`发布时间：…【 ：小 中 大】 分享：#### 微信…`）。实测北仑海关、
// 汕头联合执法组、Medicube 三条卡片的「事实要点」都是这样被污染的。
// 一个句子该有句读，或者至少带逗号且有一定长度。
// 「元数据条」不是句子：一串短标签连着排（`发布时间：… 文章来源：… 分享：…`、
// `来源：… 作者：… 责任编辑：…`）。真句子最多带一两个冒号，元数据条是三四个
// 标签值对连着来。这类组件常以句号或逗号收尾，光看句读拦不住——实测北仑海关的
// 分享栏（含「发布」二字，还会误命中事件词）就是靠这条判据挡下的。
const METADATA_LABEL_PATTERN = /[一-龥]{1,8}[:：]/g;
const METADATA_STRIP_MIN_LABELS = 3;
// 英文正文句：ASCII 句号收尾、按空格分词、且足够长。没有这一条，英文来源
// （gov.uk 的 OPSS 通报、Safety Gate）整篇没有一句「像句子」的行，选择层只能
// 退到最靠前的一行带全角标点的内容——而那往往是页尾的 cookie／调研横幅
// （实测 gov.uk 一条印出「To help us improve GOV.UK…fill in this survey」，
// 真正该印的 Hazard 段反而落选）。长度与词数门槛挡 UI 残句：
// 「End of dialog window.」只有 22 字符、4 个词。
const ENGLISH_SENTENCE_MIN_LENGTH = 40;
const ENGLISH_SENTENCE_MIN_WORDS = 6;
const isEnglishSentence = sentence => sentence.length >= ENGLISH_SENTENCE_MIN_LENGTH
  && /\.[\s"')]*$/.test(sentence)
  && (sentence.match(/[A-Za-z]+/g) || []).length >= ENGLISH_SENTENCE_MIN_WORDS;
const SENTENCE_LIKE = sentence => {
  if ((sentence.match(METADATA_LABEL_PATTERN) || []).length >= METADATA_STRIP_MIN_LABELS) return false;
  return /[。；！？]/.test(sentence)
    || (/[，、]/.test(sentence) && sentence.length >= 24)
    || isEnglishSentence(sentence);
};

export function firstEvidenceSentence(value, maxLength = 220) {
  const cleaned = cleanArticleEvidence(value);
  const sentences = cleaned
    .split(/\n+|(?<=[。！？!?；;])\s*/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length >= 16);
  // 三档筛选共用一次谓词求值：SENTENCE_LIKE 现在带标签计数与英文句判定（都会分配数组），
  // 用 find 链会让落选句被重复求值最多三次。
  const scored = sentences.map(sentence => ({
    sentence,
    like: SENTENCE_LIKE(sentence),
    event: EVENT_EVIDENCE_PATTERN.test(sentence),
    generic: GENERIC_INTRO_PATTERN.test(sentence),
  }));
  const selected = (scored.find(row => row.event && !row.generic && row.like)
    || scored.find(row => row.event && row.like)
    || scored.find(row => row.like))?.sentence
    // 找不到像句子的内容就返回空：调用方会退回标题，总好过把页面组件当事实印出去。
    || '';
  return selected ? compactEvidenceText(selected, maxLength) : '';
}
