/**
 * Cookie 相关代码。
 *
 * Cookie 罐只负责保存和合并 Cookie，不参与 HTTP 请求。这样登录态的持久化逻辑
 * 和代理转发逻辑彼此独立，读代码时更容易判断哪些代码会碰到敏感凭据。
 */

import fsp from 'node:fs/promises';
import path from 'node:path';

/**
 * 在磁盘上保存上游站点 Cookie 的小型 Cookie 罐。
 * 输入是 Cookie 文件路径和日志函数；输出是可供代理注入请求头的 Cookie 字符串。
 */
export class CookieJar {
  /**
   * 创建 Cookie 罐。
   *
   * 输入：保存文件路径、日志函数和写盘防抖时间。
   * 输出：一个尚未加载文件内容的 Cookie 罐实例。
   *
   * @param {string} file Cookie JSON 文件的绝对路径。
   * @param {(level: string, message: string) => void} log 日志函数。
   * @param {number} [saveDebounceMs=250] 写盘防抖毫秒数。
   */
  constructor(file, log, saveDebounceMs = 250) {
    this.file = file;
    this.log = log;
    this.saveDebounceMs = saveDebounceMs;
    /** @type {Map<string, string>} 当前 Cookie 名和值。 */
    this.cookies = new Map();
    this.loaded = false;
    this.writes = Promise.resolve();
    /** @type {NodeJS.Timeout | undefined} 延迟写盘计时器。 */
    this.timer = undefined;
  }

  /**
   * 从磁盘加载 Cookie。
   * 输入：无；输出：完成加载的 Promise。
   *
   * @returns {Promise<void>} 加载完成后结束。
   */
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(await fsp.readFile(this.file, 'utf8'));
      const stored = raw && typeof raw === 'object' && raw.cookies ? raw.cookies : raw;
      if (stored && typeof stored === 'object') {
        for (const [name, value] of Object.entries(stored)) {
          if (typeof value === 'string') this.cookies.set(name, value);
        }
      }
      this.log('info', `已从 ${this.file} 加载 ${this.cookies.size} 个 Cookie`);
    } catch (error) {
      if (error?.code !== 'ENOENT') this.log('warn', `Cookie 文件无法读取：${error?.message ?? error}`);
    }
  }

  /**
   * 吸收上游响应里的 Set-Cookie。
   * 输入：Set-Cookie 字符串数组；输出：无，变化会安排异步写盘。
   *
   * @param {string[] | undefined} lines 上游响应头里的 Set-Cookie。
   * @returns {void}
   */
  absorb(lines) {
    if (!Array.isArray(lines) || lines.length === 0) return;
    let changed = false;
    for (const line of lines) {
      const pair = String(line).split(';')[0] ?? '';
      const index = pair.indexOf('=');
      if (index < 1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!name) continue;
      const attributes = String(line)
        .split(';')
        .slice(1)
        .map((attribute) => attribute.trim().toLowerCase());
      const expired =
        value === '' ||
        attributes.some((attribute) => attribute === 'max-age=0' || /^max-age=-\d+$/.test(attribute)) ||
        attributes.some((attribute) => attribute.startsWith('expires=thu, 01 jan 1970'));
      const previous = this.cookies.get(name);
      if (expired) {
        if (previous !== undefined) {
          this.cookies.delete(name);
          changed = true;
        }
        continue;
      }
      if (previous !== value) {
        this.cookies.set(name, value);
        changed = true;
      }
    }
    if (changed) this.scheduleSave();
  }

  /**
   * 生成 Cookie 请求头。
   * 输入：无；输出：`name=value; ...` 格式的字符串。
   *
   * @returns {string} 可直接放到 HTTP 请求头中的 Cookie。
   */
  header() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  /**
   * 获取当前 Cookie 数量。
   * 输入：无；输出：Cookie 数量。
   *
   * @returns {number} Cookie 数量。
   */
  size() {
    return this.cookies.size;
  }

  /** @returns {void} 无需输入，重设防抖计时器，避免短时间内反复写文件。 */
  scheduleSave() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.save();
    }, this.saveDebounceMs);
    this.timer.unref?.();
  }

  /**
   * 异步保存 Cookie。
   * 输入：无；输出：完成写盘的 Promise。
   *
   * @returns {Promise<void>} 保存完成后结束。
   */
  save() {
    // 相同临时文件只能由一个写入操作使用；串行保存可避免 rename 互相抢文件。
    this.writes = this.writes.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true });
      const payload = JSON.stringify(
        { savedAt: new Date().toISOString(), cookies: Object.fromEntries(this.cookies) }, null, 2,
      );
      const temporary = `${this.file}.tmp`;
      await fsp.writeFile(temporary, payload, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(temporary, this.file);
    }).catch((error) => {
      this.log('warn', `Cookie 文件写入失败：${error?.message ?? error}`);
    });
    return this.writes;
  }

  /**
   * 关闭前取消防抖并等待最终写盘，避免旧异步写入在关闭后覆盖新值。
   * @returns {Promise<void>} 所有保存完成后结束；无需输入。
   */
  flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    return this.save();
  }
}

/**
 * 合并浏览器 Cookie 和 Cookie 罐里的 Cookie，后写入的 Cookie 覆盖同名值。
 * 输入：浏览器头和 Cookie 罐头；输出：合并后的 Cookie 请求头。
 *
 * @param {string | undefined} browserHeader 浏览器传来的 Cookie。
 * @param {string} jarHeader Cookie 罐生成的 Cookie。
 * @returns {string} 合并后的 Cookie 请求头。
 */
export function mergeCookies(browserHeader, jarHeader) {
  const merged = new Map();
  for (const segment of [browserHeader, jarHeader]) {
    for (const chunk of String(segment ?? '').split(';')) {
      const index = chunk.indexOf('=');
      if (index < 1) continue;
      merged.set(chunk.slice(0, index).trim(), chunk.slice(index + 1).trim());
    }
  }
  return [...merged].map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * 过滤可以转发给浏览器的 Set-Cookie。
 * HttpOnly Cookie 只留在 Host 端 Cookie 罐里，避免认证 Cookie 暴露给页面脚本。
 *
 * 输入：上游 Set-Cookie 数组；输出：去掉 Domain/Secure/HttpOnly 后的数组。
 *
 * @param {string[] | undefined} lines 上游 Set-Cookie。
 * @returns {string[]} 可以发给浏览器的 Set-Cookie。
 */
export function forwardableCookies(lines) {
  const forwarded = [];
  for (const line of lines ?? []) {
    const text = String(line);
    if (/\bhttponly\b/i.test(text)) continue;
    const attributes = text
      .split(';')
      .filter((attribute) => {
        const lowered = attribute.trim().toLowerCase();
        return lowered !== '' && lowered !== 'secure' && !lowered.startsWith('domain=');
      })
      .join(';');
    if (attributes.trim() !== '') forwarded.push(attributes);
  }
  return forwarded;
}
