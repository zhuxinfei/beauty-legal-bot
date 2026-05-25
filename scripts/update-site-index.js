import { readdir, writeFile, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const SITE_DIR = join(process.cwd(), 'site');
const REPORTS_DIR = join(SITE_DIR, 'reports');
const INDEX_PATH = join(SITE_DIR, 'index.html');

await mkdir(REPORTS_DIR, { recursive: true });

// 发现所有报告
const files = (await readdir(REPORTS_DIR)).filter(f => f.endsWith('.html')).sort().reverse();

// 读取报告标题
const reports = [];
for (const file of files.slice(0, 52)) {
  const html = await readFile(join(REPORTS_DIR, file), 'utf8');
  const titleMatch = html.match(/<title>([^<]+)<\/title>/);
  const itemMatch = html.match(/去重后 (\d+) 条/);
  const date = file.replace('.html', '');
  reports.push({
    date,
    title: titleMatch?.[1] || `美妆法务周报 · ${date}`,
    items: itemMatch?.[1] || '?',
  });
}

const reportsHtml = reports.length ? reports.map((r, i) => `
  <tr>
    <td>${i + 1}</td>
    <td><a href="reports/${r.date}.html">${r.date}</a></td>
    <td>${r.title}</td>
    <td>${r.items} 条情报</td>
  </tr>`).join('') : '<tr><td colspan="4">暂无周报</td></tr>';

await writeFile(INDEX_PATH, `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Global Beauty Legal Intelligence</title>
  <style>
    :root { --paper: #f7f4ef; --surface: #fffdfa; --ink: #161412; --muted: #6d6860; --line: #e2d8ca; --rose: #9f5964; }
    * { box-sizing: border-box; }
    body { margin: 0; background: linear-gradient(180deg, #f8f4ed 0%, #fbfaf7 44%, #f4efe7 100%); color: var(--ink); font-family: Georgia, "Times New Roman", "Songti SC", serif; font-size: 16px; line-height: 1.72; }
    .shell { max-width: 960px; margin: 0 auto; padding: 48px 24px 64px; }
    h1 { font-size: 40px; line-height: 1.15; margin: 0 0 8px; }
    .subtitle { color: var(--muted); font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; margin: 0 0 36px; }
    table { width: 100%; border-collapse: collapse; background: var(--surface); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; box-shadow: 0 22px 60px rgba(54, 42, 29, .09); }
    th, td { padding: 14px 16px; border-bottom: 1px solid var(--line); text-align: left; }
    th { color: var(--rose); font: 800 12px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; text-transform: uppercase; letter-spacing: .08em; background: #fdf8f5; }
    td { font-size: 15px; }
    a { color: #2b5878; text-decoration-thickness: 0.06em; text-underline-offset: 0.2em; font-weight: 700; }
    .empty { text-align: center; color: var(--muted); padding: 32px; }
    .footer { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--line); color: var(--muted); font: 13px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    @media (max-width: 680px) { .shell { padding: 24px 14px 42px; } h1 { font-size: 28px; } }
  </style>
</head>
<body>
  <main class="shell">
    <h1>国际美妆法务情报周报</h1>
    <p class="subtitle">Global Beauty Legal Intelligence · 往期周报</p>
    <table>
      <thead><tr><th>#</th><th>日期</th><th>标题</th><th>规模</th></tr></thead>
      <tbody>${reportsHtml}</tbody>
    </table>
    <footer class="footer">
      <p>由 DeepSeek V4 Pro 自动生成 · 每周一更新</p>
      <p>信息源覆盖中国、欧盟、美国、日本、韩国、印尼、泰国、越南、墨西哥、意大利等核心市场</p>
    </footer>
  </main>
</body>
</html>`);

console.log(`Updated site/index.html with ${reports.length} reports`);
