import {
  REPORT_MODULES,
  curateReportQuality,
  rankReportQualityItem,
  summarizeExecutiveReport,
} from './report-quality.js';

export const DINGTALK_REPORT_MODULES = REPORT_MODULES;

const encoder = new TextEncoder();

function utf8Bytes(value) {
  return encoder.encode(String(value || '')).length;
}

function compactText(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text;
}

function markdownText(value) {
  return compactText(value, 500).replace(/[\[\]]/g, '').replace(/\|/g, '｜');
}

function riskLabel(value) {
  if (value === 'high') return '高风险';
  if (value === 'medium') return '中风险';
  return '';
}

function joined(value) {
  return Array.isArray(value) ? value.filter(Boolean).join('；') : String(value || '');
}

function itemJudgement(item) {
  return joined(item.core_judgement)
    || joined(item.what_changed)
    || joined(item.violation_logic)
    || joined(item.regulatory_signal)
    || joined(item.compliance_meaning)
    || joined(item.why_it_matters)
    || '需结合原文评估具体合规影响。';
}

function itemImpact(item) {
  return joined(item.business_impact)
    || joined(item.affected_business)
    || joined(item.why_it_matters)
    || '待结合法务与业务范围判断。';
}

function itemAction(item) {
  return (item.recommended_actions || []).find(Boolean)
    || '建议责任团队核验原文并判断是否更新内部合规清单。';
}

function sourceLink(item) {
  const title = markdownText(item.source_name || item.title || '查看原文');
  const url = String(item.source_url || '').trim();
  return /^https?:\/\//i.test(url) ? `[${title}](${url})` : title;
}

function renderActionItem(item, tier, index) {
  const meta = [item.country || item.region || '全球', riskLabel(item.risk_level)].filter(Boolean).join('｜');
  if (tier === 'compact') {
    return [
      `#### ${index}. ${markdownText(item.title || '未命名事项')}`,
      meta ? `> ${meta}` : '',
      `- **核心判断**：${markdownText(compactText(itemJudgement(item), 120))}`,
      `- **建议行动**：${markdownText(compactText(itemAction(item), 90))}`,
      `- **来源**：${sourceLink(item)}`,
    ].filter(Boolean).join('\n');
  }
  return [
    `#### ${index}. ${markdownText(item.title || '未命名事项')}`,
    meta ? `> ${meta}` : '',
    `- **核心判断**：${markdownText(compactText(itemJudgement(item), 170))}`,
    `- **业务影响**：${markdownText(compactText(itemImpact(item), 120))}`,
    `- **建议行动**：${markdownText(compactText(itemAction(item), 110))}`,
    `- **来源**：${sourceLink(item)}`,
  ].filter(Boolean).join('\n');
}

function prepareReport(report) {
  const items = (report.sections || []).flatMap(section => section.items || []);
  return items.every(item => ['action', 'watch'].includes(item.report_tier) && Number.isFinite(item.quality_score))
    ? report
    : curateReportQuality(report);
}

function normalizedSections(report) {
  const byModule = new Map((report.sections || []).map(section => [section.module, section.items || []]));
  return REPORT_MODULES.map((module, moduleIndex) => ({
    module,
    moduleIndex,
    items: [...(byModule.get(module) || [])]
      .sort((a, b) => rankReportQualityItem(b) - rankReportQualityItem(a)),
  }));
}

