import { buildEditorialReport } from './editorial-report.js';
import { buildPremiumDingTalkMessages } from './premium-quality.js';

export const DINGTALK_REPORT_MODULES = ['新法律法规政策', '广告处罚案例', '知识产权保护与侵权', '进出口', '行业新闻简讯'];

const encoder = new TextEncoder();
const EMPHASIS_PATTERN = [
  String.raw`20\d{2}年\d{1,2}月\d{1,2}日`,
  String.raw`20\d{2}[-/.]\d{1,2}[-/.]\d{1,2}`,
  String.raw`\d+(?:\.\d+)?(?:万|亿)?元`,
  String.raw`\d+(?:\.\d+)?%`,
  '停止生产经营',
  '责令停止',
  '停止销售',
  '暂停销售',
  '禁止销售',
  '刑事责任',
  '处罚风险',
  '召回风险',
  '准入风险',
  '合规风险',
  '必须',
  '不得',
  '应当',
  '禁止',
  '召回',
  '下架',
  '罚款',
  '吊销',
  '撤销',
  '生效',
  '截止',
].join('|');

function utf8Bytes(value) {
  return encoder.encode(String(value || '')).length;
}

function compactText(value, limit = 500) {
  const result = String(value || '').replace(/\s+/g, ' ').trim();
  return result.length > limit ? `${result.slice(0, Math.max(1, limit - 1))}…` : result;
}

function markdownText(value, limit = 500) {
  return compactText(value, limit).replace(/[\[\]]/g, '').replace(/\|/g, '｜');
}

function emphasizeText(value, limit = 500, maxHighlights = 3) {
  const text = markdownText(value, limit).replace(/\*\*/g, '');
  let highlights = 0;
  return text.replace(new RegExp(`(${EMPHASIS_PATTERN})`, 'g'), match => {
    if (highlights >= maxHighlights) return match;
    highlights += 1;
    return `**${match}**`;
  });
}

function listItems(value, limit, count = 2) {
  return (Array.isArray(value) ? value : [value])
    .map(item => compactText(item, limit))
    .filter(Boolean)
    .slice(0, count);
}

function pushListField(lines, label, value, limit, count = 2, emphasize = false) {
  const items = listItems(value, limit, count);
  if (!items.length) return;
  const renderItem = emphasize ? emphasizeText : markdownText;
  lines.push(`- **${markdownText(label, 20)}**`, ...items.map(item => `  - ${renderItem(item, limit)}`));
}

function sourceLink(item) {
  const title = markdownText(item.source_name || item.title || '查看原文', 60);
  const url = String(item.source_url || '').trim();
  return /^https?:\/\//i.test(url) ? `[${title}](${url})` : title;
}

export function splitConclusionPoints(value, maxPoints = 5) {
  const text = markdownText(value);
  if (!text) return [];

  const sentences = text.match(/[^。；！？]+[。；！？]?/g) || [text];
  const actionStarts = '(?:更新|建立|完善|核验|跟踪|评估|审查|留存)';
  const points = sentences
    .flatMap(sentence => sentence
      .trim()
      .split(new RegExp(`，(?=(?:同时|优先|先|再|应|需|建议|由))|(?=并${actionStarts})`)))
    .map(point => point.trim().replace(new RegExp(`^并(?=${actionStarts})`), ''))
    .filter(Boolean)
    .map(point => /[。！？]$/.test(point) ? point : `${point.replace(/[；，]$/, '')}。`);

  if (points.length <= maxPoints) return points;
  return [...points.slice(0, maxPoints - 1), points.slice(maxPoints - 1).join('')];
}

function renderEditorialItem(item, tier = 'full') {
  const compact = tier === 'compact';
  const minimal = tier === 'minimal';
  const lines = [`#### ${item.number}. ${markdownText(item.title, minimal ? 60 : compact ? 80 : 110)}`];
  pushListField(lines, '事实摘要', item.facts, minimal ? 90 : compact ? 120 : 200, minimal || compact ? 1 : 2, true);
  pushListField(lines, '下一步观察建议', item.observation, minimal ? 80 : compact ? 110 : 180, minimal || compact ? 1 : 2, true);
  lines.push('- **来源链接**', `  - ${sourceLink(item)}`);
  return lines.join('\n');
}

function renderFallbackBody(editorial, tiers, removed) {
  const lines = [];
  for (const section of editorial.sections) {
    const items = section.items.filter(item => !removed.has(item.number));
    if (!items.length) continue;
    lines.push('', `### ${section.module}`);
    for (const item of items) lines.push(renderEditorialItem(item, tiers.get(item.number) || 'full'));
  }
  return lines;
}

