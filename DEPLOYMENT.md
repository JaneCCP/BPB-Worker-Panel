# Cloudflare Worker 自动部署配置指南

## 概述
本指南说明如何配置GitHub Actions工作流，实现构建后自动部署到指定的Cloudflare Worker。

## 所需GitHub Secrets配置

在GitHub仓库的Settings > Secrets and variables > Actions中添加以下secrets：

### 必需Secrets

| Secret名称 | 描述 | 获取方式 |
|-----------|------|----------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API令牌 | [Cloudflare Dashboard](https://dash.cloudflare.com/profile/api-tokens) |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare账户ID | Cloudflare Dashboard右侧栏 |
| `CLOUDFLARE_WORKER_NAME` | 目标Worker项目名称 | 你的Worker名称 |
| `CLOUDFLARE_KV_NAMESPACE_ID` | KV命名空间ID | **必须是32位ID，不是名称** |

### KV命名空间ID获取步骤

1. **登录Cloudflare Dashboard**
2. **进入Workers & Pages > KV**
3. **找到你的命名空间**（例如叫"test"）
4. **点击命名空间名称**进入详情页
5. **复制URL中的ID**或页面显示的32位ID

⚠️ **重要**：必须是类似 `1a2b3c4d5e6f7g8h9i0j1k2l3m4n5o6p` 的32位ID，不是"test"这个名称！

### 验证KV绑定
部署后可在GitHub Actions日志中查看生成的wrangler.toml文件，确认KV绑定配置是否正确。

1. 部署完成后，登录 [Cloudflare Dashboard](https://dash.cloudflare.com)
2. 进入 Workers & Pages → 你的Worker
3. 查看"设置"选项卡中的"KV命名空间绑定"
4. 应该能看到 `kv` 绑定到指定的命名空间

### KV绑定问题解决

如果部署后发现KV未绑定，可能是由于wrangler.toml配置结构问题。确保配置文件中：

- `kv_namespaces` 在 `env.production` 作用域内定义
- 使用 `[[env.production.kv_namespaces]]` 而不是顶层的 `[[kv_namespaces]]`

正确配置应该类似：
```toml
[env.production]
name = "your-worker"

[[env.production.kv_namespaces]]
binding = "kv"
id = "your-kv-namespace-id"
```

### 调试步骤
1. 检查GitHub Actions日志中的 `wrangler.toml` 内容是否正确
2. 确认KV命名空间ID是否为32位字符串
3. 验证Cloudflare账户是否有权限访问该KV命名空间
4. 如果仍有问题，请重新触发部署流程

### 可选Secrets

| Secret名称 | 描述 | 获取方式 |
|-----------|------|----------|
| `CLOUDFLARE_ROUTE_URL` | Worker路由URL（可选） | 例如: `your-worker.your-domain.com/*` |

> **注意**: `CLOUDFLARE_ROUTE_URL`是可选的。如果不提供，Worker将使用默认的workers.dev子域名部署。

## Cloudflare API Token配置

1. 访问 [Cloudflare API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. 点击"Create Token"
3. 使用"Custom token"模板
4. 配置权限：
   - **Account**: Cloudflare Workers:Edit
   - **Zone**: Zone:Read, Zone Settings:Read, Cloudflare Workers Routes:Edit
   - **Zone Resources**: 包含你的域名
   - **Account Resources**: 包含你的账户

## KV命名空间绑定

确保你的Worker项目中已经：
1. 创建了KV命名空间
2. 命名空间名称为 `test`
3. 在Worker设置中绑定了KV命名空间：
   - 变量名: `kv`
   - KV命名空间: 你创建的test命名空间

## 部署流程

### 手动触发部署

1. 进入GitHub仓库的 **Actions** 页面
2. 选择 **Build and Release** 工作流
3. 点击 **Run workflow** 按钮
4. 在弹出的表单中：
   - **Worker名称**（可选）：可以手动输入worker名称，留空则使用Secrets中的配置
   - 点击 **Run workflow** 开始部署

### 优先级说明

- **表单输入**：如果在Run workflow时填写了worker名称，将优先使用此值
- **Secrets配置**：如果表单留空，将使用`CLOUDFLARE_WORKER_NAME`中的配置

### 自动触发
工作流会在workflow_dispatch事件触发时运行，支持上述表单输入功能。

## 部署验证

部署成功后，你可以：
1. 访问配置的`CLOUDFLARE_ROUTE_URL`查看Worker是否正常运行
2. 在Cloudflare Dashboard的Workers页面查看部署状态
3. 检查GitHub Actions日志确认部署成功

## 故障排除

### 常见问题

1. **权限错误**: 检查API Token权限是否包含Workers编辑权限
2. **KV绑定错误**: 确认KV命名空间ID正确且已绑定到Worker
3. **路由错误**: 检查域名是否已正确配置到Cloudflare

### 验证步骤

```bash
# 本地验证wrangler配置
npx wrangler deploy --dry-run
```

## 安全注意事项

- 所有敏感信息都存储在GitHub Secrets中
- API Token使用最小权限原则
- 定期轮换API Token
- 不要在代码中硬编码任何敏感信息