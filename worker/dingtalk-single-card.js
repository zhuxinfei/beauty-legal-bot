import { buildEditorialReport } from './editorial-report.js';
import { REPORT_MODULES } from './report-quality.js';

export const DINGTALK_REPORT_MODULES = REPORT_MODULES;

const encoder = new TextEncoder();

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

function joined(value, limit, count = 2) {
  return (Array.isArray(value) ? value : [value])
    .map(item => compactText(item, limit))
    .filter(Boolean)
    .slice(0, count)
    .join('；');
}

function riskLabel(value) {
  if (value === 'high') return '高风险';
  if (value === 'medium') return '中风险';
  return '一般关注';
}

function sourceLink(item) {
  const title = markdownText(item.source_name || item.title || '查看原文', 60);
  const url = String(item.source_url || '').trim();
  return /^https?:\/\//i.test(url) ? `[${title}](${url})` : title;
}

function renderManagementSummary(editorial) {
  if (!editorial.management_conclusions.length) return [];
  return [
    '',
    '## 管理层摘要',
    ...editorial.management_conclusions.map((item, index) => `${index + 1}. ${markdownText(item, 220)}`),
  ];
}

function renderSourceIndex(editorial, removed) {
  const items = editorial.sections.flatMap(section => section.items).filter(item => !removed.has(item.number));
  if (!items.length) return [];
  return [
    '',
    '## 来源索引',
    ...items.map(item => `${item.number}. ${sourceLink(item)}｜${markdownText(item.title, 80)}｜${markdownText(item.published_at, 16)}`),
  ];
}

function renderEditorialItem(item, tier = 'full') {
  const compact = tier === 'compact';
  if (tier === 'minimal') {
    return [
      `#### ${item.number}. ${markdownText(item.title, 60)}`,
      `- **摘要**：${markdownText(item.summary, 100)}`,
      `- **来源**：${sourceLink(item)}｜${markdownText(item.published_at, 16)}`,
    ].join('\n');
  }
  const lines = [
    `#### ${item.number}. ${markdownText(item.title, compact ? 70 : 110)}`,
    `> ${markdownText(item.country, 20)}｜${riskLabel(item.risk_level)}｜${item.report_tier === 'watch' ? '持续观察' : '行动事项'}`,
    `- **摘要**：${markdownText(item.summary, compact ? 150 : 260)}`,
  ];
  const facts = joined(item.facts, compact ? 100 : 180, compact ? 1 : 2);
  const legal = joined(item.legal_analysis, compact ? 100 : 180, compact ? 1 : 2);
  const results = joined(item.results, compact ? 90 : 160, compact ? 1 : 2);
  const insights = joined(item.practical_insights, compact ? 90 : 150, compact ? 1 : 2);
  const impact = joined(item.business_impact, 45, compact ? 2 : 4);
  if (facts) lines.push(`- **事实摘要**：${markdownText(facts)}`);
  if (legal) lines.push(`- **法务研判**：${markdownText(legal)}`);
  if (results) lines.push(`- **处理结果**：${markdownText(results)}`);
  if (insights) lines.push(`- **${markdownText(item.practical_label || '执行提示', 20)}**：${markdownText(insights)}`);
  if (impact) lines.push(`- **业务影响**：${markdownText(impact)}`);
  if (item.statutory_date && item.statutory_date !== '未知') {
    lines.push(`- **法定节点**：${markdownText(item.statutory_date, 40)}`);
  }
  if (item.report_tier === 'watch') {
    lines.push(`- **关注价值**：${markdownText(item.watch_value || item.why_it_matters, compact ? 110 : 190)}`);
    lines.push(`- **下一观察点**：${markdownText(item.next_watch_signal, compact ? 100 : 170)}`);
  } else {
    const action = joined(item.recommended_actions, compact ? 100 : 170, compact ? 1 : 2);
    if (action) lines.push(`- **建议动作**：${markdownText(action)}`);
    const owners = joined(item.owner_teams, 20, 4);
    if (owners) lines.push(`- **责任团队**：${markdownText(owners, 80)}｜**完成时间**：由责任领导确定`);
  }
  lines.push(`- **来源**：${sourceLink(item)}｜${markdownText(item.published_at, 16)}`);
  return lines.join('\n');
}

function renderFallbackBody(editorial, tiers, removed) {
  const lines = ['', '## 资讯正文'];
  for (const section of editorial.sections) {
    const items = section.items.filter(item => !removed.has(item.number));
    if (!items.length) continue;
    lines.push('', `### ${section.module}`);
    for (const item of items) lines.push(renderEditorialItem(item, tiers.get(item.number) || 'full'));
  }
  return lines;
}

function renderMessage(editorial, { imageUrl, tiers, removed }) {
  const lines = [`# 美妆法务资讯｜${editorial.period?.end || '本期'}`];
  if (!editorial.item_count) {
    lines.push(
      '',
      '## 本期结论',
      '本期无重大合规更新。六大板块已完成监测，暂未发现达到行动或持续观察准入标准的新事项。',
      '',
      '> 公开来源可核验；仅供内部合规研判，不替代正式法律意见。',
    );
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  lines.push(...renderManagementSummary(editorial));
  if (imageUrl) {
    lines.push('', `![美妆法务资讯长图](${imageUrl})`, '', `[查看高清原图](${imageUrl})`);
    lines.push(...renderSourceIndex(editorial, removed));
  } else {
    lines.push(...renderFallbackBody(editorial, tiers, removed));
  }
  lines.push('', '## 本期结论', markdownText(editorial.final_synthesis, 240));
  if (removed.size) lines.push('', `> 受消息长度限制，已省略 ${removed.size} 条低优先级事项；来源原文仍保留在采集存档中。`);
  lines.push('', '> 公开来源可核验；仅供内部合规研判，不替代正式法律意见。');
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

export function buildSingleDingTalkMessage(report, {
  imageUrl = '',
  maxBytes = 18000,
} = {}) {
  const byteLimit = Math.max(1200, Number(maxBytes || 18000));
  const editorial = buildEditorialReport(report);
  const items = editorial.sections.flatMap(section => section.items);
  const tiers = new Map(items.map(item => [item.number, 'full']));
  const removed = new Set();
  const build = () => renderMessage(editorial, { imageUrl, tiers, removed });
  let markdown = build();

  const lowPriorityFirst = [...items].sort((a, b) => {
    const aChina = a.country === '中国' ? 1 : 0;
    const bChina = b.country === '中国' ? 1 : 0;
    return aChina - bChina || a.quality_score - b.quality_score || b.number - a.number;
  });

  if (!imageUrl) {
    for (const item of lowPriorityFirst) {
      if (utf8Bytes(markdown) <= byteLimit) break;
      tiers.set(item.number, 'compact');
      markdown = build();
    }
  }

  let remaining = items.length;
  for (const item of lowPriorityFirst) {
    if (utf8Bytes(markdown) <= byteLimit) break;
    if (remaining <= 1) break;
    removed.add(item.number);
    remaining -= 1;
    markdown = build();
  }

  if (!imageUrl && utf8Bytes(markdown) > byteLimit) {
    const retained = items.find(item => !removed.has(item.number));
    if (retained) {
      tiers.set(retained.number, 'minimal');
      markdown = build();
    }
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
