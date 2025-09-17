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
        
        // 添加连接超时处理
        const connectPromise = connect({
            hostname: address,
            port: port,
        });
        
        // 设置 30 秒超时
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('连接超时')), 30000);
        });
        
        const tcpSocket = await Promise.race([connectPromise, timeoutPromise]);
        
        remoteSocket.value = tcpSocket;
        log(`已连接到 ${address}:${port}`);
        
        try {
            const writer = tcpSocket.writable.getWriter();
            await writer.write(rawClientData); // first write, nomal is tls client hello
            writer.releaseLock();
        } catch (writeError) {
            log(`写入数据失败: ${writeError.message}`);
            throw writeError;
        }
        
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
            console.log('重试 tcpSocket 关闭错误', error);
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
    // remote--> ws
    let VLHeader = VLResponseHeader;
    let hasIncomingData = false; // check if remoteSocket has incoming data
    await remoteSocket.readable
        .pipeTo(
            new WritableStream({
                start() { },
                async write(chunk, controller) {
                    hasIncomingData = true;
                    // remoteChunkCount++;
                    if (webSocket.readyState !== WS_READY_STATE_OPEN) {
                        controller.error("webSocket.readyState 未打开，可能已关闭");
                    }
                    if (VLHeader) {
                        webSocket.send(await new Blob([VLHeader, chunk]).arrayBuffer());
                        VLHeader = null;
                    } else {
                        // seems no need rate limit this, CF seems fix this??..
                        // if (remoteChunkCount > 20000) {
                        // 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
                        // 	await delay(1);
                        // }
                        webSocket.send(chunk);
                    }
                },
                close() {
                    log(`远程连接!.readable 已关闭，hasIncomingData 为 ${hasIncomingData}`);
                    // safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
                },
                abort(reason) {
                    console.error(`远程连接!.readable 中止`, reason);
                },
            })
        )
        .catch((error) => {
            console.error(`VLRemoteSocketToWS 发生异常 `, error.stack || error);
            safeCloseWebSocket(webSocket);
        });

    // seems is cf connect socket have error,
    // 1. Socket.closed will have error
    // 2. Socket.readable will be close without any data coming
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

            // The event means that the client closed the client -> server stream.
            // However, the server -> client stream is still open until you call close() on the server side.
            // The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
            webSocketServer.addEventListener("close", () => {
                // client send close, need close server
                // if stream is cancel, skip controller.close
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
            // for ws 0rtt
            const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
            if (error) {
                controller.error(error);
            } else if (earlyData) {
                controller.enqueue(earlyData);
            }
        },
        pull(controller) {
            // if ws can stop read if stream is full, we can implement backpressure
            // https://streams.spec.whatwg.org/#example-rs-push-backpressure
        },
        cancel(reason) {
            // 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
            // 2. if readableStream is cancel, all controller.close/enqueue need skip,
            // 3. but from testing controller.error still work even if readableStream is cancel
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
        // go use modified Base64 for URL rfc4648 which js atob not support
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
    if (!isIPv4(address)) {
        const { ipv4 } = await resolveDNS(address, true);
        if (ipv4.length) {
            finalAddress = ipv4[0];
        } else {
            throw new Error('无法在DNS记录中找到IPv4');
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

