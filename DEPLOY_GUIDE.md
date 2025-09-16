# 🚀 Cloudflare Workers 自动化部署指南

## 📋 概述

`scripts/deploy.js` 是一个功能完整的 Cloudflare Workers 自动化部署脚本，使用官方 Cloudflare SDK 实现以下功能：

- ✅ **Worker 脚本部署**：自动部署 ES Module 格式的 Worker 脚本
- ✅ **KV 存储管理**：智能检测和创建 KV 命名空间，自动绑定
- ✅ **子域名配置**：自动启用 workers.dev 子域名访问
- ✅ **日志监控**：启用 Workers 日志和可观测性功能
- ✅ **错误处理**：完善的错误处理和重试机制
- ✅ **详细日志**：友好的部署过程日志输出

## 🔧 环境变量配置

### 必需变量

| 变量名 | 描述 | 示例 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API 令牌 | `your-api-token` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare 账户 ID | `your-account-id` |
| `CLOUDFLARE_WORKER_NAME` | Worker 名称 | `my-worker` |

### 可选变量

| 变量名 | 描述 | 默认行为 |
|--------|------|----------|
| `CLOUDFLARE_KV_NAME` | KV 数据库名称 | 未设置时跳过 KV 配置 |

### GitHub Actions 配置示例

```yaml
env:
  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  CLOUDFLARE_WORKER_NAME: ${{ secrets.CLOUDFLARE_WORKER_NAME }}
  CLOUDFLARE_KV_NAME: ${{ secrets.CLOUDFLARE_KV_NAME }}
```

### 本地开发配置

创建 `.env` 文件：
```bash
CLOUDFLARE_API_TOKEN=your-api-token
CLOUDFLARE_ACCOUNT_ID=your-account-id
CLOUDFLARE_WORKER_NAME=my-worker
CLOUDFLARE_KV_NAME=My-KV-Storage
```

## 🏗️ 部署流程

### 1. 环境检查阶段
```
🔍 环境变量检查:
   - CLOUDFLARE_API_TOKEN: ✅ 已设置
   - CLOUDFLARE_ACCOUNT_ID: ✅ 已设置
   - CLOUDFLARE_WORKER_NAME: ✅ my-worker
   - CLOUDFLARE_KV_NAME: ✅ My-KV-Storage
```

### 2. 脚本读取阶段
```
📦 读取Worker脚本文件...
   - 文件路径: /path/to/dist/worker.js
✅ Worker脚本读取成功！
   - 脚本大小: 371.52 KB
   - 脚本类型: ES Module
```

### 3. KV 命名空间管理
```
🗄️ 检查 KV 命名空间配置...
📋 查找名为 "My-KV-Storage" 的 KV 命名空间...
✅ 检测到已存在的 KV 命名空间！
   - 名称: My-KV-Storage
   - ID: 937fa6be95aa4f14a02f9cd07af45aee
📋 使用现有的 KV 命名空间，跳过创建步骤
```

### 4. Worker 部署阶段
```
🚀 开始部署到Cloudflare Workers...
✅ Worker部署成功！
📋 部署详细信息:
   - Worker名称: my-worker
   - Worker ID: worker-id
   - 部署时间: 2025/9/16 21:00:00
   - 启动时间: 4ms
   - 使用模式: standard
   - ES模块支持: ✅ 是
   - KV绑定: ✅ 已配置
```

### 5. 子域名配置阶段
```
🌐 配置Worker子域名访问...
📋 检查账户子域名配置...
✅ 检测到账户子域名: my-subdomain
📊 检查Worker子域名状态...
   - 子域名启用: ✅ 已启用
   - 预览功能: ❌ 未启用
✅ Worker子域名已处于启用状态，无需配置
🌐 Worker访问地址: https://my-worker.my-subdomain.workers.dev
```

### 6. KV 绑定验证阶段
```
🗄️ 验证KV存储绑定状态...
⏳ 等待API同步绑定信息...
📋 获取Worker配置信息... (尝试 1/3)
✅ KV存储绑定验证成功！
📋 KV绑定详细信息:
   - 绑定变量名: kv
   - 命名空间ID: 937fa6be95aa4f14a02f9cd07af45aee
   - 数据库名称: My-KV-Storage
   - 绑定类型: kv_namespace
```

### 7. 日志配置阶段
```
📊 检查Workers日志配置状态...
📋 获取当前日志设置...
✅ 检测到Workers日志已启用！
📋 当前日志配置详情:
   - 可观测性: ✅ 已启用
   - 日志记录: ✅ 已启用
   - 调用日志: ✅ 已启用
   - 采样率: 100%
   - Logpush: ❌ 未启用
```

