/**
 * Host 入口：装配回环代理、生命周期和 Harness 同源路由。
 *
 * 代理把 chat.deepseek.com 变成 http://127.0.0.1:<port>/，Cookie 保存在
 * Host 侧的状态目录里，因此页面重启后仍保持登录；页面只需要知道代理地址。
 */

import { HOST_SYNC_ROUTE, STATUS_ROUTE, SYNC_BODY_LIMIT } from './src/config.js';
import { isLoopbackOrigin, readBody, sendJson } from './src/http.js';
import { createDeepSeekProxy } from './src/proxy.js';
import { readProxyConfig } from './src/config.js';

/**
 * 输出带插件标记的日志，方便在 Host 日志中定位。
 * @param {string} level 日志级别。
 * @param {string} message 已去掉凭据的日志内容。
 * @returns {void}
 */
function log(level, message) {
  const line = `[deepseek-web-panel] ${message}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/**
 * 生成代理状态的资源函数（GET/HEAD）。
 * @param {object} proxy 代理实例。
 * @returns {() => Promise<Response>} 返回 JSON 状态的资源函数。
 */
function createStatusResource(proxy) {
  return async () => new Response(JSON.stringify({
    ok: true,
    url: proxy.url,
    running: proxy.running,
    cookies: proxy.cookieCount,
    pendingLogin: proxy.pendingLogin,
    signedIn: proxy.signedIn,
    route: proxy.route,
  }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/**
 * 创建登录态同步处理器；只接受回环来源的 POST。
 * @param {object} proxy 代理实例。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} HTTP 处理器。
 */
function createSyncHandler(proxy) {
  return async (req, res) => {
    try {
      if (req.headers.origin && !isLoopbackOrigin(req.headers.origin)) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
        return;
      }
      const method = (req.method ?? 'GET').toUpperCase();
      const allow = { allow: 'GET, HEAD, POST, OPTIONS' };
      if (method === 'OPTIONS') {
        res.writeHead(204, { ...allow, 'cache-control': 'no-store' });
        res.end();
        return;
      }
      if (method === 'GET' || method === 'HEAD') {
        sendJson(res, 200, { ok: true, pending: proxy.pendingLogin, running: proxy.running });
        return;
      }
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' }, allow);
        return;
      }
      const body = await readBody(req, SYNC_BODY_LIMIT);
      const queued = proxy.queueLogin(body.toString('utf8'));
      if (!queued.ok) {
        sendJson(res, 400, queued);
        return;
      }
      log('info', '已从 Harness 同源路由收到登录态');
      sendJson(res, 200, { ok: true, pending: true, url: proxy.url });
    } catch (error) {
      const status = error?.code === 'BODY_TOO_LARGE' ? 413 : 500;
      sendJson(res, status, {
        ok: false,
        error: status === 413 ? 'body too large' : `sync route failed: ${error?.message ?? error}`,
      });
    }
  };
}

/**
 * 启用 Host 插件；卸载时关闭代理并解除路由注册。
 * @param {import('@deepseek-ai/cordis').Context} ctx Cordis 插件上下文。
 * @returns {void} 生命周期由 ctx.effect 管理。
 */
export function apply(ctx) {
  const proxy = createDeepSeekProxy({ ...readProxyConfig(), log });

  ctx.effect(() => {
    let disposed = false;
    void proxy.start()
      .then(() => { if (disposed) return proxy.close(); })
      .catch((error) => log('error', `代理启动失败：${error?.message ?? error}`));
    return () => {
      disposed = true;
      void proxy.close();
    };
  }, 'deepseek-web-panel: loopback proxy');

  ctx.inject(['webServer'], (scope) => {
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: STATUS_ROUTE,
      resource: createStatusResource(proxy),
    }), 'deepseek-web-panel: status route');
    scope.effect(() => scope.webServer.register({
      kind: 'exact',
      path: HOST_SYNC_ROUTE,
      handler: createSyncHandler(proxy),
    }), 'deepseek-web-panel: sync route');
  });
}
