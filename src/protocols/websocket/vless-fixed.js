import { isValidUUID } from '#common/handlers';
import { globalConfig } from '#common/init';
import { handleTCPOutBound, makeReadableWebSocketStream, WS_READY_STATE_OPEN } from '#protocols/websocket/common-fixed';

// 添加处理超时和限制
const VLESS_TIMEOUT = 30000; // 30秒超时
const MAX_CHUNK_SIZE = 65536; // 64KB 最大块大小
const MAX_CHUNKS_PER_SECOND = 1000; // 每秒最大块数

export async function VlOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);

    webSocket.accept();

    let address = "";
    let portWithRandomLog = "";
    let chunkCount = 0;
    let lastChunkTime = Date.now();
    
    const log = (info, event) => {
        console.log(`[${address}:${portWithRandomLog}] ${info}`, event || "");
    };
    
    const earlyDataHeader = request.headers.get("sec-websocket-protocol") || "";
    const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

    let remoteSocketWapper = {
        value: null,
    };
    let udpStreamWrite = null;
    let isDns = false;
    let streamClosed = false;

    // 添加全局超时
    const timeoutId = setTimeout(() => {
        if (!streamClosed) {
            log('VLESS处理超时，强制关闭连接');
            streamClosed = true;
            try {
                webSocket.close(1008, 'VLESS处理超时');
            } catch (e) {
                console.error('关闭WebSocket时出错:', e);
            }
        }
    }, VLESS_TIMEOUT);

    try {
        // ws --> remote
        await readableWebSocketStream.pipeTo(new WritableStream({
            async write(chunk) {
                if (streamClosed) return;

                // 速率限制检查
                const now = Date.now();
                if (now - lastChunkTime < 1000) {
                    chunkCount++;
                    if (chunkCount > MAX_CHUNKS_PER_SECOND) {
                        log('检测到异常高频数据传输，可能存在循环');
                        throw new Error('数据传输频率过高');
                    }
                } else {
                    chunkCount = 0;
                    lastChunkTime = now;
                }

                // 检查块大小
                if (chunk.byteLength > MAX_CHUNK_SIZE) {
                    log(`数据块过大: ${chunk.byteLength} bytes`);
                    throw new Error('数据块大小超过限制');
                }

                if (isDns && udpStreamWrite) {
                    return udpStreamWrite(chunk);
                }

                if (remoteSocketWapper.value) {
                    const writer = remoteSocketWapper.value.writable.getWriter();
                    try {
                        await writer.write(chunk);
                        writer.releaseLock();
                    } catch (error) {
                        writer.releaseLock();
                        throw error;
                    }
                    return;
                }

                const {
                    hasError,
                    message,
                    portRemote = 443,
                    addressRemote = "",
                    rawDataIndex,
                    VLVersion = new Uint8Array([0, 0]),
                    isUDP,
                } = processVLHeader(chunk, globalConfig.userID);
                
                address = addressRemote;
                portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? "udp " : "tcp "} `;
                
                if (hasError) {
                    throw new Error(message);
                }
                
                const VLResponseHeader = new Uint8Array([VLVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex);
                
                if (isUDP) {
                    if (portRemote === 53) {
                        isDns = true;
                        const { write } = await handleUDPOutBound(webSocket, VLResponseHeader, log);
                        udpStreamWrite = write;
                        udpStreamWrite(rawClientData);
                        return;
                    } else {
                        throw new Error("UDP代理仅支持DNS，端口为53");
                    }
                }

                handleTCPOutBound(
                    remoteSocketWapper,
                    addressRemote,
                    portRemote,
                    rawClientData,
                    webSocket,
                    VLResponseHeader,
                    log
                );
            },
            close() {
                streamClosed = true;
                clearTimeout(timeoutId);
                log(`readableWebSocketStream 已关闭`);
            },
            abort(reason) {
                streamClosed = true;
                clearTimeout(timeoutId);
                log(`readableWebSocketStream 已中止`, JSON.stringify(reason));
            },
        }));
    } catch (err) {
        streamClosed = true;
        clearTimeout(timeoutId);
        log("readableWebSocketStream pipeTo 错误", err);
        
        try {
            webSocket.close(1011, err.message);
        } catch (closeError) {
            console.error('关闭WebSocket时出错:', closeError);
        }
    }

    return new Response(null, {
        status: 101,
        webSocket: client,
    });
}

function processVLHeader(VLBuffer, userID) {
    if (VLBuffer.byteLength < 24) {
        return {
            hasError: true,
            message: "无效数据",
        };
    }
    
    const version = new Uint8Array(VLBuffer.slice(0, 1));
    let isValidUser = false;
    let isUDP = false;
    const slicedBuffer = new Uint8Array(VLBuffer.slice(1, 17));
    const slicedBufferString = stringify(slicedBuffer);
    isValidUser = slicedBufferString === userID;

    if (!isValidUser) {
        return {
            hasError: true,
            message: "无效用户",
        };
    }

    const optLength = new Uint8Array(VLBuffer.slice(17, 18))[0];
    const command = new Uint8Array(VLBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

    if (command === 1) { 
        // TCP
    } else if (command === 2) {
        isUDP = true;
    } else {
        return {
            hasError: true,
            message: `不支持命令 ${command}，命令格式: 01-tcp,02-udp,03-mux`,
        };
    }
    
    const portIndex = 18 + optLength + 1;
    const portBuffer = VLBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(VLBuffer.slice(addressIndex, addressIndex + 1));
    const addressType = addressBuffer[0];
    let addressLength = 0;
    let addressValueIndex = addressIndex + 1;
    let addressValue = "";
    
    switch (addressType) {
        case 1:
            addressLength = 4;
            addressValue = new Uint8Array(VLBuffer.slice(addressValueIndex, addressValueIndex + addressLength)).join(".");
            break;
        case 2:
            addressLength = new Uint8Array(VLBuffer.slice(addressValueIndex, addressValueIndex + 1))[0];
            addressValueIndex += 1;
            addressValue = new TextDecoder().decode(VLBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            break;
        case 3: {
            addressLength = 16;
            const dataView = new DataView(VLBuffer.slice(addressValueIndex, addressValueIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(":");
            break;
        }
        default:
            return {
                hasError: true,
                message: `无效的地址类型: ${addressType}`,
            };
    }
    
    if (!addressValue) {
        return {
            hasError: true,
            message: `地址值为空，地址类型为: ${addressType}`,
        };
    }

    return {
        hasError: false,
        addressRemote: addressValue,
        addressType,
        portRemote,
        rawDataIndex: addressValueIndex + addressLength,
        VLVersion: version,
        isUDP,
    };
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
    byteToHex.push((i + 256).toString(16).slice(1));
}

function unsafeStringify(arr, offset = 0) {
    return (
        byteToHex[arr[offset + 0]] +
        byteToHex[arr[offset + 1]] +
        byteToHex[arr[offset + 2]] +
        byteToHex[arr[offset + 3]] +
        "-" +
        byteToHex[arr[offset + 4]] +
        byteToHex[arr[offset + 5]] +
        "-" +
        byteToHex[arr[offset + 6]] +
        byteToHex[arr[offset + 7]] +
        "-" +
        byteToHex[arr[offset + 8]] +
        byteToHex[arr[offset + 9]] +
        "-" +
        byteToHex[arr[offset + 10]] +
        byteToHex[arr[offset + 11]] +
        byteToHex[arr[offset + 12]] +
        byteToHex[arr[offset + 13]] +
        byteToHex[arr[offset + 14]] +
        byteToHex[arr[offset + 15]]
    ).toLowerCase();
}

function stringify(arr, offset = 0) {
    const uuid = unsafeStringify(arr, offset);
    if (!isValidUUID(uuid)) {
        throw TypeError("字符串化的UUID无效");
    }
    return uuid;
}

async function handleUDPOutBound(webSocket, VLResponseHeader, log) {
    let isVLHeaderSent = false;
    let messageCount = 0;
    const MAX_UDP_MESSAGES = 1000; // 限制UDP消息数量
    
    const transformStream = new TransformStream({
        start(controller) { },
        transform(chunk, controller) {
            messageCount++;
            if (messageCount > MAX_UDP_MESSAGES) {
                log('UDP消息数量超过限制');
                controller.error(new Error('UDP消息数量超过限制'));
                return;
            }

            // 处理UDP数据包
            for (let index = 0; index < chunk.byteLength;) {
                if (index + 2 > chunk.byteLength) {
                    log('UDP数据包格式错误：长度不足');
                    break;
                }
                
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
                
                if (index + 2 + udpPakcetLength > chunk.byteLength) {
                    log('UDP数据包格式错误：数据长度不匹配');
                    break;
                }
                
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
                index = index + 2 + udpPakcetLength;
                controller.enqueue(udpData);
            }
        },
        flush(controller) { },
    });

    // DNS查询处理
    transformStream.readable
        .pipeTo(
            new WritableStream({
                async write(chunk) {
                    try {
                        const dnsPromise = fetch(
                            globalConfig.dohURL,
                            {
                                method: "POST",
                                headers: {
                                    "content-type": "application/dns-message",
                                },
                                body: chunk,
                            }
                        );

                        // 添加DNS查询超时
                        const timeoutPromise = new Promise((_, reject) => {
                            setTimeout(() => reject(new Error('DNS查询超时')), 5000);
                        });

                        const resp = await Promise.race([dnsPromise, timeoutPromise]);
                        const dnsQueryResult = await resp.arrayBuffer();
                        const udpSize = dnsQueryResult.byteLength;
                        
                        const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
                        
                        if (webSocket.readyState === WS_READY_STATE_OPEN) {
                            log(`DoH成功，DNS消息长度为 ${udpSize}`);
                            if (isVLHeaderSent) {
                                webSocket.send(await new Blob([udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                            } else {
                                webSocket.send(await new Blob([VLResponseHeader, udpSizeBuffer, dnsQueryResult]).arrayBuffer());
                                isVLHeaderSent = true;
                            }
                        }
                    } catch (error) {
                        log("DNS查询失败: " + error.message);
                    }
                },
            })
        )
        .catch((error) => {
            log("DNS UDP 发生错误: " + error);
        });

    const writer = transformStream.writable.getWriter();

    return {
        write(chunk) {
            try {
                writer.write(chunk);
            } catch (error) {
                log("UDP写入错误: " + error.message);
            }
        },
    };
}