/** 回环代理装配层：只负责路由分派、启动和关闭，具体功能由独立模块处理。 */
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { DEFAULT_PORT, JAR_SAVE_DEBOUNCE_MS, LOCAL_PREFIX, SYNC_BODY_LIMIT, UPSTREAM_ORIGIN } from './config.js';
import { CookieJar } from './cookies.js';
import { createForwardHandlers } from './forward.js';
import { isAllowedOrigin, isLoopbackHost, readBody, requestPath, sendJson } from './http.js';
import { LoginStore } from './login-store.js';
import { RouteStore } from './route-store.js';
import { parseSyncBody } from './sync.js';
import { createUpgradeHandler } from './websocket.js';

/** 页面回传登录态的路径，与页面同源。 */
const CAPTURE_PATH = `${LOCAL_PREFIX}capture`;
/** 页面回报当前所在位置的路径。 */
const ROUTE_PATH = `${LOCAL_PREFIX}route`;

/**
 * 创建代理；调用 start 后才监听端口，close 会保存状态并释放连接。
 * @param {{host?: string, port?: number, stateDir?: string, debug?: boolean, log?: (level: string, message: string) => void}} [options={}] 回环监听地址、首选端口、状态目录和日志选项；端口 0 表示自动分配。
 * @returns {object} 含状态字段及 start、close、rememberLogin 方法的代理实例。
 * @throws {RangeError} 地址不是回环地址，或端口不是 0..65535 整数时抛错。
 */
