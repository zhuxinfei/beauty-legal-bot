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
| AI 复核 | 首轮结构化分析后执行证据与逻辑复核；复核异常时保留已经验证的首轮结果，不中断推送链路 |
| 模块组织 | 六大模块持续采集和分析；成品只展示本周有合格行动或观察事项的模块 |
| 来源恢复 | 直接请求失败后，对网络、超时、429 和 5xx 做有界重试；必要时用无头浏览器读取公开页面，最后尝试已核验的同机构官方备用地址 |
| 来源门槛 | 可靠来源覆盖达到 90% 即可进入分析；个别受限来源失败不会阻断一份整体合格的报告 |
| 协作平台推送 | 钉钉群机器人只发送一条 Markdown 周报；未配置钉钉时可回退飞书摘要 |
| 资讯长图 | 生成移动端可读的中国优先高清长图，完整呈现事实、法务研判、影响、动作和来源 |
| 群内版式 | 一条消息包含管理层摘要、资讯长图和来源索引；图片不可用时自动回退完整文字版 |
| 重复控制 | 候选 URL 去重、报告内条目去重、最终报告条目 30 天内不重复推送 |
| 调度 | GitHub Actions 每周一北京时间 08:17 执行，也可手动触发 |

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

## 正式内容准入

正式报告采用双通道准入：

- `action` 行动事项必须具备可核验强证据、本周新增价值、明确集团业务影响和可分派动作。
- `watch` 关注事项允许纳入有实质参考价值的行业新闻，但必须说明关注价值和下一观察点，不得写成确定法律义务。
- 每条内容按证据强度、新增价值、业务相关性、分析深度、行动或观察价值五项评分；评分仅用于内部筛选，不在卡片中展示。
- 六大板块始终参与采集和 AI 分析；没有通过质量门槛的板块不在钉钉正文中显示。
- AI 模块超时或失败不会中止整份报告，也不会用泛化“待核验”条目填充正式卡片。

## 每条内容的加工要求

所有正式条目必须包含独立的 `core_judgement`，用一至两句话说明监管或案件结论、对集团美妆业务的实质影响，以及必要的不确定性边界。

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

禁止输出“建议关注”“持续关注”“企业应留意”等空泛建议，除非同时给出具体责任团队和动作。AI 不填写内部完成时间，由具体领导决定；法规原文中的生效日、反馈截止日和法定整改节点继续保留。

## 钉钉群内周报

程序通过钉钉群机器人发送一条 Markdown 周报。正常版本依次包含管理层摘要、高清资讯长图、本期结论和编号来源索引；图片生成或发布不可用时，自动在同一条消息中展开完整专业正文。中国信息优先，行动事项与持续观察统一编号。

没有高质量内容的模块不会显示。消息上限固定为 18,000 UTF-8 字节；文字回退版先压缩单条字段，再在确有必要时省略最低优先级事项，至少保留一条完整来源。长图版本保留全部准入事项，并提供可点击的高清原图和来源索引。

AI 分析后会记录四层审计数量：AI 原始条目、来源匹配条目、结构有效条目和最终质量准入条目，并输出具体拒绝原因。主分析没有准入条目但存在公开候选时，程序只执行一次基于候选编号的精简救援分析；来源 URL、名称、国家和发布日期均由程序从已抓取候选回填，模型不能自行创建来源。

主分析和救援分析均未发现重要事项时，钉钉发送一条明确的“本期无重大合规更新”文字简报，不生成空图片。只要 AI 曾产出条目但全部在技术过滤环节归零，流程会以失败退出并停止推送，避免把过滤异常误报为正常零更新。

## 稳定性门槛

每个可抓取来源都有结构化尝试记录，包括请求方法、URL、状态码、失败分类和最终恢复方式。恢复顺序为：

1. 直接请求与有界重试，只重试网络、超时、429 和 5xx。
2. 对公开 JavaScript 页面使用 Playwright Chromium 渲染。
3. 尝试 `sources.json` 中人工核验过的同机构 `alternate_urls`。

程序不会绕过登录、验证码、付费墙、IP 白名单或其他访问控制。公众号只作为线索，不计入可抓取源覆盖率。

源目录分为两层：`required` 是在 GitHub Runner 上验证可稳定抓取的硬门槛源；`monitor_only` 是已经确认会返回 403/412、失效地址、空壳页或间歇超时的受限源。受限源仍会执行直接请求、重试和浏览器恢复，恢复成功时照常进入候选；失败时单独披露，不混入 required 覆盖率，也不因为外部访问策略阻断其余可靠来源。

