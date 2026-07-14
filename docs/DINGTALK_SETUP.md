# 钉钉群机器人配置说明

当前版本只依赖钉钉自定义群机器人，不创建或写入钉钉知识库文档。

## 必需配置

在目标钉钉群中添加自定义机器人，并把以下值配置为 GitHub Actions Secrets 或 Wrangler Secrets：

- `DINGTALK_WEBHOOK_URL`：机器人 webhook 完整地址。
- `DINGTALK_SECRET`：仅当机器人启用“加签”安全设置时需要；未启用时可留空。

机器人使用自定义关键词校验时，关键词应包含 `美妆法务资讯`。程序的每条消息标题都会包含该关键词。

不要把 webhook、access token 或签名密钥写入仓库、配置文件或日志。

## GitHub Actions

在仓库的 `Settings -> Secrets and variables -> Actions` 中配置：

1. `AI_API_KEY`
2. `DINGTALK_WEBHOOK_URL`
3. `DINGTALK_SECRET`，如未启用加签可不配置
4. `CLOUDFLARE_API_TOKEN`，仅部署 Worker 时需要

GitHub Actions 不需要 `DINGTALK_CLIENT_ID`、`DINGTALK_CLIENT_SECRET`、`DINGTALK_OPERATOR_ID` 或 `DINGTALK_WORKSPACE_ID`。

## 推送版式

程序每轮只发送一条 Markdown 消息，内容顺序为：本周总览、管理层行动看板、中国优先条目、六个业务模块和来源链接。

每个模块内优先展示中国信息，再展示其他国家和地区；同一国家内继续按风险、行业影响、直接相关性和可信度排序。没有高质量内容的模块显示“本周无高置信更新”，不填充低质量资讯。

消息最大为 18,000 UTF-8 字节。超限时程序在同一条消息内逐级压缩低优先级条目，必要时省略最低分条目并标注数量；不会拆成多个卡片。六个模块标题、中国优先顺序和所有保留条目的原文链接必须保留。

看板图片固定为 1080×1440 PNG。每次推送使用 `/assets/decision-map/YYYY-MM-DD.png` 日期版 URL；`latest` 仅用于运维诊断，不能放进钉钉正文。

## 来源恢复与覆盖率

- 网络错误、超时、429 和 5xx 会进行有界重试。
- 直接请求仍失败或页面只是空的 JavaScript shell 时，GitHub Actions 使用同一个 Playwright Chromium 实例读取公开页面。
- 浏览器仍失败后，只尝试 `worker/sources.json` 中已经确认属于同一官方机构的 `alternate_urls`。
- 登录、验证码、付费墙、IP 白名单和明确拒绝访问属于终止失败；程序记录原因，但不绕过访问控制。
- `required` 源在 GitHub Runner 上已验证可稳定抓取；中国高优先级 required 源覆盖率必须为 100%，全部 required 源覆盖率必须至少为 90%。
- 明确受 403/412、失效地址、空壳页或间歇超时影响的来源标为 `monitor_only`：每轮仍尝试恢复，成功时纳入候选，失败时在单卡和看板中披露，但不混入 required 分母。
- 页面成功读取但本周没有相关候选记为 `empty`，属于正常零更新；公众号线索不计入覆盖率分母。

required 覆盖率不达标不是“低质量成功”，而是采集失败：流程在调用 AI 和钉钉前退出。运维人员应同时查看 workflow 中每个来源的 attempts、最终错误、recovery method 和受限监测源数量，修复来源配置或加入已核验的官方备用地址后再运行。

## 成功与失败

- 唯一一条 Markdown 消息收到钉钉成功响应，整次通知才标记为成功。
- 网络错误、限流和服务端错误最多尝试三次。
- 鉴权、签名、关键词等业务错误立即停止，并让任务以失败退出。
- 图片必须先写入日期版 Cloudflare KV，并从公开 URL 回读确认是有效 PNG；验证通过后才允许调用钉钉。
- 只有图片发布、健康检查和钉钉发送全部成功后才写入 30 天去重记录。
- 报告生成后会先保存 Markdown 和 JSON；群推送失败时保留文件用于排查。

切换到正式客户群时，只需替换 `DINGTALK_WEBHOOK_URL` 和对应的 `DINGTALK_SECRET`，不需要修改代码。