function renderMessage(report, sections, tiers, removed, { imageUrl, omittedItemCount }) {
  const executive = summarizeExecutiveReport(report);
  const lines = [`# 美妆法务资讯｜${report.period?.end || '本期'}`];
  if (imageUrl) lines.push('', `![行动看板](${imageUrl})`);

  if (executive.judgements.length) {
    lines.push('', '## 本周核心判断');
    executive.judgements.forEach((item, index) => {
      lines.push(`${index + 1}. ${markdownText(compactText(item.text, 180))}`);
    });
  }

  if (executive.actions.length) {
    lines.push('', '## 优先行动');
    executive.actions.forEach((action, index) => {
      const meta = [riskLabel(action.risk_level), action.owners.join('、') || '法务'].filter(Boolean).join('｜');
      lines.push(
        `### P${index + 1}｜${markdownText(action.title)}`,
        meta ? `> ${meta}` : '',
        `- **动作**：${markdownText(compactText(action.text, 110))}`,
        `- **时间**：由责任领导确定`,
        `- **来源**：${sourceLink(action)}`,
      );
    });
  }

  const activeSections = sections
    .map(section => ({
      ...section,
      items: section.items.filter(item => item.report_tier === 'action' && !removed.has(item.__cardId)),
    }))
    .filter(section => section.items.length);
  if (activeSections.length) lines.push('', '## 重点事项');
  let displayIndex = 0;
  for (const section of activeSections) {
    lines.push('', `### ${section.module}`);
    for (const item of section.items) {
      displayIndex += 1;
      lines.push(renderActionItem(item, tiers.get(item.__cardId) || 'full', displayIndex));
    }
  }

  const watchItems = sections
    .flatMap(section => section.items)
    .filter(item => item.report_tier === 'watch' && !removed.has(item.__cardId))
    .sort((a, b) => rankReportQualityItem(b) - rankReportQualityItem(a))
    .slice(0, 3);
  if (watchItems.length) {
    lines.push('', '## 持续观察');
    watchItems.forEach(item => lines.push(
      `### ${markdownText(item.title || '行业动态')}`,
      `- **发生了什么**：${markdownText(compactText(item.core_judgement, 120))}`,
      `- **关注价值**：${markdownText(compactText(item.watch_value, 100))}`,
      `- **下一观察点**：${markdownText(compactText(item.next_watch_signal, 100))}`,
      `- **来源**：${sourceLink(item)}`,
    ));
  }

  if (omittedItemCount > 0) lines.push('', `> 已省略 ${omittedItemCount} 条低优先级事项。`);
  lines.push('', '> 公开来源可核验；仅供内部合规研判，不替代正式法律意见。');
  return lines.filter(line => line !== '').join('\n\n');
}

export function buildSingleDingTalkMessage(inputReport, {
  imageUrl = '',
  maxBytes = 18000,
} = {}) {
  const byteLimit = Math.max(1200, Number(maxBytes || 18000));
  const report = prepareReport(inputReport);
  const sections = normalizedSections(report).map(section => ({
    ...section,
    items: section.items.map((item, itemIndex) => ({
      ...item,
      __cardId: `${section.moduleIndex}:${itemIndex}`,
    })),
  }));
  const allItems = sections.flatMap(section => section.items);
  const actionItems = allItems.filter(item => item.report_tier === 'action');
  const watchItems = allItems.filter(item => item.report_tier === 'watch');
  const protectedIds = new Set(
    [...actionItems]
      .sort((a, b) => rankReportQualityItem(b) - rankReportQualityItem(a))
      .slice(0, 3)
      .map(item => item.__cardId),
  );
  const tiers = new Map(actionItems.map(item => [item.__cardId, 'full']));
  const removed = new Set();
  const build = () => renderMessage(report, sections, tiers, removed, {
    imageUrl,
    omittedItemCount: removed.size,
  });
  let markdown = build();

  for (const item of [...watchItems].sort((a, b) => rankReportQualityItem(a) - rankReportQualityItem(b))) {
    if (utf8Bytes(markdown) <= byteLimit) break;
    removed.add(item.__cardId);
    markdown = build();
  }

  for (const item of [...actionItems].sort((a, b) => rankReportQualityItem(a) - rankReportQualityItem(b))) {
    if (utf8Bytes(markdown) <= byteLimit) break;
    if (protectedIds.has(item.__cardId)) continue;
    tiers.set(item.__cardId, 'compact');
    markdown = build();
  }

  for (const item of [...actionItems].sort((a, b) => rankReportQualityItem(a) - rankReportQualityItem(b))) {
    if (utf8Bytes(markdown) <= byteLimit) break;
    if (protectedIds.has(item.__cardId)) continue;
    removed.add(item.__cardId);
    markdown = build();
  }

  for (const item of [...actionItems].sort((a, b) => rankReportQualityItem(a) - rankReportQualityItem(b))) {
    if (utf8Bytes(markdown) <= byteLimit) break;
    tiers.set(item.__cardId, 'compact');
    markdown = build();
  }

  for (const item of [...actionItems].sort((a, b) => rankReportQualityItem(a) - rankReportQualityItem(b))) {
    if (utf8Bytes(markdown) <= byteLimit) break;
    removed.add(item.__cardId);
    markdown = build();
  }

  const bytes = utf8Bytes(markdown);
  if (bytes > byteLimit) throw new Error(`Minimum DingTalk report exceeds byte budget: ${bytes}/${byteLimit}`);
  return {
    id: 'weekly-report',
    title: `美妆法务资讯｜${report.period?.end || '本期'}`,
    markdown,
    bytes,
    itemCount: allItems.length,
    displayedItemCount: allItems.length - removed.size,
    omittedItemCount: removed.size,
  };
}
