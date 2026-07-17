import { buildEditorialReport } from './editorial-report.js';

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function list(values) {
  const items = (Array.isArray(values) ? values : [values]).filter(Boolean);
  return items.length ? `<ul>${items.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : '';
}

function field(label, values, className = '') {
  const content = list(values);
  return content ? `<div class="field ${className}"><div class="field-label">${escapeHtml(label)}</div>${content}</div>` : '';
}

function riskText(level) {
  if (level === 'high') return '高风险';
  if (level === 'medium') return '中风险';
  return '一般关注';
}

function renderItem(item) {
  const action = item.report_tier === 'watch'
    ? `${field('关注价值', item.watch_value)}${field('下一观察点', item.next_watch_signal)}`
    : `${field('建议动作', item.recommended_actions, 'action')}
       <div class="ownership"><strong>责任团队</strong> ${escapeHtml(item.owner_teams.join('、') || '法务')}<span></span><strong>完成时间</strong> 由责任领导确定</div>`;
  return `<article class="news-item" data-item-number="${item.number}">
    <div class="item-topline">
      <span class="item-number">${String(item.number).padStart(2, '0')}</span>
      <span class="item-meta">${escapeHtml(item.country)} / ${escapeHtml(item.type)} / ${escapeHtml(item.report_tier === 'watch' ? '持续观察' : '行动事项')}</span>
      <span class="risk risk-${escapeHtml(item.risk_level)}">${riskText(item.risk_level)}</span>
    </div>
    <h3>${escapeHtml(item.title)}</h3>
    <div class="summary"><span>摘要</span>${escapeHtml(item.summary)}</div>
    ${field('事实摘要', item.facts)}
    ${field('法务研判', item.legal_analysis)}
    ${field('处理结果', item.results)}
    ${field(item.practical_label || '执行提示', item.practical_insights)}
    ${field('业务影响', item.business_impact)}
    ${item.statutory_date && item.statutory_date !== '未知' ? `<div class="date-line"><strong>法定节点</strong> ${escapeHtml(item.statutory_date)}</div>` : ''}
    ${action}
    <div class="source-line">来源 ${escapeHtml(item.source_name)} <span></span> ${escapeHtml(item.published_at)}</div>
  </article>`;
}

function renderSection(section) {
  return `<section class="module-section">
    <div class="module-heading"><h2>${escapeHtml(section.module)}</h2><div></div></div>
    ${section.items.map(renderItem).join('')}
  </section>`;
}

export function buildEditorialReportHtml(inputReport, { generatedAt = '' } = {}) {
  const report = buildEditorialReport(inputReport);
  const period = [report.period?.start, report.period?.end].filter(Boolean).join(' 至 ') || '本期';
  const generated = generatedAt ? String(generatedAt).replace('T', ' ').slice(0, 16) : '';
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>国际美妆法务资讯周报</title>
<style>
:root {
  --page-width: 1080px;
  --ink: #172033;
  --muted: #5f6b7a;
  --line: #d9e0e8;
  --surface: #ffffff;
  --canvas: #f2f4f7;
  --accent: #155eef;
  --accent-soft: #eaf0ff;
  --warning: #b54708;
  --danger: #b42318;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; width: var(--page-width); background: var(--canvas); }
body {
  color: var(--ink);
  font-family: "Noto Sans CJK SC", "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 36px;
  line-height: 1.58;
  letter-spacing: 0;
  -webkit-font-smoothing: antialiased;
}
.report { width: var(--page-width); padding: 40px 42px 52px; }
.masthead {
  padding: 54px 56px 50px;
  background: var(--accent-soft);
  border: 1px solid #cedafa;
  border-radius: 8px;
}
.eyebrow { display: inline-block; padding: 8px 18px; border-radius: 6px; background: var(--accent); color: #fff; font-size: 25px; font-weight: 700; }
h1 { margin: 26px 0 8px; font-size: 58px; line-height: 1.2; font-weight: 800; }
.period { color: #3157a4; font-size: 29px; font-weight: 700; }
.scope { margin-top: 16px; color: var(--muted); font-size: 25px; }
.executive { padding: 42px 12px 30px; }
.executive h2, .module-heading h2 { margin: 0; font-size: 40px; line-height: 1.3; }
.executive ol { margin: 22px 0 0; padding-left: 52px; }
.executive li { margin: 12px 0; padding-left: 8px; font-weight: 600; }
.module-section { margin-top: 34px; }
.module-heading { display: flex; align-items: end; gap: 20px; margin: 0 8px 22px; }
.module-heading div { height: 4px; flex: 1; margin-bottom: 10px; background: var(--accent); }
.news-item {
  margin: 0 0 22px;
  padding: 34px 38px 30px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  break-inside: avoid;
}
.item-topline { display: flex; align-items: center; gap: 16px; min-height: 42px; font-size: 24px; }
.item-number { color: var(--accent); font-size: 30px; font-weight: 800; font-variant-numeric: tabular-nums; }
.item-meta { color: var(--muted); font-weight: 650; }
.risk { margin-left: auto; padding: 4px 12px; border: 1px solid var(--line); border-radius: 5px; font-weight: 700; }
.risk-high { color: var(--danger); border-color: #f3b7b3; background: #fff1f0; }
.risk-medium { color: var(--warning); border-color: #f4c790; background: #fff7e8; }
.news-item h3 { margin: 14px 0 18px; font-size: 42px; line-height: 1.36; font-weight: 800; }
.summary { margin-bottom: 18px; font-weight: 600; }
.summary span, .field-label { color: var(--accent); font-size: 25px; font-weight: 800; }
.summary span { display: block; margin-bottom: 5px; }
.field { display: grid; grid-template-columns: 150px minmax(0, 1fr); gap: 18px; margin-top: 12px; }
.field-label { padding-top: 5px; }
ul { margin: 0; padding-left: 38px; }
li { margin: 3px 0; }
.action { margin-top: 18px; padding-top: 16px; border-top: 1px solid var(--line); }
.ownership, .date-line { margin-top: 14px; color: #344054; font-size: 28px; }
.ownership span, .source-line span { display: inline-block; width: 1px; height: 22px; margin: 0 14px; background: var(--line); vertical-align: -2px; }
.source-line { margin-top: 22px; padding-top: 16px; border-top: 1px solid var(--line); color: #667085; font-size: 24px; }
.conclusion { margin-top: 34px; padding: 38px 44px 42px; border-radius: 8px; background: #172033; color: #fff; }
.conclusion h2 { margin: 0 0 12px; font-size: 39px; }
.conclusion p { margin: 0; color: #e5e9f0; }
.footer { display: flex; justify-content: space-between; padding: 24px 8px 0; color: #667085; font-size: 22px; }
</style>
</head>
<body>
<main class="report">
  <header class="masthead">
    <div class="eyebrow">美妆法务情报</div>
    <h1>国际美妆法务资讯周报</h1>
    <div class="period">${escapeHtml(period)}</div>
    <div class="scope">中国信息优先 / 监管规则 / 处罚案例 / 行业动态 / 知识产权 / 进出口 / 产品安全</div>
  </header>
  ${report.management_conclusions.length ? `<section class="executive"><h2>管理层摘要</h2><ol>${report.management_conclusions.map(item => `<li>${escapeHtml(item)}</li>`).join('')}</ol></section>` : ''}
  ${report.sections.map(renderSection).join('')}
  <section class="conclusion"><h2>本期结论</h2><p>${escapeHtml(report.final_synthesis)}</p></section>
  <footer class="footer"><span>公开来源可核验 / 仅供内部合规研判</span><span>${escapeHtml(generated)}</span></footer>
</main>
</body>
</html>`;
}
