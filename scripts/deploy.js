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
        const subdomainResponse = await fetch(
            `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/workers/scripts/${CLOUDFLARE_WORKER_NAME}/subdomain`,
            {
                method: 'PUT',
                headers: {
                    'Authorization': `Bearer ${CLOUDFLARE_API_TOKEN}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ enabled: true })
            }
        );

        if (subdomainResponse.ok) {
            console.log('🎉 子域名已启用！');
        } else {
            const errorData = await subdomainResponse.json();
            // 如果已经是启用状态，也视为成功
            if (errorData.errors?.[0]?.code === 10014) {
                console.log('🎉 子域名已处于启用状态！');
            } else {
                console.log('⚠️  子域名配置失败，但Worker已部署成功');
            }
        }
        console.log(`🌐 Worker地址: https://${CLOUDFLARE_WORKER_NAME}.${CLOUDFLARE_ACCOUNT_ID}.workers.dev`);
    } catch (error) {
        console.log('⚠️  子域名配置出错，但Worker已部署成功');
        console.log('🌐 您可能需要手动在Cloudflare控制台中启用子域名');
    }
    
    return result;
}

deployToCloudflare().catch(err => {
    console.error('💥 部署错误:', err);
    process.exit(1);
});