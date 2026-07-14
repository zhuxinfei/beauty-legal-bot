import { mkdir, writeFile } from 'node:fs/promises';
import sharp from 'sharp';
import sampleReport from '../worker/sample-report.json' with { type: 'json' };
import { buildActionDashboardSvg } from '../worker/action-dashboard.js';

const sourceItems = (sampleReport.sections || []).flatMap(section => (section.items || []).map(item => ({
  ...item,
  module: section.module,
})));
const items = Array.from({ length: 16 }, (_, index) => ({
  ...structuredClone(sourceItems[index % sourceItems.length]),
  title: `${index < 4 ? '中国' : '海外'}监管事项 ${index + 1}：化妆品标签、广告宣称与备案材料一致性检查`,
  country: index < 4 ? '中国' : '美国',
  module: sampleReport.sections[index % sampleReport.sections.length].module,
  owner_teams: [`责任团队${index + 1}`],
  recommended_actions: [`完成第 ${index + 1} 项产品、标签和宣传材料合规核验`],
  risk_level: index < 5 ? 'high' : 'medium',
}));
const svg = buildActionDashboardSvg(items, {
  period: sampleReport.period,
  coverage: { overall: 0.95, chinaCritical: 1, failedSources: ['示例失败源'] },
  generatedAt: new Date().toISOString(),
});

await mkdir('out', { recursive: true });
await writeFile('out/decision-map.svg', svg, 'utf8');
await sharp(Buffer.from(svg)).png().toFile('out/decision-map.png');
await sharp(Buffer.from(svg)).resize({ width: 720 }).png().toFile('out/decision-map-preview-720.png');

const metadata = await sharp('out/decision-map.png').metadata();
console.log(JSON.stringify({ width: metadata.width, height: metadata.height, items: items.length }));
