import {
  REPORT_MODULES,
  curateReportQuality,
  summarizeExecutiveReport,
} from './report-quality.js';

const FONT_STACK = 'Noto Sans CJK SC, PingFang SC, Microsoft YaHei, sans-serif';

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function fit(value, limit) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > limit ? `${text.slice(0, Math.max(1, limit - 1))}…` : text;
}

function wrap(value, charactersPerLine, maxLines) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const lines = [];
  for (let index = 0; index < text.length && lines.length < maxLines; index += charactersPerLine) {
    lines.push(text.slice(index, index + charactersPerLine));
  }
  if (text.length > charactersPerLine * maxLines && lines.length) {
    lines[lines.length - 1] = `${lines[lines.length - 1].slice(0, -1)}…`;
  }
  return lines;
}

function textLines(lines, { x, y, size, color, weight = 400, lineHeight = 38 }) {
  return `<text x="${x}" y="${y}" font-size="${size}" font-weight="${weight}" fill="${color}">${lines.map((line, index) => `<tspan x="${x}" dy="${index ? lineHeight : 0}">${escapeXml(line)}</tspan>`).join('')}</text>`;
}

function sectionTitle(title, y) {
  return `<text x="72" y="${y}" font-size="34" font-weight="800" fill="#17212B">${escapeXml(title)}</text>
    <rect x="72" y="${y + 17}" width="64" height="5" rx="2.5" fill="#167C80"/>`;
}

function prepareExecutive(items, period) {
  const alreadyCurated = items.every(item => ['action', 'watch'].includes(item.report_tier));
  if (alreadyCurated) return summarizeExecutiveReport({ sections: [{ module: 'dashboard', items }] });
  const byModule = REPORT_MODULES.map(module => ({
    module,
    items: items.filter(item => item.module === module),
  }));
  return summarizeExecutiveReport(curateReportQuality({
    period,
    summary: [],
    risk_alerts: [],
    sections: byModule,
  }));
}

function judgementRows(judgements) {
  if (!judgements.length) {
    return '<text x="80" y="320" font-size="30" fill="#687582">本周无通过质量门槛的核心判断</text>';
  }
  return judgements.slice(0, 3).map((item, index) => {
    const top = 286 + index * 150;
    const lines = wrap(item.text, 30, 3);
    return `<g aria-label="${escapeXml(item.text)}">
      <text x="76" y="${top + 42}" font-size="28" font-weight="800" fill="#167C80">0${index + 1}</text>
      ${textLines(lines, { x: 132, y: top + 38, size: 29, color: '#17212B', weight: 650, lineHeight: 39 })}
      <line x1="72" y1="${top + 132}" x2="1008" y2="${top + 132}" stroke="#E2E7EA"/>
    </g>`;
  }).join('');
}

function actionRows(actions, startTop) {
  if (!actions.length) {
    return `<text x="80" y="${startTop + 44}" font-size="30" fill="#687582">本周无需要分派的优先行动</text>`;
  }
  return actions.slice(0, 3).map((action, index) => {
    const top = startTop + index * 158;
    const risk = action.risk_level === 'high' ? '高风险' : action.risk_level === 'medium' ? '中风险' : '优先';
    const riskColor = action.risk_level === 'high' ? '#B42318' : '#167C80';
    const actionLines = wrap(action.text, 34, 2);
    const owners = action.owners.join('、') || '法务';
    return `<g aria-label="${escapeXml(action.text)}">
      <text x="76" y="${top + 32}" font-size="25" font-weight="800" fill="${riskColor}">${escapeXml(risk)}</text>
      <text x="184" y="${top + 32}" font-size="29" font-weight="700" fill="#17212B">${escapeXml(fit(action.title, 26))}</text>
      ${textLines(actionLines, { x: 184, y: top + 72, size: 26, color: '#33404C', lineHeight: 35 })}
      <text x="184" y="${top + 139}" font-size="23" fill="#687582">归口：${escapeXml(fit(owners, 18))}｜时间：由责任领导确定</text>
      <line x1="72" y1="${top + 150}" x2="1008" y2="${top + 150}" stroke="#E2E7EA"/>
    </g>`;
  }).join('');
}

export function buildActionDashboardSvg(items = [], {
  period = {},
  generatedAt = '',
} = {}) {
  const executive = prepareExecutive(items, period);
  const periodText = [period.start, period.end].filter(Boolean).join(' - ') || '本期';
  const generatedText = generatedAt ? String(generatedAt).replace('T', ' ').slice(0, 16) : '';
  const judgementRowsCount = Math.max(1, executive.judgements.length);
  const actionTitleY = 286 + judgementRowsCount * 150 + 54;
  const actionRowsTop = actionTitleY + 56;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" font-family="${FONT_STACK}">
    <rect width="1080" height="1440" fill="#F4F6F7"/>
    <rect x="42" y="36" width="996" height="1368" rx="8" fill="#FFFFFF" stroke="#D8DEE3"/>
    <text x="72" y="102" font-size="54" font-weight="800" fill="#17212B">行动看板</text>
    <text x="74" y="145" font-size="26" fill="#687582">${escapeXml(periodText)}｜中国信息优先</text>

    ${sectionTitle('本周核心判断', 230)}
    ${judgementRows(executive.judgements)}

    ${sectionTitle('优先行动', actionTitleY)}
    ${actionRows(executive.actions, actionRowsTop)}

    <text x="72" y="1372" font-size="23" fill="#687582">公开来源可核验｜内部合规研判</text>
    ${generatedText ? `<text x="1008" y="1372" text-anchor="end" font-size="23" fill="#687582">生成 ${escapeXml(generatedText)}</text>` : ''}
  </svg>`;
}
