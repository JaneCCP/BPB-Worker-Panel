import { globalConfig, init, initHttp, initWs } from './common/init';
import { fallback, serveIcon, renderSecrets, handlePanel, handleSubscriptions, handleLogin, handleError, handleWebsocket } from './common/handlers';
import { logout } from './auth';

// 添加全局超时设置
const GLOBAL_TIMEOUT = 30000; // 30秒全局超时
const REQUEST_TIMEOUT = 25000; // 25秒请求超时

export default {
	async fetch(request, env) {
		// 创建超时Promise
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => {
				reject(new Error('请求处理超时'));
			}, GLOBAL_TIMEOUT);
		});

		// 主处理逻辑
		const mainPromise = (async () => {
			try {
				const upgradeHeader = request.headers.get('Upgrade');
				init(request, env);

				if (upgradeHeader === 'websocket') {
					initWs(env);
					return await handleWebsocketWithTimeout(request);
				} else {
					initHttp(request, env);
					const path = globalConfig.pathName;
					
					// 添加请求超时
					const requestPromise = (async () => {
						if (path.startsWith('/panel')) return await handlePanel(request, env);
						if (path.startsWith('/sub')) return await handleSubscriptions(request, env);
						if (path.startsWith('/login')) return await handleLogin(request, env);
						if (path.startsWith('/logout')) return await logout(request, env);
						if (path.startsWith('/secrets')) return await renderSecrets();
						if (path.startsWith('/favicon.ico')) return await serveIcon();
						return await fallback(request);
					})();

					const requestTimeoutPromise = new Promise((_, reject) => {
						setTimeout(() => {
							reject(new Error('请求处理超时'));
						}, REQUEST_TIMEOUT);
					});

					return await Promise.race([requestPromise, requestTimeoutPromise]);
				}

			} catch (error) {
				console.error('Worker处理错误:', error);
				return await handleError(error);
			}
		})();

		// 使用Promise.race来实现全局超时
		try {
			return await Promise.race([mainPromise, timeoutPromise]);
		} catch (error) {
			console.error('Worker全局错误:', error);
			
			// 如果是超时错误，返回特定的错误响应
			if (error.message.includes('超时')) {
				return new Response('请求处理超时，请稍后重试', {
					status: 408,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' }
				});
			}
			
			return await handleError(error);
		}
	}
}

// WebSocket处理的超时包装
async function handleWebsocketWithTimeout(request) {
	const WS_TIMEOUT = 60000; // WebSocket 60秒超时
	
	const wsPromise = handleWebsocket(request);
	const wsTimeoutPromise = new Promise((_, reject) => {
		setTimeout(() => {
			reject(new Error('WebSocket连接超时'));
		}, WS_TIMEOUT);
	});

	try {
		return await Promise.race([wsPromise, wsTimeoutPromise]);
	} catch (error) {
		console.error('WebSocket处理错误:', error);
		
		if (error.message.includes('超时')) {
			return new Response('WebSocket连接超时', {
				status: 408,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' }
			});
		}
		
		throw error;
	}
}