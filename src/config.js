/**
 * DeepSeek 网页版面板插件的集中配置。
 *
 * 端口、状态目录和路由名集中在这里，代理模块与 Host 路由共用同一份常量。
 */

import os from 'node:os';
import path from 'node:path';

/** 代理内部路由（页面同源，非 Harness 路由）共用的路径前缀。 */
export const LOCAL_PREFIX = '/__ds/';
/** 页面查询代理状态的 Harness 同源路由。 */
export const STATUS_ROUTE = '/plugins/deepseek-web-panel/status';
/** 页面提交登录态的 Harness 同源路由。 */
export const HOST_SYNC_ROUTE = '/plugins/deepseek-web-panel/sync';
/** 上游 DeepSeek 网页地址。 */
export const UPSTREAM_ORIGIN = 'https://chat.deepseek.com';
/** 上游网页使用的主机名。 */
export const UPSTREAM_HOST = 'chat.deepseek.com';
/** 上游静态资源地址。 */
export const CDN_ORIGIN = 'https://fe-static.deepseek.com';
/** 默认监听端口，端口被占用时会自动换成空闲端口。 */
export const DEFAULT_PORT = 3098;
/** 静态资源缓存的有效时间。 */
export const ASSET_CACHE_TTL_MS = 10 * 60 * 1000;
/** 静态资源缓存最多保存多少项。 */
export const ASSET_CACHE_ENTRIES = 96;
/** Cookie 写盘防抖时间。 */
export const JAR_SAVE_DEBOUNCE_MS = 250;
/** 登录态请求体最大字节数。 */
export const SYNC_BODY_LIMIT = 64 * 1024;
/** 登录 token 最大字符数，防止异常输入占满内存。 */
export const TOKEN_LIMIT = 8192;

/**
 * 读取 Host 端代理配置。
 *
 * @param {NodeJS.ProcessEnv} [env=process.env] 环境变量。
 * @returns {{ host: string, port: number, stateDir: string, debug: boolean }} 代理配置。
 */
export function readProxyConfig(env = process.env) {
  const home = env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh');
  const stateDir = env.DSH_DEEPSEEK_WEB_PANEL_STATE?.trim() || path.join(home, 'deepseek-web-panel');
  // Number 会拒绝“3098abc”这种混合输入，避免把错误配置悄悄当成合法端口。
  const requestedPort = Number(env.DSH_DEEPSEEK_WEB_PANEL_PORT?.trim());
  const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort <= 65535
    ? requestedPort
    : DEFAULT_PORT;

  return {
    host: '127.0.0.1',
    port,
    stateDir,
    debug: env.DSH_DEEPSEEK_WEB_PANEL_DEBUG === '1',
  };
}
