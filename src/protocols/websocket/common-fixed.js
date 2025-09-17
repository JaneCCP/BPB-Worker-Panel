import { connect } from 'cloudflare:sockets';
import { isIPv4, parseHostPort, resolveDNS } from '#configs/utils';
import { wsConfig } from '#common/init';

export const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;

// 添加超时和重试限制
const CONNECTION_TIMEOUT = 10000; // 10秒超时
const MAX_RETRY_ATTEMPTS = 3;
const RETRY_DELAY = 1000; // 1秒重试延迟

export async function handleTCPOutBound(
    remoteSocket,
    addressRemote,
    portRemote,
    rawClientData,
    webSocket,
    VLResponseHeader,
    log
) {
    let retryCount = 0;

    async function connectAndWrite(address, port) {
        // 添加连接超时
        const connectPromise = connect({
            hostname: address,
            port: port,
        });

        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('连接超时')), CONNECTION_TIMEOUT);
        });

        const tcpSocket = await Promise.race([connectPromise, timeoutPromise]);
        
        remoteSocket.value = tcpSocket;
        log(`已连接到 ${address}:${port}`);
        
        const writer = tcpSocket.writable.getWriter();
        await writer.write(rawClientData);
        writer.releaseLock();
        return tcpSocket;
    }

    async function retry() {
        // 限制重试次数，防止无限循环
        if (retryCount >= MAX_RETRY_ATTEMPTS) {
            log(`已达到最大重试次数 (${MAX_RETRY_ATTEMPTS})，停止重试`);
            webSocket.close(1011, '连接失败：已达到最大重试次数');
            return;
        }

        retryCount++;
        log(`第 ${retryCount} 次重试连接`);

        // 添加重试延迟
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * retryCount));

        let tcpSocket;
        const { proxyMode, panelIPs } = wsConfig;
        const getRandomValue = (arr) => arr[Math.floor(Math.random() * arr.length)];
        const parseIPs = (value) => value ? value.split(',').map(val => val.trim()).filter(Boolean) : undefined;

        try {
            if (proxyMode === 'proxyip') {
                log(`直连失败，尝试为 ${addressRemote} 使用代理IP (重试 ${retryCount})`);
                const proxyIPs = parseIPs(wsConfig.envProxyIPs) || wsConfig.defaultProxyIPs;
                const ips = panelIPs.length ? panelIPs : proxyIPs;
                const proxyIP = getRandomValue(ips);
                const { host, port } = parseHostPort(proxyIP, true);
                tcpSocket = await connectAndWrite(host || addressRemote, port || portRemote);
            } else if (proxyMode === 'prefix') {
                log(`直连失败，尝试为 ${addressRemote} 生成动态前缀 (重试 ${retryCount})`);
                const prefixes = parseIPs(wsConfig.envPrefixes) || wsConfig.defaultPrefixes;
                const ips = panelIPs.length ? panelIPs : prefixes;
                const prefix = getRandomValue(ips);
                const dynamicProxyIP = await getDynamicProxyIP(addressRemote, prefix);
                tcpSocket = await connectAndWrite(dynamicProxyIP, portRemote);
            }

            if (tcpSocket) {
                tcpSocket.closed.catch(error => {
                    console.log('重试 tcpSocket 关闭错误', error);
                }).finally(() => {
                    safeCloseWebSocket(webSocket);
                });

                remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, null, log);
            }
        } catch (error) {
            console.error(`重试 ${retryCount} 失败:`, error);
            if (retryCount < MAX_RETRY_ATTEMPTS) {
                // 递归重试，但有限制
                await retry();
            } else {
                webSocket.close(1011, '所有重试均失败: ' + error.message);
            }
        }
    }

    try {
        const tcpSocket = await connectAndWrite(addressRemote, portRemote);
        remoteSocketToWS(tcpSocket, webSocket, VLResponseHeader, retry, log);
    } catch (error) {
        console.error('初始连接失败:', error);
        await retry();
    }
}

