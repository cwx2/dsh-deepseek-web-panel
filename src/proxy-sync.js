/** 独立代理上的同步控制接口，开发入口和旧版 Host 页面使用。 */
import { SYNC_ACK_PATH, SYNC_BODY_LIMIT } from './config.js';
import { isLoopbackOrigin, readBody, sendJson } from './http.js';
import { parseSyncBody } from './sync.js';

/**
 * 创建控制接口处理器，支持状态查询、凭据提交和旧版确认接口。
 * @param {import('./login-store.js').LoginStore} store 待同步登录态队列。
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, pathname: string) => Promise<void>} 控制接口处理器。
 */
export function createProxySyncHandler(store) {
  return async (req, res, pathname) => {
    const requestOrigin = req.headers.origin;
    const cors = {
      'access-control-allow-origin': isLoopbackOrigin(requestOrigin) ? requestOrigin : 'null',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '600',
      vary: 'origin',
    };
    const method = (req.method ?? 'GET').toUpperCase();
    if (method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    if (pathname === SYNC_ACK_PATH) {
      if (method !== 'POST') {
        sendJson(res, 405, { ok: false, error: 'method not allowed' }, cors);
        return;
      }
      try {
        const body = await readBody(req, SYNC_BODY_LIMIT);
        const ack = body.length ? JSON.parse(body.toString('utf8')) : {};
        // 只接受当前文档对应的确认；空回执、旧文档回执都不删除新凭据。
        if (store.pending && ack?.syncId === store.pending.syncId) store.clear(store.pending);
        await store.flush();
        sendJson(res, 200, { ok: true, pending: store.pending !== null }, cors);
      } catch (error) {
        sendJson(res, error.code === 'BODY_TOO_LARGE' ? 413 : 400, { ok: false, error: 'invalid acknowledgement' }, cors);
      }
      return;
    }
    if (method === 'GET') {
      sendJson(res, 200, { ok: true, pending: store.pending !== null }, cors);
      return;
    }
    if (method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' }, cors);
      return;
    }
    try {
      const payload = parseSyncBody(await readBody(req, SYNC_BODY_LIMIT), req.headers['content-type']);
      const result = store.queue(payload);
      await store.flush();
      sendJson(res, result.ok ? 200 : 400, result.ok ? { ok: true, pending: true } : result, cors);
    } catch (error) {
      sendJson(res, error.code === 'BODY_TOO_LARGE' ? 413 : 500, { ok: false, error: error.message }, cors);
    }
  };
}
