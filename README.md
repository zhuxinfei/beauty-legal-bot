# 美妆法务资讯周报机器人

每周从用户维护的美妆法务信息源目录中抓取公开网页候选，并结合公众号线索，用 OpenAI-compatible AI 接口生成面向美妆公司法务人员的情报周报。

它不是新闻搬运工具。最终输出必须经过法务拆解，说明法规变化、违法逻辑、业务影响和可执行动作。

## 核心能力

| 能力 | 说明 |
|------|------|
| 信息源目录 | `worker/sources.json` 由 Excel 转换生成；Excel 只是 source catalog，不是资讯内容 |
| 信息源类型 | 支持 `official_site`、`industry_site`、`rss`、`wechat_public_account`、`manual_link` |
| 公众号处理 | 公众号只作为 `leads` 选题线索，不直接爬历史文章，不作为事实源 |
| 法务拆解 | 法规、案例、IP、进出口按类型强制输出拆解字段和行动建议 |
| 模块组织 | 按广告合规及处罚案例、美妆动态、知识产权动态、新规及案例动态、进出口动态、产品质量/召回与安全风险六大模块展示，宁缺毋滥 |
| 协作平台推送 | 优先写入钉钉知识库文档，再推送钉钉 Markdown 摘要卡片；未配置钉钉时可回退飞书摘要 |
| 风险雷达 | 生成“本周美妆法务风险雷达”图片，辅助理解监管主题、市场、风险、业务影响和行动归口 |
| 完整页面 | Worker 动态渲染 HTML，展示完整拆解 |
| 往期查看 | `/report/latest`、`/report/YYYY-MM-DD`、`/report` |
| 重复控制 | 候选 URL 去重、报告内条目去重、最终报告条目 30 天内不重复推送 |
| 调度 | Cloudflare Cron 每周一北京时间 08:00 执行 |

## 信息源工作流

