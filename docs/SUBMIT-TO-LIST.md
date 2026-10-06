# 投稿到 awesome-dsh-plugin（当前真实流程）

> 2026-10-06 · 实机核对过源码后的结论
> **⚠️ 本文取代 `PR-SUBMISSION.md` 和 `RELEASE-CHECKLIST.md` 第四节里关于投稿的部分** ——
> 那两份写的是「在 README 里加一行」，那个方式**已经作废**。

---

## 一句话

投稿 = **在 `data/plugins/` 下新增一个 YAML 文件**。
**不要手工改 README** —— 两份 README 都是从 `data/plugins/*.yml` 生成出来的。

---

## 为什么旧的「README 加一行」方式废了

`CONTRIBUTING.md` 写得很直白：以前所有人往同一个 README 分类的同一位置追加，
**合并一个 PR 就会撞掉下一个**。所以改成「一个插件一个文件」——
条目文件永不冲突，而生成出来的 README 行总是相撞。

更硬的一层在 CI 里：`.github/workflows/pr-check.yml` 有一步叫
**「A generated README row that lists nothing is not a submission」** ——
如果一个 PR 只改了 README 里的插件行、却没有动 `data/plugins/` 下的任何文件，
**直接判失败**。理由是这种 PR 合并下去等于什么都没收录。

---

## 我们要提交的条目

**文件**：`data/plugins/hanzheng-dev__dsh-access-phone-remote--plugin.yml`

文件名规则：`owner__repo` 打头，`__` 分隔 owner 和 repo；
monorepo 子包再接 `--` 加**子目录路径（`/` 换成 `-`）**。
我们的子目录是 `plugin`，所以是 `--plugin`。

**内容**：

```yaml
url: https://github.com/hanzheng-dev/dsh-access-phone-remote/tree/main/plugin
name: hanzheng-dev/dsh-access-phone-remote#plugin
category: remote
description:
  en: 'Supervises the dsh-access-phone-remote server from inside the harness: start, stop and restart it, health-check it over loopback, tail its log, and edit its project directory and port from a Settings section that shows the phone URL with a locally rendered QR code.'
  zh: '在 harness 内托管 dsh-access-phone-remote 服务端：启动、停止、重启，走回环做健康检查，读日志尾部；设置页里可改项目目录与端口，并显示手机访问地址和本地生成的二维码。'
```

**字段规则**：

| 字段 | 规则 |
|---|---|
| `url` | 必须与仓库完全一致；monorepo 子包要指向 `/tree/<分支>/<子目录>` |
| `name` | 列表里显示的链接文字；子包写成 `owner/repo#<子目录名>` |
| `category` | 见下方取值表。**选错不会被打回**（维护者会直接改），但别乱选 |
| `description.en` | **必填**。只说功能，**不许营销词**，**必须属实**（会对着代码核） |
| `description.zh` | 可选。不写维护者会补 |
| `tarball` | 可选。必须指向 GitHub Release 托管的 https `.tgz` |

⚠️ **描述里含 `: `（冒号+空格）必须加引号**，否则 YAML 会把它当嵌套键解析。

可用 `category`：
`agi` `ui` `usage` `theme` `model` `identity` `session` `memory` `tools` `wsl`
`browser` `vision` `voice` `docs` `skill` `workflow` `git` `notify` `dev`
`security` `remote` `market` `fun`

我们用 `remote`。

---

## ⚠️ 为什么必须是子包形式（不能直接指仓库根）

`check-submission.mjs` 里这段注释是决定性的：

> The site builds the install command from the entry's URL, so
> `dsh plugin add github:owner/repo` targets **the root**, not wherever the
> manifest happens to live.

也就是说：**条目 url 指哪儿，安装命令就装哪儿**。
`dsh-access-phone-remote` 的**根包是那个独立的 Node 应用**（`main: src/server.js`），
**没有 `dsh.bundle`**。如果把条目指向仓库根，CI 会判失败，并提示改成子包形式：

```
url: https://github.com/hanzheng-dev/dsh-access-phone-remote/tree/main/plugin
name: hanzheng-dev/dsh-access-phone-remote#plugin
```

