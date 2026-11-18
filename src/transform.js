/**
 * 上游文本改写：让 DeepSeek 的页面、CSS 和入口脚本在回环来源下工作。
 * 补丁依赖上游 bundle 的特定文本，匹配不到时必须报告，方便上游升级后定位问题。
 */
import { CDN_ORIGIN, LOCAL_PREFIX } from './config.js';
export { LOCAL_PREFIX } from './config.js';

/** 上游 HTML/CSS 使用的资源前缀。 */
export const CDN_PREFIX = `${CDN_ORIGIN}/chat/`;

/**
 * 把 HTML 中的 CDN 资源改成代理地址，并去掉改写后不再有效的完整性和跨域属性。
 * @param {string} html 上游 HTML 文本。
 * @param {string} origin 不带结尾斜杠的代理来源。
 * @returns {{html: string, replaced: number}} 改写的 HTML 和替换次数。
 */
export function rewriteHtml(html, origin) {
  let out = html.replace(/\s+integrity="[^"]*"/g, '');
  out = out.replace(/\s+crossorigin(?=[\s>/])/g, '');
  const parts = out.split(CDN_PREFIX);
  return { html: parts.join(`${origin}${LOCAL_PREFIX}`), replaced: parts.length - 1 };
}

/**
 * 把 CSS 中的 CDN 字体、图片地址改走本地代理，避免跨来源资源被 CDN 拒绝。
 * @param {string} css 上游 CSS 文本。
 * @returns {{css: string, replaced: number}} 改写后的 CSS 和替换次数。
 */
export function rewriteCss(css) {
  const parts = css.split(CDN_PREFIX);
  return { css: parts.join(LOCAL_PREFIX), replaced: parts.length - 1 };
}

/** 补丁顺序按具体用途排列；from 必须对应上游实际文本，不可随意美化。 */
const ENTRY_PATCHES = [
  {
    // 回环 IPv4 会被站点误判成开发环境，固定为生产站点主机名。
    id: 'environment',
    from: 'let e=location.hostname;if(e.match(/(\\d{1,3}\\.){3,3}\\d{1,3}/))return"dev";',
    to: 'let e="chat.deepseek.com";if(!1)return"dev";',
  },
  {
    // 未知主机名时仍使用生产环境，避免页面启动时直接抛错。
    id: 'hostname-fallback',
    from: 'throw Error("Unknown hostname: ".concat(e))',
    to: 'return"production"',
  },
  {
    // HTTP 回环页面使用 ws，HTTPS 页面使用 wss。
    id: 'tts-websocket-scheme',
    from: 'wsEndpoint:"wss://".concat(window.location.host,"/api/v0/chat/tts/")',
    to: 'wsEndpoint:(window.location.protocol==="https:"?"wss://":"ws://").concat(window.location.host,"/api/v0/chat/tts/")',
  },
  {
    // 后续懒加载的 chunk 也要通过同一个代理来源加载。
    id: 'public-path',
    from: 'h.p="https://fe-static.deepseek.com/chat/"',
    to: 'h.p=(window.location.origin+"/__ds/")',
  },
];

/**
 * 改写入口脚本的环境、WebSocket 协议和懒加载资源路径。
 * @param {string} source 上游入口脚本文本。
 * @returns {{text: string, applied: string[], missing: string[]}} 改写结果、命中的补丁和缺失的补丁。
 */
export function patchEntryBundle(source) {
  let text = source;
  const applied = [];
  const missing = [];
  for (const patch of ENTRY_PATCHES) {
    if (!text.includes(patch.from)) {
      missing.push(patch.id);
      continue;
    }
    text = text.replace(patch.from, patch.to);
    applied.push(patch.id);
  }
  return { text, applied, missing };
}