export function createDeepSeekProxy(options = {}) {
  const host = options.host ?? '127.0.0.1';
  const desiredPort = options.port ?? DEFAULT_PORT;
  if (!isLoopbackHost(host) || !Number.isInteger(desiredPort) || desiredPort < 0 || desiredPort > 65535) {
    throw new RangeError('代理必须使用回环地址和 0..65535 的整数端口。');
  }
  const stateDir = options.stateDir ?? path.join(process.cwd(), '.deepseek-chat');
  const log = options.log ?? (() => {});
  const jar = new CookieJar(path.join(stateDir, 'cookies.json'), log, JAR_SAVE_DEBOUNCE_MS);
  const login = new LoginStore(path.join(stateDir, 'session.json'), log);
  const routes = new RouteStore(path.join(stateDir, 'route.json'), log);
  const agent = new https.Agent({ keepAlive: true, maxSockets: 64 });
  const sockets = new Set();
  let server;
  let baseUrl = null;
  let listeningPort = 0;
  let starting = null;
  let closing = null;

  /** @returns {string} 当前代理来源；尚未启动时返回首选地址。 */
  function origin() {
    const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    return baseUrl ? baseUrl.replace(/\/$/, '') : `http://${address}:${desiredPort}`;
  }

  /**
   * 把转发异常写回浏览器；响应已开始时终止连接。
   * @param {import('node:http').ServerResponse} res HTTP 响应。
   * @param {unknown} error 捕获的错误。
   * @returns {void} 写入错误响应或关闭连接。
   */
  function failRequest(res, error) {
    log('warn', `代理请求失败：${error?.message ?? error}`);
    if (res.headersSent) res.destroy();
    else sendJson(res, 502, { ok: false, error: error?.message ?? String(error) });
  }

  const { handleAsset, handleUpstream } = createForwardHandlers({
    agent, jar, login, origin, log, debug: options.debug === true, failRequest,
  });
  const handleUpgrade = createUpgradeHandler({ jar, origin, log, sockets });

  /**
   * 接收页面回传的登录态；token 未变化时不写盘。
   * @param {import('node:http').IncomingMessage} req 页面请求。
   * @param {import('node:http').ServerResponse} res HTTP 响应。
   * @returns {Promise<void>} 响应写完即结束。
   */
  async function handleCapture(req, res) {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    const body = await readBody(req, SYNC_BODY_LIMIT);
    const payload = parseSyncBody(body, req.headers['content-type']);
    if (!payload) {
      sendJson(res, 400, { ok: false, error: 'expected a login token' });
      return;
    }
    const stored = login.remember(payload);
    if (stored) log('info', '已记住网页版登录态，下次打开自动登录');
    sendJson(res, 200, { ok: true, stored, signedIn: login.saved !== null });
  }

  /**
   * 记录页面当前所在位置，供下次打开时恢复。
   * @param {import('node:http').IncomingMessage} req 页面请求。
   * @param {import('node:http').ServerResponse} res HTTP 响应。
   * @returns {Promise<void>} 响应写完即结束。
   */
  async function handleRoute(req, res) {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }
    const body = await readBody(req, 4096);
    let path = null;
    try {
      path = JSON.parse(body.toString('utf8')).path;
    } catch {
      path = null;
    }
    const changed = routes.set(path);
    sendJson(res, changed || routes.route === path ? 200 : 400, { ok: changed || routes.route === path, route: routes.route });
  }

  /**
   * 检查请求来源，再分派页面控制接口、健康检查、资源和上游请求。
   * @param {import('node:http').IncomingMessage} req 浏览器请求。
   * @param {import('node:http').ServerResponse} res HTTP 响应。
   * @returns {void} 具体处理器负责发送响应。
   */
  function handle(req, res) {
    try {
      const pathname = requestPath(req.url);
      const pathOnly = pathname.split('?')[0];
      if (!isAllowedOrigin(req.headers.origin, origin())) {
        sendJson(res, 403, { ok: false, error: 'cross-origin request rejected' });
      } else if (pathOnly === CAPTURE_PATH) {
        void handleCapture(req, res).catch((error) => failRequest(res, error));
      } else if (pathOnly === ROUTE_PATH) {
        void handleRoute(req, res).catch((error) => failRequest(res, error));
      } else if (pathOnly === `${LOCAL_PREFIX}health`) {
        sendJson(res, 200, {
          ok: true, url: baseUrl, cookies: jar.size(), upstream: UPSTREAM_ORIGIN,
          signedIn: login.saved !== null, route: routes.route,
        });
      } else if (pathOnly.startsWith(LOCAL_PREFIX)) handleAsset(req, res, pathname);
      else handleUpstream(req, res, pathname);
    } catch (error) {
      failRequest(res, error);
    }
  }

  /**
   * 创建并监听一个 HTTP 服务，失败时由 start 决定是否更换端口。
   * @param {number} port 首选端口，0 由系统分配。
   * @returns {Promise<import('node:http').Server>} 已开始监听的服务。
   */
  function listen(port) {
    return new Promise((resolve, reject) => {
      const candidate = http.createServer(handle);
      candidate.on('upgrade', handleUpgrade);
      candidate.on('connection', (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
      });
      candidate.on('clientError', (_error, socket) => socket.destroy());
      candidate.once('error', reject);
      candidate.listen(port, host.replace(/^\[|\]$/g, ''), () => {
        candidate.removeListener('error', reject);
        listeningPort = candidate.address().port;
        const address = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
        baseUrl = `http://${address}:${listeningPort}/`;
        resolve(candidate);
      });
    });
  }

  const api = {
    /** @returns {string | null} 启动后的完整 URL，未启动时为 null。 */
    get url() { return baseUrl; },
    /** @returns {boolean} 服务是否已经监听。 */
    get running() { return Boolean(server?.listening); },
    /** @returns {number} 实际监听端口，关闭后为 0。 */
    get port() { return listeningPort; },
    /** @returns {number} 当前 Host Cookie 数量。 */
    get cookieCount() { return jar.size(); },
    /** @returns {boolean} 是否已记住一份长期登录态。 */
    get signedIn() { return login.saved !== null; },
    /** @returns {string | null} 上次页面所在位置，供面板恢复。 */
    get route() { return routes.route; },
    /**
     * 记住一份凭据，下一次文档加载时注入。
     * @param {unknown} payload 用户粘贴的 token 或 JSON。
     * @returns {boolean} 是否写入了新凭据。
     */
    rememberLogin(payload) { return login.remember(payload); },
    /**
     * 加载状态并启动；并发调用共用一次启动，只有端口占用时才自动换端口。
     * @returns {Promise<object>} 已启动的当前代理实例。
     */
    async start() {
      if (closing) await closing;
      if (server) return api;
      if (starting) return starting;
      starting = (async () => {
        await Promise.all([jar.load(), login.load(), routes.load()]);
        try { server = await listen(desiredPort); }
        catch (error) {
          if (error.code !== 'EADDRINUSE' || desiredPort === 0) throw error;
          log('warn', `端口 ${desiredPort} 已占用，改用空闲端口`);
          server = await listen(0);
        }
        log('info', `DeepSeek 代理监听 ${baseUrl}`);
        return api;
      })();
      try { return await starting; }
      finally { starting = null; }
    },
    /**
     * 等待启动结束，关闭活动连接，并等待状态写盘；重复关闭共用一次操作。
     * @returns {Promise<void>} 服务与持久化状态均处理完毕后结束。
     */
    async close() {
      if (closing) return closing;
      closing = (async () => {
        if (starting) await starting.catch(() => undefined);
        const current = server;
        server = undefined;
        baseUrl = null;
        listeningPort = 0;
        const stopped = current ? new Promise((resolve) => current.close(resolve)) : Promise.resolve();
        for (const socket of sockets) socket.destroy();
        agent.destroy();
        await stopped;
        await Promise.all([jar.flush(), login.flush(), routes.flush()]);
      })();
      try { await closing; }
      finally { closing = null; }
    },
  };
  return api;
}
