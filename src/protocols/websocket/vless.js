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

    // WebSocket --> 远程服务器
    readableWebSocketStream.pipeTo(new WritableStream({
        async write(chunk) {
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
            portWithRandomLog = `${portRemote}--${Math.random().toFixed(4)} ${isUDP ? "udp " : "tcp "} `;
            
            if (hasError) {
                // controller.error(message);
                throw new Error(message); // Cloudflare似乎有bug，controller.error不会结束流
                // webSocket.close(1000, message);
                // return;
            }
            
            // ["版本", "附加信息长度 N"]
            const VLResponseHeader = new Uint8Array([VLVersion[0], 0]);
            const rawClientData = chunk.slice(rawDataIndex);
            
            // 如果是UDP但端口不是DNS端口，则关闭连接
            if (isUDP) {
                if (portRemote === 53) {
                    isDns = true;
                    const { write } = await handleUDPOutBound(webSocket, VLResponseHeader, log);
                    udpStreamWrite = write;
                    udpStreamWrite(rawClientData);
                    return;
                } else {
                    // controller.error('UDP proxy only enable for DNS which is port 53');
                    throw new Error("UDP代理仅支持DNS服务(端口53)"); // Cloudflare似乎有bug，controller.error不会结束流
                    // return;
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
            log(`可读WebSocket流已关闭`);
        },
        abort(reason) {
            log(`可读WebSocket流已中止`, JSON.stringify(reason));
        },
    })
    )
        .catch((err) => {
            log("可读WebSocket流管道传输错误", err);
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
            message: "数据无效",
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
            message: "用户无效",
        };
    }

    const optLength = new Uint8Array(VLBuffer.slice(17, 18))[0];
    // 暂时跳过可选项

    const command = new Uint8Array(VLBuffer.slice(18 + optLength, 18 + optLength + 1))[0];

    // 0x01 TCP
    // 0x02 UDP
    // 0x03 MUX
    if (command === 1) { /* 空 */ } else if (command === 2) {
        isUDP = true;
    } else {
        return {
            hasError: true,
            message: `命令 ${command} 不支持，支持的命令：01-tcp，02-udp，03-mux`,
        };
    }
    const portIndex = 18 + optLength + 1;
    const portBuffer = VLBuffer.slice(portIndex, portIndex + 2);
    // 端口在原始数据中是大端序，例如 80 == 0x005d
    const portRemote = new DataView(portBuffer).getUint16(0);

    let addressIndex = portIndex + 2;
    const addressBuffer = new Uint8Array(VLBuffer.slice(addressIndex, addressIndex + 1));

    // 1--> IPv4  地址长度 = 4
    // 2--> 域名  地址长度 = addressBuffer[1]
    // 3--> IPv6  地址长度 = 16
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
            // IPv6地址示例：2001:0db8:85a3:0000:0000:8a2e:0370:7334
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            addressValue = ipv6.join(":");
            // IPv6似乎不需要添加[]
            break;
        }
        default:
            return {
                hasError: true,
                message: `地址类型无效：${addressType}`,
            };
    }
    if (!addressValue) {
        return {
            hasError: true,
            message: `地址值为空，地址类型：${addressType}`,
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
            // UDP消息的前2字节是UDP数据的长度
            // TODO: 这里可能有bug，因为UDP数据块可能分布在两个WebSocket消息中
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

    // 目前只处理DNS UDP
    transformStream.readable
        .pipeTo(
            new WritableStream({
                async write(chunk) {
                    const resp = await fetch(
                        globalConfig.dohURL, // DNS服务器URL
                        {
                            method: "POST",
                            headers: {
                                "content-type": "application/dns-message",
                            },
                            body: chunk,
                        }
                    );
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
                },
            })
        )
        .catch((error) => {
            log("DNS UDP出现错误：" + error);
        });

    const writer = transformStream.writable.getWriter();

    return {
        write(chunk) {
            writer.write(chunk);
        },
    };
}