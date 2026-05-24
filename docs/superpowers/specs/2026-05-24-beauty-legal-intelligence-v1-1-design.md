# 美妆法务资讯雷达 v1.1 修订设计

## 1. 修订目标

本修订不是推倒重做，而是在现有 `beauty-legal-bot` Worker 架构上补齐信息源建模和内容加工能力。

核心用户是美妆公司法务人员。产品输出不是新闻列表，而是可供法务、注册、供应链、电商、市场团队行动的美妆法务情报周报。

本次修订目标：

- 明确 Excel 只是信息源目录，不是资讯内容。
- 按 Excel 中的几个业务模块组织最终报告。
- 每个模块只放少量高质量信息；宁缺毋滥，没有高质量信息可以不放或显示“本周无高价值更新”。
- 法规动态、处罚案例、判决、IP、进出口内容必须经过法务拆解，不能原样搬运信息。
- 修正公众号源识别：公众号不直接爬历史文章，而是作为选题线索。
- 借鉴同类开源项目和监管情报产品的成熟模式，但不引入重型系统。

## 2. 外部项目参考与取舍

### 2.1 AI News Radar 类

参考对象：Horizon、agents-radar、ai-news-radar。

可借鉴能力：

- 多源采集后统一成候选 item。
- 先规则粗筛，再由 LLM 评分和摘要。
- 输出页面、RSS、Webhook、邮件等多渠道结果。
- 保留历史报告和可追溯来源。

不直接采用原因：

- 通用新闻雷达偏科技资讯，不符合美妆法务垂直场景。
- 依赖和部署链路偏重；当前目标是 Cloudflare Worker 轻量部署。

### 2.2 网页变化监控类

参考对象：changedetection.io、Huginn。

可借鉴能力：

- 对没有 RSS 的监管官网保存页面 hash 或正文摘要。
- 只有页面变化时进入候选池。
- 记录 source health，便于排查长期失败源。

不直接采用原因：

- 完整部署 changedetection.io 或 Huginn 会增加服务器和维护成本。
- 第一版先用 Worker 内轻量抓取，后续可按源增加 change detection。

### 2.3 RSS 桥接类

参考对象：RSSHub、RSS-Bridge。

可借鉴能力：

- 对有 RSS 或可桥接 RSS 的源优先使用 RSS。
- RSS item 通常自带标题、链接、时间，比网页链接抽取稳定。

不直接采用原因：

- 公共 RSSHub/RSS-Bridge 实例稳定性不可控。
- 自建实例会增加部署复杂度。
- 作为可选 source adapter，而不是强依赖。

### 2.4 商业监管情报平台

参考对象：RegPulse、RegASK、Polzia、Regology、Responsiv。

可借鉴能力：

- 风险评级。
- 影响范围。
- 截止日期和关键节点。
- 行动清单。
- 原文链接和审计留痕。

本项目应吸收其产品形态：输出法务情报，而不是新闻摘要。

## 3. 信息源角色

### 3.1 Excel 的定位

Excel 是 source catalog 的原始输入，只用于告诉程序“去哪里看”和“这些源大概属于哪个模块”。

Excel 不直接决定最终报告内容，最终报告必须来自抓取候选、公开原文链接和 DeepSeek 加工后的结构化分析。

### 3.2 信息源类型

`sources.json` 中每条源应包含：

```json
{
  "id": "src-001-nmpa",
  "name": "国家药品监督管理局",
  "url": "https://www.nmpa.gov.cn/",
  "module": "新规/修订/废止/生效提醒",
  "region": "亚洲",
  "country": "中国",
  "source_type": "official_site",
  "authority_type": "regulator",
  "priority": "high",
  "topics": ["化妆品", "备案", "标签", "功效宣称"]
}
```

`source_type` 取值：

- `official_site`：药监局、市监局、海关、法院、FDA、BPOM 等官方/监管源。
- `industry_site`：行业媒体、协会、专业服务机构、知识产权机构等公开网站。
- `rss`：RSS/Atom/JSON feed。
- `wechat_public_account`：公众号名称或公众号入口，不直接抓取历史文章。
- `manual_link`：人工维护的具体公开链接，包括具体公众号文章链接、官方公告链接、案例链接。

### 3.3 公众号处理

公众号不作为可稳定抓取源。只凭公众号名称，程序不能可靠获取历史文章，也不应绕过登录、验证码或反爬限制。

处理规则：

- Excel 中 `url = "微信公众号"`，或名称/URL 包含 `公众号`、`微信`、`mp.weixin.qq.com`、`weixin`，应识别为 `wechat_public_account`。
- `wechat_public_account` 不执行网页 fetch，不记为抓取失败。
- 公众号源转换成 `leads[]`，作为 DeepSeek 的选题线索。
- DeepSeek 可以参考公众号名称和 topics 判断近期应关注方向，但最终报告条目必须回到官方或公开网页原文。
- 如果只有公众号线索、找不到公开原文链接，则不进入最终报告。
- 如果后续人工提供具体 `https://mp.weixin.qq.com/s/...` 文章链接，可作为 `manual_link` 低优先级候选，但仍需标明来源可信度。

