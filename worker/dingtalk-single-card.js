export const DINGTALK_REPORT_MODULES = [
  '广告合规及处罚案例',
  '美妆动态',
  '知识产权动态',
  '新规及案例动态',
  '进出口动态',
  '产品质量/召回与安全风险',
];

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
  return value === 'high' ? '高风险' : value === 'medium' ? '中风险' : '一般风险';
}

function itemScore(item) {
  return (item.country === '中国' ? 1000 : 0)
    + (item.risk_level === 'high' ? 100 : item.risk_level === 'medium' ? 50 : 10)
    + (item.industry_impact === 'high' ? 40 : item.industry_impact === 'medium' ? 20 : 5)
    + (item.relevance === 'direct' ? 30 : 0)
    + (item.confidence === 'high' ? 20 : item.confidence === 'medium' ? 10 : 0);
}

function itemJudgement(item) {
  const candidates = [
    item.what_changed,
    item.violation_logic,
    item.regulatory_signal,
    item.compliance_meaning,
    item.why_it_matters,
    item.facts,
  ];
  const value = candidates.find(candidate => Array.isArray(candidate)
    ? candidate.some(Boolean)
    : String(candidate || '').trim());
  return Array.isArray(value) ? value.filter(Boolean).join('；') : String(value || '需结合原文评估具体合规影响。');
}

function itemImpact(item) {
  const impacts = Array.isArray(item.business_impact) ? item.business_impact.filter(Boolean) : [];
  return impacts.join('；') || item.affected_business || item.why_it_matters || '待结合法务与业务范围判断。';
}

function itemAction(item) {
  const actions = Array.isArray(item.recommended_actions) ? item.recommended_actions.filter(Boolean) : [];
  return actions[0] || '核验原文，并判断是否需要更新内部合规清单。';
}

function sourceLink(item) {
  const title = markdownText(item.title || '未命名事项');
  const url = String(item.source_url || '').trim();
  return /^https?:\/\//i.test(url) ? `[${title}](${url})` : title;
}

function renderItem(item, tier, index) {
  const meta = [item.country || item.region || '全球', riskLabel(item.risk_level)].filter(Boolean).join('｜');
  if (tier === 'index') return `${index}. ${sourceLink(item)} · ${meta}`;
  if (tier === 'compact') {
    return [
      `### ${index}. ${sourceLink(item)}`,
      `> ${meta}｜判断：${markdownText(compactText(itemJudgement(item), 90))}`,
      `- **行动**：${markdownText(compactText(itemAction(item), 72))}`,
    ].join('\n');
  }
  return [
    `### ${index}. ${sourceLink(item)}`,
    `> ${meta}${item.relevance === 'direct' ? '｜直接相关' : ''}`,
    `- **核心判断**：${markdownText(compactText(itemJudgement(item), 150))}`,
    `- **业务影响**：${markdownText(compactText(itemImpact(item), 110))}`,
    `- **建议行动**：${markdownText(compactText(itemAction(item), 100))}`,
  ].join('\n');
}

function normalizedSections(report) {
  const byModule = new Map((report.sections || []).map(section => [section.module, section.items || []]));
  return DINGTALK_REPORT_MODULES.map((module, moduleIndex) => ({
    module,
    moduleIndex,
    items: [...(byModule.get(module) || [])]
      .sort((a, b) => itemScore(b) - itemScore(a) || String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN')),
  }));
}

function renderMessage(report, sections, tiers, removed, { imageUrl, omittedItemCount }) {
  const itemCount = sections.reduce((sum, section) => sum + section.items.length, 0);
  const date = report.period?.end || '本期';
  const chinaItems = sections.flatMap(section => section.items).filter(item => item.country === '中国').slice(0, 3);
  const lines = [`# 美妆法务资讯｜${date}`];
  if (imageUrl) lines.push('', `![管理层行动看板](${imageUrl})`);
  if (chinaItems.length) {
    lines.push('', '## 中国监管重点', ...chinaItems.map((item, index) => `${index + 1}. ${sourceLink(item)}`));
  }
  if (omittedItemCount > 0) {
    lines.push('', `> 受单卡上限影响，另有 ${omittedItemCount} 条低优先级事项未展开；高风险、中国事项和来源链接优先保留。`);
  }

  let displayIndex = 0;
  for (const section of sections) {
    lines.push('', `## M${section.moduleIndex + 1} ${section.module}`);
    const visibleItems = section.items.filter(item => !removed.has(item.__cardId));
    if (!visibleItems.length) {
      lines.push(section.items.length ? '- 本模块低优先级事项未在单卡中展开。' : '- 本周无高置信更新。');
      continue;
    }
    for (const item of visibleItems) {
      displayIndex += 1;
      lines.push(renderItem(item, tiers.get(item.__cardId) || 'index', displayIndex));
    }
  }

  lines.push('', '> 数据口径：仅纳入可核验公开来源；本报告用于内部合规研判，不替代正式法律意见。');
  return lines.join('\n');
}

/**
 * 把完整周报压入一个钉钉 Markdown 字节预算。
 * 压缩只改变展示深度，不改变中国优先和风险排序；只有最后一级才移除最低评分条目，并明确披露数量。
 */
export function buildSingleDingTalkMessage(report, {
  imageUrl = '',
  maxBytes = 18000,
} = {}) {
  const byteLimit = Math.max(1200, Number(maxBytes || 18000));
  const sections = normalizedSections(report).map(section => ({
    ...section,
    items: section.items.map((item, itemIndex) => ({ ...item, __cardId: `${section.moduleIndex}:${itemIndex}` })),
  }));
  const allItems = sections.flatMap(section => section.items);
  const tiers = new Map(allItems.map(item => [
    item.__cardId,
    item.country === '中国' || item.risk_level === 'high' ? 'full' : 'compact',
  ]));
  const removed = new Set();

  const build = () => renderMessage(report, sections, tiers, removed, {
    imageUrl,
    omittedItemCount: removed.size,
  });
  let markdown = build();

  for (const targetTier of ['compact', 'index']) {
    if (utf8Bytes(markdown) <= byteLimit) break;
    for (const item of [...allItems].sort((a, b) => itemScore(a) - itemScore(b))) {
      const current = tiers.get(item.__cardId);
      if ((targetTier === 'compact' && current === 'full') || (targetTier === 'index' && current !== 'index')) {
        tiers.set(item.__cardId, targetTier);
        markdown = build();
        if (utf8Bytes(markdown) <= byteLimit) break;
      }
    }
  }

  if (utf8Bytes(markdown) > byteLimit) {
    for (const item of [...allItems].sort((a, b) => itemScore(a) - itemScore(b))) {
      removed.add(item.__cardId);
      markdown = build();
      if (utf8Bytes(markdown) <= byteLimit) break;
    }
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
