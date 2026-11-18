/** 网络转发处理器：负责静态资源改写、页面注入和 API 流式响应。 */
import https from 'node:https';
import { ASSET_CACHE_ENTRIES, ASSET_CACHE_TTL_MS, CDN_ORIGIN, UPSTREAM_HOST, UPSTREAM_ORIGIN } from './config.js';
import { mergeCookies } from './cookies.js';
import { decodeBody, HOP_REQUEST_HEADERS, responseHeaders } from './http.js';
import { injectBootScript } from './sync.js';
import { LOCAL_PREFIX, patchEntryBundle, rewriteCss, rewriteHtml } from './transform.js';

/**
 * 为一个代理实例创建网络处理器和它自己的静态资源缓存。
 * @param {object} options 共享的 agent、jar、login、origin、log、debug 和 failRequest。
 * @returns {{handleAsset: Function, handleUpstream: Function}} 资源与上游请求处理器。
 */
export function createForwardHandlers({ agent, jar, login, origin, log, debug, failRequest }) {
  const assetCache = new Map();
  /**
   * 读取未过期的静态资源缓存。
   * 输入：上游路径；输出：缓存对象或 null。
   *
   * @param {string} key 缓存键。
   * @returns {{ at: number, status: number, headers: Record<string, string | string[]>, body: Buffer } | null} 缓存结果。
   */
  function assetCacheGet(key) {
    const hit = assetCache.get(key);
    if (!hit) return null;
    if (Date.now() - hit.at > ASSET_CACHE_TTL_MS) {
      assetCache.delete(key);
      return null;
    }
    return hit;
  }

  /**
   * 写入静态资源缓存，超过数量上限时淘汰最早的一项。
   * 输入：缓存键和值；输出：无。
   *
   * @param {string} key 缓存键。
   * @param {{ at: number, status: number, headers: Record<string, string | string[]>, body: Buffer }} value 缓存值。
   * @returns {void}
   */
  function assetCacheSet(key, value) {
    if (assetCache.size >= ASSET_CACHE_ENTRIES) {
      const oldest = assetCache.keys().next().value;
      if (oldest !== undefined) assetCache.delete(oldest);
    }
    assetCache.set(key, value);
  }

  /**
   * 读取并返回一个 CDN 静态资源，入口脚本和 CSS 会先做改写。
   * 输入：浏览器请求、响应对象和本地资源路径；输出：无，异步写入 HTTP 响应。
   *
   * @param {import('node:http').IncomingMessage} req 浏览器请求。
   * @param {import('node:http').ServerResponse} res HTTP 响应。
   * @param {string} pathname 本地资源路径。
   * @returns {void}
   */
  function handleAsset(req, res, pathname) {
    const upstreamPath = `/chat${pathname.slice(LOCAL_PREFIX.length - 1)}`;
    const cached = assetCacheGet(upstreamPath);
    if (cached) {
      res.writeHead(cached.status, {
        ...cached.headers,
        'content-length': String(cached.body.length),
      });
      res.end(cached.body);
      return;
    }
    const request = https.request(
      {
        host: CDN_ORIGIN.replace('https://', ''),
        port: 443,
        servername: 'fe-static.deepseek.com',
        method: 'GET',
        path: upstreamPath,
        agent,
        headers: {
          host: 'fe-static.deepseek.com',
          accept: '*/*',
          'accept-encoding': 'identity',
          'user-agent': req.headers['user-agent'] ?? 'dsh-deepseek-chat',
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('error', (error) => failRequest(res, error));
        response.on('end', () => {
          try {
            const status = response.statusCode ?? 200;
            const contentType = String(response.headers['content-type'] ?? '');
            const raw = Buffer.concat(chunks);
            let body = raw;
            let headers = responseHeaders(response.headers, { origin: origin() });
            const name = pathname.split('?')[0].split('/').pop() ?? '';
            const isEntry = /^main\.[0-9a-z]+\.js$/i.test(name);
            const isCss = contentType.toLowerCase().includes('text/css') || name.endsWith('.css');
            if (status === 200 && (isEntry || isCss)) {
              const decoded = decodeBody(raw, response.headers['content-encoding']);
              const text = decoded.toString('utf8');
              if (isEntry) {
                const patched = patchEntryBundle(text);
                if (patched.missing.length > 0) {
                  log('warn', `entry bundle patterns missing: ${patched.missing.join(', ')}`);
                }
                body = Buffer.from(patched.text, 'utf8');
              } else {
                body = Buffer.from(rewriteCss(text).css, 'utf8');
              }
              headers = {
                ...responseHeaders(response.headers, { origin: origin(), dropBodyFields: true }),
                'content-type': isEntry ? 'application/javascript; charset=utf-8' : 'text/css; charset=utf-8',
              };
            }
            assetCacheSet(upstreamPath, { at: Date.now(), status, headers, body });
            res.writeHead(status, { ...headers, 'content-length': String(body.length) });
            res.end(body);
          } catch (error) {
            failRequest(res, error);
          }
        });
      },
    );
    request.on('error', (error) => failRequest(res, error));
    request.end();
  }

  /**
   * 转发属于 DeepSeek 应用本身的请求，并同步 Cookie。
   * 输入：浏览器请求、响应对象和上游路径；输出：无，响应会流式写回浏览器。
   *
   * @param {import('node:http').IncomingMessage} req 浏览器请求。
   * @param {import('node:http').ServerResponse} res HTTP 响应。
   * @param {string} pathname 上游路径。
   * @returns {void}
   */
  function handleUpstream(req, res, pathname) {
    const method = req.method ?? 'GET';
    /** @type {Record<string, string | string[]>} */
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (HOP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
      headers[key] = value;
    }
    headers.host = UPSTREAM_HOST;
    headers.origin = UPSTREAM_ORIGIN;
    headers.referer = `${UPSTREAM_ORIGIN}/`;
    headers.cookie = mergeCookies(req.headers.cookie, jar.header());
    headers['accept-encoding'] = 'gzip, deflate, br';
    if (debug) {
      const auth = req.headers.authorization;
      log(
        'debug',
        `upstream ${method} ${pathname} auth=${auth ? 'present' : 'none'} cookies=${jar.size()}`,
      );
    }

    const request = https.request(
      {
        host: UPSTREAM_HOST,
        port: 443,
        servername: UPSTREAM_HOST,
        method,
        path: pathname,
        headers,
        agent,
      },
      (response) => {
        jar.absorb(response.headers['set-cookie']);
        const contentType = String(response.headers['content-type'] ?? '').toLowerCase();
        const status = response.statusCode ?? 200;
        if (method !== 'HEAD' && contentType.startsWith('text/html')) {
          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('error', (error) => failRequest(res, error));
          response.on('end', () => {
            try {
              const decoded = decodeBody(Buffer.concat(chunks), response.headers['content-encoding']);
              const { html, replaced } = rewriteHtml(decoded.toString('utf8'), origin());
              if (replaced === 0) log('warn', 'document had no CDN asset URLs to rewrite');
              // 每次加载都注入：UA 规范化 + 已记住的登录态 + 登录态捕获。
              const payload = login.pending ?? login.saved;
              const body = Buffer.from(injectBootScript(html, payload), 'utf8');
              res.writeHead(status, {
                ...responseHeaders(response.headers, { origin: origin(), dropBodyFields: true }),
                'content-length': String(body.length),
                'cache-control': 'no-store',
              });
              res.end(body);
              // 发送完文档仍保留待同步凭据，等页面成功写入 localStorage 后按 syncId 确认清理。
            } catch (error) {
              failRequest(res, error);
            }
          });
          return;
        }
        res.writeHead(status, responseHeaders(response.headers, { origin: origin() }));
        response.pipe(res);
        response.on('error', () => {
          try {
            res.destroy();
          } catch {}
        });
      },
    );
    request.on('error', (error) => failRequest(res, error));
    req.on('error', (error) => request.destroy(error));
    res.on('close', () => {
      if (!res.writableEnded) request.destroy();
    });
    if (method === 'GET' || method === 'HEAD') request.end();
    else req.pipe(request);
  }

  return { handleAsset, handleUpstream };
}
