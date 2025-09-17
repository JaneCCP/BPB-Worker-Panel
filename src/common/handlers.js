import { Authenticate, generateJWTToken, resetPassword } from "#auth";
import { getClashNormalConfig, getClashWarpConfig } from "#configs/clash";
import { extractWireguardParams } from "#configs/utils";
import { getSingBoxCustomConfig, getSingBoxWarpConfig } from "#configs/sing-box";
import { getXrayCustomConfigs, getXrayWarpConfigs } from "#configs/xray";
import { getSimpleNormalConfigs } from "#configs/simpleNormal";
import { getDataset, updateDataset } from "#kv";
import JSZip from "jszip";
import { fetchWarpConfigs } from "#protocols/warp";
import { globalConfig, httpConfig, wsConfig } from "#common/init";
import { VlOverWSHandler } from "#protocols/websocket/vless";
import { TrOverWSHandler } from "#protocols/websocket/trojan";
export let settings = {}

export async function handleWebsocket(request) {
    const encodedPathConfig = globalConfig.pathName.replace("/", "") || '';

    // 添加超时保护
    const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
            reject(new Error('WebSocket处理超时'));
        }, 30000); // 30秒超时
    });

    const wsPromise = (async () => {
        try {
            // 验证编码路径的有效性
            if (!encodedPathConfig || encodedPathConfig.length > 1000) {
                throw new Error('无效的路径配置');
            }

            // 验证是否为有效的 base64
            if (!/^[A-Za-z0-9+/]+=*$/.test(encodedPathConfig)) {
                throw new Error('路径配置格式无效');
            }

            const { protocol, mode, panelIPs } = JSON.parse(atob(encodedPathConfig));
            
            // 验证解析后的配置
            if (!protocol || !['vl', 'tr'].includes(protocol)) {
                throw new Error('不支持的协议类型');
            }

            Object.assign(wsConfig, {
                wsProtocol: protocol,
                proxyMode: mode,
                panelIPs: panelIPs || []
            });

            switch (protocol) {
                case 'vl':
                    return await VlOverWSHandler(request);
                case 'tr':
                    return await TrOverWSHandler(request);
                default:
                    return await fallback(request);
            }

        } catch (error) {
            console.error('WebSocket处理错误:', error);
            return new Response('解析WebSocket路径配置失败: ' + error.message, { status: 400 });
        }
    })();

    try {
        return await Promise.race([wsPromise, timeoutPromise]);
    } catch (error) {
        console.error('WebSocket超时或错误:', error);
        return new Response('WebSocket处理超时', { status: 408 });
    }
}

export async function handlePanel(request, env) {
    switch (globalConfig.pathName) {
        case '/panel':
            return await renderPanel(request, env);
        case '/panel/settings':
            return await getSettings(request, env);
        case '/panel/update-settings':
            return await updateSettings(request, env);
        case '/panel/reset-settings':
            return await resetSettings(request, env);
        case '/panel/reset-password':
            return await resetPassword(request, env);
        case '/panel/my-ip':
            return await getMyIP(request);
        case '/panel/update-warp':
            return await updateWarpConfigs(request, env);
        case '/panel/get-warp-configs':
            return await getWarpConfigs(request, env);
        default:
            return await fallback(request);
    }
}

export async function handleError(error) {
    const html = hexToString(__ERROR_HTML_CONTENT__).replace('__ERROR_MESSAGE__', error.message);

    return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html' }
    });
}

export async function handleLogin(request, env) {
    if (globalConfig.pathName === '/login') return await renderLogin(request, env);
    if (globalConfig.pathName === '/login/authenticate') return await generateJWTToken(request, env);
    return await fallback(request);
}

