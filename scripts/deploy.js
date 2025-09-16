import { readFileSync } from 'fs';
import { join, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

const WORKER_SCRIPT_PATH = join(__dirname, '../dist/worker.js');

async function enableWorkersLogs() {
    console.log('📊 正在启用Workers日志...');
    try {
        // 创建包含settings部分的multipart/form-data
        const formData = new FormData();
        
        // 添加settings部分，包含日志配置
        const settingsBlob = new Blob([JSON.stringify({
            log: true
        })], { type: 'application/json' });
        
        formData.append('settings', settingsBlob, 'settings.json');
        
        const logResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${process.env.CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${process.env.CLOUDFLARE_WORKER_NAME}/settings`,
            {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`
                    // 不设置Content-Type，让浏览器自动设置multipart/form-data
                },
                body: formData
            }
        );
        
        console.log('📊 日志启用响应状态:', logResponse.status);
        console.log('📊 响应头:', Object.fromEntries(logResponse.headers.entries()));
        
        const logContentType = logResponse.headers.get('content-type');
        if (logContentType && logContentType.includes('application/json')) {
            const logResult = await logResponse.json();
            console.log('📋 Workers日志启用结果:', JSON.stringify(logResult, null, 2));
            
            if (logResult.success) {
                console.log('✅ Workers日志已成功启用！');
            } else {
                console.log('⚠️  日志启用失败:', logResult.errors);
            }
        } else {
            const textResponse = await logResponse.text();
            console.log('📋 日志启用原始响应:', textResponse);
        }
        
    } catch (logError) {
        console.log('⚠️  日志启用过程中出现错误:', logError.message);
    }
}

