# RUN-NOTES · 让它真的跑起来

> 记录时间：2026-10-07 凌晨
> 机器：Windows 11 / pwsh / Git Bash
> **结论：跑起来了，看到了界面 —— 而且现在是 `build.sh` 自动做的。**
> 走的路线是 **SDK 自带的 Previewer**：没下 QEMU、没装 DevEco、没登华为账号。

---

## 0. 一句话结论

`entry-default-signed.hap` 现在是这样一条链产出来的，八步全绿：

```
.ets ─ets-loader─► JS ─es2abc─► modules.abc ─┐
resources ─restool─► resources.index ────────┼─app_packing_tool─► .hap ─hap-sign-tool─► 签名 .hap
                                             ┘                                          │
                              verify-app（签名/格式合法）◄───────────────────────────────┘
                                             │
                              preview-smoke（**运行时真的接受了**）◄─────────────────────┘
```

前七步以前就有。**第八步是这次补的，也是这次最值钱的东西**：

> **`verify-app` 通过只证明「文件格式合法 + 签名有效」，完全不证明运行时会加载这份字节码。**
>
> 实测证据：`verify-app` 一路 `Verify success`，而 Previewer 一跑就报
> `Cannot find module '...' , which is application Entry Point`。
> **换句话说，在补上第八步之前，这个仓库的"HAP 构建成功"是个假绿灯。**

**可复现性已经证明过了**：`build.sh` 跑完，`build/stage/smoke-frame.jpg`
与当初手工攻关时那张 `run-artifacts/setup-screen.jpg` **SHA-256 完全相同**
（`36498c0687b06bc2cf1e5bb97640d8564b464e0fe8728cfdd7666b2ea9c4b99e`，均为 1080×2340 / 111,246 B）
—— 也就是**逐字节等价**。不是"看起来一样"，是同一张图。

界面内容：标题 `dsh-access-phone-remote`、副标题 `第一次使用，请填电脑地址`、
输入框（占位 `粘贴完整地址`）、说明文字、橙色按钮 `连 接` —— 就是 `pages/Setup.ets` 那一页。

---

## 1. 卡的到底是什么（三处，全在构建链上）

手工构建链（`build.sh`）和 DevEco 的差别，浓缩成三行：

| # | 缺陷 | 症状原话 |
|---|---|---|
| 1 | `modules.abc` 的**记录名**不是归一化 ohmurl | `Cannot find module 'io.github.hanzhengdev.phoneaccess&entry/src/main/ets/pages/Setup&1.0.0', which is application Entry Point` |
| 2 | es2abc 清单里模块类型写了 `commonjs` | `Input file is not esmodule` |
| 3 | 打包进 HAP 的 `module.json` 缺 `compileMode` | 引擎退化成 FA 加载路径，去找 `pages/Setup.abc` 而不是 `modules.abc` |

外加一条"少了不报错、只是解析链空着"的：

| 4 | 缺 `pkgContextInfo.json` | 多包/ohModule 解析表为空；预览器报 loader/pkgContext 缺失 |

### 1.1 记录名（最关键的一条）

运行时期望的格式是**归一化 ohmurl**：

```
<bundleName>&<模块名>/<模块内路径>&<版本>
```

即 `io.github.hanzhengdev.phoneaccess&entry/src/main/ets/pages/Setup&1.0.0`。

**⚠️ 第一段是 `bundleName`（应用的包名），不是模块名。**
这一点是**拿运行时的原话校准的** —— 它自己把想要的字符串打在错误信息里了：

```
D C03f00/ArkCompiler: [ecmascript] TransformToNormalizedOhmUrl
    inputFileName: pages/Setup.abc oldEntryPoint: io.github.hanzhengdev.phoneacc...
D C03f00/ArkCompiler: [ecmascript] Throw error: Cannot find module
    'io.github.hanzhengdev.phoneaccess&entry/src/main/ets/pages/Setup&1.0.0'
```

这也和 SDK 里正规函数的实现一致（`ets-loader/lib/ark_utils.js`）：

```js
function getNormalizedOhmUrlByFilepath(e, r, t, o, i) {
  var { pkgName: o, pkgPath: a, isRecordName: n, moduleName: l } = o,
      r = getPkgInfo(e, r, t, a, o, i);
  return r ? ({ projectFilePath: t, pkgInfo: a } = r,
    i = a.bundleName + `&${o}/${t}&` + a.version,      // ← 就是这一行
    n ? i : `${a.isSO ? "Y" : "N"}&${l || a.moduleName}&` + i) : e;
}
```

`build.sh` 早先手拼的是 `entry/ets/<rel>` —— 既不是 `@bundle:` ohmurl，也不是归一化 ohmurl，
**运行时按 ohmurl 去记录表里查，永远查不到**。

> 正规做法是直接 require 这个 `ark_utils.js` 调 `getNormalizedOhmUrlByFilepath`，
> 但它要一整套 `projectConfig` + `pkgContextInfo` 才能跑；本工程按**同一个公式**算等价值，
> 并把公式来源写进了 `build.sh` 的注释里。

