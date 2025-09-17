import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Cloudflare from 'cloudflare';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 环境变量
const {
    CLOUDFLARE_API_TOKEN,
    CLOUDFLARE_ACCOUNT_ID,
    CLOUDFLARE_WORKER_NAME,
    CLOUDFLARE_KV_NAME  // KV 数据库名称，不再需要 CLOUDFLARE_KV_ID
} = process.env;

// 调试信息：显示环境变量状态
console.log('🔍 环境变量检查:');
console.log(`   - CLOUDFLARE_API_TOKEN: ${CLOUDFLARE_API_TOKEN ? '✅ 已设置' : '❌ 未设置'}`);
console.log(`   - CLOUDFLARE_ACCOUNT_ID: ${CLOUDFLARE_ACCOUNT_ID ? '✅ 已设置' : '❌ 未设置'}`);
console.log(`   - CLOUDFLARE_WORKER_NAME: ${CLOUDFLARE_WORKER_NAME ? `✅ ${CLOUDFLARE_WORKER_NAME}` : '❌ 未设置'}`);
console.log(`   - CLOUDFLARE_KV_NAME: ${CLOUDFLARE_KV_NAME ? `✅ ${CLOUDFLARE_KV_NAME}` : '⚠️ 未设置 (将跳过KV配置)'}`);
console.log('');

// 检查必需的环境变量
if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_WORKER_NAME) {
    console.error('❌ 缺少必需的环境变量，无法继续部署');
    process.exit(1);
}

// 文件路径
const WORKER_SCRIPT_PATH = join(__dirname, '..', 'dist', 'worker.js');

// 初始化 Cloudflare 客户端
const cloudflare = new Cloudflare({
    apiToken: CLOUDFLARE_API_TOKEN,
});

async function ensureKVNamespace() {
    // 如果没有配置 KV 数据库名称，跳过 KV 配置
    if (!CLOUDFLARE_KV_NAME) {
        console.log('⚠️ 未配置 CLOUDFLARE_KV_NAME，跳过 KV 命名空间配置');
        return null;
    }

    console.log('🗄️ 检查 KV 命名空间配置...');
    
    try {
        // 获取所有现有的 KV 命名空间
        console.log(`📋 查找名为 "${CLOUDFLARE_KV_NAME}" 的 KV 命名空间...`);
        
        const namespacesResponse = await cloudflare.kv.namespaces.list({
            account_id: CLOUDFLARE_ACCOUNT_ID,
            per_page: 100
        });
        const namespaces = namespacesResponse.result || [];
        
        // 查找是否已存在同名的命名空间
        const existingNamespace = namespaces.find(ns => ns.title === CLOUDFLARE_KV_NAME);
        
        if (existingNamespace) {
            console.log('✅ 检测到已存在的 KV 命名空间！');
            console.log(`   - 名称: ${existingNamespace.title}`);
            console.log(`   - ID: ${existingNamespace.id}`);
            console.log('📋 使用现有的 KV 命名空间，跳过创建步骤');
            return existingNamespace.id;
        }
        
        // 如果不存在，创建新的命名空间
        console.log('✅ 未检测到同名的 KV 命名空间');
        console.log('📝 开始创建新的 KV 命名空间...');
        const newNamespace = await cloudflare.kv.namespaces.create({
            account_id: CLOUDFLARE_ACCOUNT_ID,
            title: CLOUDFLARE_KV_NAME
        });
        
        console.log('✅ KV 命名空间创建成功！');
        console.log(`   - 名称: ${newNamespace.title}`);
        console.log(`   - ID: ${newNamespace.id}`);
        
        return newNamespace.id;
        
    } catch (error) {
        console.error('💥 KV 命名空间配置失败:', error.message);
        if (error.response) {
            console.error('📋 错误详情:', JSON.stringify(error.response.data, null, 2));
        }
        // KV 配置失败不应该阻止 Worker 部署，返回 null 继续部署
        return null;
    }
}