async function deployToCloudflare() {
    const {
        CLOUDFLARE_API_TOKEN,
        CLOUDFLARE_ACCOUNT_ID,
        CLOUDFLARE_WORKER_NAME,
        CLOUDFLARE_KV_ID
    } = process.env;

    if (!CLOUDFLARE_API_TOKEN || !CLOUDFLARE_ACCOUNT_ID || !CLOUDFLARE_WORKER_NAME) {
        throw new Error('缺少必需的环境变量');
    }

    console.log('📦 读取Worker脚本...');
    const workerScript = readFileSync(WORKER_SCRIPT_PATH, 'utf8');
    
    console.log('🚀 部署到Cloudflare Worker...');
    
    // 构建multipart表单数据
    const formData = new FormData();
    
    // 添加脚本文件 - 使用正确的 MIME 类型
    formData.append('worker.js', new Blob([workerScript], { type: 'application/javascript+module' }), 'worker.js');
    
    // 添加配置元数据 - 包含KV命名空间绑定
    const metadata = {
        main_module: 'worker.js',
        compatibility_date: '2025-09-16',
        usage_model: 'standard',
        bindings: [
            {
                type: 'kv_namespace',
                name: 'kv',
                namespace_id: CLOUDFLARE_KV_ID
            }
        ],
        vars: {
            ENVIRONMENT: 'production'
        }
    };
    
    formData.append('metadata', JSON.stringify(metadata));

    const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${CLOUDFLARE_WORKER_NAME}`,
        {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
            },
            body: formData
        }
    );

    const result = await response.json();
    
    if (!response.ok) {
        console.error('❌ 部署失败:', result);
        throw new Error(`部署失败: ${result.errors?.[0]?.message || '未知错误'}`);
    }

    console.log('✅ Worker部署成功！');
    
    // 根据官方API文档配置子域名访问
    console.log('🌐 配置子域名访问...');
    try {
        // 1. 获取当前子域名状态
        console.log('📡 正在获取子域名状态...');
        console.log('🔗 请求URL:', `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`);
        
        const getResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
                }
            }
        );

        console.log('📊 响应状态码:', getResponse.status);
        console.log('📊 响应状态文本:', getResponse.statusText);
        
        const getResult = await getResponse.json();
        console.log('📋 完整API响应:', JSON.stringify(getResult, null, 2));
        
        if (getResponse.ok && getResult.success && getResult.result?.subdomain) {
            // 子域名已存在，获取Worker列表来确认域名
            console.log('🎉 子域名已启用！');
            console.log('🔧 从API获取的子域名:', getResult.result.subdomain);
            
            // 获取Worker详细信息
            console.log('📡 正在获取Worker详细信息...');
            const workerInfoResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${CLOUDFLARE_WORKER_NAME}`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
                    }
                }
            );
            
            console.log('📊 Worker信息响应状态:', workerInfoResponse.status);
            console.log('📊 Worker信息响应头:', Object.fromEntries(workerInfoResponse.headers.entries()));
            
            // 检查响应内容类型
            const contentType = workerInfoResponse.headers.get('content-type');
            console.log('📊 响应内容类型:', contentType);
            
            let workerInfoResult;
            try {
                if (contentType && contentType.includes('application/json')) {
                    workerInfoResult = await workerInfoResponse.json();
                    console.log('📋 Worker信息API响应:', JSON.stringify(workerInfoResult, null, 2));
                } else {
                    const textResponse = await workerInfoResponse.text();
                    console.log('📋 Worker信息非JSON响应:', textResponse);
                    workerInfoResult = { success: false, error: 'Non-JSON response' };
                }
            } catch (parseError) {
                console.log('❌ Worker信息JSON解析失败:', parseError.message);
                const textResponse = await workerInfoResponse.text();
                console.log('📋 原始响应内容:', textResponse);
                workerInfoResult = { success: false, error: 'JSON parse failed' };
            }
            
            // 获取Worker的子域名绑定信息
            console.log('📡 正在获取Worker子域名绑定...');
            const subdomainBindingResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${CLOUDFLARE_WORKER_NAME}/subdomain`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
                    }
                }
            );
            
            console.log('📊 子域名绑定响应状态:', subdomainBindingResponse.status);
            console.log('📊 子域名绑定响应头:', Object.fromEntries(subdomainBindingResponse.headers.entries()));
            
            const bindingContentType = subdomainBindingResponse.headers.get('content-type');
            console.log('📊 绑定响应内容类型:', bindingContentType);
            
            let subdomainBindingResult;
            try {
                if (bindingContentType && bindingContentType.includes('application/json')) {
                    subdomainBindingResult = await subdomainBindingResponse.json();
                    console.log('📋 子域名绑定API响应:', JSON.stringify(subdomainBindingResult, null, 2));
                } else {
                    const textResponse = await subdomainBindingResponse.text();
                    console.log('📋 子域名绑定非JSON响应:', textResponse);
                    subdomainBindingResult = { success: false, error: 'Non-JSON response' };
                }
            } catch (parseError) {
                console.log('❌ 子域名绑定JSON解析失败:', parseError.message);
                const textResponse = await subdomainBindingResponse.text();
                console.log('📋 绑定原始响应内容:', textResponse);
                subdomainBindingResult = { success: false, error: 'JSON parse failed' };
            }
            
            // 从API响应构建真实的Worker地址
            if (subdomainBindingResult.success && subdomainBindingResult.result?.enabled) {
                console.log('🌐 Worker子域名已启用！');
                
                // 从Worker信息中获取真实的Worker名称
                let realWorkerName = CLOUDFLARE_WORKER_NAME;
                if (workerInfoResult && workerInfoResult.success && workerInfoResult.result?.id) {
                    realWorkerName = workerInfoResult.result.id;
                    console.log('🔧 从API获取的真实Worker名称:', realWorkerName);
                } else {
                    console.log('🔧 使用环境变量Worker名称:', realWorkerName);
                }
                
                console.log('🌐 真实Worker地址:', `https://${realWorkerName}.${getResult.result.subdomain}.workers.dev`);
                
                // 启用 Workers 日志
                await enableWorkersLogs();
            } else {
                console.log('⚠️  Worker子域名未启用，尝试启用...');
                // 启用Worker的子域名
                const enableWorkerSubdomainResponse = await fetch(
                    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${CLOUDFLARE_WORKER_NAME}/subdomain`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ enabled: true })
                    }
                );
                
                console.log('📊 启用子域名响应状态:', enableWorkerSubdomainResponse.status);
                
                let enableResult;
                try {
                    const enableContentType = enableWorkerSubdomainResponse.headers.get('content-type');
                    if (enableContentType && enableContentType.includes('application/json')) {
                        enableResult = await enableWorkerSubdomainResponse.json();
                        console.log('📋 启用Worker子域名结果:', JSON.stringify(enableResult, null, 2));
                    } else {
                        const textResponse = await enableWorkerSubdomainResponse.text();
                        console.log('📋 启用子域名非JSON响应:', textResponse);
                        enableResult = { success: false, error: 'Non-JSON response' };
                    }
                } catch (parseError) {
                    console.log('❌ 启用子域名JSON解析失败:', parseError.message);
                    const textResponse = await enableWorkerSubdomainResponse.text();
                    console.log('📋 启用原始响应内容:', textResponse);
                    enableResult = { success: false, error: 'JSON parse failed' };
                }
                
                if (enableResult.success) {
                    console.log('🎉 Worker子域名启用成功！');
                    
                    // 从Worker信息中获取真实的Worker名称
                    let realWorkerName = CLOUDFLARE_WORKER_NAME;
                    if (workerInfoResult && workerInfoResult.success && workerInfoResult.result?.id) {
                        realWorkerName = workerInfoResult.result.id;
                        console.log('🔧 从API获取的真实Worker名称:', realWorkerName);
                    } else {
                        console.log('🔧 使用环境变量Worker名称:', realWorkerName);
                    }
                    
                    console.log('🌐 真实Worker地址:', `https://${realWorkerName}.${getResult.result.subdomain}.workers.dev`);
                }
            }
            
            // 启用 Workers 日志
            await enableWorkersLogs();
            
        } else {
            // 2. 创建子域名
            console.log('📝 子域名不存在，正在创建...');
            console.log('🔗 创建请求URL:', `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`);
            console.log('📤 请求体:', JSON.stringify({ subdomain: CLOUDFLARE_ACCOUNT_ID }, null, 2));
            
            const createResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`,
                {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        subdomain: CLOUDFLARE_ACCOUNT_ID
                    })
                }
            );

            console.log('📊 创建响应状态码:', createResponse.status);
            console.log('📊 创建响应状态文本:', createResponse.statusText);
            
            const createResult = await createResponse.json();
            console.log('📋 子域名创建完整响应:', JSON.stringify(createResult, null, 2));
            
            if (createResponse.ok && createResult.success) {
                console.log('🎉 子域名创建成功！');
                console.log('🔧 从API获取的新子域名:', createResult.result.subdomain);
                
                // 创建成功后，再次获取最新状态
                console.log('📡 重新获取子域名状态确认...');
                const verifyResponse = await fetch(
                    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`,
                    {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
                        }
                    }
                );
                
                const verifyResult = await verifyResponse.json();
                console.log('📋 验证子域名状态响应:', JSON.stringify(verifyResult, null, 2));
                
                if (verifyResult.success && verifyResult.result?.subdomain) {
                    // 获取Worker列表来确认真实的Worker名称
                    console.log('📡 获取Worker列表确认名称...');
                    const workerListResponse = await fetch(
                        `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts`,
                        {
                            method: 'GET',
                            headers: {
                                'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`
                            }
                        }
                    );
                    
                    let realWorkerName = CLOUDFLARE_WORKER_NAME;
                    if (workerListResponse.ok) {
                        const workerListResult = await workerListResponse.json();
                        console.log('📋 Worker列表响应:', JSON.stringify(workerListResult, null, 2));
                        
                        // 查找匹配的Worker
                        if (workerListResult.success && workerListResult.result) {
                            const matchedWorker = workerListResult.result.find(worker => 
                                worker.id === CLOUDFLARE_WORKER_NAME || worker.script === CLOUDFLARE_WORKER_NAME
                            );
                            if (matchedWorker) {
                                realWorkerName = matchedWorker.id;
                                console.log('🔧 从Worker列表获取的真实名称:', realWorkerName);
                            }
                        }
                    }
                    
                    console.log('🌐 确认的真实Worker地址:', `https://${realWorkerName}.${verifyResult.result.subdomain}.workers.dev`);
                    
                    // 启用 Workers 日志
                    await enableWorkersLogs();
                }
            } else {
                console.log('❌ 子域名创建失败');
                console.log('📋 错误详情:', createResult.errors || createResult.messages || '未知错误');
            }
        }
    } catch (error) {
        console.log('💥 子域名配置过程中发生异常');
        console.log('📋 异常详情:', error.message);
        console.log('📋 异常堆栈:', error.stack);
    }
    
    return result;
}

deployToCloudflare().catch(err => {
    console.error('💥 部署错误:', err);
    process.exit(1);
});