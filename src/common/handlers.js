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

    try {
        const { protocol, mode, panelIPs } = JSON.parse(atob(encodedPathConfig));
        Object.assign(wsConfig, {
            wsProtocol: protocol,
            proxyMode: mode,
            panelIPs: panelIPs
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
        return new Response('解析WebSocket路径配置失败', { status: 400 });
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
    const dataset = await getDataset(request, env);
    settings = dataset.settings;
    const { client, subPath } = httpConfig;
    const path = decodeURIComponent(globalConfig.pathName);
    const url = new URL(request.url);
    const appParam = url.searchParams.get('app');

    switch (path) {
        case `/sub/simple-normal/${subPath}`:
            return await getSimpleNormalConfigs();
        case `/sub/normal/${subPath}`:
            // 检查是否有app=singbox参数，决定使用哪组配置
            if (appParam === 'singbox') {
                // 第二组应用程序 (husi, Nekobox, Nekoray, Karing)
                switch (client) {
                    case 'sing-box':
                        return await getSingBoxCustomConfig(env, false);
                    case 'clash':
                        return await getClashNormalConfig(env);
                    case 'xray':
                        return await getXrayCustomConfigs(env, false);
                    default:
                        break;
                }
            } else {
                // 第一组应用程序 (v2rayNG, MahsaNG, v2rayN, v2rayN-PRO, Shadowrocket, Streisand, Hiddify)
                switch (client) {
                    case 'sing-box':
                        return await getSingBoxCustomConfig(env, false);
                    case 'clash':
                        return await getClashNormalConfig(env);
                    case 'xray':
                        return await getXrayCustomConfigs(env, false);
                    default:
                        break;
                }
            }

        case `/sub/fragment/${subPath}`:
            switch (client) {
                case 'sing-box':
                    return await getSingBoxCustomConfig(env, true);
                case 'xray':
                    return await getXrayCustomConfigs(env, true);
                default:
                    break;
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
                    break;
            }

        case `/sub/warp-pro/${subPath}`:
            switch (client) {
                case 'clash':
                    return await getClashWarpConfig(request, env, true);
                case 'xray-knocker':
                case 'xray':
                    return await getXrayWarpConfigs(request, env, true);
                default:
                    break;
            }

        default:
            return await fallback(request);
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
    const url = new URL(request.url);
    url.hostname = globalConfig.fallbackDomain;
    url.protocol = 'https:';
    const newRequest = new Request(url.toString(), {
        method: request.method,
        headers: request.headers,
        body: request.body,
        redirect: 'manual'
    });

    return await fetch(newRequest);
}

async function getMyIP(request) {
    const ip = (await request.text()).trim();
    
    // 创建超时控制器
    const timeoutMs = 3000; // 5秒超时
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    // 备用 API 列表
    const apis = [
        {
            url: `https://ipapi.co/${ip}/json/`,
            transform: (data) => ({
                status: 'success',
                country: data.country_name,
                countryCode: data.country_code,
                region: data.region,
                regionName: data.region,
                city: data.city,
                zip: data.postal,
                lat: data.latitude,
                lon: data.longitude,
                timezone: data.timezone,
                isp: data.org,
                org: data.org,
                as: data.asn,
                query: data.ip
            })
        },
        {
            url: `http://ip-api.com/json/${ip}?lang=zh-CN`,
            transform: (data) => data
        },
        {
            url: `https://ipinfo.io/${ip}/json`,
            transform: (data) => ({
                status: 'success',
                country: data.country,
                countryCode: data.country,
                region: data.region,
                regionName: data.region,
                city: data.city,
                zip: data.postal,
                lat: parseFloat(data.loc?.split(',')[0]) || 0,
                lon: parseFloat(data.loc?.split(',')[1]) || 0,
                timezone: data.timezone,
                isp: data.org,
                org: data.org,
                as: data.org,
                query: data.ip
            })
        }
    ];
    
    try {
        // 并行请求所有 API，使用第一个成功的响应
        const promises = apis.map(async (api) => {
            try {
                const response = await fetch(api.url, {
                    signal: controller.signal,
                    headers: {
                        'User-Agent': 'BPB-Worker-Panel/1.0'
                    }
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                
                const data = await response.json();
                return api.transform(data);
            } catch (error) {
                throw new Error(`${api.url}: ${error.message}`);
            }
        });
        
        // 使用 Promise.any 获取第一个成功的结果
        const geoLocation = await Promise.any(promises);
        clearTimeout(timeoutId);
        
        // 检查结果有效性
        if (!geoLocation || (geoLocation.status && geoLocation.status === 'fail')) {
            throw new Error('所有 API 都返回了无效数据');
        }
        
        return await respond(true, 200, null, geoLocation);
        
    } catch (error) {
        clearTimeout(timeoutId);
        console.error('获取IP地址时出错:', error);
        
        // 如果是超时错误，返回更友好的错误信息
        if (error.name === 'AbortError') {
            return await respond(false, 408, '请求超时，请稍后重试');
        }
        
        // 如果所有 API 都失败，返回基本信息
        if (error instanceof AggregateError) {
            console.error('所有 IP API 都失败了:', error.errors);
            return await respond(false, 503, '所有 IP 查询服务暂时不可用，请稍后重试');
        }
        
        return await respond(false, 500, `获取IP地址时出错: ${error.message || error}`);
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
                DNS = 1.1.1.1, 1.0.0.1
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