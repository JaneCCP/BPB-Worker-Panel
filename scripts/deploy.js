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
        console.log('📋 部署结果:', JSON.stringify(deployResult, null, 2));
        
        if (deployResult.success) {
            console.log('✅ Worker部署成功！');
        } else {
            console.error('💥 Worker部署失败:', deployResult.errors);
            throw new Error(`部署失败: ${JSON.stringify(deployResult.errors)}`);
        }
        
        // 配置子域名
        await configureSubdomain();
        
        // 启用日志
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
        
        console.log('📋 子域名状态:', JSON.stringify(subdomainResult, null, 2));
        
        if (subdomainResult.subdomain) {
            console.log('🎉 子域名已启用！');
            
            // 获取真实的 Worker 信息
            const workerInfo = await cloudflare.workers.scripts.get(CLOUDFLARE_WORKER_NAME, {
                account_id: CLOUDFLARE_ACCOUNT_ID
            });
            
            console.log('📋 Worker信息:', JSON.stringify(workerInfo, null, 2));
            
            // 使用从 API 获取的真实信息构建地址
            const realWorkerName = workerInfo.id || CLOUDFLARE_WORKER_NAME;
            console.log(`🌐 Worker地址: https://${realWorkerName}.${subdomainResult.subdomain}.workers.dev`);
        } else {
            console.log('📝 创建子域名...');
            const createResult = await cloudflare.workers.subdomains.update({
                account_id: CLOUDFLARE_ACCOUNT_ID,
                subdomain: CLOUDFLARE_ACCOUNT_ID
            });
            
            console.log('📋 子域名创建结果:', JSON.stringify(createResult, null, 2));
            
            if (createResult.subdomain) {
                console.log('✅ 子域名创建成功！');
                
                // 获取真实的 Worker 信息
                const workerInfo = await cloudflare.workers.scripts.get(CLOUDFLARE_WORKER_NAME, {
                    account_id: CLOUDFLARE_ACCOUNT_ID
                });
                
                console.log('📋 Worker信息:', JSON.stringify(workerInfo, null, 2));
                
                // 使用从 API 获取的真实信息构建地址
                const realWorkerName = workerInfo.id || CLOUDFLARE_WORKER_NAME;
                console.log(`🌐 Worker地址: https://${realWorkerName}.${createResult.subdomain}.workers.dev`);
            }
        }
        
    } catch (error) {
        console.log('⚠️ 子域名配置失败:', error.message);
        if (error.response) {
            console.log('📋 错误详情:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

async function enableWorkersLogs() {
    console.log('📊 正在启用Workers日志...');
    try {
        // 使用正确的配置结构启用 Workers 日志
        const logResult = await cloudflare.workers.scripts.settings.edit(
            CLOUDFLARE_WORKER_NAME,
            {
                account_id: CLOUDFLARE_ACCOUNT_ID,
                settings: {                     
                    enabled: true,
                    head_sampling_rate: 1,
                    invocation_logs: true                                   
                }
            }
        );
        
        console.log('📋 Workers日志配置结果:', JSON.stringify(logResult, null, 2));
        
        if (logResult.observability && logResult.observability.logs && logResult.observability.logs.enabled) {
            console.log('✅ Workers日志已成功启用！');
        } else {
            console.log('⚠️ Workers日志启用状态未确认');
        }
        
    } catch (error) {
        console.log('⚠️ 日志启用失败:', error.message);
        if (error.response) {
            console.log('📋 错误详情:', JSON.stringify(error.response.data, null, 2));
        }
    }
}

// 执行部署
deployToCloudflare();