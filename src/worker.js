import { globalConfig, init, initHttp, initWs } from './common/init';
import { fallback, serveIcon, renderSecrets, handlePanel, handleSubscriptions, handleLogin, handleError, handleWebsocket } from './common/handlers';
import { logout } from './auth';

export default {
	async fetch(request, env) {
		// 添加全局超时保护
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => {
				reject(new Error('Worker处理超时'));
			}, 25000); // 25秒超时
		});

		const mainPromise = (async () => {
			try {
				const upgradeHeader = request.headers.get('Upgrade');
				init(request, env);

				if (upgradeHeader === 'websocket') {
					initWs(env);
					return await handleWebsocket(request);
				} else {
					initHttp(request, env);
					const path = globalConfig.pathName;
					
					// 添加路径验证，防止处理异常路径
					if (!path || path.length > 500) {
						return new Response('Invalid path', { status: 400 });
					}
					
					if (path.startsWith('/panel')) return await handlePanel(request, env);
					if (path.startsWith('/sub')) return await handleSubscriptions(request, env);
					if (path.startsWith('/login')) return await handleLogin(request, env);
					if (path.startsWith('/logout')) return await logout(request, env);
					if (path.startsWith('/secrets')) return await renderSecrets();
					if (path.startsWith('/favicon.ico')) return await serveIcon();
					
					// 检查是否是 base64 编码的路径（可能是 WebSocket 配置）
					if (path.match(/^\/[A-Za-z0-9+/]+=*$/)) {
						// 这可能是 WebSocket 配置路径，但不是 WebSocket 请求
						return new Response('WebSocket upgrade required', { 
							status: 426,
							headers: { 'Upgrade': 'websocket' }
						});
					}
					
					return await fallback(request);
				}

			} catch (error) {
				console.error('Worker处理错误:', error);
				return await handleError(error);
			}
		})();

		try {
			return await Promise.race([mainPromise, timeoutPromise]);
		} catch (error) {
			console.error('Worker全局错误:', error);
			
			if (error.message.includes('超时')) {
				return new Response('Request timeout', {
					status: 408,
					headers: { 'Content-Type': 'text/plain' }
				});
			}
			
			return new Response('Internal server error', {
				status: 500,
				headers: { 'Content-Type': 'text/plain' }
			});
		}
	}
}