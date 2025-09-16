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
    
    // 添加脚本文件
    formData.append('script', new Blob([workerScript], { type: 'application/javascript' }), 'worker.js');
    
    // 添加配置元数据
    const metadata = {
        main_module: 'worker.js',
        bindings: [
            {
                type: 'kv_namespace',
                name: 'kv',
                namespace_id: CLOUDFLARE_KV_ID
            }
        ],
        vars: {
            ENVIRONMENT: 'production'
        },
        compatibility_date: '2025-09-16'
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
    console.log(`🌐 Worker地址: https://${CLOUDFLARE_WORKER_NAME}.${CLOUDFLARE_ACCOUNT_ID}.workers.dev`);
    
    return result;
}

deployToCloudflare().catch(err => {
    console.error('💥 部署错误:', err);
    process.exit(1);
});