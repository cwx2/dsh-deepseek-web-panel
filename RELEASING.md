# 发布清单

这个项目已经发布在 npm 上（`dsh-deepseek-web-panel`）。以后每次发版，按下面的顺序做，不要跳步。

## 0. 发布前

npm 上的内容基本不可撤回：24 小时内可以 `unpublish`，之后只能 `deprecate`；
而且同名同版本永远不能重发。**每次 `publish` 之前都要跑完这一节。**

```powershell
cd D:\ProductCode\DeepSeekHanessCode\dsh-deepseek-web-panel

# 1) 语法与清单
npm.cmd run check
npm.cmd pack --dry-run

# 2) 确认没有夹带本机信息
git grep -n -I -E 'C:\\\\Users|/Users/[a-z]|Bearer [A-Za-z0-9]'

# 3) 确认版本号是新的
npm.cmd view dsh-deepseek-web-panel versions --json
```

检查 `pack --dry-run` 的输出：应当只有 `index.js`、`client.js`、`src/`、`cordis.patch.yml`、
`locale/`、`assets/`、`README.md`、`LICENSE`、`CHANGELOG.md`，外加 npm 自动带上的
`package.json`。**截图不会进包**（`docs/` 不在 `files` 里），这是故意的。

## 1. 改版本号并更新日志

```powershell
npm.cmd version patch -m "chore: release %s"
```

`patch` 是修 bug，`minor` 是加功能，`major` 是不兼容变更。这条命令会同时改
`package.json`、打一个 `vX.Y.Z` 的 git tag，并提交。

然后手动在 `CHANGELOG.md` 顶部补一节：

```markdown
## 0.1.1

- 修复了……
```

再补一个提交（或者把日志写进上一条提交）：

```powershell
git add CHANGELOG.md
git commit -m "docs: changelog for 0.1.1"
```

## 2. 确认 DSH 版本范围

`package.json` 里的 `engines.dsh` 决定了哪些 Harness 版本能装：

```json
"dsh": ">=0.2.2-rc.1 <0.2.3-0"
```

DSH 一旦升到 `0.2.3`，这个范围就不再匹配，用户装不上、也收不到更新提示。
**每次 DSH 起新的 minor，都要放宽这里并重新发版。**

## 3. 推送

```powershell
git push --follow-tags
```

## 4. 发布

```powershell
npm.cmd publish --otp=你的六位动态码
```

预期输出：

```
+ dsh-deepseek-web-panel@0.1.1
```

如果报 `E403` / `Tag not authorized`，是 2FA 码过期，重新取一个再发。
如果报 `E409`，是版本号已经被占用，回到第 1 步升版本。

## 5. 验证

```powershell
npm.cmd view dsh-deepseek-web-panel version
```

再到 <https://www.npmjs.com/package/dsh-deepseek-web-panel> 看一眼描述和 README 是否正常。

## 6. GitHub Release 会自动创建

`.github/workflows/release.yml` 在推送 `v*` tag 时自动：

1. 跑 `npm run check`；
2. `npm pack` 出 tarball；
3. 用 tarball 建一个 GitHub Release。

所以 `git push --follow-tags` 之后，去仓库 Releases 页面确认一下即可，不用手工上传附件。

## 7. 更新插件索引（每次发版都要做）

索引里写死了 commit sha，发版后必须重新生成，否则 Discover 里装到的还是旧代码：

```powershell
node scripts/index.mjs
git add docs/index.json
git commit -m "chore: refresh the plugin index for vX.Y.Z"
git push
```

## 8. 首次启用 GitHub Pages（只做一次）

索引要通过 HTTPS 对外提供，用户才能把它加进 Discover：

1. 仓库 → Settings → Pages；
2. Source 选 **Deploy from a branch**，分支 `main`、目录 `/docs`；
3. 保存后等一两分钟，访问确认能打开：
   `https://cwx2.github.io/dsh-deepseek-web-panel/index.json`

## 9. 让用户更新

- 从 npm 装的用户：插件页会出现 **Update**；
- 从 Git 装的用户：需要卸载再装（`github:` 源不跟踪新提交）；
- 从索引装的用户：Discover 里能看到新版本，一键安装；
- 版本号不变的话，任何人都拿不到新代码。
