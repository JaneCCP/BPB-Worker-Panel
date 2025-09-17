import { globalConfig, init, initHttp, initWs } from './common/init';
import { fallback, serveIcon, renderSecrets, handlePanel, handleSubscriptions, handleLogin, handleError, handleWebsocket } from './common/handlers';
import { logout } from './auth';

export default {
	async fetch(request, env) {
		// 添加全局超时处理
		const timeoutPromise = new Promise((_, reject) => {
			setTimeout(() => reject(new Error('Worker 处理超时')), 25000); // 25秒超时，留5秒缓冲
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
					if (path.startsWith('/panel')) return await handlePanel(request, env);
					if (path.startsWith('/sub')) return await handleSubscriptions(request, env);
					if (path.startsWith('/login')) return await handleLogin(request, env);
					if (path.startsWith('/logout')) return await logout(request, env);
					if (path.startsWith('/secrets')) return await renderSecrets();
					if (path.startsWith('/favicon.ico')) return await serveIcon();
					return await fallback(request);
				}

			} catch (error) {
				console.error('Worker 处理错误:', error);
				return await handleError(error);
			}
		})();

		try {
			return await Promise.race([mainPromise, timeoutPromise]);
		} catch (error) {
			console.error('Worker 超时或错误:', error);
			return new Response('服务暂时不可用', { 
				status: 503,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' }
			});
		}
	}
}