从用户维护的 Excel 生成结构化源目录：

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
```

生成结果包含：

- `name`：来源名称
- `url`：来源地址或“微信公众号”
- `module`：五大报告模块之一
- `region` / `country`：区域与国家
- `source_type`：`official_site` / `industry_site` / `rss` / `wechat_public_account` / `manual_link`
- `authority_type`：`regulator` / `industry`
- `priority`：`high` / `medium` / `low`
- `topics`：检索和筛选主题

Excel 是信息源目录，只告诉程序“去哪里看”和“关注什么”。最终报告必须来自公开 URL 候选或可验证原文链接。

## 公众号规则

- `url = "微信公众号"` 或名称/URL 包含公众号、微信、`mp.weixin.qq.com`、`weixin` 时，标记为 `wechat_public_account`。
- 公众号不执行 fetch，不算抓取失败。
- 公众号会进入 `leads[]`，只作为 AI 判断选题方向的线索。
- AI 不得把公众号线索作为事实来源。
- 没有公开原文链接的内容不能进入最终报告。

## 报告模块

最终文档按以下模块组织：

1. 广告合规及处罚案例
2. 美妆动态
3. 知识产权动态
4. 新规及案例动态
5. 进出口动态
6. 产品质量/召回与安全风险

规则：

- 质量优先模式会扩大候选池和 AI 分析容量。
- 没有高质量内容时不硬凑。
- 低价值、无原文链接、无具体行动建议的条目会被过滤。

## 每条内容的加工要求

法规类必须包含：

- 变化点
- 法务拆解 / 企业义务
- 影响范围
- 合规动作
- 截止节点

案例类必须包含：

- 案情
- 违法逻辑
- 处罚/结果
- 业务启示
- 排查动作

禁止输出“建议关注”“持续关注”“企业应留意”等空泛建议，除非同时给出具体责任团队和动作。

## 报告页面

部署后可访问：

```text
/report/latest
/report/YYYY-MM-DD
/report
```

页面是模板化动态渲染，不写死数据。每次周报生成后会写入：

- `report:latest`
- `report:YYYY-MM-DD`
- `report:index`

HTML 主题采用 `Trust & Authority`：权威海军蓝 + 信任金，移动端单列卡片，无外部字体或 CDN 依赖，适合飞书跳转阅读。

## 部署（Cloudflare Workers）

### 1. 安装并登录 Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. 配置密钥

```bash
cd worker
npx wrangler secret put AI_API_KEY
npx wrangler secret put DINGTALK_WEBHOOK_URL
npx wrangler secret put DINGTALK_SECRET
npx wrangler secret put DINGTALK_CLIENT_ID
npx wrangler secret put DINGTALK_CLIENT_SECRET
npx wrangler secret put DINGTALK_OPERATOR_ID
npx wrangler secret put DINGTALK_WORKSPACE_ID
```

可选回退通道：

```bash
npx wrangler secret put FEISHU_WEBHOOK_URL
```

可选模型配置在 `worker/wrangler.toml`：

```toml
[vars]
AI_API_BASE_URL = "https://hk.testvideo.site/v1"
AI_MODEL = "gpt-5.4-mini"
NOTIFY_CHANNEL = "dingtalk"
```

`AI_API_KEY` 为模型中转密钥；不要写入仓库。`DINGTALK_SECRET` 仅在钉钉机器人启用“加签”时需要。
钉钉机器人关键词需包含 `美妆法务资讯`。配置 `DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_OPERATOR_ID`、`DINGTALK_WORKSPACE_ID` 后，程序会先在知识库中创建并写入完整周报文档，再把摘要卡片里的“查看完整版本”链接指向具体文档。文档写入失败时不会推送钉钉群摘要。

当前先使用测试钉钉企业、机器人和知识库。切换正式企业应用、webhook 和知识库时，按 [钉钉配置说明](docs/DINGTALK_SETUP.md) 替换 GitHub Secrets / Wrangler Secrets 即可。

### 3. KV 绑定

`worker/wrangler.toml` 已绑定 `SEEN_NEWS`，用于去重、报告页面和往期索引。

### 4. 部署

```bash
cd worker
npx wrangler deploy
```

部署后每周一 UTC 00:00（北京时间 08:00）自动执行。

## 本地验证

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
node worker/test-runner.js
node --check worker/index.js
python3 - << 'PY'
import json
from collections import Counter
from pathlib import Path
data=json.loads(Path('worker/sources.json').read_text(encoding='utf-8'))
print(Counter(s['source_type'] for s in data['sources']))
print(Counter(s['module'] for s in data['sources']))
assert len(data['sources']) == 80
assert sum(1 for s in data['sources'] if s['source_type']=='wechat_public_account') >= 40
assert all(s['module'] != 'uncategorized' for s in data['sources'])
PY
```

预期输出包含：

```text
Wrote 80 sources to worker/sources.json
worker pure function tests ok
```

## 手动触发

部署后访问：

```text
/test
```

Worker 会异步运行周报管道，完成后先写入钉钉知识库文档；文档写入成功后推送钉钉 Markdown 摘要卡片。未配置钉钉时回退飞书摘要，并更新 `/report/latest`。

## 文件结构

```text
beauty-legal-bot/
├── docs/
│   ├── PROJECT_TASK_BRIEF.md
│   └── superpowers/
│       ├── plans/
│       └── specs/
├── scripts/
│   └── extract_sources.py
├── worker/
│   ├── index.js
│   ├── sample-report.json
│   ├── sources.json
│   ├── test-runner.js
│   └── wrangler.toml
├── beauty_legal_bot.py
└── requirements.txt
```

## 注意事项

- 当前程序使用 OpenAI-compatible AI 接口，默认 base URL 可在 `AI_API_BASE_URL` 中配置。
- 不引入 NewsAPI、搜索 API 或其他付费模型服务。
- 报告内容必须带原文链接；没有原文链接的候选不得进入最终推送。
- 公众号只作为线索，不直接作为事实来源。
- 同一报告内相同 `source_url` 只保留一次；没有 URL 时用类型、国家和标题兜底去重。
- 协作平台推送以最终报告条目指纹做 30 天历史去重；若全部条目已推送过，则只更新页面不重复打扰。
- AI 输出仅供法务信息初筛，不构成正式法律意见。