## 4. 模块组织

最终页面按 Excel/业务模块组织，而不是按来源类型组织。

模块固定为：

1. 新规 / 修订 / 废止 / 生效提醒
2. 广告合规及处罚案例
3. 美妆行业动态
4. 知识产权动态
5. 进出口 / 跨境电商动态

每个模块规则：

- 新规 / 修订 / 废止 / 生效提醒：相关且高价值的法规节点尽量完整收录，不硬性限制 2-3 条。
- 其他模块：每模块最多 2-3 条。
- 没有高质量内容时，该模块可以不显示；如需要保持模块稳定，也可显示“本周无高价值更新”。
- 禁止为了凑数加入低价值、无原文链接、无行动建议的信息。

## 5. 采集与加工链路

### 5.1 数据流

```text
Excel
  → scripts/extract_sources.py
  → worker/sources.json
  → source adapters
      official_site / industry_site: fetch HTML + extract links
      rss: parse feed items
      manual_link: direct candidate
      wechat_public_account: lead only
  → candidates[] + leads[]
  → DeepSeek 结构化筛选与法务拆解
  → 类型化 JSON report
  → 模块级截断和去重
  → HTML 完整页面 + 飞书摘要卡片
  → KV 保存 latest、dated report、index、30 天 item 指纹
```

### 5.2 Candidate 与 Lead

`candidates[]` 是可进入最终报告的候选，必须有公开 URL：

```json
{
  "title": "国家药监局发布化妆品安全评估相关通知",
  "url": "https://example.gov.cn/notice/123",
  "source_name": "国家药监局",
  "source_type": "official_site",
  "module": "新规/修订/废止/生效提醒",
  "region": "亚洲",
  "country": "中国",
  "published_at": "2026-05-24",
  "snippet": "页面摘要",
  "authority_type": "regulator",
  "priority": "high",
  "topics": ["化妆品", "安全评估"]
}
```

`leads[]` 是线索，不可直接进入最终报告：

```json
{
  "name": "化妆品观察",
  "source_type": "wechat_public_account",
  "module": "美妆行业动态",
  "country": "中国",
  "topics": ["化妆品", "监管", "处罚案例"]
}
```

DeepSeek prompt 必须声明：leads 只能帮助判断关注方向，不能作为事实来源。

## 6. 内容必须做法务拆解

DeepSeek 不是新闻摘要助手，而是美妆公司法务情报分析助手。

最终条目必须回答：

- 发生了什么？
- 来源是否可信？
- 属于哪个法规/案例/IP/进出口风险类型？
- 对哪些国家、渠道、品类、SKU、团队有影响？
- 是否有生效日、反馈截止日、整改期限、认证节点？
- 法务、注册、供应链、电商、市场团队分别要做什么？
- 为什么这条值得进入周报？

空泛输出禁止进入最终报告，例如：

- “建议关注”
- “企业应留意”
- “可能产生影响”
- “需持续观察”

除非同时给出具体动作、责任团队和触发条件。

## 7. 类型化 JSON Schema

### 7.1 通用字段

每条 item 必须包含：

```json
{
  "type": "法规|案例|动态|IP|进出口",
  "module": "模块名称",
  "region": "区域",
  "country": "国家",
  "title": "标题",
  "source_name": "来源名称",
  "source_url": "公开原文链接",
  "published_at": "发布日期或未知",
  "risk_level": "high|medium|low",
  "why_it_matters": "为什么值得法务关注",
  "recommended_actions": ["具体动作"],
  "owner_teams": ["法务", "注册", "供应链"],
  "confidence": "high|medium|low"
}
```

没有 `source_url` 的 item 不能进入最终报告。

### 7.2 法规类字段

法规、修订、废止、征求意见、生效提醒必须包含：

```json
{
  "status": "征求意见|正式发布|生效提醒|修订|废止",
  "effective_date": "生效日或未知",
  "feedback_deadline": "反馈截止日或未知",
  "regulatory_area": "备案|注册|标签|功效宣称|配方|原料|广告|进出口|认证",
  "what_changed": ["变化点"],
  "legal_obligation": ["新增或变化的企业义务"],
  "affected_business": ["影响市场、渠道、品类、SKU、团队"],
  "next_deadline": "下一关键日期或未知"
}
```

页面展示名称：

- 变化点
- 法务拆解
- 影响范围
- 合规动作
- 截止节点

### 7.3 案例类字段

行政处罚、判决、召回、通报必须包含：

```json
{
  "case_type": "行政处罚|民事判决|刑事案件|召回|监管通报",
  "parties": "涉事主体或未知",
  "facts": ["案情事实"],
  "violation_logic": ["监管/法院认定逻辑"],
  "penalty_or_result": ["处罚、判决或处理结果"],
  "risk_pattern": "功效宣称|虚假广告|标签瑕疵|未备案|IP侵权|进口不合规|平台规则",
  "business_lessons": ["对公司业务的启示"]
}
```

页面展示名称：

- 案情
- 违法逻辑
- 处罚/结果
- 业务启示
- 排查动作

### 7.4 IP 类字段