### dsh 确实支持子目录安装（实测过）

`dsh plugin add` 只是把参数原样转给 pnpm（`lib/plugin-*.js` 里的 `runPlugin`，
只有相对路径 `./` `../` 会被 `anchorPathSpec` 改写）。子目录靠的是 **pnpm 的语法**：

```sh
dsh plugin --profile web add github:hanzheng-dev/dsh-access-phone-remote#path:/plugin
```

`#path:/plugin` 是 pnpm 的 git 依赖子目录语法。`scripts/build-site.mjs` 里生成的就是这个：

```js
? `dsh plugin --profile web add github:${e.repo}#path:/${e.sub}`
: `dsh plugin --profile web add github:${e.repo}`
```

**实测**（pnpm 11.22.0，临时目录）：

```
$ pnpm add "github:hanzheng-dev/dsh-access-phone-remote#path:/plugin"
+ dsh-access-phone-remote 1.0.0
```

装出来的确实是 `plugin/` 子包（含 `cordis.patch.yml`、`dsh.bundle`），**不是根包**。

⚠️ pnpm 解析 git 依赖走的是 **git 自己的代理设置**，不读 `.npmrc` 的 `proxy` ——
国内直连 GitHub 不通时，要么给 git 配 `http.proxy`，要么设 `HTTP_PROXY`/`HTTPS_PROXY`
环境变量，否则会看到 `git ls-remote failed: Failed to connect to github.com port 443`。

---

## CI 会卡什么

每个 PR 依次跑（`.github/workflows/pr-check.yml`）：

| # | 检查 | 说明 |
|---|---|---|
| 1 | **条目数量上限** | 一个 PR **最多 3 条**，超了直接拒并要求拆分 |
| 2 | **`dsh.bundle`** | 从**条目 url 对应的那个 `package.json`** 取。只声明 `dsh.client` 会失败 |
| 3 | **仓库年龄** | **满 1 天**。见下 |
| 4 | `awesome-lint` + 站点构建 | 双语一致性、分隔符、日期、截图 |

还有几个「防呆」检查（都是踩过坑才加的）：

- **stale-fork guard**：PR 删掉超过 2 个既有条目文件 → 判定 fork 太旧，要求先 sync
- **条目文件必须以 `.yml` 结尾** —— 改丢了扩展名会被 `readEntries()` 静默跳过，
  而且**其它检查全绿**（因为 README 重新生成时也会漏掉它，整棵树自洽）
- **条目必须正好在 `data/plugins/` 下一层** —— 放进 `data/` 或更深的子目录同样是静默漏掉
- **只改 README、不改 `data/plugins/`** → 直接失败（见上文）

### 仓库年龄门槛（我们被卡的就是这条）

`check-submission.mjs`：`const MIN_AGE_DAYS = 1`。

- **`dsh-access-phone-remote` 创建于 2026-10-06 13:04:46 UTC**
- **满 1 天的时刻：2026-10-07 21:04:46（UTC+8）**

这条**不需要重开 PR**。CI 的措辞是：

> nothing to do: this check re-runs by itself and should clear in about Nh.
> No need to resubmit, push, or close and reopen

因为 `regate.yml` 每 6 小时重跑一次 gate（它匹配 `/days old/` 这句措辞），
**时间一到自己变绿**。

另有豁免：条目指向的仓库**已经在列表里**时跳过年龄检查
（判断依据是 base commit 上的条目文件名，防止 PR 自己给自己发豁免）。

---

## 本地预检（提 PR 前跑）

在 awesome-dsh-plugin 的 fork 里：

```bash
node scripts/generate-readme.mjs        # 确认条目被读到（会打印 entries 数）
SKIP_PUBLISH_CHECKS=1 node scripts/build-site.mjs   # 站点构建 + 双语/日期校验
node --test scripts/added-dates.test.mjs
node --test scripts/capabilities.test.mjs
```

⚠️ **`generate-readme.mjs` 只在条目已提交后才有 added-date 可推** ——
没 commit 就构建会报 `no added-date derivable ... refusing to build`。

⚠️ `npx awesome-lint` 在本地 fork 克隆里可能报
`Invalid GitHub repo URL: <本地路径>` —— 那是**环境问题，不是你条目的问题**
（在改动归零的情况下同样报）。CI 里跑在真实仓库上下文，正常。

**两形态都接受**：只提交 yml（常见），或 yml + 本地重新生成的 README。
后者必须与 `--check` 一致。**我们选只提交 yml** —— diff 最小，
CI 那一步会自己重新生成，所以条目照样会被 lint 和构建覆盖到。

---

## 开 PR

分支已经推上去了：

- 分支：`add-dsh-access-phone-remote`（在 `hanzheng-dev/awesome-dsh-plugin` fork 上）
- 提交：`cbd0a881d` — 只加一个文件，+6 行
- 开 PR 链接：
  `https://github.com/hanzheng-dev/awesome-dsh-plugin/pull/new/add-dsh-access-phone-remote`