async function deployToCloudflare() {
    try {
        console.log('📦 读取Worker脚本文件...');
        console.log(`   - 文件路径: ${WORKER_SCRIPT_PATH}`);
        
        const workerScript = readFileSync(WORKER_SCRIPT_PATH, 'utf8');
        const scriptSize = (workerScript.length / 1024).toFixed(2);
        
        console.log(`✅ Worker脚本读取成功！`);
        console.log(`   - 脚本大小: ${scriptSize} KB`);
        console.log(`   - 脚本类型: ES Module`);
        console.log('');
        
        console.log('🚀 开始部署到Cloudflare Workers...');
        
        // 创建脚本文件对象
        const scriptFile = new File([workerScript], 'worker.js', { 
            type: 'application/javascript+module' 
        });
        
        // 获取或创建 KV 命名空间
        const kvNamespaceId = await ensureKVNamespace();
        
        // 构建元数据
        const metadata = {
            main_module: 'worker.js',
            bindings: []
        };
        
        // 添加 KV 绑定（如果有 KV 命名空间）
        if (kvNamespaceId) {
            metadata.bindings.push({
                type: 'kv_namespace',
                name: 'kv',
                namespace_id: kvNamespaceId
            });
        }
        
        // 使用官方 SDK 部署
        const deployResult = await cloudflare.workers.scripts.update(
            CLOUDFLARE_WORKER_NAME,
            {
                account_id: CLOUDFLARE_ACCOUNT_ID,
                metadata: metadata,
                files: [scriptFile]
            }
        );
        
        console.log('✅ Worker部署成功！');
        console.log('📋 部署详细信息:');
        console.log(`   - Worker名称: ${CLOUDFLARE_WORKER_NAME}`);
        console.log(`   - Worker ID: ${deployResult.id}`);
        console.log(`   - 部署时间: ${new Date(deployResult.modified_on).toLocaleString('zh-CN')}`);
        console.log(`   - 启动时间: ${deployResult.startup_time_ms}ms`);
        console.log(`   - 使用模式: ${deployResult.usage_model}`);
        console.log(`   - ES模块支持: ${deployResult.has_modules ? '✅ 是' : '❌ 否'}`);
        console.log(`   - KV绑定: ${kvNamespaceId ? '✅ 已配置' : '⚠️ 未配置'}`);
        console.log('');
        
        // 先配置子域名，再检查日志（避免并行操作可能的冲突）
        await configureSubdomain();
        
        // 等待一下，确保前面的操作完全完成
        console.log('⏳ 等待配置生效...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        await enableWorkersLogs();
        
        // KV绑定验证需要等待部署完成，所以单独执行
        await configureKVBinding();
        
        // 部署完成总结
        console.log('');
        console.log('🎉 部署流程全部完成！');
        console.log('📋 部署总结:');
        console.log(`   - Worker名称: ${CLOUDFLARE_WORKER_NAME}`);
        console.log(`   - KV存储: ${CLOUDFLARE_KV_NAME ? `✅ ${CLOUDFLARE_KV_NAME}` : '⚠️ 未配置'}`);
        console.log(`   - 子域名访问: ✅ 已启用`);
        console.log(`   - 日志监控: ✅ 已启用`);
        console.log('');
        console.log('🚀 你的Worker现在已经可以正常使用了！');
        
    } catch (error) {
        console.error('💥 部署失败:', error.message);
        if (error.response) {
            console.error('📋 错误详情:', JSON.stringify(error.response.data, null, 2));
        }
        process.exit(1);
    }
}

async function configureSubdomain() {
    console.log('🌐 配置Worker子域名访问...');
    try {
        // 首先获取账户级别的子域名信息
        console.log('📋 检查账户子域名配置...');
        let accountSubdomain = null;
        try {
            const subdomainResult = await cloudflare.workers.subdomains.get({
                account_id: CLOUDFLARE_ACCOUNT_ID
            });
            accountSubdomain = subdomainResult.subdomain;
            console.log(`✅ 检测到账户子域名: ${accountSubdomain}`);
        } catch (error) {
            console.log('⚠️ 账户子域名未配置，尝试自动创建...');
            try {
                const createResult = await cloudflare.workers.subdomains.update({
                    account_id: CLOUDFLARE_ACCOUNT_ID,
                    subdomain: CLOUDFLARE_ACCOUNT_ID
                });
                accountSubdomain = createResult.subdomain;
                console.log(`✅ 账户子域名创建成功: ${accountSubdomain}`);
            } catch (createError) {
                console.log('⚠️ 无法创建账户子域名:', createError.message);
            }
        }
        
        // 检查当前 Worker 的子域名状态
        try {
            const workerSubdomainStatus = await cloudflare.workers.scripts.subdomain.get(
                CLOUDFLARE_WORKER_NAME,
                {
                    account_id: CLOUDFLARE_ACCOUNT_ID
                }
            );
            
            console.log('📊 检查Worker子域名状态...');
            console.log(`   - 子域名启用: ${workerSubdomainStatus.enabled ? '✅ 已启用' : '❌ 未启用'}`);
            console.log(`   - 预览功能: ${workerSubdomainStatus.previews_enabled ? '✅ 已启用' : '❌ 未启用'}`);
            
            if (!workerSubdomainStatus.enabled) {
                console.log('📝 正在启用Worker子域名...');
                const enableResult = await cloudflare.workers.scripts.subdomain.create(
                    CLOUDFLARE_WORKER_NAME,
                    {
                        account_id: CLOUDFLARE_ACCOUNT_ID,
                        enabled: true,
                        previews_enabled: false
                    }
                );
                
                console.log('✅ Worker子域名启用成功！');
                console.log(`   - 子域名状态: ${enableResult.enabled ? '✅ 已启用' : '❌ 启用失败'}`);
                console.log(`   - 预览功能: ${enableResult.previews_enabled ? '✅ 已启用' : '❌ 未启用'}`);
            } else {
                console.log('✅ Worker子域名已处于启用状态，无需配置');
            }
            
            // 显示访问地址
            if (accountSubdomain) {
                console.log(`🌐 Worker访问地址: https://${CLOUDFLARE_WORKER_NAME}.${accountSubdomain}.workers.dev`);
            } else {
                console.log('⚠️ 无法确定完整的访问地址，请检查账户子域名配置');
            }
            
        } catch (error) {
            console.log('⚠️ Worker子域名配置失败:', error.message);
            
            // 如果获取失败，尝试直接启用
            if (error.message.includes('not found') || error.status === 404) {
                console.log('📝 尝试直接启用Worker子域名...');
                try {
                    const enableResult = await cloudflare.workers.scripts.subdomain.create(
                        CLOUDFLARE_WORKER_NAME,
                        {
                            account_id: CLOUDFLARE_ACCOUNT_ID,
                            enabled: true,
                            previews_enabled: false
                        }
                    );
                    
                    console.log('✅ Worker子域名已启用！');
                    console.log(`   - 子域名启用: ${enableResult.enabled ? '是' : '否'}`);
                    console.log(`   - 预览启用: ${enableResult.previews_enabled ? '是' : '否'}`);
                    
                    if (accountSubdomain) {
                        console.log(`🌐 Worker访问地址: https://${CLOUDFLARE_WORKER_NAME}.${accountSubdomain}.workers.dev`);
                    }
                } catch (enableError) {
                    console.log('💥 启用Worker子域名失败:', enableError.message);
                }
            }
        }
        
    } catch (error) {
        console.log('⚠️ 子域名配置过程出错:', error.message);
        if (error.response) {
            console.log('📋 错误详情:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

async function configureKVBinding() {
    console.log('🗄️ 验证KV存储绑定状态...');
    
    // 如果没有配置 KV 数据库名称，跳过验证
    if (!CLOUDFLARE_KV_NAME) {
        console.log('⚠️ 未配置KV数据库名称，跳过绑定验证');
        return;
    }
    
    try {
        console.log('📋 获取Worker配置信息...');
        
        // 使用正确的API方法获取Worker的配置信息（包含绑定）
        const workerSettings = await cloudflare.workers.scripts.scriptAndVersionSettings.get(
            CLOUDFLARE_WORKER_NAME, 
            {
                account_id: CLOUDFLARE_ACCOUNT_ID
            }
        );
        
        // 检查是否已有 KV 绑定
        const kvBinding = workerSettings.bindings && 
            workerSettings.bindings.find(binding => 
                binding.type === 'kv_namespace' && 
                binding.name === 'kv'
            );
        
        if (kvBinding) {
            console.log('✅ KV存储绑定验证成功！');
            console.log('📋 KV绑定详细信息:');
            console.log(`   - 绑定变量名: ${kvBinding.name}`);
            console.log(`   - 命名空间ID: ${kvBinding.namespace_id}`);
            console.log(`   - 数据库名称: ${CLOUDFLARE_KV_NAME}`);
            console.log(`   - 绑定类型: ${kvBinding.type}`);
        } else {
            console.log('⚠️ 未检测到KV绑定配置');
            console.log('💡 提示: 如果刚完成部署，绑定可能需要几分钟生效');
        }
        
    } catch (error) {
        console.log('❌ KV绑定验证失败:', error.message);
        if (error.response) {
            console.log('📋 错误详情:', JSON.stringify(error.response.data, null, 2));
        }
    }
}



async function enableWorkersLogs() {
    console.log('📊 检查Workers日志配置状态...');
    try {
        console.log('📋 获取当前日志设置...');
        // 先获取当前日志配置
        const currentSettings = await cloudflare.workers.scripts.settings.get(
            CLOUDFLARE_WORKER_NAME,
            {
                account_id: CLOUDFLARE_ACCOUNT_ID
            }
        );
        
        // 详细记录当前状态
        console.log('🔍 详细日志状态检查:');
        console.log(`   - observability 对象存在: ${currentSettings.observability ? '✅' : '❌'}`);
        if (currentSettings.observability) {
            console.log(`   - observability.enabled: ${currentSettings.observability.enabled ? '✅' : '❌'}`);
            console.log(`   - logs 对象存在: ${currentSettings.observability.logs ? '✅' : '❌'}`);
            if (currentSettings.observability.logs) {
                console.log(`   - logs.enabled: ${currentSettings.observability.logs.enabled ? '✅' : '❌'}`);
                console.log(`   - logs.invocation_logs: ${currentSettings.observability.logs.invocation_logs ? '✅' : '❌'}`);
                console.log(`   - logs.head_sampling_rate: ${currentSettings.observability.logs.head_sampling_rate || 0}`);
            }
        }
        console.log(`   - logpush: ${currentSettings.logpush ? '✅' : '❌'}`);
        
        // 检查日志是否已启用 - 需要同时检查 observability.enabled 和 logs.enabled
        const observabilityEnabled = currentSettings.observability && currentSettings.observability.enabled;
        const logsEnabled = currentSettings.observability && 
            currentSettings.observability.logs && 
            currentSettings.observability.logs.enabled;
        
        const fullLogsEnabled = observabilityEnabled && logsEnabled;
        
        if (fullLogsEnabled) {
            console.log('✅ 检测到Workers日志已启用！');
            console.log('📋 当前日志配置详情:');
            console.log(`   - 可观测性: ${currentSettings.observability.enabled ? '✅ 已启用' : '❌ 未启用'}`);
            console.log(`   - 日志记录: ${currentSettings.observability.logs.enabled ? '✅ 已启用' : '❌ 未启用'}`);
            console.log(`   - 调用日志: ${currentSettings.observability.logs.invocation_logs ? '✅ 已启用' : '❌ 未启用'}`);
            console.log(`   - 采样率: ${(currentSettings.observability.logs.head_sampling_rate * 100)}%`);
            console.log(`   - Logpush: ${currentSettings.logpush ? '✅ 已启用' : '❌ 未启用'}`);
        } else {
            console.log('⚠️ 检测到Workers日志未启用');
            console.log('📝 正在启用Workers日志功能...');
            // 根据 settings.ts 接口使用官方标准的完整配置结构
            const logResult = await cloudflare.workers.scripts.settings.edit(
                CLOUDFLARE_WORKER_NAME,
                {
                    account_id: CLOUDFLARE_ACCOUNT_ID,
                    logpush: false,
                    observability: {
                        enabled: true,
                        head_sampling_rate: 1,
                        logs: {
                            enabled: true,
                            invocation_logs: true,
                            head_sampling_rate: 1
                        }
                    },
                    tail_consumers: []
                }
            );
            
            if (logResult.observability && logResult.observability.logs && logResult.observability.logs.enabled) {
                console.log('✅ Workers日志启用成功！');
                console.log('📋 新的日志配置详情:');
                console.log(`   - 可观测性: ${logResult.observability.enabled ? '✅ 已启用' : '❌ 未启用'}`);
                console.log(`   - 日志记录: ${logResult.observability.logs.enabled ? '✅ 已启用' : '❌ 未启用'}`);
                console.log(`   - 调用日志: ${logResult.observability.logs.invocation_logs ? '✅ 已启用' : '❌ 未启用'}`);
                console.log(`   - 采样率: ${(logResult.observability.logs.head_sampling_rate * 100)}%`);
                console.log(`   - Logpush: ${logResult.logpush ? '✅ 已启用' : '❌ 未启用'}`);
            } else {
                console.log('❌ Workers日志启用失败');
                console.log('⚠️ 请检查账户权限或手动在控制台中启用');
            }
        }
        
    } catch (error) {
        console.log('⚠️ 日志配置失败:', error.message);
        if (error.response) {
            console.log('📋 错误详情:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

// 执行部署
deployToCloudflare();