export async function handleSubscriptions(request, env) {
    try {
        // 添加超时保护
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error('订阅处理超时'));
            }, 15000); // 15秒超时
        });

        const subPromise = (async () => {
            const dataset = await getDataset(request, env);
            settings = dataset.settings;
            const { client, subPath } = httpConfig;
            
            // 安全解码路径
            let path;
            try {
                path = decodeURIComponent(globalConfig.pathName);
            } catch (error) {
                throw new Error('路径解码失败');
            }

            // 验证路径长度
            if (path.length > 500) {
                throw new Error('路径过长');
            }

            switch (path) {
                case `/sub/simple-normal/${subPath}`:
                    return await getSimpleNormalConfigs();
                    
                case `/sub/normal/${subPath}`:
                    switch (client) {
                        case 'sing-box':
                            return await getSingBoxCustomConfig(env, false);
                        case 'clash':
                            return await getClashNormalConfig(env);
                        case 'xray':
                            return await getXrayCustomConfigs(env, false);
                        default:
                            return new Response('不支持的客户端类型', { status: 400 });
                    }

                case `/sub/fragment/${subPath}`:
                    switch (client) {
                        case 'sing-box':
                            return await getSingBoxCustomConfig(env, true);
                        case 'xray':
                            return await getXrayCustomConfigs(env, true);
                        default:
                            return new Response('不支持的客户端类型', { status: 400 });
                    }

                case `/sub/warp/${subPath}`:
                    switch (client) {
                        case 'clash':
                            return await getClashWarpConfig(request, env, false);
                        case 'sing-box':
                            return await getSingBoxWarpConfig(request, env);
                        case 'xray':
                            return await getXrayWarpConfigs(request, env, false);
                        default:
                            return new Response('不支持的客户端类型', { status: 400 });
                    }

                case `/sub/warp-pro/${subPath}`:
                    switch (client) {
                        case 'clash':
                            return await getClashWarpConfig(request, env, true);
                        case 'xray-knocker':
                        case 'xray':
                            return await getXrayWarpConfigs(request, env, true);
                        default:
                            return new Response('不支持的客户端类型', { status: 400 });
                    }

                default:
                    return await fallback(request);
            }
        })();

        return await Promise.race([subPromise, timeoutPromise]);
        
    } catch (error) {
        console.error('订阅处理错误:', error);
        return new Response('订阅处理失败: ' + error.message, { 
            status: 500,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
        });
    }
}

async function updateSettings(request, env) {
    if (request.method === 'POST') {
        const auth = await Authenticate(request, env);
        if (!auth) return await respond(false, 401, '未授权或会话已过期');
        const proxySettings = await updateDataset(request, env);
        return await respond(true, 200, null, proxySettings);
    }

    return await respond(false, 405, '方法不被允许');
}

async function resetSettings(request, env) {
    if (request.method === 'POST') {
        const auth = await Authenticate(request, env);
        if (!auth) return await respond(false, 401, '未授权或会话已过期');
        const proxySettings = await updateDataset(request, env);
        return await respond(true, 200, null, proxySettings);
    }

    return await respond(false, 405, '方法不被允许');
}

async function getSettings(request, env) {
    const isPassSet = await env.kv.get('pwd') ? true : false;
    const auth = await Authenticate(request, env);
    if (!auth) return await respond(false, 401, '未授权或会话已过期', { isPassSet });
    const dataset = await getDataset(request, env);
    const data = {
        proxySettings: dataset.settings,
        isPassSet,
        subPath: httpConfig.subPath
    };

    return await respond(true, 200, null, data);
}

export async function fallback(request) {
    try {
        const url = new URL(request.url);
        
        // 防止无限重定向
        if (url.hostname === globalConfig.fallbackDomain) {
            return new Response('Fallback loop detected', { status: 500 });
        }
        
        url.hostname = globalConfig.fallbackDomain || 'www.baidu.com';
        url.protocol = 'https:';
        
        const newRequest = new Request(url.toString(), {
            method: request.method,
            headers: request.headers,
            body: request.body,
            redirect: 'manual'
        });

        // 添加超时保护
        const fetchPromise = fetch(newRequest);
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                reject(new Error('Fallback请求超时'));
            }, 10000); // 10秒超时
        });

        return await Promise.race([fetchPromise, timeoutPromise]);
        
    } catch (error) {
        console.error('Fallback错误:', error);
        return new Response('Fallback failed: ' + error.message, { 
            status: 502,
            headers: { 'Content-Type': 'text/plain' }
        });
    }
}

async function getMyIP(request) {
    const ip = (await request.text()).trim();
    try {
        const response = await fetch(`http://ip-api.com/json/${ip}?nocache=${Date.now()}&lang=zh-CN`);
        const geoLocation = await response.json();
        return await respond(true, 200, null, geoLocation);
    } catch (error) {
        console.error('获取IP地址时出错:', error);
        return await respond(false, 500, `获取IP地址时出错: ${error}`)
    }
}