**base 要选 `awesome-dsh-plugin/awesome-dsh-plugin` 的 `main`。**

### 用 API 开（无需点网页）

```bash
POST https://api.github.com/repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls
{
  "title": "Add hanzheng-dev/dsh-access-phone-remote#plugin",
  "head": "hanzheng-dev:add-dsh-access-phone-remote",
  "base": "main",
  "body": "..."
}
```

凭据可用 `git credential fill`（host=github.com）取 —— 本机存的是 `gho_` OAuth token，
scope 为 `gist, repo, workflow`，够用。

---

## 仓库侧要满足的（与 PR 无关，但清单会看）

| 项 | 状态 |
|---|---|
| 加 `dsh-plugin` topic | ✅ 已加 |
| 仓库有真实可用代码（非占位） | ✅ |
| 仓库未归档 | ✅ |
| `screenshots.json` 放在**子包目录内**（`plugin/screenshots.json`） | ✅ |
| 截图相对路径**不得跳出插件目录**（不能 `/` 开头、不能 `..`） | ✅ `assets/...` |

截图详情：1-8 张；也可以写绝对 URL，但必须是 **GitHub 托管的 https**
（`raw.githubusercontent.com` / `user-images.githubusercontent.com` /
`camo.githubusercontent.com` / `github.com` 附件）——**第三方图床会被拒**（用户隐私）。
不声明也行，市场会从 README 自动抽图；声明只是为了控制顺序与取舍。

---

## 提完 PR 之后

- 反馈以 PR 评论给出，会点名要改什么。**因描述不准确被打回不是否定插件** —— 改那行就行
- 合并后 `sync-readme.yml` 在 main 上重新生成两份 README，网站自动重建
- `decay-scan.yml` 定期扫描：仓库消失/归档/长期停更会被汇总到跟踪 issue，复核后移除

---

## 我们踩过的坑（都已修）

1. **一开始按旧文档手改了 README** —— 错。已撤，改为只加 yml。
2. **插件客户端半写成了裸 ESM**（`export function apply`）——
   dsh 浏览器侧只认 `window.__ModuleLoader__.load({id, factory})`，
   写成裸 ESM **永远不会被加载，而且没有任何报错**，设置页只是安静地少一页。
   已按已装插件 `dsh-session-delete` 的形状重写。
3. **`package.json` 漏了 `exports["./client"]`** ——
   形状对了也进不了浏览器图。已在 `plugin/test/static.mjs` 里加了回归断言。
4. **`git push` 报 `Connection was reset`** —— git **不读 Windows 系统代理**。
   给仓库配 `git config http.proxy http://127.0.0.1:7897`（https 同理）。
   curl 能通 ≠ git 能通。
5. **pnpm 装 `github:` 依赖时连不上 GitHub** —— 见上文，同样要给 git/pnpm 环境变量配代理。
6. **提交署名用了 `dsj-open <dsj-open@local>`** ——
   这种邮箱不会关联到 GitHub 账号，**贡献图不计**。已用
   `git filter-branch --env-filter` 全量改写成
   `hanzheng-dev <hanzheng-dev@users.noreply.github.com>`（实测 `author.login=hanzheng-dev`）。