IP 动态必须包含：

```json
{
  "dispute_focus": "争议焦点",
  "protected_element": "商标|包装|外观设计|文案|品牌名",
  "infringement_logic": ["侵权或不正当竞争认定逻辑"],
  "impact_on_brand_assets": ["对包装、命名、素材、达人内容的影响"]
}
```

### 7.5 进出口类字段

进出口 / 跨境电商必须包含：

```json
{
  "market_access_change": ["准入或清关变化"],
  "affected_import_flow": ["影响的进口、清关、平台流程"],
  "documents_needed": ["需要准备或更新的文件"],
  "deadline": "截止日或未知"
}
```

## 8. 模块数量与质量控制

DeepSeek 输出后，Worker 进行代码层过滤：

1. 删除无 `source_url` 的 item。
2. 删除缺少类型必需拆解字段的 item。
3. 删除 `recommended_actions` 为空或只有空泛表述的 item。
4. 删除 `confidence = low` 且不是法规关键节点的 item。
5. 按 `source_url` 去重；无 URL 时用 `type + country + normalized title` 兜底。
6. 按模块排序和截断：
   - 新规 / 修订 / 废止 / 生效提醒：保留全部高质量法规节点。
   - 其他模块：最多 3 条。
7. 如果模块没有剩余高质量 item，则不显示或显示“本周无高价值更新”。

## 9. 页面与飞书展示

### 9.1 完整页面

完整页面按模块展示。每条内容展示加工后的法务拆解，不显示原始无加工摘要。

法规类示例：

```text
[法规][亚洲-中国][征求意见] NMPA 发布 示例事项
原文：国家药监局
时间：发布日；反馈截止日；生效日

变化点：
- 新增 示例事项 要求
- 调整 示例事项 备案材料

法务拆解：
- 属于标签/备案合规变化
- 对在售 SKU 和新品上市均有影响

影响范围：
- 市场：中国
- 品类：防晒 / 美白 / 普通护肤
- 团队：法务、注册、市场

合规动作：
- 注册团队核查备案资料
- 市场和电商暂停使用不匹配话术
- 法务更新审核 checklist
```

案例类示例：

```text
[案例][亚洲-中国][行政处罚] 直播功效宣称被罚
原文：上海市监局

案情：
- 直播间宣称 示例事项
- 备案资料无法支持该表述

违法逻辑：
- 监管以直播录屏、详情页、备案资料不一致作为证据
- 认定构成无法证明的功效宣称

处罚/结果：
- 罚款 示例事项
- 责令停止发布相关广告

业务启示：
- 达人口播需纳入 claim library
- 电商详情页、短视频、直播间话术需一致

排查动作：
- 抽查 Top 20 SKU 的直播脚本
- 市场提交达人脚本审核留痕
```

### 9.2 飞书摘要

飞书卡片只展示加工后的重点动作，不展示全文。

```text
⚖️ 美妆法务周报 · 2026-05-25

本周重点风险：
1. [法规][印尼] 清真认证进入关键节点
   动作：注册/供应链排查印尼 SKU 认证状态

2. [案例][中国] 直播功效宣称处罚持续高发
   动作：抽查 Top SKU 直播脚本与备案资料一致性

查看完整拆解：/report/latest
```

## 10. 验证要求

本次修订实现后必须验证：

- Excel 中 `url = "微信公众号"` 的源被标为 `wechat_public_account`。
- 公众号源进入 `leads[]`，不进入 `candidates[]`，不记为抓取失败。
- DeepSeek prompt 同时包含 `candidates[]` 和 `leads[]`。
- 最终报告 item 必须有公开 `source_url`。
- 法规类 item 缺少 `what_changed`、`legal_obligation`、`affected_business`、`recommended_actions` 时会被过滤或要求修复。
- 案例类 item 缺少 `facts`、`violation_logic`、`penalty_or_result`、`business_lessons` 时会被过滤或要求修复。
- 每个非法规模块最多 3 条。
- 没有高质量内容时不硬凑。
- HTML 页面按模块展示拆解结果。
- 飞书卡片只展示重点风险和动作，并链接完整页面。

## 11. 不做事项

本修订不做：

- 自动爬取微信公众号历史文章。
- 绕过微信登录、验证码、反爬机制。
- 引入 NewsAPI、搜索 API 或其他额外付费信息源。
- 部署 changedetection.io、Huginn、RSSHub 或 RSS-Bridge 作为强依赖。
- 将普通美妆新闻、融资、新品、代言、营销活动纳入周报。

## 12. 实施策略

保留现有 Worker 和 KV 架构，只做增量修正：

1. 修正 `extract_sources.py` 的 source_type 和模块识别。
2. 增加 `leads[]` 生成逻辑。
3. 增加 RSS/manual_link adapter 的接口边界，第一版可先实现 manual_link 和公开网页。
4. 扩展 DeepSeek prompt 和 JSON schema。
5. 增加类型化校验和低质量过滤。
6. 增加模块级截断。
7. 调整 HTML 渲染字段。
8. 调整飞书摘要为“风险 + 动作”。
9. 补测试并运行全流程验证。
