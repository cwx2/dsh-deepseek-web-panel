/** 登录态存储：一份“待注入”的一次性凭据，和一份“已记住”的长期凭据。 */
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { normalizeSyncPayload } from './sync.js';

export class LoginStore {
  /**
   * 创建存储；文件操作用 `writes` 串行，避免旧写入覆盖新凭据。
   * @param {string} file 待注入凭据文件的完整路径。
   * @param {(level: string, message: string) => void} log 不包含凭据的日志函数。
   */
  constructor(file, log) {
    this.file = file;
    /** 长期凭据：面板里登录一次后一直复用，直到被新凭据替换。 */
    this.sessionFile = path.join(path.dirname(file), 'session.json');
    this.log = log;
    this.pending = null;
    this.saved = null;
    this.writes = Promise.resolve();
  }

  /**
   * 恢复已保存的凭据；启动期间已有新输入时优先保留新输入。
   * @returns {Promise<void>} 读取结束；缺文件正常忽略，其他错误只记日志。
   */
  async load() {
    await this.readInto(this.sessionFile, (value) => { this.saved = value; }, '长期登录态');
    await this.readInto(this.file, (value) => {
      if (!this.pending) this.pending = { ...value, syncId: randomUUID() };
    }, '待注入登录态');
  }

  /**
   * 读取一个凭据文件并交给回调。
   * @param {string} file 文件路径。
   * @param {(value: {token: string, id: string | null}) => void} apply 应用读取结果。
   * @param {string} label 日志里的名称。
   * @returns {Promise<void>} 读取结束。
   */
  async readInto(file, apply, label) {
    try {
      const stored = JSON.parse(await fs.readFile(file, 'utf8'));
      const value = normalizeSyncPayload(stored);
      if (value) apply(value);
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('warn', `${label}读取失败：${error.message}`);
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
   * 记住一份凭据，供以后每次页面加载注入；内容未变化时不重复写盘。
   * @param {unknown} payload 裸 token、JSON 文本或含 token 的对象。
   * @returns {boolean} 是否写入了新凭据。
   */
  remember(payload) {
    const normalized = normalizeSyncPayload(payload);
    if (!normalized) return false;
    if (this.saved && this.saved.token === normalized.token) return false;
    this.saved = { token: normalized.token, id: normalized.id };
    void this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.sessionFile), { recursive: true });
      await fs.writeFile(
        this.sessionFile,
        JSON.stringify({ ...this.saved, savedAt: new Date().toISOString() }, null, 2),
        { mode: 0o600 },
      );
    });
    return true;
  }

  /**
   * 校验并排队凭据；排队的凭据同时成为长期凭据。
   * @param {unknown} payload 裸 token、JSON 文本或含 token 的对象。
   * @returns {{ok: true} | {ok: false, error: string}} 入队结果，不返回凭据。
   */
  queue(payload) {
    const normalized = normalizeSyncPayload(payload);
    if (!normalized) return { ok: false, error: 'expected a chat.deepseek.com login token' };
    const value = { ...normalized, syncId: randomUUID() };
    this.pending = value;
    this.remember(normalized);
    void this.enqueue(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      await fs.writeFile(this.file, JSON.stringify({ ...value, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    });
    return { ok: true };
  }

  /**
   * 只清理排队中的那份凭据，长期凭据保留。
   * @param {{token: string, id: string | null, syncId: string} | null} expected 当时取出的凭据对象。
   * @returns {void} 内存立即清理，文件删除排在已有写入后面。
   */
  clear(expected) {
    if (!expected || this.pending !== expected) return;
    this.pending = null;
    void this.enqueue(() => fs.rm(this.file, { force: true }));
  }

  /** @returns {Promise<void>} 等待已排队的文件操作结束，供关闭代理时调用。 */
  flush() {
    return this.writes;
  }
}
