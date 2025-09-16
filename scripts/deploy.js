import { readFileSync } from 'fs';
import { join, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = pathDirname(__filename);

const WORKER_SCRIPT_PATH = join(__dirname, '../dist/worker.js');

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
    
    // 尝试启用子域名（如果尚未启用）
    console.log('🌐 配置子域名访问...');
    try {
        // 首先检查子域名状态
        const checkResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                }
            }
        );

        const checkResult = await checkResponse.json();
        console.log('子域名检查结果:', JSON.stringify(checkResult, null, 2));
        
        if (checkResponse.ok && checkResult.result?.subdomain) {
            console.log('🎉 子域名已启用！');
            console.log(`🌐 Worker地址: https://${CLOUDFLARE_WORKER_NAME}.${checkResult.result.subdomain}.workers.dev`);
        } else {
            // 尝试启用子域名
            const enableResponse = await fetch(
                `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`,
                {
                    method: 'PUT',
                    headers: {
                        'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ subdomain: CLOUDFLARE_ACCOUNT_ID })
                }
            );

            const enableResult = await enableResponse.json();
            console.log('子域名启用结果:', JSON.stringify(enableResult, null, 2));
            
            if (enableResponse.ok) {
                console.log('🎉 子域名已成功启用！');
                console.log(`🌐 Worker地址: https://${CLOUDFLARE_WORKER_NAME}.${CLOUDFLARE_ACCOUNT_ID}.workers.dev`);
                
                // 再次检查确认状态
                const verifyResponse = await fetch(
                    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/subdomain`,
                    {
                        method: 'GET',
                        headers: {
                            'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                            'Content-Type': 'application/json'
                        }
                    }
                );
                const verifyResult = await verifyResponse.json();
                console.log('验证子域名状态:', JSON.stringify(verifyResult, null, 2));
                
                // 添加路由配置
                console.log('🔗 配置Worker路由...');
                const routeResponse = await fetch(
                    `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${CLOUDFLARE_WORKER_NAME}/routes`,
                    {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            pattern: `${CLOUDFLARE_WORKER_NAME}.${CLOUDFLARE_ACCOUNT_ID}.workers.dev/*`,
                            script: CLOUDFLARE_WORKER_NAME
                        })
                    }
                );
                const routeResult = await routeResponse.json();
                console.log('路由配置结果:', JSON.stringify(routeResult, null, 2));
            } else {
                console.log('⚠️  子域名配置失败，但Worker已部署成功');
                console.log('错误详情:', enableResult.errors);
                console.log(`🌐 Worker地址: https://${CLOUDFLARE_WORKER_NAME}.${CLOUDFLARE_ACCOUNT_ID}.workers.dev`);
            }
        }
    } catch (error) {
        console.log('⚠️  子域名配置出错，但Worker已部署成功');
        console.log('错误:', error.message);
        console.log(`🌐 Worker地址: https://${CLOUDFLARE_WORKER_NAME}.${CLOUDFLARE_ACCOUNT_ID}.workers.dev`);
    }
    
    return result;
}

deployToCloudflare().catch(err => {
    console.error('💥 部署错误:', err);
    process.exit(1);
});