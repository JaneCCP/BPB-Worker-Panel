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
        
        const namespaces = [];
        for await (const namespace of cloudflare.kv.namespaces.list({
            account_id: CLOUDFLARE_ACCOUNT_ID
        })) {
            namespaces.push(namespace);
        }
        
        // 查找是否已存在同名的命名空间
        const existingNamespace = namespaces.find(ns => ns.title === CLOUDFLARE_KV_NAME);
        
        if (existingNamespace) {
            console.log('✅ 找到现有的 KV 命名空间！');
            console.log(`   - 名称: ${existingNamespace.title}`);
            console.log(`   - ID: ${existingNamespace.id}`);
            return existingNamespace.id;
        }
        
        // 如果不存在，创建新的命名空间
        console.log('📝 创建新的 KV 命名空间...');
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
        console.log('📦 读取Worker脚本...');
        const workerScript = readFileSync(WORKER_SCRIPT_PATH, 'utf8');
        
        console.log('🚀 使用官方SDK部署到Cloudflare Worker...');
        
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
        console.log('📋 部署信息:');
        console.log(`   - Worker ID: ${deployResult.id}`);
        console.log(`   - 部署时间: ${new Date(deployResult.modified_on).toLocaleString('zh-CN')}`);
        console.log(`   - 启动时间: ${deployResult.startup_time_ms}ms`);
        console.log(`   - 使用模式: ${deployResult.usage_model}`);
        console.log(`   - 是否包含模块: ${deployResult.has_modules ? '是' : '否'}`);
        
        // 配置子域名
        await configureSubdomain();
        
        // 检查并配置 KV 绑定
        await configureKVBinding();
        
        // 检查并启用日志
        await enableWorkersLogs();
        
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
        let accountSubdomain = null;
        try {
            const subdomainResult = await cloudflare.workers.subdomains.get({
                account_id: CLOUDFLARE_ACCOUNT_ID
            });
            accountSubdomain = subdomainResult.subdomain;
        } catch (error) {
            console.log('📝 账户子域名未配置，尝试创建...');
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
            
            console.log('📊 当前Worker子域名状态:');
            console.log(`   - 子域名启用: ${workerSubdomainStatus.enabled ? '是' : '否'}`);
            console.log(`   - 预览启用: ${workerSubdomainStatus.previews_enabled ? '是' : '否'}`);
            
            if (!workerSubdomainStatus.enabled) {
                console.log('📝 启用Worker子域名...');
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
    console.log('🗄️ 验证KV存储绑定...');
    
    // 如果没有配置 KV 数据库名称，跳过验证
    if (!CLOUDFLARE_KV_NAME) {
        console.log('⚠️ 未配置 KV 数据库，跳过绑定验证');
        return;
    }
    
    try {
        // 获取当前 Worker 的详细信息来验证绑定
        const workerDetails = await cloudflare.workers.scripts.get(CLOUDFLARE_WORKER_NAME, {
            account_id: CLOUDFLARE_ACCOUNT_ID
        });
        
        // 检查是否已有 KV 绑定
        const kvBinding = workerDetails.bindings && 
            workerDetails.bindings.find(binding => 
                binding.type === 'kv_namespace' && 
                binding.name === 'kv'
            );
        
        if (kvBinding) {
            console.log('✅ KV存储绑定验证成功！');
            console.log('📋 绑定信息:');
            console.log(`   - 变量名: ${kvBinding.name}`);
            console.log(`   - 命名空间ID: ${kvBinding.namespace_id}`);
            console.log(`   - 数据库名称: ${CLOUDFLARE_KV_NAME}`);
        } else {
            console.log('⚠️ 未找到 KV 绑定，可能配置失败');
        }
        
    } catch (error) {
        console.log('⚠️ KV绑定验证失败:', error.message);
        if (error.response) {
            console.log('📋 错误详情:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

async function enableWorkersLogs() {
    console.log('📊 检查Workers日志状态...');
    try {
        // 先获取当前日志配置
        const currentSettings = await cloudflare.workers.scripts.settings.get(
            CLOUDFLARE_WORKER_NAME,
            {
                account_id: CLOUDFLARE_ACCOUNT_ID
            }
        );
        
        // 检查日志是否已启用
        const logsEnabled = currentSettings.observability && 
            currentSettings.observability.logs && 
            currentSettings.observability.logs.enabled;
        
        if (logsEnabled) {
            console.log('✅ Workers日志已启用！');
            console.log('📋 当前日志配置:');
            console.log(`   - 可观测性: ${currentSettings.observability.enabled ? '已启用' : '未启用'}`);
            console.log(`   - 日志记录: ${currentSettings.observability.logs.enabled ? '已启用' : '未启用'}`);
            console.log(`   - 调用日志: ${currentSettings.observability.logs.invocation_logs ? '已启用' : '未启用'}`);
            console.log(`   - 采样率: ${(currentSettings.observability.logs.head_sampling_rate * 100)}%`);
            console.log(`   - Logpush: ${currentSettings.logpush ? '已启用' : '未启用'}`);
        } else {
            console.log('📝 启用Workers日志...');
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
                console.log('✅ Workers日志已成功启用！');
                console.log('📋 日志配置信息:');
                console.log(`   - 可观测性: ${logResult.observability.enabled ? '已启用' : '未启用'}`);
                console.log(`   - 日志记录: ${logResult.observability.logs.enabled ? '已启用' : '未启用'}`);
                console.log(`   - 调用日志: ${logResult.observability.logs.invocation_logs ? '已启用' : '未启用'}`);
                console.log(`   - 采样率: ${(logResult.observability.logs.head_sampling_rate * 100)}%`);
                console.log(`   - Logpush: ${logResult.logpush ? '已启用' : '未启用'}`);
            } else {
                console.log('⚠️ Workers日志启用状态未确认');
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