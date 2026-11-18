/** 登录态存储：只保存一份“已记住”的凭据，供每次页面加载回填。 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeSyncPayload } from './sync.js';

export class LoginStore {
  /**
   * 创建存储；文件写入串行执行，避免旧写入覆盖新凭据。
   * @param {string} file 凭据文件的完整路径。
   * @param {(level: string, message: string) => void} log 不包含凭据的日志函数。
   */
  constructor(file, log) {
    this.file = file;
    this.log = log;
    this.saved = null;
    this.writes = Promise.resolve();
  }

  /**
   * 读取已保存的凭据。
   * @returns {Promise<void>} 读取结束；缺文件正常忽略，其他错误只记日志。
   */
  async load() {
    try {
      const stored = JSON.parse(await fs.readFile(this.file, 'utf8'));
      const value = normalizeSyncPayload(stored);
      if (value) this.saved = value;
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('warn', `登录态读取失败：${error.message}`);
    }
  }

  /**
   * 串行执行一次文件操作，失败不会阻断后面的写入。
   * @param {() => Promise<unknown>} operation 要执行的文件操作。
   * @returns {Promise<void>} 本次操作结束后的 Promise。
   */
  enqueue(operation) {
    this.writes = this.writes.then(operation).then(() => undefined).catch((error) => {
      this.log('warn', `登录态保存失败：${error.message}`);
    });
    return this.writes;
  }

  /**
   * 记住一份凭据；内容未变化时不重复写盘。
   * @param {unknown} payload 裸 token、JSON 文本或含 token 的对象。
   * @returns {boolean} 是否写入了新凭据。
   */
  remember(payload) {
    const normalized = normalizeSyncPayload(payload);
    if (!normalized) return false;
    if (this.saved && this.saved.token === normalized.token) return false;
    this.saved = { token: normalized.token, id: normalized.id };
    void this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(
        this.file,
        JSON.stringify({ ...this.saved, savedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
    });
    return true;
  }

  /** @returns {Promise<void>} 等待已排队的文件操作结束，供关闭代理时调用。 */
  flush() {
    return this.writes;
  }
}