---

## 2. Previewer 的启动姿势（它没写文档，这是实测摸出来的）

Previewer **不是加载 HAP**，而是加载**一个已解包的 app 目录 + 一个资源目录**，
再通过 WebSocket 把渲染帧发出来。至少需要：

```
-j <app目录>     必须存在；modules.abc 直接放这里（Stage 非卡片模型不会去 app/ets 找）
-or <宽> <高>     原始分辨率（两个参数）
-cr <宽> <高>     压缩分辨率（两个参数）
-url <页面>       如 pages/Setup
```

其余可选但强烈建议：

```
-device phone -shape rect -cm light -av ACE_2_0 -o portrait -sd 480 -l zh_CN
-pm Stage -projectID <随意> -n <bundleName>
-arp <资源目录>       含 module.json / resources.index / resources/
-pages main_pages     ⚠️ 只能填 profile 名；填 Windows 绝对路径会被正则拒（退出码 11）
-s <命名管道名>        本地命令通道（不填会每 2ms 刷 "socket is null"）
-lws <端口>           WebSocket 图像通道监听端口
-sid <16位hex>        图像通道路径校验用；**WS 路径必须等于它**，否则握手中断
-ljPath <loader.json> ohmurl/多包解析链；同目录还要有 pkgContextInfo.json
```

这些参数名是从上游开源 `openharmony/ide_previewer` 的 `util/CommandParser.cpp`
对照出来的（二进制里没有明文参数表，但报错会带参数名）。

### 2.1 Previewer 自己不开窗口 —— 怎么看界面

`InitGlfwEnv` 里 `CreateGlfwWindow(w,h,false)` 第三参为 `false`，**不开可见窗口**，
帧只从 WebSocket 发出去。帧格式：**40 字节头 + 完整 JPEG**：

```
偏移 0     : 0x12345678（headStart，小端）
偏移 4     : origWidth    (0x438 = 1080)
偏移 8     : origHeight   (0x924 = 2340)
偏移 12/16 : compWidth / compHeight
偏移 20~39 : 全屏刷新 region，全 0
偏移 40    : ff d8 ff ... JPEG ... ff d9
```

Node 24 自带全局 `WebSocket`，所以**零依赖**就能收帧存图 —— 见 `tools/preview-smoke.js`。

---

## 3. 运行期自检 `tools/preview-smoke.js`（这次新增的那道关）

```bash
# 单独跑
OHOS_SDK=D:/ohos/sdk node tools/preview-smoke.js build/stage pages/Setup 25

# build.sh 的第 8 步自动跑这个；要跳过用 SKIP_SMOKE=1（不建议）
```

它做四件事：解包产物布局 → 起命名管道 + spawn Previewer → 抓 WS 帧存成 `smoke-frame.jpg`
→ **按日志判定**。

**判定规则（这里是重点，写之前先踩过一遍）**：

判"失败"只认这几条**硬标志**（都是实测撞到过的原话）：

```
Cannot find module                    → 记录名对不上（不是归一化 ohmurl）
Cannot execute module buffer file     → 字节码没被执行（记录名 / 模块类型不对）
is not esmodule                       → es2abc 清单里模块类型不是 esm
Don't find some necessary node in loader.json
Launch -j parameters abnormal
Error message:                        → Ace 层报了错
```

**⚠️ 故意没用 `find asset failed`**：它在**每次正常启动**里都会出现 **7 条**，
全部良性 —— `manifest.json` / `component_collection.txt` / `jsMockHmos.abc` /
`resources/default/properties/string.json` / `commons.abc` / `vendors.abc` / `app.abc`，
都是"可选资源没找到"的常态警告。
真正要命的那条长这样：`find asset failed, assetName = pages/Setup.abc` ——
但**靠"名字里带 `.abc`"分不出来**（`commons.abc` 也带），
所以放弃它，改用它**下游必然会出现的** `Cannot find module`。

再加一条**空白帧兜底**（启发式，按本项目标定）：
同一页面同一尺寸下，**空白**首帧恒为 **40,651 B**，**渲染出来**是 **111,286 B** ——
差了近 3 倍（纯白图 JPEG 压得极小）。所以设 `BLANK_MAX = 60000` 兜底，
防"没报错但其实是白屏"。

---

## 4. 逐层卡点（撞墙顺序，供后人少走弯路）

1. **没参数** → `[ERROR][CommandParser.cpp][IsAppPathValid] Launch -j parameters abnormal!`
   → 补 `-j/-or/-cr/-url`。

2. **`-j` 目录形态不对**：`modules.abc` 放 `app/` 根**是对的**（Stage 非卡片不加 `assetPath/ets`）；
   早先那次崩（`0xc0000005` JS 引擎 AV）是**缺 `compileMode`** 导致走了 FA 分支，不是路径问题。

