# 钉钉配置说明

当前版本先使用今天测试的钉钉企业、机器人和知识库。后续切换到正式钉钉企业应用时，不需要改代码，只替换配置。

## 当前测试配置

- 机器人关键词：`美妆法务资讯`
- 知识库入口：`https://alidocs.dingtalk.com/i/spaces/3YxXA9e5bv7NDXNy/overview`
- 非敏感默认值：
  - `worker/wrangler.toml` 的 `DINGTALK_DOC_URL`
  - `.github/workflows/weekly.yml` 的 `DINGTALK_DOC_URL`

以下信息不要写入仓库，均通过 GitHub Secrets 或 Wrangler Secrets 配置：

- `DINGTALK_WEBHOOK_URL`
- `DINGTALK_SECRET`
- `DINGTALK_CLIENT_ID`
- `DINGTALK_CLIENT_SECRET`
- `DINGTALK_OPERATOR_ID`
- `DINGTALK_WORKSPACE_ID`

## 切换正式钉钉应用

1. 在钉钉开放平台创建或选择正式企业内部应用。
2. 确认应用权限至少包含：
   - `Wiki.Workspace.Read`
   - `Wiki.Node.Read`
   - `Document.WorkspaceDocument.Read`
   - `Document.WorkspaceDocument.Write`
   - `Storage.File.Write`
   - `qyapi_get_department_member`
3. 发布应用，并确认应用在目标企业组织内可用。
4. 获取正式应用信息：
   - Client ID
   - Client Secret
   - 操作人 `operatorId`
   - 目标知识库 `workspaceId`
5. 在 GitHub Actions Secrets 中替换：
   - `DINGTALK_CLIENT_ID`
   - `DINGTALK_CLIENT_SECRET`
   - `DINGTALK_OPERATOR_ID`
   - `DINGTALK_WORKSPACE_ID`
   - `DINGTALK_WEBHOOK_URL`
   - `DINGTALK_SECRET`，如机器人未加签可留空
6. 如果正式知识库入口不同，同步修改：
   - `.github/workflows/weekly.yml` 中的 `DINGTALK_DOC_URL`
   - `worker/wrangler.toml` 中的 `DINGTALK_DOC_URL`

## 推送顺序

程序会按以下顺序执行：

1. 抓取和分析资讯。
2. 生成完整 Markdown 周报。
3. 生成风险雷达图片。
4. 创建并写入钉钉文档。
5. 文档写入成功后，才推送钉钉群摘要卡片。

如果钉钉文档未写入成功，群摘要不会发送。
