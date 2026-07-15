const MODULES = [
  '广告合规及处罚案例',
  '美妆动态',
  '知识产权动态',
  '新规及案例动态',
  '进出口动态',
  '产品质量/召回与安全风险',
];

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

function riskLabel(value) {
  return value === 'high' ? '高' : value === 'medium' ? '中' : '一般';
}

function score(item) {
  return (item.country === '中国' ? 1000 : 0)
    + (item.risk_level === 'high' ? 100 : item.risk_level === 'medium' ? 50 : 10)
    + (item.industry_impact === 'high' ? 40 : item.industry_impact === 'medium' ? 20 : 5)
    + (item.relevance === 'direct' ? 30 : 0)
    + (item.confidence === 'high' ? 20 : item.confidence === 'medium' ? 10 : 0);
}

function actionText(item) {
  return (item.recommended_actions || []).find(Boolean) || '核验原文并更新内部合规清单';
}

function ownerText(item) {
  return (item.owner_teams || []).filter(Boolean).slice(0, 2).join('、') || '法务';
}

function sectionTitle(title, y, accent = '#167C80') {
  return `<text x="64" y="${y}" font-size="34" font-weight="800" fill="#17212B">${escapeXml(title)}</text>
    <rect x="64" y="${y + 14}" width="72" height="5" rx="2.5" fill="${accent}"/>`;
}

function kpiCard(x, label, value, tone = 'neutral') {
  const palette = {
    neutral: ['#F0F4F7', '#17212B'],
    danger: ['#FFF0EE', '#B42318'],
    teal: ['#EAF7F5', '#167C80'],
    amber: ['#FFF6E7', '#9A6700'],
  }[tone];
  return `<g>
    <rect x="${x}" y="138" width="222" height="92" rx="8" fill="${palette[0]}"/>
    <text x="${x + 18}" y="169" font-size="24" fill="#53606D">${escapeXml(label)}</text>
    <text x="${x + 18}" y="211" font-size="38" font-weight="800" fill="${palette[1]}">${escapeXml(value)}</text>
  </g>`;
}

function chinaRows(items) {
  if (!items.length) {
    return '<text x="74" y="336" font-size="28" fill="#53606D">本周无高置信中国监管更新</text>';
  }
  return items.slice(0, 3).map((item, index) => {
    const y = 334 + index * 72;
    const riskColor = item.risk_level === 'high' ? '#B42318' : '#9A6700';
    return `<g>
      <rect x="64" y="${y - 34}" width="952" height="58" rx="6" fill="${index === 0 ? '#F7FAFB' : '#FFFFFF'}" stroke="#DCE3E8"/>
      <rect x="78" y="${y - 20}" width="44" height="32" rx="4" fill="${riskColor}"/>
      <text x="100" y="${y + 4}" text-anchor="middle" font-size="24" font-weight="700" fill="#FFFFFF">${riskLabel(item.risk_level)}</text>
      <text x="140" y="${y + 4}" font-size="28" font-weight="650" fill="#17212B">${escapeXml(fit(item.title, 29))}</text>
    </g>`;
  }).join('');
}

function moduleRows(items) {
  const counts = new Map(MODULES.map(module => [module, { total: 0, high: 0 }]));
  for (const item of items) {
    if (!counts.has(item.module)) continue;
    counts.get(item.module).total += 1;
    if (item.risk_level === 'high') counts.get(item.module).high += 1;
  }
  const max = Math.max(1, ...[...counts.values()].map(value => value.total));
  return MODULES.map((module, index) => {
    const y = 642 + index * 48;
    const value = counts.get(module);
    const width = Math.round(330 * value.total / max);
    return `<g>
      <text x="64" y="${y}" font-size="25" fill="#33404C">${escapeXml(fit(module, 17))}</text>
      <rect x="370" y="${y - 24}" width="420" height="28" rx="4" fill="#E8EDF1"/>
      <rect x="370" y="${y - 24}" width="${Math.max(value.total ? 20 : 0, width)}" height="28" rx="4" fill="#2D8C8C"/>
      <text x="812" y="${y}" font-size="25" font-weight="700" fill="#17212B">${value.total} 条</text>
      <text x="906" y="${y}" font-size="24" fill="${value.high ? '#B42318' : '#687582'}">高风险 ${value.high}</text>
    </g>`;
  }).join('');
}

