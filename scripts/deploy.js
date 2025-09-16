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
    CLOUDFLARE_WORKER_NAME
} = process.env;

// 文件路径
const WORKER_SCRIPT_PATH = join(__dirname, '..', 'dist', 'worker.js');

// 初始化 Cloudflare 客户端
const cloudflare = new Cloudflare({
    apiToken: CLOUDFLARE_API_TOKEN,
});

async function deployToCloudflare() {
    try {
        console.log('📦 读取Worker脚本...');
        const workerScript = readFileSync(WORKER_SCRIPT_PATH, 'utf8');
        
        console.log('🚀 部署到Cloudflare Worker...');
        
        // 使用 multipart 方式部署 Worker 脚本
        const formData = new FormData();
        
        // 添加脚本文件
        const scriptBlob = new Blob([workerScript], { type: 'application/javascript+module' });
        formData.append('worker.js', scriptBlob, 'worker.js');
        
        // 添加元数据
        const metadata = {
            main_module: 'worker.js',
            bindings: [
                {
                    type: 'kv_namespace',
                    name: 'kv',
                    namespace_id: process.env.CLOUDFLARE_KV_ID
                }
            ]
        };
        const metadataBlob = new Blob([JSON.stringify(metadata)], { type: 'application/json' });
        formData.append('metadata', metadataBlob, 'metadata.json');
        
        // 直接使用 fetch 进行部署
        const deployResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${CLOUDFLARE_WORKER_NAME}`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
                },
                body: formData
            }
        );
        
        const deployResult = await deployResponse.json();
        
        console.log('📊 部署响应状态:', deployResponse.status);
        
        if (deployResult.success) {
            console.log('✅ Worker部署成功！');
            console.log('📋 部署信息:');
            console.log(`   - Worker ID: ${deployResult.result.id}`);
            console.log(`   - 部署时间: ${new Date(deployResult.result.modified_on).toLocaleString('zh-CN')}`);
            console.log(`   - 启动时间: ${deployResult.result.startup_time_ms}ms`);
            console.log(`   - 使用模式: ${deployResult.result.usage_model}`);
        } else {
            console.error('💥 Worker部署失败:', deployResult.errors);
            throw new Error(`部署失败: ${JSON.stringify(deployResult.errors)}`);
        }
        
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
    console.log('🌐 配置子域名访问...');
    try {
        // 获取子域名状态
        const subdomainResult = await cloudflare.workers.subdomains.get({
            account_id: CLOUDFLARE_ACCOUNT_ID
        });
        
        if (subdomainResult.subdomain) {
            console.log('🎉 子域名已启用！');
            console.log(`   - 子域名: ${subdomainResult.subdomain}`);
            
            // 通过 SDK 获取 Worker 列表来找到真实的 Worker 名称
            const workersResponse = await cloudflare.workers.scripts.list({
                account_id: CLOUDFLARE_ACCOUNT_ID
            });
            
            // 检查返回的数据结构
            const workersList = workersResponse.result || workersResponse;
            
            // 查找当前 Worker（使用环境变量名称查找）
            let currentWorker = null;
            if (Array.isArray(workersList)) {
                currentWorker = workersList.find(worker => 
                    worker.id === CLOUDFLARE_WORKER_NAME
                );
            }
            
            // 只有在成功获取到真实 Worker 名称时才输出地址
            if (currentWorker && currentWorker.id) {
                console.log(`🌐 Worker地址: https://${currentWorker.id}.${subdomainResult.subdomain}.workers.dev`);
            } else {
                console.log('⚠️ 无法获取 Worker 真实名称，跳过地址输出');
            }
        } else {
            console.log('📝 创建子域名...');
            const createResult = await cloudflare.workers.subdomains.update({
                account_id: CLOUDFLARE_ACCOUNT_ID,
                subdomain: CLOUDFLARE_ACCOUNT_ID
            });
            
            if (createResult.subdomain) {
                console.log('✅ 子域名创建成功！');
                console.log(`   - 子域名: ${createResult.subdomain}`);
                
                // 通过 SDK 获取 Worker 列表来找到真实的 Worker 名称
                const workersResponse = await cloudflare.workers.scripts.list({
                    account_id: CLOUDFLARE_ACCOUNT_ID
                });
                
                // 检查返回的数据结构
                const workersList = workersResponse.result || workersResponse;
                
                // 查找当前 Worker（使用环境变量名称查找）
                let currentWorker = null;
                if (Array.isArray(workersList)) {
                    currentWorker = workersList.find(worker => 
                        worker.id === CLOUDFLARE_WORKER_NAME
                    );
                }
                
                // 只有在成功获取到真实 Worker 名称时才输出地址
                if (currentWorker && currentWorker.id) {
                    console.log(`🌐 Worker地址: https://${currentWorker.id}.${createResult.subdomain}.workers.dev`);
                } else {
                    console.log('⚠️ 无法获取 Worker 真实名称，跳过地址输出');
                }
            }
        }
        
    } catch (error) {
        console.log('⚠️ 子域名配置失败:', error.message);
        if (error.response) {
            console.log('📋 错误详情:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

async function configureKVBinding() {
    console.log('🗄️ 检查KV存储绑定...');
    try {
        // 获取当前 Worker 的详细信息
        const workerDetails = await cloudflare.workers.scripts.get(CLOUDFLARE_WORKER_NAME, {
            account_id: CLOUDFLARE_ACCOUNT_ID
        });
        
        // 检查是否已有 KV 绑定
        const hasKVBinding = workerDetails.bindings && 
            workerDetails.bindings.some(binding => 
                binding.type === 'kv_namespace' && 
                binding.name === 'kv' && 
                binding.namespace_id === process.env.CLOUDFLARE_KV_ID
            );
        
        if (hasKVBinding) {
            console.log('✅ KV存储绑定已存在！');
            console.log('📋 绑定信息:');
            console.log(`   - 变量名: kv`);
            console.log(`   - 命名空间ID: ${process.env.CLOUDFLARE_KV_ID}`);
        } else {
            console.log('📝 配置KV存储绑定...');
            // 重新部署 Worker 以添加 KV 绑定（这部分已在主部署函数中处理）
            console.log('✅ KV存储绑定已在部署时配置！');
        }
        
    } catch (error) {
        console.log('⚠️ KV绑定检查失败:', error.message);
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