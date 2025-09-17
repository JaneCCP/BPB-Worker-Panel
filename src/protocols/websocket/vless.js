import { isValidUUID } from '#common/handlers';
import { globalConfig } from '#common/init';
import { handleTCPOutBound, makeReadableWebSocketStream, WS_READY_STATE_OPEN } from '#protocols/websocket/common';

export async function VlOverWSHandler(request) {
    const webSocketPair = new WebSocketPair();
    const [client, webSocket] = Object.values(webSocketPair);

    webSocket.accept();

    let address = "";
    let portWithRandomLog = "";
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

    // ws --> remote
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
            try {
                if (isDns && udpStreamWrite) {
                    return udpStreamWrite(chunk);
                }

                if (remoteSocketWapper.value) {
                    const writer = remoteSocketWapper.value.writable.getWriter();
                    await writer.write(chunk);
                    writer.releaseLock();
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
                    log(`VLESS 头部解析错误: ${message}`);
                    webSocket.close(1002, message);
                    return;
                }
                
                // ["version", "附加信息长度 N"]
                const VLResponseHeader = new Uint8Array([VLVersion[0], 0]);
                const rawClientData = chunk.slice(rawDataIndex);
                
                // if UDP but port not DNS port, close it
                if (isUDP) {
                    if (portRemote === 53) {
                        isDns = true;
                        try {
                            const { write } = await handleUDPOutBound(webSocket, VLResponseHeader, log);
                            udpStreamWrite = write;
                            udpStreamWrite(rawClientData);
                        } catch (udpError) {
                            log(`UDP 处理错误: ${udpError.message}`);
                            webSocket.close(1011, 'UDP处理失败');
                        }
                        return;
                    } else {
                        log(`不支持的UDP端口: ${portRemote}`);
                        webSocket.close(1002, "UDP代理仅支持DNS，端口为53");
                        return;
                    }
                }

                // 添加 TCP 连接超时处理
                try {
                    await handleTCPOutBound(
                        remoteSocketWapper,
                        addressRemote,
                        portRemote,
                        rawClientData,
                        webSocket,
                        VLResponseHeader,
                        log
                    );
                } catch (tcpError) {
                    log(`TCP 连接错误: ${tcpError.message}`);
                    webSocket.close(1011, 'TCP连接失败');
                }
            } catch (error) {
                log(`写入流错误: ${error.message}`);
                webSocket.close(1011, '处理错误');
            }
        },
        close() {
            log(`readableWebSocketStream 已关闭`);
        },
        abort(reason) {
            log(`readableWebSocketStream 已中止`, JSON.stringify(reason));
        },
    })
    )
        .catch((err) => {
            log("readableWebSocketStream pipeTo 错误", err);
            // 确保 WebSocket 被关闭
            if (webSocket.readyState === WS_READY_STATE_OPEN) {
                webSocket.close(1011, 'Stream处理错误');
            }
        });

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
    //skip opt for now

    const command = new Uint8Array(VLBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

    // 0x01 TCP
    // 0x02 UDP
    // 0x03 MUX
    if (command === 1) { /* empty */ } else if (command === 2) {
        isUDP = true;
    } else {
        return {
            hasError: true,
            message: `不支持命令 ${command}，命令格式: 01-tcp,02-udp,03-mux`,
        };
    }
    const portIndex = 18 + optLength + 1;
    const portBuffer = VLBuffer.slice(portIndex, portIndex + 2);
    // port is big-Endian in raw data etc 80 == 0x005d
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(VLBuffer.slice(addressIndex, addressIndex + 1));

    // 1--> ipv4  addressLength =4
    // 2--> domain name addressLength=addressBuffer[1]
    // 3--> ipv6  addressLength =16
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
            // 2001:0db8:85a3:0000:0000:8a2e:0370:7334
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(":");
            // seems no need add [] for ipv6
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
    const transformStream = new TransformStream({
        start(controller) { },
        transform(chunk, controller) {
            // udp message 2 byte is the the length of udp data
            // TODO: this should have bug, beacsue maybe udp chunk can be in two websocket message
            for (let index = 0; index < chunk.byteLength;) {
                const lengthBuffer = chunk.slice(index, index + 2);
                const udpPakcetLength = new DataView(lengthBuffer).getUint16(0);
                const udpData = new Uint8Array(chunk.slice(index + 2, index + 2 + udpPakcetLength));
                index = index + 2 + udpPakcetLength;
                controller.enqueue(udpData);
            }
        },
        flush(controller) { },
    });

    // only handle dns udp for now
    transformStream.readable
        .pipeTo(
            new WritableStream({
                async write(chunk) {
                    // 添加 DoH 请求超时处理
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10秒超时
                    
                    try {
                        const resp = await fetch(
                            globalConfig.dohURL, // dns server url
                            {
                                method: "POST",
                                headers: {
                                    "content-type": "application/dns-message",
                                },
                                body: chunk,
                                signal: controller.signal
                            }
                        );
                        clearTimeout(timeoutId);
                        const dnsQueryResult = await resp.arrayBuffer();
                        const udpSize = dnsQueryResult.byteLength;
                        // console.log([...new Uint8Array(dnsQueryResult)].map((x) => x.toString(16)));
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
                    } catch (fetchError) {
                        clearTimeout(timeoutId);
                        log(`DoH 请求失败: ${fetchError.message}`);
                        // 发送错误响应而不是挂起
                        if (webSocket.readyState === WS_READY_STATE_OPEN) {
                            webSocket.close(1011, 'DNS查询失败');
                        }
                        return;
                    }
                },
            })
        )
        .catch((error) => {
            log("DNS UDP 发生错误" + error);
        });

    const writer = transformStream.writable.getWriter();

    return {
        write(chunk) {
            writer.write(chunk);
        },
    };
}