function actionRows(items) {
  if (!items.length) return '<text x="74" y="1084" font-size="28" fill="#53606D">本周无待办行动</text>';
  return items.slice(0, 5).map((item, index) => {
    const y = 1048 + index * 64;
    return `<g>
      <text x="70" y="${y}" font-size="27" font-weight="800" fill="${item.risk_level === 'high' ? '#B42318' : '#167C80'}">${index + 1}</text>
      <text x="112" y="${y}" font-size="27" font-weight="650" fill="#17212B">${escapeXml(fit(item.title, 31))}</text>
      <text x="112" y="${y + 29}" font-size="22" fill="#53606D">行动：${escapeXml(fit(actionText(item), 27))}</text>
      <text x="1016" y="${y + 29}" text-anchor="end" font-size="22" font-weight="650" fill="#33404C">责任：${escapeXml(fit(ownerText(item), 9))}</text>
      <line x1="64" y1="${y + 42}" x2="1016" y2="${y + 42}" stroke="#E3E8EC"/>
    </g>`;
  }).join('');
}

/**
 * 将本期全部可核验条目汇总成移动端优先的管理层行动看板。
 * 统计使用完整报告；视觉上只展开中国 Top 3 和行动 Top 5，并明确以标题区分 Top N 与总数。
 */
export function buildActionDashboardSvg(items = [], {
  period = {},
  coverage = {},
  generatedAt = '',
} = {}) {
  const sorted = [...items].sort((a, b) => score(b) - score(a) || String(a.title || '').localeCompare(String(b.title || ''), 'zh-Hans-CN'));
  const china = sorted.filter(item => item.country === '中国');
  const highRisk = items.filter(item => item.risk_level === 'high').length;
  const official = items.filter(item => ['official', 'official_site', 'regulator', 'court'].includes(item.source_type) || item.authority_type === 'regulator').length;
  const overallCoverage = Number.isFinite(Number(coverage.overall)) ? `${(Number(coverage.overall) * 100).toFixed(0)}%` : '—';
  const periodText = [period.start, period.end].filter(Boolean).join(' - ') || '本期';
  const generatedText = generatedAt ? String(generatedAt).replace('T', ' ').slice(0, 16) : '—';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1440" viewBox="0 0 1080 1440" font-family="${FONT_STACK}">
    <rect x="0" y="0" width="1080" height="1440" fill="#F4F7FA"/>
    <rect x="36" y="32" width="1008" height="1372" rx="10" fill="#FFFFFF" stroke="#D8E0E6"/>
    <text x="64" y="82" font-size="52" font-weight="800" fill="#17212B">行动看板</text>
    <text x="66" y="119" font-size="26" fill="#687582">${escapeXml(periodText)}｜中国信息优先｜公开来源可核验</text>
    ${kpiCard(64, '正式情报', items.length, 'neutral')}
    ${kpiCard(306, '高风险', highRisk, 'danger')}
    ${kpiCard(548, '官方来源', official, 'teal')}
    ${kpiCard(790, '来源覆盖', overallCoverage, 'amber')}

    ${sectionTitle('中国监管重点 Top 3', 270, '#B42318')}
    ${chinaRows(china)}

    ${sectionTitle('六模块风险分布', 574, '#167C80')}
    ${moduleRows(items)}

    ${sectionTitle('本周优先行动 Top 5', 982, '#9A6700')}
    ${actionRows(sorted)}

    <rect x="64" y="1360" width="952" height="1" fill="#DCE3E8"/>
    <text x="64" y="1390" font-size="24" fill="#687582">中国关键源 ${(Number(coverage.chinaCritical || 0) * 100).toFixed(0)}%｜门槛失败 ${(coverage.failedSources || []).length}｜受限监测 ${(coverage.monitoredFailedSources || []).length}</text>
    <text x="1016" y="1390" text-anchor="end" font-size="24" fill="#687582">生成 ${escapeXml(generatedText)}</text>
  </svg>`;
}