function renderMessage(editorial, { tiers, removed }) {
  const lines = [`# 美妆法务资讯｜${editorial.period?.end || '本期'}`];
  if (!editorial.item_count) {
    lines.push('', '本期五个重点板块未发现达到准入标准的新事项。');
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  lines.push(...renderFallbackBody(editorial, tiers, removed));
  if (removed.size) lines.push('', `> 受消息长度限制，已省略 ${removed.size} 条低优先级事项；来源原文仍保留在采集存档中。`);
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildSingleDingTalkMessage(report, {
  maxBytes = 18000,
} = {}) {
  const byteLimit = Math.max(1200, Number(maxBytes || 18000));
  const editorial = buildEditorialReport(report);
  const items = editorial.sections.flatMap(section => section.items);
  const tiers = new Map(items.map(item => [item.number, 'full']));
  const removed = new Set();
  const build = () => renderMessage(editorial, { tiers, removed });
  let markdown = build();

  const lowPriorityFirst = [...items].sort((a, b) => {
    const aChina = a.country === '中国' ? 1 : 0;
    const bChina = b.country === '中国' ? 1 : 0;
    return aChina - bChina || a.quality_score - b.quality_score || b.number - a.number;
  });

  for (const item of lowPriorityFirst) {
    if (utf8Bytes(markdown) <= byteLimit) break;
    tiers.set(item.number, 'compact');
    markdown = build();
  }

  if (utf8Bytes(markdown) > byteLimit) {
    for (const item of items) tiers.set(item.number, 'minimal');
    markdown = build();
  }

  const bytes = utf8Bytes(markdown);
  if (bytes > byteLimit) throw new Error(`Minimum DingTalk report exceeds byte budget: ${bytes}/${byteLimit}`);
  return {
    id: 'weekly-report',
    title: `美妆法务资讯｜${editorial.period?.end || '本期'}`,
    markdown,
    bytes,
    itemCount: editorial.item_count,
    displayedItemCount: editorial.item_count - removed.size,
    omittedItemCount: removed.size,
  };
}

function messageFromEditorial(editorial, byteLimit, index, total) {
  const items = editorial.sections.flatMap(section => section.items);
  const tiers = new Map(items.map(item => [item.number, 'full']));
  const removed = new Set();
  let markdown = renderMessage(editorial, { tiers, removed });
  if (utf8Bytes(markdown) > byteLimit) {
    for (const item of items) tiers.set(item.number, 'compact');
    markdown = renderMessage(editorial, { tiers, removed });
  }
  if (utf8Bytes(markdown) > byteLimit) {
    for (const item of items) tiers.set(item.number, 'minimal');
    markdown = renderMessage(editorial, { tiers, removed });
  }
  if (utf8Bytes(markdown) > byteLimit) throw new Error(`DingTalk report segment exceeds byte budget: ${utf8Bytes(markdown)}/${byteLimit}`);
  return {
    id: total > 1 ? `weekly-report-${index + 1}` : 'weekly-report',
    title: `美妆法务资讯｜${editorial.period?.end || '本期'}${total > 1 ? `（${index + 1}/${total}）` : ''}`,
    markdown,
    bytes: utf8Bytes(markdown),
    itemCount: items.length,
    displayedItemCount: items.length,
  };
}

export function buildDingTalkMessages(report, { maxBytes = 18000 } = {}) {
  const byteLimit = Math.max(1200, Number(maxBytes || 18000));
  if (report?.premium_delivery === true) {
    const premiumMessages = buildPremiumDingTalkMessages(report, { maxBytes: byteLimit });
    return premiumMessages.length ? premiumMessages : [{
      id: 'weekly-report',
      title: `美妆法务资讯｜${report.period?.end || '本期'}`,
      markdown: `# 美妆法务资讯精品卡\n\n周期：${report.period?.start || ''} 至 ${report.period?.end || ''}\n\n本期没有达到精品证据门槛的事项，宁缺毋滥。\n`,
      bytes: 0,
      itemCount: 0,
      displayedItemCount: 0,
    }];
  }
  try {
    return [buildSingleDingTalkMessage(report, { maxBytes: byteLimit })];
  } catch {}

  const editorial = buildEditorialReport(report);
  const chunks = [];
  let current = [];
  const renderSize = sections => utf8Bytes(renderMessage({ ...editorial, sections, item_count: sections.reduce((sum, section) => sum + section.items.length, 0) }, {
    tiers: new Map(sections.flatMap(section => section.items).map(item => [item.number, 'minimal'])),
    removed: new Set(),
  }));

  for (const section of editorial.sections) {
    const candidate = [...current, section];
    if (current.length && renderSize(candidate) > byteLimit) {
      chunks.push(current);
      current = [];
    }
    if (renderSize([section]) <= byteLimit) {
      current.push(section);
      continue;
    }
    let itemChunk = [];
    for (const item of section.items) {
      const next = [...itemChunk, item];
      const partial = [{ ...section, items: next }];
      if (itemChunk.length && renderSize(partial) > byteLimit) {
        chunks.push([{ ...section, items: itemChunk }]);
        itemChunk = [item];
      } else {
        itemChunk = next;
      }
    }
    if (itemChunk.length) chunks.push([{ ...section, items: itemChunk }]);
  }
  if (current.length) chunks.push(current);
  return chunks.map((sections, index) => messageFromEditorial({
    ...editorial,
    sections,
    item_count: sections.reduce((sum, section) => sum + section.items.length, 0),
  }, byteLimit, index, chunks.length));
}
