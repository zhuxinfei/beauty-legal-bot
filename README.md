# 美妆法务资讯周报机器人

每周自动抓取美妆行业法规、处罚案例、知识产权和跨境进出口信息源，用 DeepSeek 结构化筛选后：

- 推送一张飞书摘要卡片
- 生成完整 HTML 周报页面
- 通过 Cloudflare Workers KV 保存最新与往期周报

## 核心能力

| 能力 | 说明 |
|------|------|
| 信息源目录 | `worker/sources.json` 由 Excel 转换生成，可人工维护 |
| 模型引擎 | 当前只实现 DeepSeek API；调用集中在 Worker 的模型边界函数，后续可替换 |
| 飞书摘要 | 只展示本周重点、风险提醒和完整周报链接 |
| 完整页面 | Worker 动态渲染 HTML 模板，数据来自每次生成的报告 |
| 往期查看 | `/report/latest` 查看最新，`/report/YYYY-MM-DD` 查看指定日期，`/report` 查看索引 |
| 调度 | Cloudflare Cron 每周一北京时间 08:00 执行 |

## 信息源工作流

从用户维护的 Excel 生成结构化源目录：

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
```

生成结果包含：

- `name`：来源名称
- `url`：来源地址
- `module`：法规、案例、美妆动态、IP、进出口等模块
- `region` / `country`：区域与国家
- `source_type`：website / wechat_public_account / rss
- `authority_type`：official / industry
- `priority`：high / medium / low
- `topics`：检索和筛选主题

公众号来源只作为线索，不直接抓取；最终报告要求尽量回到官方或公开网页链接。

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
npx wrangler secret put DEEPSEEK_API_KEY
npx wrangler secret put FEISHU_WEBHOOK_URL
```

可选模型配置在 `worker/wrangler.toml`：

```toml
[vars]
DEEPSEEK_MODEL = "deepseek-chat"
```

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
```

预期输出包含：

```text
Wrote 69 sources to worker/sources.json
worker pure function tests ok
```

## 手动触发

部署后访问：

```text
/test
```

Worker 会异步运行周报管道，完成后推送飞书摘要，并更新 `/report/latest`。

## 文件结构

```text
beauty-legal-bot/
├── scripts/
│   └── extract_sources.py      # Excel → worker/sources.json
├── worker/
│   ├── index.js                # Cloudflare Worker 主逻辑
│   ├── sample-report.json      # HTML/飞书渲染测试 fixture
│   ├── sources.json            # 结构化信息源目录
│   ├── test-runner.js          # Node 纯函数测试
│   └── wrangler.toml           # Cron + KV + vars
├── beauty_legal_bot.py         # 旧本地预览脚本，线上不依赖
└── requirements.txt
```

## 注意事项

- 当前程序只依赖 DeepSeek API 作为模型引擎。
- 不引入 NewsAPI、搜索 API 或其他付费模型服务。
- 报告内容必须带原文链接；没有原文链接的候选不得进入最终推送。
- AI 输出仅供法务信息初筛，不构成正式法律意见。
