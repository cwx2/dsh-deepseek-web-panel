/** TTS WebSocket 隧道，与普通 HTTP 路由使用同一套来源检查。 */
import tls from 'node:tls';
import { UPSTREAM_HOST, UPSTREAM_ORIGIN } from './config.js';
import { mergeCookies } from './cookies.js';
import { isAllowedOrigin, requestPath } from './http.js';

/**
 * 创建 WebSocket 升级处理器。
 * @param {object} options Cookie 罐、代理来源函数、日志函数和活动连接集合。
 * @returns {Function} Node upgrade 事件处理器，结果通过 socket 返回。
 */
export function createUpgradeHandler({ jar, origin, log, sockets }) {
  /**
   * 把 TTS WebSocket 升级连接原样隧道到上游。
   * 输入：升级请求、客户端 socket 和已读入的握手数据；输出：无，连接建立后双向转发。
   *
   * @param {import('node:http').IncomingMessage} req WebSocket 升级请求。
   * @param {import('node:net').Socket} socket 客户端连接。
   * @param {Buffer} head 已读入的握手数据。
   * @returns {void}
   */
  function handleUpgrade(req, socket, head) {
    try {
      if (!isAllowedOrigin(req.headers.origin, origin())) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return;
      }
      const pathname = requestPath(req.url);
      if (!pathname.startsWith('/api/')) {
        socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
        return;
      }
      socket.setNoDelay(true);
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      const connection = tls.connect({ host: UPSTREAM_HOST, port: 443, servername: UPSTREAM_HOST }, () => {
        const lines = [`GET ${pathname} HTTP/1.1`];
        /** @type {Record<string, string | string[]>} */
        const headers = {};
        for (const [key, value] of Object.entries(req.headers)) {
          if (value === undefined) continue;
          if (key === 'host' || key === 'cookie' || key === 'origin') continue;
          headers[key] = value;
        }
        headers.host = UPSTREAM_HOST;
        headers.origin = UPSTREAM_ORIGIN;
        headers.cookie = mergeCookies(req.headers.cookie, jar.header());
        for (const [key, value] of Object.entries(headers)) {
          lines.push(`${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
        }
        connection.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head && head.length > 0) connection.write(head);
        connection.pipe(socket);
        socket.pipe(connection);
        socket.resume();
      });
      connection.on('error', (error) => {
        log('warn', `websocket upstream error: ${error?.message ?? error}`);
        connection.destroy();
        socket.destroy();
      });
      socket.on('error', () => connection.destroy());
      socket.on('close', () => connection.destroy());
    } catch (error) {
      log('warn', `websocket setup failed: ${error?.message ?? error}`);
      try {
        socket.destroy();
      } catch {}
    }
  }

  return handleUpgrade;
}
