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
| `CLOUDFLARE_KV_NAMESPACE_ID` | KV命名空间ID | Workers & Pages > KV > 命名空间详情 |

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

1. **手动触发**: 进入GitHub Actions页面，选择"Build and Release"工作流，点击"Run workflow"
2. **自动触发**: 工作流会在workflow_dispatch事件触发时运行

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