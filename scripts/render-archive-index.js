// Build the GitHub Pages archive index (public/index.html): every published
// weekly report PDF, newest first, so historical DingTalk links keep working.
// Usage: node scripts/render-archive-index.js --date 2026-09-07 --out public/index.html
//
// 数据源全部容错，任一缺失都不影响出页：
//   1. git ls-tree -r -z --name-only origin/gh-pages
//      注意 workflow 里 `git fetch --depth=1 origin gh-pages` 只写 FETCH_HEAD，
//      单分支 clone 不会创建 origin/gh-pages，所以再兜底 FETCH_HEAD。
//      -z 必须保留：默认输出会把中文路径转义成 "\347\276\216..." 并加引号，
//      文件名正则将无法匹配。
//   2. docs/archive/*.pdf  回收的历史 PDF（workflow 已 cp 进 public/）
//   3. public/*.pdf        本次已就位的 PDF
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const REPORT_PATTERN = /^美妆法务资讯周报-(\d{4}-\d{2}-\d{2})\.pdf$/;
const REPORT_PREFIX = '美妆法务资讯周报-';
const LATEST_FILENAME = 'latest-report.pdf';
const ARCHIVE_DIR = 'docs/archive';
const PUBLIC_DIR = 'public';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--date') args.date = argv[i + 1] || '';
    else if (argv[i] === '--out') args.out = argv[i + 1] || '';
    else if (argv[i] === '--ref') args.ref = argv[i + 1] || '';
  }
  return args;
}

// `git ls-tree` on a ref that does not exist is a normal condition here, not an error.
function listRefPaths(ref) {
  if (!ref) return [];
  try {
    const out = execFileSync('git', ['ls-tree', '-r', '-z', '--name-only', ref], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
    });
    return out.split('\0').filter(Boolean);
  } catch {
    console.log(`[archive] ref ${ref} 不可用，跳过`);
    return [];
  }
}

function listDirPdfs(dir) {
  try {
    return readdirSync(resolve(dir)).filter(name => name.toLowerCase().endsWith('.pdf'));
  } catch {
    return [];
  }
}

function dateFromFilename(name) {
  const match = REPORT_PATTERN.exec(name);
  return match ? match[1] : '';
}

// 收集所有来源里的周报 PDF：date -> { date, filename }，按日期去重。
function collectReports(sources) {
  const byDate = new Map();
  for (const { label, names } of sources) {
    for (const name of names) {
      const file = basename(name);
      const date = dateFromFilename(file);
      if (!date) continue;
      if (!byDate.has(date)) byDate.set(date, { date, filename: file, source: label });
    }
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

// 中文文件名必须 encodeURI，否则部分客户端/分享链路会打不开链接。
function href(filename) {
  return encodeURI(filename);
}

function renderHtml({ date, reports, hasLatest, generatedAt }) {
  const latestDate = date || (reports[0] && reports[0].date) || '';
  const latestFile = latestDate ? `${REPORT_PREFIX}${latestDate}.pdf` : '';
  const sourceNote = [...new Set(reports.map(item => item.source))].join(' / ');

  const latestBlock = latestFile
    ? `  <section class="latest">
    <h2>最新一期</h2>
    <a class="latest-link" href="${href(latestFile)}">${escapeHtml(latestDate)} 周报 · PDF</a>
  </section>`
    : `  <section class="latest">
    <h2>最新一期</h2>
    <p class="empty">尚未生成本期报告。</p>
  </section>`;

  const archiveBlock = reports.length
    ? `  <ul class="archive">
${reports.map(item => `    <li><a href="${href(item.filename)}">${escapeHtml(item.filename)}</a></li>`).join('\n')}
  </ul>`
    : `  <p class="empty">暂无历史归档，下周发布后会自动出现在这里。</p>`;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>美妆法务资讯周报 · 历史归档</title>
<style>
  body { font-family: -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif; max-width: 800px; margin: 0 auto; padding: 24px 20px 60px; color: #333; line-height: 1.7; background: #fafafa; }
  h1 { font-size: 1.5em; border-bottom: 2px solid #c00; padding-bottom: 8px; margin: 0 0 8px; }
  h2 { font-size: 1.1em; margin-top: 28px; border-left: 4px solid #c00; padding-left: 12px; }
  p.meta { color: #888; font-size: 0.85em; margin: 0 0 8px; }
  ul { list-style: none; padding: 0; margin: 0; }
  li { background: #fff; border: 1px solid #eee; border-radius: 6px; margin: 8px 0; }
  li a { display: block; padding: 12px 14px; color: #06c; text-decoration: none; word-break: break-all; }
  li a:hover { background: #f7f7f7; }
  .latest-link { display: block; background: #fff; border: 1px solid #c00; border-left: 4px solid #c00; border-radius: 6px; padding: 14px; color: #c00; font-weight: 600; text-decoration: none; word-break: break-all; }
  .latest-link:hover { background: #fff5f5; }
  .latest-only { color: #999; font-size: 0.85em; font-weight: 400; }
  .empty { color: #777; background: #fff; border: 1px dashed #ddd; border-radius: 6px; padding: 14px; margin: 8px 0; }
  footer { margin-top: 40px; color: #aaa; font-size: 0.8em; border-top: 1px solid #eee; padding-top: 12px; }
  @media (max-width: 480px) {
    body { padding: 16px 14px 40px; }
    h1 { font-size: 1.3em; }
    li a, .latest-link { padding: 12px; }
  }
</style>
</head>
<body>
  <h1>美妆法务资讯周报 · 历史归档</h1>
  <p class="meta">共 ${reports.length} 期 · 本页更新于 ${escapeHtml(generatedAt)}</p>
${latestBlock}
  <h2>历史归档</h2>
${archiveBlock}
  <h2>快捷入口</h2>
  <ul>
    <li><a href="${LATEST_FILENAME}">${LATEST_FILENAME} <span class="latest-only">始终最新</span></a></li>
  </ul>
  <footer>归档来源：${escapeHtml(sourceNote || '无')} · 链接永久有效，可直接分享或引用。</footer>
</body>
</html>
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const out = resolve(args.out || `${PUBLIC_DIR}/index.html`);
  const explicitRef = args.ref || '';
  const refs = explicitRef
    ? [explicitRef]
    : ['origin/gh-pages', 'FETCH_HEAD'];
  const refPaths = refs.flatMap(ref => listRefPaths(ref).map(path => ({ path, ref })));
  const sources = [
    { label: 'gh-pages', names: refPaths.map(item => item.path) },
    { label: ARCHIVE_DIR, names: listDirPdfs(ARCHIVE_DIR) },
    { label: PUBLIC_DIR, names: listDirPdfs(PUBLIC_DIR) },
  ];
  const reports = collectReports(sources);
  const hasLatest = listDirPdfs(PUBLIC_DIR).includes(LATEST_FILENAME);
  const html = renderHtml({
    date: args.date || '',
    reports,
    hasLatest,
    generatedAt: new Date().toISOString().slice(0, 10),
  });

  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, 'utf8');
  console.log(
    `[archive] ${out} 生成完成：${reports.length} 期`
    + `${reports.length ? `（${reports[0].date} … ${reports[reports.length - 1].date}）` : ''}`
    + `, latest-report.pdf=${hasLatest ? '有' : '无'}`
    + `${existsSync(resolve(ARCHIVE_DIR)) ? '' : `, ${ARCHIVE_DIR} 不存在`}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

export { collectReports, dateFromFilename, renderHtml };
