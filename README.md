# 美妆电商法务资讯每日推送机器人

每天自动推送美妆电商行业法规变化、执法案例和法务洞察到飞书。

### 信息源：DeepSeek

由 DeepSeek 调研全球美妆法规动态，无需 NewsAPI。覆盖：
- 国家药监局 (NMPA) 化妆品备案/功效宣称/安全评估新规
- 各地市场监管部门行政处罚案例（直播带货/跨境电商）
- FDA MoCRA / EU 1223/2009 / 东盟化妆品指令
- 美妆品牌知识产权纠纷

### 日报内容

| 模块 | 说明 |
|------|------|
| 📌 今日重点关注 | ≤3 条最重大动态 |
| 📋 法规变化 | 新规 + 影响 + 行动建议 + 来源 |
| ⚖️ 案例警示 | 处罚 + 合规启示，电商标 🔥 |
| 💡 法务洞察 | 2-3 条可操作的合规建议 |

## 部署（Cloudflare Workers）

### 1. 准备

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

### 3. 部署

```bash
npx wrangler deploy
```

部署后每天 UTC 00:00（北京时间 08:00）自动推送。

### 4. 修改推送时间

编辑 `worker/wrangler.toml`，修改 cron 表达式（UTC 时间）：

```toml
[triggers]
crons = ["0 0 * * *"]   # UTC 00:00 = 北京时间 08:00
```

## 本地测试

```bash
pip install requests
python beauty_legal_bot.py --test   # 预览日报（不推送）
python beauty_legal_bot.py --push   # 推送到飞书
```

## 文件结构

```
beauty-legal-bot/
├── worker/
│   ├── index.js          # CF Worker（线上 24/7）
│   └── wrangler.toml     # Cron + KV 配置
├── beauty_legal_bot.py   # 本地测试脚本
└── requirements.txt
```

## 去重

CF Worker 通过 KV 存储每日指纹，7 天内相同内容不重复推送。

## API Key

| 服务 | 地址 |
|------|------|
| DeepSeek | https://platform.deepseek.com/api_keys |
| 飞书机器人 | 群设置 → 群机器人 → 自定义机器人 |
