/**
 * HTTP 代理共用的小工具。
 *
 * 集中处理压缩、请求路径、安全来源、响应头和请求体，避免代理与 Host 路由
 * 各自维护一套 HTTP 细节。
 */

import zlib from 'node:zlib';

import { UPSTREAM_ORIGIN } from './config.js';
import { forwardableCookies } from './cookies.js';

/** Hop-by-hop 头，以及不能直接放进 iframe 的安全策略头。 */
export const STRIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-security-policy',
  'content-security-policy-report-only',
  'x-frame-options',
  'cross-origin-opener-policy',
  'cross-origin-embedder-policy',
  'cross-origin-resource-policy',
  'strict-transport-security',
  'expect-ct',
  'nel',
  'alt-svc',
  'report-to',
  'reporting-endpoints',
  'permissions-policy',
  'server',
]);

/** 不应该从浏览器原样转发给上游的请求头。 */
export const HOP_REQUEST_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
  'cookie',
  'origin',
  'referer',
  'accept-encoding',
  'if-none-match',
  'if-modified-since',
]);

/**
 * 按 content-encoding 解压响应体。
 * 输入：响应字节和编码值；输出：解压后的 Buffer，未知编码会抛错。
 *
 * @param {Buffer} buffer 原始响应体。
 * @param {string | string[] | undefined} encoding Content-Encoding。
 * @returns {Buffer} 解压后的响应体。
 */
export function decodeBody(buffer, encoding) {
  const value = String(encoding ?? '').trim().toLowerCase();
  if (!value || value === 'identity') return buffer;
  let decoded = buffer;
  // 编码按声明顺序叠加，解码要从最后一层往回拆。
  for (const coding of value.split(',').map((part) => part.trim()).reverse()) {
    if (!coding || coding === 'identity') continue;
    if (coding === 'gzip' || coding === 'x-gzip') decoded = zlib.gunzipSync(decoded);
    else if (coding === 'deflate') decoded = zlib.inflateSync(decoded);
    else if (coding === 'br') decoded = zlib.brotliDecompressSync(decoded);
    else throw new Error(`unsupported content-encoding: ${coding}`);
  }
  return decoded;
}

/**
 * 生成浏览器要收到的响应头。
 * 输入：上游头、代理来源和是否丢弃实体长度字段；输出：清理后的头对象。
 *
 * @param {import('node:http').IncomingHttpHeaders} source 上游响应头。
 * @param {{ origin: string, dropBodyFields?: boolean }} options 清理选项。
 * @returns {Record<string, string | string[]>} 可发送给浏览器的头。
 */
export function responseHeaders(source, { origin, dropBodyFields = false }) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const lowered = key.toLowerCase();
    if (STRIP_HEADERS.has(lowered) || lowered === 'set-cookie') continue;
    if (dropBodyFields && ['content-length', 'content-encoding', 'etag', 'content-md5', 'digest'].includes(lowered)) continue;
    if (lowered === 'location') {
      out[key] = String(value).replace(/^https?:\/\/(chat|chat-dev)\.deepseek\.com(?=[:/?#]|$)/i, origin);
      continue;
    }
    out[key] = value;
  }
  const forwarded = forwardableCookies(source['set-cookie']);
  if (forwarded.length > 0) out['set-cookie'] = forwarded;
  return out;
}

/**
 * 把 origin-form 或 absolute-form URL 统一成路径和查询字符串。
 * 输入：Node 请求 URL；输出：以 `/` 开头的路径。
 *
 * @param {string | undefined} rawUrl 原始 URL。
 * @returns {string} 规范化后的请求路径。
 */
export function requestPath(rawUrl) {
  const value = String(rawUrl ?? '/');
  if (/^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return '/';
    }
  }
  return value.startsWith('/') ? value : `/${value}`;
}

/**
 * 判断主机名是不是本机回环地址。
 * 输入：主机名；输出：是回环地址返回 true，否则返回 false。
 *
 * @param {string | undefined} name 主机名。
 * @returns {boolean} 是否为回环主机。
 */
export function isLoopbackHost(name) {
  const value = String(name ?? '').toLowerCase();
  return value === '127.0.0.1' || value === 'localhost' || value === '::1' || value === '[::1]';
}

/**
 * 判断 Origin 是否是本机 HTTP(S) 页面。
 * 输入：Origin 头；输出：通过协议和主机校验返回 true。
 *
 * @param {string | undefined} header Origin 请求头。
 * @returns {boolean} 是否为回环来源。
 */
export function isLoopbackOrigin(header) {
  const text = String(header ?? '').trim();
  if (!text) return false;
  try {
    const parsed = new URL(text);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * 判断请求来源是否允许访问代理。
 * 输入：Origin 头和当前代理地址；输出：允许访问返回 true。
 *
 * @param {string | undefined} header Origin 请求头。
 * @param {string} proxyOrigin 当前代理来源。
 * @returns {boolean} 是否允许该来源。
 */
export function isAllowedOrigin(header, proxyOrigin) {
  if (!header) return true;
  return [proxyOrigin, UPSTREAM_ORIGIN].some((candidate) => candidate.toLowerCase() === String(header).toLowerCase());
}

/**
 * 返回禁用缓存的 JSON 响应；连接已结束时不重复写头。
 * @param {import('node:http').ServerResponse} res HTTP 响应。
 * @param {number} status HTTP 状态码。
 * @param {unknown} payload 可 JSON 序列化的数据。
 * @param {Record<string, string>} [extra={}] 额外响应头。
 * @returns {void} 结果写入 HTTP 响应。
 */
export function sendJson(res, status, payload, extra = {}) {
  if (res.headersSent || res.destroyed) return;
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...extra,
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
  });
  res.end(body);
}

/**
 * 有上限地读取请求体。超限后继续排空输入，不再保留字节，便于完整返回 413。
 * @param {import('node:http').IncomingMessage} req Node HTTP 请求。
 * @param {number} limit 最多允许的字节数。
 * @returns {Promise<Buffer>} 完整请求体；超限或传输失败时拒绝。
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let overflow = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        overflow = true;
        chunks.length = 0;
      } else if (!overflow) chunks.push(Buffer.from(chunk));
    });
    req.once('error', reject);
    req.once('aborted', () => reject(new Error('request aborted')));
    req.once('end', () => {
      if (overflow) reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' }));
      else resolve(Buffer.concat(chunks));
    });
  });
}
