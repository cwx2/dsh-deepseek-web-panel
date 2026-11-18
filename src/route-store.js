/**
 * 最近访问位置的存储。
 *
 * 网页版是单页应用，切换会话只改 URL 不刷新页面。面板一旦被卸载再重建，
 * 就只能从首页重新加载，所以页面把当前位置报给 Host，下次按这个位置恢复。
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * 判断一个路径是否可以安全地拼回代理地址。
 * @param {unknown} value 页面回报的路径。
 * @returns {boolean} 是否可接受。
 */
export function isSafeRoute(value) {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > 512) return false;
  if (!value.startsWith('/')) return false;
  // 排除协议相对地址和 Windows 路径分隔符，避免把请求带出代理源。
  if (value.startsWith('//') || value.includes('\\')) return false;
  if (/[\r\n\t]/.test(value)) return false;
  return true;
}

export class RouteStore {
  /**
   * @param {string} file 位置文件的完整路径。
   * @param {(level: string, message: string) => void} log 日志函数。
   */
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.value = null;
    this.writes = Promise.resolve();
  }

  /** @returns {string | null} 最近一次位置。 */
  get route() {
    return this.value;
  }

  /**
   * 读取上次保存的位置。
   * @returns {Promise<void>} 读取结束；缺文件正常忽略。
   */
  async load() {
    try {
      const stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (isSafeRoute(stored.path)) this.value = stored.path;
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('warn', `上次位置读取失败：${error.message}`);
    }
  }

  /**
   * 记录一个新位置；与当前值相同则不写盘。
   * @param {unknown} value 页面回报的位置。
   * @returns {boolean} 是否发生了变化。
   */
  set(value) {
    if (!isSafeRoute(value) || value === this.value) return false;
    this.value = value;
    this.writes = this.writes
      .then(async () => {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(this.file, JSON.stringify({ path: this.value }), { mode: 0o600 });
      })
      .catch((error) => this.log('warn', `位置保存失败：${error.message}`));
    return true;
  }

  /** @returns {Promise<void>} 等待已排队的写入结束。 */
  flush() {
    return this.writes;
  }
}
