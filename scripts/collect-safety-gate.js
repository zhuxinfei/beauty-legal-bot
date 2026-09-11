// EU Safety Gate 化妆品通报采集（2026-09-11 新增）
//
// 为什么加这条通道：筛选层修对之后，瓶颈变成「合格的条目数」本身。国内法规类
// 不是周更（实测中国政府网政策文件库返回的全是 2025 年文件），而 Safety Gate
// 是**每周五发**的官方通报，实测最新一期发布日就是当天，41 条通报里 4 条化妆品。
// 官方、结构化、无反爬、无需 key，直接补「产品质量/召回」这个核心类目。
//
// 用法：
//   node scripts/collect-safety-gate.js --days 21 --merge-into out/hydrated-authority.json
//   node scripts/collect-safety-gate.js --days 21 --output out/safety-gate.json
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { XMLParser } from 'fast-xml-parser';

const INDEX_URL = 'https://ec.europa.eu/safety-gate-alerts/api/download/weeklyReport/list/xml/en';
const USER_AGENT = 'beauty-legal-bot/2.0 (+weekly cosmetics compliance digest)';
const MODULE = '产品质量/召回与安全风险';

function parseArgs(argv) {
  const args = { days: 15, output: '', mergeInto: '' };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--days') args.days = Number(argv[++i] || args.days);
    else if (token === '--output') args.output = argv[++i] || '';
    else if (token === '--merge-into') args.mergeInto = argv[++i] || '';
  }
  return args;
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
const asArray = value => (Array.isArray(value) ? value : value === undefined || value === null ? [] : [value]);
// 有的字段在 XML 里带属性，解析出来是对象（实测出现过 brand 变 [object Object]）
const text = value => {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return text(value['#text'] ?? value.__text ?? '');
  return String(value).trim();
};

async function fetchText(url) {
  const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.text();
}

// 索引按时间倒序排列，第一条即最新一期
async function listReports() {
  const document = parser.parse(await fetchText(INDEX_URL));
  return asArray(document?.['Safety-Gate']?.weeklyReport).map(entry => ({
    date: text(entry.publicationDate),
    url: text(entry.URL).replace(/&amp;/g, '&'),
  })).filter(report => report.url);
}

function isoDate(value) {
  const match = text(value).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return match ? `${match[3]}-${match[2]}-${match[1]}` : '';
}

function buildArticleText(alert) {
  const lines = [
    `通报国：${text(alert.notifyingCountry)}`,
    alert.countryOfOrigin ? `原产国：${text(alert.countryOfOrigin)}` : '',
    alert.brand ? `品牌：${text(alert.brand)}` : '',
    alert.product ? `产品类别：${text(alert.product)}` : '',
    alert.name ? `产品名称：${text(alert.name)}` : '',
    alert.description ? `产品描述：${text(alert.description)}` : '',
    alert.type ? `型号：${text(alert.type)}` : '',
    alert.barcode ? `条码：${text(alert.barcode)}` : '',
    alert.batchNumber ? `批号：${text(alert.batchNumber)}` : '',
    // riskType 是短类型（Chemical / Microbiological），danger 是整句风险描述
    alert.riskType ? `风险类型：${text(alert.riskType)}` : '',
    alert.level ? `风险等级：${text(alert.level)}` : '',
    alert.danger ? `风险描述：${text(alert.danger)}` : '',
    alert.measures ? `处置措施：${text(alert.measures)}` : '',
    alert.onlineTrader ? `在线销售商：${text(alert.onlineTrader)}` : '',
    alert.caseNumber ? `案号：${text(alert.caseNumber)}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

function toRecord(alert, report) {
  const publishedAt = isoDate(report.date);
  const reference = text(alert.reference);
  // 标题要短：原先把整句 danger 拼进去，一条标题两百多字。短类型在 riskType。
  const brand = text(alert.brand).slice(0, 36);
  const product = text(alert.product).slice(0, 40);
  const riskType = text(alert.riskType);
  const level = text(alert.level);
  const qualifier = [riskType, level].filter(Boolean).join('・');
  const subject = [brand, product].filter(Boolean).join(' ') || text(alert.name).slice(0, 60);
  const title = `欧盟 Safety Gate 通报：${subject}${qualifier ? `（${qualifier}）` : ''}`.slice(0, 110);
  return {
    url: reference,
    final_url: reference,
    source_url: reference,
    title,
    published_at: publishedAt,
    country: '欧盟',
    region: '欧洲',
    module: MODULE,
    discovery_module: MODULE,
    discovery_query: 'safety-gate:cosmetics',
    discovery_provider: 'safety_gate',
    source_name: 'EU Safety Gate (RAPEX)',
    source_scope: 'hard_fact_endpoint',
    source_type: 'official_site',
    authority_type: 'regulator',
    priority: 'high',
    topics: ['化妆品', '召回', '产品安全', riskType].filter(Boolean),
    raw_markdown: '',
    fit_markdown: '',
    references_markdown: '',
    article_text: buildArticleText(alert),
    crawl_status: 'hydrated',
    quality_flags: [],
    hydration_source: 'safety_gate_api',
  };
}

async function collect({ days }) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
  const reports = (await listReports()).filter(report => isoDate(report.date) >= cutoff);
  const records = [];
  const audit = { reports: reports.length, alerts: 0, cosmetics: 0, skipped: [] };
  for (const report of reports) {
    try {
      const document = parser.parse(await fetchText(report.url));
      for (const alert of asArray(document?.['Safety-Gate']?.notifications)) {
        audit.alerts += 1;
        if (text(alert.category) !== 'Cosmetics') continue;
        audit.cosmetics += 1;
        const record = toRecord(alert, report);
        if (record.url) records.push(record);
      }
    } catch (error) {
      audit.skipped.push({ date: report.date, error: String(error?.message || error).slice(0, 160) });
    }
  }
  return { records, audit };
}

const invokedDirectly = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (invokedDirectly) {
  const args = parseArgs(process.argv);
  const { records, audit } = await collect({ days: args.days });
  console.log(`Safety Gate: ${audit.reports} 期报告, ${audit.alerts} 条通报, ${audit.cosmetics} 条化妆品 → ${records.length} 条记录`);
  if (audit.skipped.length) console.warn(`  跳过 ${audit.skipped.length} 期: ${JSON.stringify(audit.skipped.slice(0, 3))}`);
  if (args.mergeInto) {
    const payload = JSON.parse(await readFile(resolve(args.mergeInto), 'utf8'));
    const existing = new Set((payload.records || []).map(record => String(record.final_url || record.url || '').trim()));
    const fresh = records.filter(record => !existing.has(record.url));
    payload.records = [...(payload.records || []), ...fresh];
    await writeFile(resolve(args.mergeInto), `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`  合并进 ${args.mergeInto}：新增 ${fresh.length} 条（去重掉 ${records.length - fresh.length} 条）`);
  }
  if (args.output) {
    await writeFile(resolve(args.output), `${JSON.stringify({ records }, null, 2)}\n`);
    console.log(`  → ${args.output}`);
  }
}