正常周报的硬门槛为：中国 required 高优先级源覆盖率和全部 required 源覆盖率均至少 90%。页面成功读取但本周没有相关资讯记为 `empty`，属于正常零更新，不是抓取失败。required 门槛不满足时，流程会以失败退出，不调用 AI、不发送一份看似完整但来源不足的周报，也不写入 30 天去重状态。

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
```

可选回退通道：

```bash
npx wrangler secret put FEISHU_WEBHOOK_URL
```

GitHub Actions 的模型配置在仓库 Variables 中：

```text
AI_API_BASE_URL=https://你的中转服务/v1
AI_MODEL=gpt-5.5
```

工作流会优先读取这两个 Variables；未配置时才使用代码中的默认值。`worker/wrangler.toml` 仍提供本地 Wrangler 部署的默认值：

正式采集前会先发送一个最小 AI 连通性请求；该请求失败时会立即停止，不再先抓取完整信息源。正式分析默认只发送 40 条候选、24 条线索，最多生成 6000 tokens，避免中转服务因超大非流式请求长时间无响应。

```toml
[vars]
AI_API_BASE_URL = "https://hk.testvideo.site/v1"
AI_MODEL = "gpt-5.5"
NOTIFY_CHANNEL = "dingtalk"
```

`AI_API_KEY` 为模型中转密钥；不要写入仓库。生产 Worker 不再读取已弃用的 `DEEPSEEK_*` 环境变量。`DINGTALK_SECRET` 仅在钉钉机器人启用“加签”时需要。
钉钉机器人关键词需包含 `美妆法务资讯`。群机器人路径不需要企业内部应用或知识库凭据。

GitHub Actions 还需要 `CLOUDFLARE_API_TOKEN`，用于在推送前发布日期版 PNG。账号 ID、KV namespace ID 和公开 Worker 地址配置在 workflow 环境变量中。

切换正式客户群时，按 [钉钉配置说明](docs/DINGTALK_SETUP.md) 替换 webhook 和可选签名密钥即可。

### 3. KV 绑定

`worker/wrangler.toml` 已绑定 `SEEN_NEWS`，用于去重和历史推送控制。

### 4. 部署

```bash
cd worker
npx wrangler deploy
```

远程正式流程由 GitHub Actions 在每周一 UTC 00:17（北京时间 08:17）自动执行；Cloudflare Worker 提供页面、资源路由和手动测试入口。

## 本地验证

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
node worker/test-runner.js
npm run render:editorial-report
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

Worker 会运行完整周报管道，并通过钉钉群机器人发送一条完整 Markdown 周报；未配置钉钉时回退飞书摘要。可靠来源覆盖不足或钉钉发送失败会让整轮任务失败；资讯长图生成或发布失败会自动降级为完整文字版。

## 文件结构

```text
beauty-legal-bot/
├── docs/
│   ├── PROJECT_TASK_BRIEF.md
│   └── superpowers/
│       ├── plans/
│       └── specs/
├── scripts/
│   ├── extract_sources.py
│   ├── render-dashboard-fixture.js
│   └── render-editorial-report-png.js
├── worker/
│   ├── action-dashboard.js            # 仅保留历史兼容，不再用于周报
│   ├── browser-fetch.js
│   ├── cloudflare-assets.js
│   ├── dingtalk-single-card.js
│   ├── editorial-report.js
│   ├── editorial-report-image.js
│   ├── index.js
│   ├── report-quality.js
│   ├── source-recovery.js
│   ├── sample-report.json
│   ├── sources.json
│   ├── test-runner.js
│   └── wrangler.toml
├── beauty_legal_bot.py
└── requirements.txt
```

## 注意事项

- 当前程序使用 OpenAI-compatible AI 接口，默认 base URL 可在 `AI_API_BASE_URL` 中配置。
- 默认模型为 `gpt-5.5`；旧 DeepSeek 凭据和模型回退已停用。使用 `gpt-5.6-sol` 时正式请求默认采用中等推理强度；高推理强度仅显式启用。
- 来源覆盖率默认要求总体和中国关键源均达到 90%；个别站点临时受限不会终止报告，但低于门槛仍会阻断推送。
- AI 复核只允许纠错或删除首轮条目，不能新增条目、替换来源或改变报告周期；复核失败时降级使用已验证的首轮结果。
- 不引入 NewsAPI、搜索 API 或其他付费模型服务。
- 报告内容必须带原文链接；没有原文链接的候选不得进入最终推送。
- 公众号只作为线索，不直接作为事实来源。
- 同一报告内相同 `source_url` 只保留一次；没有 URL 时用类型、国家和标题兜底去重。
- 协作平台推送以最终报告条目指纹做 30 天历史去重；若全部条目已推送过，则只更新页面不重复打扰。
- AI 输出仅供法务信息初筛，不构成正式法律意见。
- 图片发布顺序固定为：渲染 PNG → 写入日期版 KV → 从公开日期 URL 健康检查 → 发送钉钉 → 写入去重状态。钉钉正文不使用 `latest` 图片 URL，避免缓存命中上一期图片。
