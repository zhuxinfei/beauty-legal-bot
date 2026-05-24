# beauty-legal-bot 项目任务总览

最后更新：2026-05-24

## 1. 项目目标

把 `beauty-legal-bot` 做成面向美妆公司法务人员的“美妆法务情报周报”工具。

它不是普通美妆新闻机器人，而是帮助法务、合规、注册、供应链、电商、市场团队快速识别法规变化、处罚案例、知识产权和跨境合规风险，并给出可执行动作。

核心输出：

- 飞书摘要卡片：只展示本周重点风险和动作。
- 完整 HTML 页面：展示按模块整理的详细法务拆解。
- 往期页面：支持 `/report/latest`、`/report/YYYY-MM-DD`、`/report`。

## 2. 用户画像

主要用户：美妆公司法务人员。

关心问题：

- 有什么新法规、修订、废止、征求意见、生效提醒？
- 是否影响准入、备案、标签、功效宣称、原料、广告、进出口、认证？
- 有哪些处罚案例、判决、召回、通报值得复盘？
- 监管/法院为什么这么认定？违法逻辑是什么？
- 对自家 SKU、直播、电商详情页、达人合作、包装、商标、清关有什么影响？
- 谁要做什么，什么时候做？

禁止输出普通新闻搬运。

## 3. 当前代码状态

当前分支：`feature/legal-intelligence-redesign`

已完成并提交：

- `c99cb76` Add beauty legal intelligence implementation plan
- `1f97a14` Add structured legal intelligence sources
- `7d0463f` Add worker source utility tests
- `e672789` Add source candidate collection
- `7436712` Add DeepSeek structured analysis boundary
- `63cea69` Add legal report renderers
- `5f59e82` Implement weekly legal intelligence reports
- `53edc87` Prevent duplicate legal report items

当前已具备：

- Cloudflare Worker 主架构。
- DeepSeek API 调用边界。
- Excel 转 `worker/sources.json`。
- 公开网页 HTML 抓取和 `<a>` 链接抽取。
- 候选标题关键词过滤。
- DeepSeek 结构化 JSON 分析。
- HTML 完整页面模板。
- 飞书摘要卡片。
- KV 保存 latest、dated report、report index。
- 报告内去重和 30 天 item 指纹去重。
- 每周一北京时间 08:00 cron。
- `worker/test-runner.js` 本地测试。

## 4. 已发现的关键偏差

### 4.1 Excel 是信息源目录，不是资讯内容

Excel 只告诉程序去哪看、属于哪个模块，不代表最终报告内容。

### 4.2 公众号识别错误

当前 `worker/sources.json` 统计：

```text
total 69
source_type Counter({'website': 69})
url 微信公众号 rows 45
```

也就是说，Excel 里大量 `url = "微信公众号"` 的源被误识别成了 `website`。

正确处理应为：

- `url = "微信公众号"` 或名称/URL 包含 `公众号`、`微信`、`mp.weixin.qq.com`、`weixin` → `source_type = "wechat_public_account"`。
- 不直接爬公众号历史文章。
- 作为 `leads[]` 选题线索传入 DeepSeek。
- 最终报告必须回到官方或公开网页原文链接。

### 4.3 内容拆解不够强

当前 JSON 有 `content`、`impact_scope`、`analysis`、`action`，但字段太泛。

需要改成按类型强制拆解：

- 法规类：变化点、法律义务、影响业务、截止节点、行动建议。
- 案例类：案情、违法逻辑、处罚结果、风险模式、业务启示、排查动作。
- IP 类：争议焦点、保护要素、侵权逻辑、品牌资产影响。
- 进出口类：准入/清关变化、影响流程、所需文件、截止日。

## 5. 最新确认的产品原则

用户已确认：

- 按 Excel 中的几个模块整理最终报告。
- 每个模块下放几条信息。
- 宁缺毋滥，没有高质量信息可以不放。
- 法规动态、案例都要有拆解。
- 拒绝信息无加工直接扔给用户。
- 可以参考同类产品和开源项目，综合众家之长，不必全部从头做。

## 6. 参考项目和借鉴点

### 6.1 AI News Radar

参考：Horizon、agents-radar、ai-news-radar。

借鉴：

- 多源采集 → candidate 标准化 → 去重 → LLM 评分/摘要 → 页面/推送。
- 历史报告和来源可追溯。

不直接使用原因：

- 偏通用新闻/AI 科技资讯，不是美妆法务垂直场景。
- 系统偏重；当前目标是 Cloudflare Worker 轻量部署。

### 6.2 网页变化监控

参考：changedetection.io、Huginn。

借鉴：

- 页面 hash / 变化检测。
- source health。
- 失败源排查。