async function getWarpConfigs(request, env) {
    const isPro = httpConfig.client === 'amnezia';
    const auth = await Authenticate(request, env);
    if (!auth) return new Response('未授权或会话已过期', { status: 401 });
    const { warpConfigs, settings } = await getDataset(request, env);
    const warpConfig = extractWireguardParams(warpConfigs, false);
    const { warpIPv6, publicKey, privateKey } = warpConfig;
    const { warpEndpoints, amneziaNoiseCount, amneziaNoiseSizeMin, amneziaNoiseSizeMax } = settings;
    const zip = new JSZip();
    const trimLines = (string) => string.split("\n").map(line => line.trim()).join("\n");
    const amneziaNoise = isPro
        ?
        `Jc = ${amneziaNoiseCount}
        Jmin = ${amneziaNoiseSizeMin}
        Jmax = ${amneziaNoiseSizeMax}
        S1 = 0
        S2 = 0
        H1 = 0
        H2 = 0
        H3 = 0
        H4 = 0`
        : '';

    try {
        warpEndpoints.forEach((endpoint, index) => {
            zip.file(`${atob('QlBC')}-Warp-${index + 1}.conf`, trimLines(
                `[Interface]
                PrivateKey = ${privateKey}
                Address = 172.16.0.2/32, ${warpIPv6}
                DNS = 8.8.8.8, 8.8.4.4
                MTU = 1280
                ${amneziaNoise}
                [Peer]
                PublicKey = ${publicKey}
                AllowedIPs = 0.0.0.0/0, ::/0
                Endpoint = ${endpoint}
                PersistentKeepalive = 25`
            ));
        });

        const zipBlob = await zip.generateAsync({ type: "blob" });
        const arrayBuffer = await zipBlob.arrayBuffer();
        return new Response(arrayBuffer, {
            headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="${atob('QlBC')}-Warp-${isPro ? "Pro-" : ""}configs.zip"`,
            },
        });
    } catch (error) {
        return new Response(`生成ZIP文件时出错: ${error}`, { status: 500 });
    }
}

export async function serveIcon() {
    const faviconBase64 = __ICON__;
    return new Response(Uint8Array.from(atob(faviconBase64), c => c.charCodeAt(0)), {
        headers: {
            'Content-Type': 'image/x-icon',
            'Cache-Control': 'public, max-age=86400',
        }
    });
}

async function renderPanel(request, env) {
    const pwd = await env.kv.get('pwd');
    if (pwd) {
        const auth = await Authenticate(request, env);
        if (!auth) return Response.redirect(`${httpConfig.urlOrigin}/login`, 302);
    }

    const html = hexToString(__PANEL_HTML_CONTENT__);
    return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
    });
}

async function renderLogin(request, env) {
    const auth = await Authenticate(request, env);
    if (auth) return Response.redirect(`${httpConfig.urlOrigin}/panel`, 302);

    const html = hexToString(__LOGIN_HTML_CONTENT__);
    return new Response(html, {
        headers: { 'Content-Type': 'text/html' }
    });
}

export async function renderSecrets() {
    const html = hexToString(__SECRETS_HTML_CONTENT__);
    return new Response(html, {
        headers: { 'Content-Type': 'text/html' },
    });
}

async function updateWarpConfigs(request, env) {
    if (request.method === 'POST') {
        const auth = await Authenticate(request, env);
        if (!auth) return await respond(false, 401, '未授权');
        try {
            await fetchWarpConfigs(env);
            return await respond(true, 200, 'Warp配置更新成功！');
        } catch (error) {
            console.log(error);
            return await respond(false, 500, `更新Warp配置时出错: ${error}`);
        }
    }

    return await respond(false, 405, '方法不被允许');
}

export async function respond(success, status, message, body, customHeaders) {
    return new Response(JSON.stringify({
        success,
        status,
        message: message || '',
        body: body || ''
    }), {
        headers: customHeaders || {
            'Content-Type': message ? 'text/plain' : 'application/json'
        }
    });
}

function hexToString(hex) {
    const bytes = new Uint8Array(hex.match(/.{1,2}/g).map(b => parseInt(b, 16)));
    const decoder = new TextDecoder();
    return decoder.decode(bytes);
}

export function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
}