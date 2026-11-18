# Changelog

## 0.1.1

- 修复：登录完成后顶部状态一直显示「未登录」（改为每 4 秒轮询，且不重载 iframe）
- 新增：插件索引 docs/index.json，可在 Plugins → Discover 里搜索安装
- 新增：.github/workflows/release.yml，推送 tag 时自动构建并发布 Release

## 0.1.0

首个公开版本。

- 左侧栏「网页版」入口，主区域整页嵌入 chat.deepseek.com。
- 本机回环反向代理：改写 CDN 资源地址、剥离 CSP/X-Frame-Options，使页面可被嵌入。
- 登录态持久化：Cookie 存 `cookies.json`，网页版 token 自动捕获并回填，重开 Harness 仍保持登录。
- 会话位置记忆：切回 Harness 再回来，回到上次停留的对话。
- UA 规范化：规避官网对 Electron 外壳的「使用环境异常」提示。
- 「登录帮助」三步说明与「高级：手动同步登录」兜底入口。