async function remoteSocketToWS(remoteSocket, webSocket, VLResponseHeader, retry, log) {
    let VLHeader = VLResponseHeader;
    let hasIncomingData = false;
    let streamClosed = false;

    // 添加超时检测
    const timeoutId = setTimeout(() => {
        if (!hasIncomingData && !streamClosed) {
            log('检测到可能的死锁，强制关闭连接');
            safeCloseWebSocket(webSocket);
            streamClosed = true;
        }
    }, CONNECTION_TIMEOUT);

    try {
        await remoteSocket.readable
            .pipeTo(
                new WritableStream({
                    start() { },
                    async write(chunk, controller) {
                        if (streamClosed) return;
                        
                        hasIncomingData = true;
                        clearTimeout(timeoutId); // 清除超时检测
                        
                        if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                            controller.error("webSocket.readyState 未打开，可能已关闭");
                            return;
                        }
                        
                        try {
                            if (VLHeader) {
                                webSocket.send(await new Blob([VLHeader, chunk]).arrayBuffer());
                                VLHeader = null;
                            } else {
                                webSocket.send(chunk);
                            }
                        } catch (sendError) {
                            console.error('发送数据到WebSocket失败:', sendError);
                            controller.error(sendError);
                        }
                    },
                    close() {
                        streamClosed = true;
                        clearTimeout(timeoutId);
                        log(`远程连接!.readable 已关闭，hasIncomingData 为 ${hasIncomingData}`);
                    },
                    abort(reason) {
                        streamClosed = true;
                        clearTimeout(timeoutId);
                        console.error(`远程连接!.readable 中止`, reason);
                    },
                })
            );
    } catch (error) {
        streamClosed = true;
        clearTimeout(timeoutId);
        console.error(`VLRemoteSocketToWS 发生异常 `, error.stack || error);
        safeCloseWebSocket(webSocket);
    }

    // 检查是否需要重试
    if (hasIncomingData === false && retry && !streamClosed) {
        log(`没有接收到数据，准备重试`);
        retry();
    }
}

export function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
    let readableStreamCancel = false;
    let messageCount = 0;
    const MAX_MESSAGES = 10000; // 防止消息过多导致内存问题

    const stream = new ReadableStream({
        start(controller) {
            webSocketServer.addEventListener("message", (event) => {
                if (readableStreamCancel) {
                    return;
                }

                messageCount++;
                if (messageCount > MAX_MESSAGES) {
                    log(`消息数量超过限制 (${MAX_MESSAGES})，关闭连接`);
                    controller.error(new Error('消息数量超过限制'));
                    return;
                }

                const message = event.data;
                controller.enqueue(message);
            });

            webSocketServer.addEventListener("close", () => {
                safeCloseWebSocket(webSocketServer);
                if (readableStreamCancel) {
                    return;
                }
                controller.close();
            });

            webSocketServer.addEventListener("error", (err) => {
                log("webSocketServer 发生错误");
                controller.error(err);
            });

            // 处理早期数据
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull(controller) {
            // 实现背压控制
        },
        cancel(reason) {
            if (readableStreamCancel) {
                return;
            }
            log(`ReadableStream 已取消，原因: ${reason}`);
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
        console.error('safeCloseWebSocket 错误', error);
    }
}

async function getDynamicProxyIP(address, prefix) {
    let finalAddress = address;
    
    // 添加DNS解析超时
    const DNS_TIMEOUT = 5000; // 5秒DNS超时
    
    if (!isIPv4(address)) {
        try {
            const dnsPromise = resolveDNS(address, true);
            const timeoutPromise = new Promise((_, reject) => {
                setTimeout(() => reject(new Error('DNS解析超时')), DNS_TIMEOUT);
            });
            
            const { ipv4 } = await Promise.race([dnsPromise, timeoutPromise]);
            
            if (ipv4.length) {
                finalAddress = ipv4[0];
            } else {
                throw new Error('无法在DNS记录中找到IPv4');
            }
        } catch (error) {
            console.error('DNS解析失败:', error);
            throw error;
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