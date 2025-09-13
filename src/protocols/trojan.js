import { sha224 } from 'js-sha256';
import { handleTCPOutBound, makeReadableWebSocketStream } from './common';
import { globalConfig } from '../helpers/init';

export async function TrOverWSHandler(request) {
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

    readableWebSocketStream
        .pipeTo(
            new WritableStream({
                async write(chunk, controller) {
                    if (udpStreamWrite) {
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
                        rawClientData,
                    } = parseTRHeader(chunk);

                    address = addressRemote;
                    portWithRandomLog = `${portRemote}--${Math.random().toString(36).substr(2, 4)} tcp`;

                    if (hasError) {
                        throw new Error(message);
                        // return;
                    }

                    handleTCPOutBound(
                        remoteSocketWapper, 
                        addressRemote, 
                        portRemote, 
                        rawClientData, 
                        webSocket, 
                        null, 
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
            log("可读WebSocket流 pipeTo 错误", err);
        });

    return new Response(null, {
        status: 101,
        // @ts-ignore
        webSocket: client,
    });
}

function parseTRHeader(buffer) {
    if (buffer.byteLength < 56) {
            return {
                hasError: true,
                message: "无效的数据",
            };
        }

    let crLfIndex = 56;
    if (new Uint8Array(buffer.slice(56, 57))[0] !== 0x0d || new Uint8Array(buffer.slice(57, 58))[0] !== 0x0a) {
        return {
            hasError: true,
            message: "无效的头部格式 (缺少 CR LF)",
        };
    }

    const password = new TextDecoder().decode(buffer.slice(0, crLfIndex));
    if (password !== sha224(globalConfig.TrPass)) {
        return {
            hasError: true,
            message: "无效的密码",
        };
    }

    const socks5DataBuffer = buffer.slice(crLfIndex + 2);
    if (socks5DataBuffer.byteLength < 6) {
        return {
            hasError: true,
            message: "无效的SOCKS5请求数据",
        };
    }

    const view = new DataView(socks5DataBuffer);
    const cmd = view.getUint8(0);
    if (cmd !== 1) {
        return {
            hasError: true,
            message: "不支持的命令，仅允许TCP (CONNECT)",
        };
    }

    const atype = view.getUint8(1);
    // 0x01: IPv4 address
    // 0x03: Domain name
    // 0x04: IPv6 address
    let addressLength = 0;
    let addressIndex = 2;
    let address = "";
    switch (atype) {
        case 1:
            addressLength = 4;
            address = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength)).join(".");
            break;
        case 3:
            addressLength = new Uint8Array(socks5DataBuffer.slice(addressIndex, addressIndex + 1))[0];
            addressIndex += 1;
            address = new TextDecoder().decode(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
            break;
        case 4: {
            addressLength = 16;
            const dataView = new DataView(socks5DataBuffer.slice(addressIndex, addressIndex + addressLength));
            const ipv6 = [];
            for (let i = 0; i < 8; i++) {
                ipv6.push(dataView.getUint16(i * 2).toString(16));
            }
            address = ipv6.join(":");
            break;
        }
        default:
            return {
                hasError: true,
                message: `无效的地址类型: ${atype}`,
            };
    }

    if (!address) {
        return {
            hasError: true,
            message: `地址为空，地址类型为 ${atype}`,
        };
    }

    const portIndex = addressIndex + addressLength;
    const portBuffer = socks5DataBuffer.slice(portIndex, portIndex + 2);
    const portRemote = new DataView(portBuffer).getUint16(0);
    return {
        hasError: false,
        addressRemote: address,
        portRemote,
        rawClientData: socks5DataBuffer.slice(portIndex + 4),
    };
}
