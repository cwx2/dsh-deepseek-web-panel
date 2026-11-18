/**
 * 页面注入脚本。
 *
 * 一次注入做三件事，顺序固定：
 * 1. 环境规范化：网页版用 UA 里的 Electron 标记判断“第三方外壳”，这里去掉标记。
 * 2. 登录态回填：把 Host 记住的 token 写进页面 localStorage，页面一启动就是已登录。
 * 3. 登录态捕获：页面里出现新 token（用户自己登录）时回传 Host，下次继续复用。
 */

import { TOKEN_LIMIT } from './config.js';

/**
 * 在 HTML 的 head 开头插入一段内联脚本。
 * @param {string} html 上游 HTML。
 * @param {string} script 完整的 `<script>` 片段。
 * @returns {string} 注入后的 HTML。
 */
function injectAtHead(html, script) {
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return `${html.slice(0, at)}${script}${html.slice(at)}`;
  }
  return `${script}${html}`;
}

/**
 * 把用户输入统一成 `{ token, id }`。
 * 输入可以是裸 token、站点 localStorage 的 envelope 或 `{ token, id }` 对象。
 *
 * @param {unknown} payload 用户粘贴的原始内容。
 * @returns {{ token: string, id: string | null } | null} 规范化后的登录态。
 */
export function normalizeSyncPayload(payload) {
  /** @type {unknown} */
  let source = payload;
  if (typeof source === 'string') {
    const text = source.trim();
    if (text.startsWith('{') || text.startsWith('"')) {
      try {
        source = JSON.parse(text);
      } catch {
        source = text;
      }
    }
  }

  let token = '';
  /** @type {string | null} */
  let id = null;
  if (typeof source === 'string') {
    token = source;
  } else if (source && typeof source === 'object') {
    const bag = /** @type {Record<string, any>} */ (source);
    const candidate = bag.token ?? bag.userToken ?? bag.access_token ?? bag.value;
    if (typeof candidate === 'string') token = candidate;
    else if (candidate && typeof candidate === 'object' && typeof candidate.value === 'string') token = candidate.value;
    const idCandidate = bag.id ?? bag.userId ?? bag.user_id;
    if (typeof idCandidate === 'number') id = String(idCandidate);
    else if (typeof idCandidate === 'string' && idCandidate.trim() !== '') id = idCandidate.trim();
  }

  token = String(token ?? '').trim();
  if (token.length > 1 && token.startsWith('"') && token.endsWith('"')) token = token.slice(1, -1).trim();
  if (!token || token.length > TOKEN_LIMIT || /[\r\n]/.test(token)) return null;
  return { token, id };
}

/**
 * 解析登录态同步 POST 请求体。
 * @param {Buffer} buffer 请求体。
 * @param {string | string[] | undefined} contentType Content-Type 请求头。
 * @returns {{ token: string, id: string | null } | null} 解析结果。
 */
export function parseSyncBody(buffer, contentType) {
  const text = buffer.toString('utf8').trim();
  if (!text) return null;
  if (String(contentType ?? '').toLowerCase().includes('json')) {
    try {
      return normalizeSyncPayload(JSON.parse(text));
    } catch {
      return null;
    }
  }
  return normalizeSyncPayload(text);
}

/** 环境规范化脚本体（不含 `<script>` 标签）。 */
const ENV_BODY =
  'try{' +
  'var ua=navigator.userAgent.replace(/\\s*Electron\\/[^\\s]+/gi,"").replace(/\\sdsh\\/[^\\s]+/gi,"");' +
  'try{Object.defineProperty(navigator,"userAgent",{configurable:true,get:function(){return ua}})}catch(e){}' +
  'try{if(window.process&&window.process.type==="renderer"){delete window.process}}catch(e){}' +
  '}catch(e){}';

/**
 * 生成登录态回填脚本体。
 * @param {{ token: string, id: string | null }} payload 规范化登录态。
 * @returns {string} 脚本体。
 */
function restoreBody(payload) {
  const data = JSON.stringify({ token: payload.token, id: payload.id ?? null }).replace(/</g, '\\u003c');
  return (
    'try{' +
    `var d=${data};` +
    'localStorage.setItem("userToken",JSON.stringify({value:d.token,__version:"0"}));' +
    'localStorage.setItem("__appKit_userInfo",JSON.stringify({value:{id:d.id},__version:"0"}));' +
    'document.documentElement.setAttribute("data-dsh-deepseek-sync","ok");' +
    '}catch(e){document.documentElement.setAttribute("data-dsh-deepseek-sync","error");}'
  );
}

/**
 * 捕获脚本体：页面里出现 token 就回传 Host，只在变化时发一次。
 * @returns {string} 脚本体。
 */
function captureBody() {
  return (
    'try{' +
    'var sent=null;' +
    'var read=function(){try{var r=localStorage.getItem("userToken");if(!r)return null;var p=JSON.parse(r);' +
    'if(p&&typeof p.value==="string")return p.value;if(p&&typeof p.token==="string")return p.token;' +
    'if(typeof r==="string"&&r.length<8000&&r.indexOf("{")!==0)return r}catch(e){}return null};' +
    'var readId=function(){try{var r=localStorage.getItem("__appKit_userInfo");if(!r)return null;' +
    'var p=JSON.parse(r);return p&&p.value&&p.value.id?String(p.value.id):null}catch(e){return null}};' +
    'var tick=function(){var v=read();if(!v||v===sent)return;sent=v;' +
    'try{fetch("/__ds/capture",{method:"POST",headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({token:v,id:readId()}),keepalive:true}).catch(function(){})}catch(e){}};' +
    'tick();setInterval(tick,2500);' +
    '}catch(e){}'
  );
}

/**
 * 位置回报脚本体：页面是单页应用，切换会话只改 URL，这里把当前位置报给 Host。
 * @returns {string} 脚本体。
 */
function routeBody() {
  return (
    'try{' +
    'var sendRoute=function(){try{fetch("/__ds/route",{method:"POST",headers:{"content-type":"application/json"},' +
    'body:JSON.stringify({path:location.pathname+location.search+location.hash}),keepalive:true}).catch(function(){})}catch(e){}};' +
    'sendRoute();' +
    'try{var push=history.pushState;history.pushState=function(){var r=push.apply(this,arguments);sendRoute();return r};' +
    'var replace=history.replaceState;history.replaceState=function(){var r=replace.apply(this,arguments);sendRoute();return r}}catch(e){}' +
    'try{window.addEventListener("popstate",sendRoute)}catch(e){}' +
    '}catch(e){}'
  );
}

/**
 * 生成完整的启动脚本：环境 → 回填 → 捕获 → 位置回报。
 * @param {{ token: string, id: string | null } | null} payload 已记住的登录态，可为空。
 * @returns {string} 可直接插入 head 的 `<script>` 片段。
 */
export function createBootScript(payload) {
  const parts = [ENV_BODY];
  if (payload) parts.push(restoreBody(payload));
  parts.push(captureBody());
  parts.push(routeBody());
  const inner = parts.map((part) => `(function(){${part}})();`).join('');
  return `<script data-dsh-deepseek-boot="1">${inner}</script>`;
}

/**
 * 注入启动脚本。
 * @param {string} html 已经改写资源地址的 HTML。
 * @param {{ token: string, id: string | null } | null} payload 已记住的登录态。
 * @returns {string} 注入后的 HTML。
 */
export function injectBootScript(html, payload) {
  return injectAtHead(html, createBootScript(payload));
}
