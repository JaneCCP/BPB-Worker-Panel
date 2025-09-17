import { connect } from 'cloudflare:sockets';
import { isIPv4, parseHostPort, resolveDNS } from '#configs/utils';
import { wsConfig } from '#common/init';

export const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

export async function handleTCPOutBound(
    remoteSocket,
    addressRemote,
    portRemote,
    rawClientData,
    webSocket,
    VLResponseHeader,
    log
) {
    async function connectAndWrite(address, port) {
        // if (/^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?).){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/.test(address)) address = `${atob('d3d3Lg==')}${address}${atob('LnNzbGlwLmlv')}`;
        const tcpSocket = connect({
            hostname: address,
            port: port,
        });

        remoteSocket.value = tcpSocket;
        log(`已连接到 ${address}:${port}`);
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData); // 首次写入，通常是TLS客户端hello
        writer.releaseLock();
        return tcpSocket;
    }

    async function retry() {
        let tcpSocket;
        const { proxyMode, panelIPs } = wsConfig;
        const getRandomValue = (arr) => arr[Math.floor(Math.random() * arr.length)];
        const parseIPs = (value) => value ? value.split(',').map(val => val.trim()).filter(Boolean) : undefined;

        if (proxyMode === 'proxyip') {
            log(`直连失败，尝试为 ${addressRemote} 使用代理IP`);
            try {
                const proxyIPs = parseIPs(wsConfig.envProxyIPs) ||  wsConfig.defaultProxyIPs;
                const ips = panelIPs.length ? panelIPs : proxyIPs;
                const proxyIP = getRandomValue(ips);
                const { host, port } = parseHostPort(proxyIP, true);
                tcpSocket = await connectAndWrite(host || addressRemote, port || portRemote);
            } catch (error) {
                console.error('代理IP连接失败:', error);
                webSocket.close(1011, '代理IP连接失败: ' + error.message);
            }

        } else if (proxyMode === 'prefix') {
            log(`直连失败，尝试为 ${addressRemote} 生成动态前缀`);
            try {
                const prefixes = parseIPs(wsConfig.envPrefixes) || wsConfig.defaultPrefixes;
                const ips = panelIPs.length ? panelIPs : prefixes;
                const prefix = getRandomValue(ips);
                const dynamicProxyIP = await getDynamicProxyIP(addressRemote, prefix);
                tcpSocket = await connectAndWrite(dynamicProxyIP, portRemote);
            } catch (error) {
                console.error('前缀连接失败:', error);
                webSocket.close(1011, '前缀连接失败: ' + error.message);
            }
        }

        tcpSocket.closed.catch(error => {
            console.log('重试TCP套接字关闭错误', error);
        }).finally(() => {
            safeCloseWebSocket(webSocket);
        });

        remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, null, log);
    }

    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, retry, log);
    } catch (error) {
        console.error('连接失败:', error);
        webSocket.close(1011, '连接失败');
    }
}

async function remoteSocketToWS(remoteSocket, webSocket, VLResponseHeader, retry, log) {
    // 远程套接字 --> WebSocket
    let VLHeader = VLResponseHeader;
    let hasIncomingData = false; // 检查远程套接字是否有传入数据
    await remoteSocket.readable
        .pipeTo(
            new WritableStream({
                start() { },
                async write(chunk, controller) {
                    hasIncomingData = true;
                    // remoteChunkCount++;
                    if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                        controller.error("WebSocket状态不是打开状态，可能已关闭");
                    }
                    if (VLHeader) {
                        webSocket.send(await new Blob([VLHeader, chunk]).arrayBuffer());
                        VLHeader = null;
                    } else {
                        // 似乎不需要限制速率，CF似乎修复了这个问题？
                        // if (remoteChunkCount > 20000) {
                        // 	// CF一个包是4096字节（4kb），4096 * 20000 = 80M
                        // 	await delay(1);
                        // }
                        webSocket.send(chunk);
                    }
                },
                close() {
                    log(`远程连接可读流已关闭，hasIncomingData为 ${hasIncomingData}`);
                    // safeCloseWebSocket(webSocket); // 不需要服务器先关闭WebSocket，某些情况下会导致HTTP ERR_CONTENT_LENGTH_MISMATCH问题，客户端会发送关闭事件
                },
                abort(reason) {
                    console.error(`远程连接可读流中止`, reason);
                },
            })
        )
        .catch((error) => {
            console.error(`VL远程Socket到WS发生异常 `, error.stack || error);
            safeCloseWebSocket(webSocket);
        });

    // 似乎是CF连接套接字有错误，
    // 1. Socket.closed会有错误
    // 2. Socket.readable会在没有任何数据传入的情况下关闭
    if (hasIncomingData === false && retry) {
        log(`重试`);
        retry();
    }
}

