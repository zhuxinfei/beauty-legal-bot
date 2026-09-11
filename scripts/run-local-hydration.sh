#!/usr/bin/env bash
# 本机采集：discovery + hydration 在国内网络完成，产物推到单文件分支后触发 CI 组装发布。
#
# 为什么必须在本机跑（2026-09-10 定位）：
#   GitHub runner 是境外 IP，中国政务站的 WAF 会全量拦截。实测 nmpa.gov.cn 14/14、
#   customs.gov.cn 6/7 返回空正文（crawl_status=failed / empty-hydrated-body），
#   各省药监局 100% 失败。空正文记录在 assemble-cards.js 的第一步就被丢弃，
#   本轮因此丢掉 15 条 hard_fact_ready。同一批 URL 在本机（国内住宅 IP）探测
#   30 个域名有 21 个可抓，8 个种子源可展开为 41 条记录、39 条有正文。
#
#   注意 nmpa.gov.cn 与 customs.gov.cn 的阿里云 WAF 是 JS 挑战（HTTP 412 + acw_tc
#   限流 cookie），本机同样抓不到，且高频访问会连首页一起封。这两个源要另想办法，
#   不要靠调大并发或重试去撞。
#
# 网络出口分两步（方向相反）：
#   发现 —— 走代理（Google News RSS，境外）
#   水合 —— 直连（政务站，境内），显式 unset 代理变量
#
# 用法：
#   scripts/run-local-hydration.sh                # 采集 → 推产物 → 触发 CI
#   NO_TRIGGER=1 scripts/run-local-hydration.sh   # 只采集，本地看产物
#   NO_DELIVERY=1 scripts/run-local-hydration.sh  # 触发但只验收不推钉钉
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT=$(pwd)

PYTHON_BIN="${HYDRATE_PYTHON:-$ROOT/.venv-hydrate/bin/python}"
BRANCH="${HYDRATION_BRANCH:-hydration-latest}"
WORKFLOW="${WORKFLOW:-weekly.yml}"
WORKFLOW_REF="${WORKFLOW_REF:-feat/15-items-and-archive}"

if [ ! -x "$PYTHON_BIN" ]; then
  echo "找不到水合解释器：$PYTHON_BIN" >&2
  echo "本机系统 Python 是 3.9，crawl4ai 需要 3.10+。搭建方式：" >&2
  echo "  uv python install 3.11 && uv venv --python 3.11 .venv-hydrate" >&2
  echo "  uv pip install --python .venv-hydrate/bin/python -i https://pypi.tuna.tsinghua.edu.cn/simple crawl4ai" >&2
  echo "  .venv-hydrate/bin/python -m playwright install chromium" >&2
  exit 1
fi

mkdir -p out

echo "==> [1/4] 发现候选（走代理访问 Google News RSS）"
# CI 的 DISCOVERY_TOTAL_TIMEOUT_MS=180s 是按 runner 直连 Google 定的。本机每条查询
# 都要经代理，141 个查询跑到一半就被总预算掐断，整批返回 0 条
# （实测日志：Open-web discovery unavailable: open-web discovery timed out /
#   Discovery queries=0, raw=0，直接导致水合只能去抓固定栏目页、净新增为 0）。
export DISCOVERY_TOTAL_TIMEOUT_MS="${DISCOVERY_TOTAL_TIMEOUT_MS:-900000}"
export DISCOVERY_QUERY_TIMEOUT_MS="${DISCOVERY_QUERY_TIMEOUT_MS:-20000}"
node scripts/discover-open-web.js out/discovery.json out/acquisition-manifest.json

echo "==> [2/4] 水合正文（直连政务站，显式绕开代理）"
env -u ALL_PROXY -u HTTP_PROXY -u HTTPS_PROXY -u all_proxy -u http_proxy -u https_proxy \
  CRAWL4_AI_BASE_DIRECTORY="${CRAWL4_AI_BASE_DIRECTORY:-/tmp/beauty-legal-bot-crawl4ai}" \
  node scripts/crawl4ai-hydrate.js \
    --python "$PYTHON_BIN" \
    --input out/acquisition-manifest.json \
    --output out/hydrated-authority.json \
    --limit "${HYDRATE_LIMIT:-200}" \
    --page-timeout-ms "${PAGE_TIMEOUT_MS:-25000}" \
    --attachment-limit "${CRAWL4AI_ATTACHMENT_LIMIT:-2}"

echo "==> [2.5/4] 并入 EU Safety Gate 化妆品召回（官方周更，结构化，无反爬）"
node scripts/collect-safety-gate.js --days 15 --merge-into out/hydrated-authority.json \
  || echo "    Safety Gate 采集失败，跳过（不阻断）"

node -e '
const fs = require("fs");
const rows = JSON.parse(fs.readFileSync("out/hydrated-authority.json", "utf8")).records || [];
const withText = rows.filter(r => (r.article_text || "").length > 100).length;
const grades = {};
for (const r of rows) grades[r.evidence_grade || "?"] = (grades[r.evidence_grade || "?"] || 0) + 1;
console.log(`    records=${rows.length}, withText=${withText}`);
console.log(`    grades=${JSON.stringify(grades)}`);
'

if [ "${NO_TRIGGER:-0}" = "1" ]; then
  echo "NO_TRIGGER=1，停在此处。产物：out/hydrated-authority.json"
  exit 0
fi

echo "==> [3/4] 推送产物到分支 $BRANCH（单文件提交，force 覆盖，不留历史）"
blob=$(git hash-object -w out/hydrated-authority.json)
tree=$(printf '100644 blob %s\thydrated-authority.json\n' "$blob" | git mktree)
commit=$(GIT_AUTHOR_NAME=local-hydration GIT_AUTHOR_EMAIL=local@localhost \
         GIT_COMMITTER_NAME=local-hydration GIT_COMMITTER_EMAIL=local@localhost \
         git commit-tree "$tree" -m "hydration payload $(date +%Y-%m-%d)")
git push -f origin "$commit:refs/heads/$BRANCH"
echo "    已推送提交 $commit"

echo "==> [4/4] 触发 CI（组装 → 质检 → PDF → 发布）"
trigger_args=(-f "hydration_ref=$BRANCH")
if [ "${NO_DELIVERY:-0}" = "1" ]; then
  trigger_args+=(-f no_delivery=true)
fi
gh workflow run "$WORKFLOW" --ref "$WORKFLOW_REF" "${trigger_args[@]}"
echo "    已触发。进度：gh run list --limit 3"