3. **`loader.json not found`** → 补 `-ljPath` + **同目录** `pkgContextInfo.json`
   （`StageContext::SetPkgContextInfo` 要求 `-ljPath` 路径里含 `loader.json` 字样，同目录找 `pkgContextInfo.json`）。
   `loader.json` 必须有 `modulePathMap` / `harNameOhmMap` / `projectRootPath` / `hspResourcesMap`，缺一即
   `Don't find some necessary node in loader.json`。

4. **页面按 FA 方式找 `pages/Setup.abc`** → `page_router_manager is creating page ... path: pages/Setup.js`
   → `find asset failed: pages/Setup.abc`。根因是 `module.json` **没有 `module.compileMode`**，
   引擎 `InitializeAppInfo()` 读到空 → 不启用 esmodule 加载路径。补 `"compileMode":"esmodule"` 后好转。

5. **`Cannot find module '...' which is application Entry Point`** → **记录名不匹配**，见 §1.1。

6. **`Input file is not esmodule`** → es2abc 清单里模块类型要写 **`esm`**（原先写的是 `commonjs`）。

7. 六条全过之后：`ExecuteModuleBuffer` → 成功 → **首帧 111,286 B（有内容）**。
   骤冷对照：修好前首帧**恒为 40,651 B 纯白**。

---

## 5. `build.sh` 现在做了什么（四条修复，都已固化）

| 位置 | 改动 |
|---|---|
| `gen_module_json.js` | `module.compileMode = "esmodule"`、`module.packageName = <module.name>`（缺则补） |
| `make_abc_list.js` | 记录名 = `<bundleName>&<模块名>/src/main/ets/<rel>&<versionName>`；模块类型 `commonjs` → **`esm`** |
| 新增（步骤 4） | 生成 `pkgContextInfo.json` 并放进 stage |
| 步骤 5 | 打包加了 `--pkg-context-path <stage/pkgContextInfo.json>` |
| 新增（步骤 8） | `tools/preview-smoke.js` —— **运行期自检，不过就不出包** |

`--pkg-context-path` 这个参数名不是文档里写的，是从
`app_packing_tool.jar` 的 `CommandParser.class` 里挖出来的（解包 jar 搜字符串）。

**没有改动 `harmonyos/` 里任何 ArkTS 源码** —— 四处全是构建配置层面的事。

---

## 6. 还差什么（诚实清单）

1. **`pages/Index`（全屏 ArkWeb 壳）验不了 —— 而且它在预览器里注定白屏。**
   `Index.ets` 第 54 行是**字段初始化器**：

   ```ts
   import { webview } from '@kit.ArkWeb';
   private controller: webview.WebviewController = new webview.WebviewController();
   ```

   而 **Previewer 里根本没有 ArkWeb 模块**（`@kit.ArkWeb` 是 undefined），一构造就抛：

   ```
   Throw error: Cannot read property WebviewController of undefined
   TypeError: Cannot read property WebviewController of undefined
   ```

   ⇒ 那是**预览器的能力边界，不是构建缺陷**。
   **别因为"Index 白屏"去调构建参数，会白折腾。**
   Index 只能在真机 / 模拟器上验。

2. **真机从未验证过。** 手头没有纯血鸿蒙设备；
   `hdc` 有（`<SDK>/tc/toolchains/hdc.exe`），但没镜像/设备。
   路线 B（OpenHarmony QEMU x86_64 镜像）**没试**。

3. 因此：**配置页能起 ≠ 客户端能用。**
   这个 App 的**全部 UI 都在那个还没验过的 Web 壳里**。
   发布产物时必须带上这句话。

---

## 7. 怎么判定"跑通了"

| 级别 | 标准 | 现状 |
|---|---|---|
| 能构建 | `build.sh` 出签名 HAP，`verify-app` success | ✅ |
| **运行时接受** | Previewer 能加载 `modules.abc` 并渲染出 ArkUI 页面 | ✅ **pages/Setup** |
| 主界面可用 | **Web 壳渲染出电脑端页面** | ❌ 预览器验不了（缺 ArkWeb） |
| 真机可用 | `hdc install` 后启动、配置、看到页面、收到推送 | ❌ 无设备 |

截图存 `docs/images/`，命名 `screenshot-harmonyos-*.png`。

---

## 8. 附：产物清单

| 文件 | 说明 |
|---|---|
| `build/stage/smoke-frame.jpg` | **运行期自检截到的首帧**（Setup 页，构建产物，不进仓库） |
| `tools/preview-smoke.js` | ★ 运行期自检：解包布局 + 起 Previewer + 抓帧 + 判定（零依赖） |
| `run-artifacts/setup-screen.jpg` | 最早手工攻关时那张成功截图（与本文件的 smoke-frame 逐字节相同） |
| `run-artifacts/rebuild-abc.js` | 当时用来「按指定记录名重建 abc」的一次性脚本（现已固化进 `build.sh`） |
| `run-artifacts/preview-harness.js` | 当时的手工抓帧脚本（已被 `tools/preview-smoke.js` 取代） |
| `run-artifacts/loader.json` / `pkgContextInfo.json` | 运行期解析配置样本 |
