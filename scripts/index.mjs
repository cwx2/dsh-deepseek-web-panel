/**
 * 生成 DSH 插件索引（docs/index.json）。
 *
 * 索引里每个版本要写死 git commit，所以每次发版后都要重跑这个脚本并提交。
 * 用法：node scripts/index.mjs
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const zh = JSON.parse(fs.readFileSync(path.join(root, 'locale/zh.json'), 'utf8')).meta;
const en = JSON.parse(fs.readFileSync(path.join(root, 'locale/en.json'), 'utf8')).meta;

/** 读取当前提交信息。 */
function head() {
  const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const ts = Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: root, encoding: 'utf8' }).trim());
  return { sha, ts };
}

/** 从 repository 字段推导 https 地址，去掉 git+ 前缀和 .git 后缀。 */
function repoUrl() {
  const raw = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url ?? '';
  return raw.replace(/^git\+/, '').replace(/\.git$/, '');
}

const { sha, ts } = head();
const url = repoUrl();

const index = {
  format: 1,
  title: { zh: zh.title, en: en.title },
  description: { zh: zh.description, en: en.description },
  metadata: {
    categories: {
      ui: { title: { zh: '界面与面板', en: 'Interface' } },
    },
    labels: {
      deepseek: { title: { zh: 'DeepSeek 网页版', en: 'DeepSeek web' } },
    },
  },
  plugins: [
    {
      name: pkg.name,
      title: { zh: zh.title, en: en.title },
      description: { zh: zh.description, en: en.description },
      icon: `${url.replace('https://github.com/', 'https://raw.githubusercontent.com/')}/main/assets/icon.svg`,
      author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name,
      homepage: `${url}#readme`,
      repository: { url },
      metadata: { category: 'ui', labels: ['deepseek'] },
      versions: [
        {
          version: pkg.version,
          publishTimestamp: ts,
          source: { type: 'git', url, commit: sha },
          engines: { dsh: pkg.engines.dsh },
        },
      ],
    },
  ],
};

const out = path.join(root, 'docs/index.json');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8');
console.log(`已生成 ${path.relative(root, out)}：${pkg.name}@${pkg.version} @ ${sha.slice(0, 7)}`);
