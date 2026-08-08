const MARKDOWN_TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const PAGE_CONTROL_PATTERN = /(?:下载|打印|关闭窗口|字体(?:大小)?|字号|分享到(?:新浪微博|QQ空间|微信|微博)|分享至(?:新浪微博|QQ空间|微信|微博)|收藏本站|返回顶部|视窗|最小化|最大化|还原|loading\.{3}|无障碍|关怀版|繁體|简体|EN(?:\s*$)|扫一扫|复制链接|打开适老|聽|请听|我在听|说话\(|網站地圖)/gi;
const PAGE_SHELL_PATTERN = /^(?:网站首页|首页|主页|当前位置|导航|站点导航|机构概况|信息公开|办事大厅|新闻中心|通知公告|联系我们|登录|注册|搜索|高级检索|友情链接|上一页|下一页|English|Home|Menu|X\b|用户空间|海关电邮|守国门|促发展)(?:\s|[>＞|｜:：/·-]|$)/i;
const EVENT_EVIDENCE_PATTERN = /(?:发布|公布|公告|通告|通报|征求意见|实施|生效|处罚|罚款|罚没|没收|召回|停止销售|抽检|不合格|判决|裁定|侵权|冒用|假冒|商标|专利|著作权|虚假宣传|功效宣称|平台治理|专项治理|治理公告|海关|关税|报关|清关|进口|出口|标准|法规|条例|办法|规定|备案|注册)/i;
const NAVIGATION_TOKEN_PATTERN = /新闻发布厅|时政要闻|媒体聚焦|快捷检索|高级检索|友情链接|返回顶部|上一篇|下一篇|机构|新闻|政务|服务|互动|专题|总局|司局|地方|图片|视频|当|好|让|党|放心/gi;
const SUBSTANTIVE_ACTION_PATTERN = /发布|公布|通报|征求意见|实施|生效|处罚|罚款|罚没|没收|召回|停止销售|抽检|不合格|判决|裁定|侵权|虚假宣传|功效宣称|平台治理|专项治理|调整|修订|要求|决定/;

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
  const navigationHits = line.match(NAVIGATION_TOKEN_PATTERN)?.length || 0;
  const withoutNavigationLabels = line.replace(NAVIGATION_TOKEN_PATTERN, ' ');
  if (navigationHits >= 2 && !SUBSTANTIVE_ACTION_PATTERN.test(withoutNavigationLabels)) return '';
  if (/^[\p{P}\p{S}\s]+$/u.test(line)) return '';
  if (/^(?:新浪微博|QQ空间|微信|微博|复制链接)(?:\s+(?:新浪微博|QQ空间|微信|微博|复制链接))*$/i.test(line)) return '';
  return line;
}

export function cleanArticleEvidence(value) {
  const lines = plainText(value)
    .split(/\n+/)
    .map(cleanLine)
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
