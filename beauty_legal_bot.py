#!/usr/bin/env python3
"""
美妆电商法务资讯每日推送机器人
--------------------------------
管道: DeepSeek 调研分析 → 飞书推送
用法: python beauty_legal_bot.py --test  # 预览日报
      python beauty_legal_bot.py --push  # 生成并推送到飞书

推荐部署: CF Workers（见 worker/ 目录），本脚本用于本地测试预览
"""

import os, sys, json, logging, argparse
from datetime import datetime
from pathlib import Path

APP_NAME = "beauty_legal_bot"
CONFIG_DIR = Path.home() / f".{APP_NAME}"
CONFIG_FILE = CONFIG_DIR / "config.json"

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger(APP_NAME)

DEEPSEEK_API = "https://api.deepseek.com/chat/completions"

SYSTEM_PROMPT = """你是一位资深美妆/化妆品电商法务总监，就职于一家跨境电商美妆企业。
公司业务覆盖四大市场：中国、欧美、东南亚、大洋洲。各市场均等关注。
你的任务是**调研并撰写**一份今日美妆行业法规资讯日报。

## 调研要求
请基于你对全球美妆法规的专业知识，梳理最近 7 天内的重要动态：

### 🇨🇳 中国
- NMPA（国家药监局）：化妆品注册备案、功效宣称、标签管理、安全评估、禁限用物质清单
- 市场监管/海关：跨境电商化妆品合规、进出口政策
- 直播带货/社交电商：虚假宣传、功效宣称处罚案例

### 🇪🇺 欧美
- EU 1223/2009 修订动态、ECHA 化妆品相关物质评估、SCCS 安全意见
- FDA MoCRA 实施进展、设施注册、产品列名截止

### 🌏 东南亚
- 东盟化妆品指令 (ACD) 更新：禁限用物质清单、标签要求
- **印尼 BPOM**：化妆品备案/注册、清真认证 (Halal) 强制要求
- 泰国 FDA、越南 DAV、菲律宾 FDA、马来西亚 NPRA 化妆品准入变化

### 🦘 大洋洲
- 澳大利亚 AICIS：化妆品原料评估与登记
- 新西兰 EPA：化妆品产品组标准更新
- 澳新防晒霜标准 AS/NZS 2604 更新动态

### 信息来源
优先引用官方来源（NMPA、各地药监局、FDA、EU Official Journal、BPOM、AICIS等）。
如果不确定某条信息的真实 URL，请注明来源机构名称，但不要编造 URL。

## 铁律
- 只保留与美妆/化妆品直接相关的法规变化和案例
- 新品上市、融资、营销活动、代言人 → 不要
- 与美妆无关的内容 → 不要
- 超过 10 天的旧闻 → 不要
- **严禁编造 URL**：不确定的只写来源机构名
- 每个区域至少尝试覆盖，确实没有就说"近期无重大变化"

## 输出格式（600-800 字，每条有实质内容）

**🇨🇳 中国**（1-2 条，标 [法规] 或 [案例]）

[法规] **{标题}**
- 内容：{什么法规、谁发布、何时生效、核心条款}
- 影响范围：{涉及哪些品类/渠道/市场、受影响企业类型}
- 行动建议：{法务部应该做什么}

[案例] **{标题}**
- 案情：{谁、做了什么、违反了哪条法规}
- 处罚/判决：{金额、措施、法律定性}
- 拆解分析：{为什么会被罚、执法逻辑是什么、透露出什么监管信号}
- 合规启示：{我们的业务是否存在同样风险、如何规避}

**🇪🇺 欧美**（1-2 条，格式同上）

**🌏 东南亚**（1-2 条，格式同上）

**🦘 大洋洲**（0-1 条，格式同上，无则跳过）

## 格式规则
- 不设单独的"重点关注"或"行动建议"模块——内容都在分区条目里
- 每条给足背景和判断，"发生什么、关我什么事、我要做什么"
- 没有重大变化就说"近期无重大法规变化"
- 链接用文字超链接 [来源](url)，严禁裸 URL"""


def load_config():
    if CONFIG_FILE.exists():
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    return {}


def call_deepseek(api_key, model="deepseek-chat"):
    import requests as req
    today = datetime.now().strftime("%Y年%m月%d日")

    for attempt in range(3):
        try:
            resp = req.post(
                DEEPSEEK_API,
                headers={"Authorization": f"Bearer {api_key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": f"今天是 {today}。直接输出日报，禁止任何开场白。"},
                    ],
                    "temperature": 0.3,
                    "max_tokens": 2048,
                },
                timeout=120,
            )
            if resp.status_code == 200:
                return resp.json()["choices"][0]["message"]["content"]
            log.error(f"DeepSeek {resp.status_code}: {resp.text[:300]}")
            if attempt < 2:
                import time; time.sleep(2 ** attempt)
        except Exception as e:
            log.error(f"DeepSeek error: {e}")
            if attempt < 2:
                import time; time.sleep(2 ** attempt)
    return None


def send_to_feishu(webhook_url, content):
    import requests as req
    today = datetime.now().strftime("%Y-%m-%d")
    card = {
        "config": {"wide_screen_mode": True},
        "header": {"title": {"tag": "plain_text", "content": f"⚖️ 美妆法务日报 · {today}"}, "template": "blue"},
        "elements": [
            {"tag": "div", "text": {"tag": "lark_md", "content": content}},
            {"tag": "hr"},
            {"tag": "note", "elements": [{"tag": "plain_text", "content": f"🤖 DeepSeek AI · {today}"}]},
        ],
    }
    try:
        resp = req.post(webhook_url, json={"msg_type": "interactive", "card": card}, timeout=30)
        if resp.status_code == 200:
            body = resp.json()
            ok = body.get("code") == 0 or body.get("StatusCode") == 0
            if ok:
                log.info("飞书推送成功")
            else:
                log.error(f"飞书错误: {body}")
            return ok
        log.error(f"飞书 {resp.status_code}")
        return False
    except Exception as e:
        log.error(f"飞书异常: {e}")
        return False


def main():
    parser = argparse.ArgumentParser(description="美妆电商法务资讯推送机器人")
    parser.add_argument("--test", action="store_true", help="生成并预览日报（不推送）")
    parser.add_argument("--push", action="store_true", help="生成日报并推送到飞书")
    args = parser.parse_args()

    if not args.test and not args.push:
        parser.print_help()
        return

    cfg = load_config()
    api_key = cfg.get("deepseek_api_key", "")
    webhook_url = cfg.get("feishu_webhook_url", "")
    model = cfg.get("deepseek_model", "deepseek-chat")

    if not api_key:
        log.error("未配置 deepseek_api_key")
        sys.exit(1)

    log.info("DeepSeek 调研中...")
    report = call_deepseek(api_key, model)
    if not report:
        log.error("生成失败")
        sys.exit(1)

    log.info(f"完成，{len(report)} 字符")
    print("\n" + "=" * 60)
    print(report)
    print("=" * 60)

    if args.push:
        if not webhook_url:
            log.error("未配置 feishu_webhook_url")
            sys.exit(1)
        log.info("推送到飞书...")
        ok = send_to_feishu(webhook_url, report)
        print("推送成功 ✅" if ok else "推送失败 ❌")


if __name__ == "__main__":
    main()
