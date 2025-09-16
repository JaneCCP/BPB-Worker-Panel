# KV 自动配置说明

## 🎯 新功能特性

现在 `deploy.js` 支持自动创建和管理 KV 命名空间，无需手动配置 KV ID！

## 📋 环境变量配置

### 必需的环境变量：
```bash
CLOUDFLARE_API_TOKEN=your-api-token
CLOUDFLARE_ACCOUNT_ID=your-account-id  
CLOUDFLARE_WORKER_NAME=your-worker-name
```

### 可选的 KV 配置：
```bash
CLOUDFLARE_KV_NAME=your-kv-database-name
```

## 🔄 自动化流程

### 1. **KV 命名空间检查**
- 如果设置了 `CLOUDFLARE_KV_NAME`，脚本会自动检查是否存在同名的 KV 命名空间
- 如果存在，直接使用现有的命名空间
- 如果不存在，自动创建新的命名空间

### 2. **自动绑定**
- 获取到 KV 命名空间 ID 后，自动绑定到 Worker
- 在 Worker 中可以通过 `kv` 变量访问 KV 存储

### 3. **容错处理**
- 如果 KV 配置失败，不会阻止 Worker 部署
- 会显示详细的错误信息，便于调试

## 📝 使用示例

### GitHub Actions 环境变量设置：
```yaml
env:
  CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  CLOUDFLARE_WORKER_NAME: bpb-worker-panel
  CLOUDFLARE_KV_NAME: BPB-Worker-Storage  # 可选，如果不设置则不创建 KV
```

### 本地开发环境：
```bash
export CLOUDFLARE_API_TOKEN="your-token"
export CLOUDFLARE_ACCOUNT_ID="your-account-id"
export CLOUDFLARE_WORKER_NAME="my-worker"
export CLOUDFLARE_KV_NAME="My-KV-Database"  # 可选
```

## ✅ 优势

1. **简化配置**：不再需要手动创建 KV 命名空间和记录 ID
2. **自动化**：一键部署，自动处理 KV 创建和绑定
3. **幂等性**：多次运行不会重复创建，安全可靠
4. **容错性**：KV 配置失败不影响 Worker 部署
5. **透明性**：详细的日志输出，便于监控和调试

## 🔧 迁移指南

### 从旧版本迁移：
1. 移除 `CLOUDFLARE_KV_ID` 环境变量
2. 添加 `CLOUDFLARE_KV_NAME` 环境变量（设置为你想要的数据库名称）
3. 重新运行部署脚本

### 示例：
```bash
# 旧配置（移除）
# CLOUDFLARE_KV_ID=0f2ac74b498b48028cb68387c421e279

# 新配置（添加）
CLOUDFLARE_KV_NAME=BPB-Worker-Panel-Storage
```

## 📊 日志输出示例

```
🗄️ 检查 KV 命名空间配置...
📋 查找名为 "BPB-Worker-Storage" 的 KV 命名空间...
✅ 找到现有的 KV 命名空间！
   - 名称: BPB-Worker-Storage
   - ID: 0f2ac74b498b48028cb68387c421e279
🚀 使用官方SDK部署到Cloudflare Worker...
✅ Worker部署成功！
📋 部署信息:
   - Worker ID: my-worker
   - 部署时间: 2024/1/1 12:00:00
   - 启动时间: 150ms
   - 使用模式: bundled
   - 是否包含模块: 是
🗄️ 验证KV存储绑定...
✅ KV存储绑定验证成功！
📋 绑定信息:
   - 变量名: kv
   - 命名空间ID: 0f2ac74b498b48028cb68387c421e279
   - 数据库名称: BPB-Worker-Storage
```

现在你的 KV 配置完全自动化了！🎉