export function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener("message", (event) => {
                if (readableStreamCancel) {
                    return;
                }
                const message = event.data;
                controller.enqueue(message);
            });

            // 该事件意味着客户端关闭了客户端 -> 服务器流。
            // 但是，服务器 -> 客户端流仍然打开，直到您在服务器端调用close()。
            // WebSocket协议规定必须在每个方向发送单独的关闭消息才能完全关闭套接字。
            webSocketServer.addEventListener("close", () => {
                // 客户端发送关闭，需要关闭服务器
                // 如果流被取消，跳过controller.close
                safeCloseWebSocket(webSocketServer);
                if (readableStreamCancel) {
                    return;
                }
                controller.close();
            });
            webSocketServer.addEventListener("error", (err) => {
                log("WebSocket服务器发生错误");
                controller.error(err);
            });
            // 用于WebSocket 0-RTT
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull(controller) {
            // 如果WebSocket可以在流满时停止读取，我们可以实现背压
            // https://streams.spec.whatwg.org/#example-rs-push-backpressure
        },
        cancel(reason) {
            // 1. 管道WritableStream有错误，会调用此cancel，所以WebSocket处理服务器关闭到这里
            // 2. 如果readableStream被取消，所有controller.close/enqueue需要跳过，
            // 3. 但从测试来看，即使readableStream被取消，controller.error仍然有效
            if (readableStreamCancel) {
                return;
            }
            log(`可读流被取消，原因：${reason}`);
            readableStreamCancel = true;
            safeCloseWebSocket(webSocketServer);
        },
    });

    return stream;
}

function base64ToArrayBuffer(base64Str) {
    if (!base64Str) {
        return { earlyData: null, error: null };
    }
    try {
        // Go使用修改的Base64用于URL rfc4648，JS的atob不支持
        base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
        const decode = atob(base64Str);
        const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
        return { earlyData: arryBuffer.buffer, error: null };
    } catch (error) {
        return { earlyData: null, error };
    }
}

export function safeCloseWebSocket(socket) {
    try {
        if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
            socket.close();
        }
    } catch (error) {
        console.error('安全关闭WebSocket错误', error);
    }
}

async function getDynamicProxyIP(address, prefix) {
    let finalAddress = address;
    if (!isIPv4(address)) {
        const { ipv4 } = await resolveDNS(address, true);
        if (ipv4.length) {
            finalAddress = ipv4[0];
        } else {
            throw new Error('在DNS记录中找不到IPv4地址');
        }
    }

    return convertToNAT64IPv6(finalAddress, prefix);
}

function convertToNAT64IPv6(ipv4Address, prefix) {
    const parts = ipv4Address.split('.');
    if (parts.length !== 4) {
        throw new Error('无效的IPv4地址');
    }

    const hex = parts.map(part => {
        const num = parseInt(part, 10);
        if (num < 0 || num > 255) {
            throw new Error('无效的IPv4地址');
        }
        return num.toString(16).padStart(2, '0');
    });

    const match = prefix.match(/^\[([0-9A-Fa-f:]+)\]$/);
    if (match) {
        return `[${match[1]}${hex[0]}${hex[1]}:${hex[2]}${hex[3]}]`;
    }
}