不直接使用原因：

- 部署维护成本高。

### 6.3 RSS 桥接

参考：RSSHub、RSS-Bridge。

借鉴：

- `source_type = rss` adapter。
- 对有 RSS 的源优先用 RSS item。

不强依赖公共实例。

### 6.4 商业监管情报平台

参考：RegPulse、RegASK、Polzia、Regology、Responsiv。

借鉴：

- 风险评级。
- 影响范围。
- 截止日期。
- 行动清单。
- 审计留痕。

## 7. 修订设计文档

最新修订设计已写入：

```text
docs/superpowers/specs/2026-05-24-beauty-legal-intelligence-v1-1-design.md
```

它覆盖：

- Excel source catalog 定位。
- 公众号线索机制。
- source_type 分类。
- 按模块组织。
- 法规/案例/IP/进出口类型化拆解 schema。
- 模块级数量限制。
- 低质量过滤。
- 页面和飞书展示方式。
- 不做事项。
- 实施策略。

## 8. 下一步实现任务

建议按以下顺序实现 v1.1：

### Task A：修正 source catalog

文件：

- `scripts/extract_sources.py`
- `worker/sources.json`
- `worker/test-runner.js` 或新增脚本测试

要求：

- 正确识别 `wechat_public_account`。
- 根据 Excel 模块/名称补齐模块映射。
- 区分 `official_site`、`industry_site`、`rss`、`manual_link`。
- 重新生成 `sources.json`。

验证：

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
python3 - << 'PY'
import json
from collections import Counter
from pathlib import Path
data=json.loads(Path('worker/sources.json').read_text(encoding='utf-8'))
print(Counter(s['source_type'] for s in data['sources']))
assert sum(1 for s in data['sources'] if s['source_type']=='wechat_public_account') >= 40
PY
```

### Task B：增加 candidates + leads

文件：

- `worker/index.js`
- `worker/test-runner.js`

要求：

- 可抓源进入 `candidates[]`。
- 公众号源进入 `leads[]`。
- 公众号不 fetch，不算失败源。
- DeepSeek prompt 同时接收 candidates 和 leads。

### Task C：扩展类型化 JSON schema

文件：

- `worker/index.js`
- `worker/sample-report.json`
- `worker/test-runner.js`

要求：

- 法规类字段：`what_changed`、`legal_obligation`、`affected_business`、`next_deadline`。
- 案例类字段：`facts`、`violation_logic`、`penalty_or_result`、`risk_pattern`、`business_lessons`。
- IP 类字段。
- 进出口类字段。
- `recommended_actions` 必须具体。

### Task D：增加质量过滤和模块截断

要求：

- 无 `source_url` 删除。
- 缺少类型必需字段删除或要求 DeepSeek 修复。
- 空泛建议删除。
- 非法规模块最多 3 条。
- 没有高质量内容不硬凑。

### Task E：更新 HTML 和飞书展示

要求：

- HTML 按模块展示。
- 法规展示：变化点、法务拆解、影响范围、合规动作、截止节点。
- 案例展示：案情、违法逻辑、处罚/结果、业务启示、排查动作。
- 飞书卡片展示重点风险和动作，不展示原始新闻。

### Task F：最终验证和线上测试

本地验证：

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
node worker/test-runner.js
node --check worker/index.js
```

线上：

- `wrangler deploy`
- 访问 `/test`
- 查看飞书卡片
- 打开 `/report/latest`
- 打开 `/report`

注意：之前 `wrangler whoami` 报错：

```text
Failed to fetch auth token: Connect Timeout Error
attempted address: dash.cloudflare.com:443
Not logged in.
```

需要先恢复 Cloudflare 登录或网络。

## 9. 当前本地验证命令

当前版本已通过：

```bash
python3 scripts/extract_sources.py "/Users/zhuxinfei/Downloads/美妆行业新法律法规、违法案例公众号_网站收录 +2026.5.24.xlsx" worker/sources.json
node worker/test-runner.js
node --check worker/index.js
```

但 v1.1 尚未实现，不能把当前版本视为最终满足需求。

## 10. 给其他工具的执行提示

如果用 Codex 或其他工具继续，请从这里开始：

1. 先读本文件。
2. 再读：
   - `docs/superpowers/specs/2026-05-24-beauty-legal-intelligence-v1-1-design.md`
   - `worker/index.js`
   - `scripts/extract_sources.py`
   - `worker/test-runner.js`
3. 不要推倒重写。
4. 在现有 Worker 架构上增量实现 v1.1。
5. 每一步都先加测试再改代码。
6. 不要把公众号当可稳定抓取源。
7. 不要输出无加工新闻摘要。
8. 最终用户是美妆公司法务人员。