### 8. 部署完成总结
```
🎉 部署流程全部完成！
📋 部署总结:
   - Worker名称: my-worker
   - KV存储: ✅ My-KV-Storage
   - 子域名访问: ✅ 已启用
   - 日志监控: ✅ 已启用

🚀 你的Worker现在已经可以正常使用了！
```

## 🔧 核心功能详解

### KV 命名空间智能管理

脚本会自动：
1. **检查现有命名空间**：查找是否已存在同名的 KV 命名空间
2. **智能创建**：如果不存在则自动创建新的命名空间
3. **自动绑定**：将 KV 命名空间绑定到 Worker（变量名：`kv`）
4. **容错处理**：KV 配置失败不会阻止 Worker 部署

### 子域名自动配置

- **账户子域名检查**：检查并创建账户级别的子域名
- **Worker 子域名启用**：为特定 Worker 启用 workers.dev 访问
- **预览功能控制**：默认禁用预览功能，只启用生产访问
- **访问地址显示**：自动显示完整的访问地址

### 日志和监控配置

自动启用以下功能：
- **可观测性**：启用 Workers 可观测性功能
- **日志记录**：启用详细的执行日志
- **调用日志**：记录每次函数调用
- **采样率**：设置为 100% 完整采样
- **Logpush**：默认禁用（可根据需要手动启用）

### 错误处理和重试机制

- **环境变量验证**：部署前检查必需的环境变量
- **API 同步等待**：KV 绑定验证前等待 API 同步
- **重试机制**：KV 绑定验证支持最多 3 次重试
- **详细错误信息**：提供清晰的错误原因和解决建议

## 📁 文件结构要求

```
project/
├── dist/
│   └── worker.js          # 编译后的 Worker 脚本
├── scripts/
│   └── deploy.js          # 部署脚本
└── package.json
```

## 🚀 使用方法

### 1. 直接运行
```bash
node scripts/deploy.js
```

### 2. 通过 npm 脚本
在 `package.json` 中添加：
```json
{
  "scripts": {
    "deploy": "node scripts/deploy.js"
  }
}
```

然后运行：
```bash
npm run deploy
```

### 3. GitHub Actions 集成
```yaml
- name: Deploy to Cloudflare Worker
  run: node scripts/deploy.js
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    CLOUDFLARE_WORKER_NAME: ${{ secrets.CLOUDFLARE_WORKER_NAME }}
    CLOUDFLARE_KV_NAME: ${{ secrets.CLOUDFLARE_KV_NAME }}
```

## 🔍 故障排除

### 常见问题

#### 1. 环境变量未设置
```
❌ 缺少必需的环境变量，无法继续部署
```
**解决方案**：检查并设置所有必需的环境变量

#### 2. KV 绑定验证失败
```
❌ 多次尝试后仍未检测到KV绑定配置
💡 可能原因:
   - API同步延迟，绑定可能需要更多时间生效
```
**解决方案**：这通常是 API 同步延迟，可以：
- 等待几分钟后重新运行
- 在 Cloudflare 控制台手动验证绑定状态
- 检查 API 令牌权限

#### 3. 子域名配置失败
```
⚠️ 无法创建账户子域名: error message
```
**解决方案**：
- 检查 API 令牌是否有足够权限
- 确认账户状态正常
- 手动在控制台配置子域名

#### 4. 脚本文件不存在
```
Error: ENOENT: no such file or directory, open 'dist/worker.js'
```
**解决方案**：
- 确保已运行构建命令生成 `dist/worker.js`
- 检查文件路径是否正确

### API 权限要求

API 令牌需要以下权限：
- **Workers Scripts**: Edit
- **Workers KV Storage**: Edit  
- **Zone Settings**: Edit (用于子域名配置)
- **Logs**: Edit (用于日志配置)

## 📊 性能和限制

### 脚本大小限制
- **免费版**：最大 1MB
- **付费版**：最大 10MB
- 当前脚本会显示实际大小以便监控

### KV 存储限制
- **命名空间数量**：免费版最多 3 个
- **键值对数量**：每个命名空间最多 100,000 个
- **值大小**：最大 25MB

### 部署频率限制
- **API 调用**：每分钟最多 1200 次
- **部署频率**：建议不超过每分钟 10 次

## 🔄 版本更新

### 更新脚本
1. 备份当前配置
2. 更新 `scripts/deploy.js`
3. 测试新功能
4. 更新环境变量（如需要）

### 兼容性
- **Node.js**：需要 18+ 版本
- **Cloudflare SDK**：使用 5.1.0+ 版本
- **ES Modules**：脚本使用 ES Module 格式

## 📞 支持和反馈

如果遇到问题或有改进建议：
1. 检查日志输出中的详细错误信息
2. 参考故障排除部分
3. 查看 Cloudflare 官方文档
4. 提交 Issue 或 Pull Request

---

**注意**：首次使用前请确保已正确配置所有环境变量，并且 Cloudflare API 令牌具有足够的权限。