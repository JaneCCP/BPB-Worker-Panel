import { globalConfig, httpConfig } from '#common/init';
import { getConfigAddresses, generateRemark, randomUpperCase, base64EncodeUnicode, generateWsPath } from '#configs/utils';
import { settings } from '#common/handlers';

export async function getSimpleNormalConfigs() {
    let VLConfs = '', TRConfs = '', chainProxy = '';
    let proxyIndex = 1;
    const Addresses = await getConfigAddresses(false);

    // 检查地址列表是否为空，如果为空则返回错误信息
    if (!Addresses || Addresses.length === 0) {
        const errorMessage = '配置错误：未设置任何可用的 CDN 地址或优选域名。请在控制面板中配置。';
        return new Response(errorMessage, {
            status: 400,
            headers: {
                'Content-Type': 'text/plain;charset=utf-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'CDN-Cache-Control': 'no-store'
            }
        });
    }

    const buildConfig = (protocol, addr, port, host, sni, remark) => {
        const isTLS = httpConfig.defaultHttpsPorts.includes(port);
        const security = isTLS ? 'tls' : 'none';
        
        const config = new URL(`${protocol}://config`);
        let pathProtocol = 'vl';

        if (protocol === 'vless') {
            config.username = globalConfig.userID;
            config.searchParams.append('encryption', 'none');
        } else {
            config.username = globalConfig.TrPass;
            pathProtocol = 'tr';
        }

        const path = generateWsPath(pathProtocol);
        config.hostname = addr;
        config.port = port;
        config.searchParams.append('host', host);
        config.searchParams.append('type', 'ws');
        config.searchParams.append('security', security);
        config.hash = remark;

        if (httpConfig.client === 'singbox') {
            config.searchParams.append('eh', 'Sec-WebSocket-Protocol');
            config.searchParams.append('ed', '2560');
            config.searchParams.append('path', path);
        } else {
            config.searchParams.append('path', `${path}?ed=2560`);
        }

        if (isTLS) {
            config.searchParams.append('sni', sni);
            config.searchParams.append('fp', settings.fingerprint);
            config.searchParams.append('alpn', 'http/1.1');
        }

        return config.href;
    }

    settings.ports.forEach(port => {
        Addresses.forEach(addr => {
            const isCustomAddr = settings.customCdnAddrs.includes(addr);
            const configType = isCustomAddr ? 'C' : '';
            const sni = isCustomAddr ? settings.customCdnSni : randomUpperCase(httpConfig.hostName);
            const host = isCustomAddr ? settings.customCdnHost : httpConfig.hostName;

            const VLRemark = generateRemark(proxyIndex, port, addr, settings.cleanIPs, 'VLESS', configType);
            const TRRemark = generateRemark(proxyIndex, port, addr, settings.cleanIPs, 'Trojan', configType);

            if (settings.VLConfigs) {
                const vlConfig = buildConfig('vless', addr, port, host, sni, VLRemark);
                VLConfs += `${vlConfig}\n`;
            }

            if (settings.TRConfigs) {
                const trConfig = buildConfig('trojan', addr, port, host, sni, TRRemark);
                TRConfs += `${trConfig}\n`;
            }

            proxyIndex++;
        });
    });

    if (settings.outProxy) {
        let chainRemark = `#${encodeURIComponent('💦 链式代理 🔗')}`;
        if (settings.outProxy.startsWith('socks') || settings.outProxy.startsWith('http')) {
            const regex = /^(?:socks|http):\/\/([^@]+)@/;
            const isUserPass = settings.outProxy.match(regex);
            const userPass = isUserPass ? isUserPass[1] : false;
            chainProxy = userPass
                ? settings.outProxy.replace(userPass, btoa(userPass)) + chainRemark
                : settings.outProxy + chainRemark;
        } else {
            chainProxy = settings.outProxy.split('#')[0] + chainRemark;
        }
    }

    const configs = btoa(VLConfs + TRConfs + chainProxy);
    const hiddifyHash = base64EncodeUnicode(`💦 Normal Sub`);

    return new Response(configs, {
        status: 200,
        headers: {
            'Content-Type': 'text/plain;charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'CDN-Cache-Control': 'no-store',
            'Profile-Title': `base64:${hiddifyHash}`,
            'DNS': settings.remoteDNS
        }
    });
}