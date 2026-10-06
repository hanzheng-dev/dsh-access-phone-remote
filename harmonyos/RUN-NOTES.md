# RUN-NOTES —— 把鸿蒙产物真的跑起来

> 记录时间：2026-10-07 凌晨
> 机器：Windows 11 / pwsh / Git Bash
> 结论：**跑起来了，看到了界面。**
> 走通的是**路径 A（SDK 自带 Previewer）**，没有下 QEMU、没装 DevEco、没登华为账号。

---

## 0. 一句话结论

`D:\dsj-open\harmonyos\entry-default-signed.hap` 里的 `ets/modules.abc`
**原样喂给 Previewer 跑不起来**（页面记录名对不上）；在**不动任何源码**的前提下，
把同一个工程的 JS 产物用 es2abc **按正确的记录名格式重新生成 `modules.abc`**
（外加几处运行期配置），Previewer 就**成功渲染出了 App 的 ArkUI 界面**：

- 截图：`D:\dsj-open\harmonyos\run-artifacts\setup-screen.jpg`
- 界面内容（MiMo 识图逐字读出）：标题 `dsh-access-phone-remote`、
  副标题 `第一次使用，请填电脑地址`、输入框（占位 `粘贴完整地址`）、
  说明文字、橙色按钮 `连 接` —— 就是 `entry/src/main/ets/pages/Setup.ets` 那一页。

> 说明：能跑的是**用同一份源码重新产出的 `modules.abc`**。原 HAP 的 `modules.abc`
> 与它的差别**只在记录名/模块类型**，字节码逻辑是同一份。原 HAP 直接跑会失败，
> 原因与修法见 §5、§6。

---

## 1. 路径 A 的完整启动姿势（原样可复制）

Previewer 不是加载 HAP，而是加载一个**已解包的 app 目录** + 一个**资源目录**，
并通过 WebSocket 把渲染帧发出来。它至少需要：

```
-j <app目录>     （必须存在；里面直接放 modules.abc）
-or <宽> <高>    原始分辨率（两个参数）
-cr <宽> <高>    压缩分辨率（两个参数）
-url <页面>      如 pages/Setup
```

其余可选但强烈建议的：

```
-device phone -shape rect -cm light -av ACE_2_0 -o portrait -sd 480 -l zh_CN
-pm Stage -projectID ohprev -n <bundleName>
-arp <资源目录>     含 module.json / resources.index / resources/
-pages main_pages   注意：只能填 profile 名，填 Windows 绝对路径会被正则拒绝（退出码 11）
-s <命名管道名>     本地命令通道（不填会每 2ms 刷 "socket is null"，可用 Node 建管道喂它）
-lws <端口>        WebSocket 图像通道监听端口
-sid <16位hex>     图像通道路径校验用的会话 id
-ljPath <loader.json>  ohmurl/多包解析链
```

### 1.1 我实际用的目录布局（`D:\temp\ohos-try\`）

```
app/                      ← -j 指向这里
  modules.abc             ← 必须是这个名字、放在根（Stage 非卡片模型不会去 app/ets 找）
res/                      ← -arp 指向这里
  module.json             ← 由 HAP 解包得到，另补了 module.compileMode="esmodule"、module.packageName="entry"
  resources.index
  resources/base/...
lj/
  loader.json             ← modulePathMap/harNameOhmMap/projectRootPath/hspResourcesMap 四个键缺一不可
  pkgContextInfo.json     ← {"entry":{packageName,bundleName,moduleName,version,compileMode,...}}
```

### 1.2 一条命令

```powershell
$BIN = 'D:\ohos\sdk\previewer\previewer\common\bin\Previewer.exe'
$T   = 'D:\temp\ohos-try'
& $BIN -device phone -shape rect -or 1080 2340 -cr 1080 2340 `
  -j "$T\app" -n io.github.hanzhengdev.phoneaccess -url pages/Setup `
  -s ohprev_test -lws 10565 -sid a1b2c3d4e5f60718 `
  -pm Stage -projectID ohprev -arp "$T\res" -ljPath "$T\lj\loader.json" `
  -pages main_pages -l zh_CN -o portrait -cm light -av ACE_2_0 -sd 480
```

### 1.3 怎么看界面（Previewer 自己不开窗口）

`InitGlfwEnv` 里 `CreateGlfwWindow(w,h,false)` 第三参为 `false`，**不开可见窗口**；
它把帧通过 WebSocket 发出去（`ws://127.0.0.1:<lws>/<sid>`，路径必须等于 `-sid`，否则握手中断）。
帧格式：**40 字节头 + 完整 JPEG**：

```
偏移 0  : 0x12345678（headStart，小端）
偏移 4  : origWidth    (0x438 = 1080)
偏移 8  : origHeight   (0x924 = 2340)
偏移 12 : compWidth
偏移 16 : compHeight
偏移 20~39: 0（全屏刷新 region 全 0）
偏移 40 : ff d8 ff ... JPEG ... ff d9
```

用 Node 24 自带的全局 `WebSocket` 就能收帧存图，见
`run-artifacts\preview-harness.js`（它同时用 `net` 建 `\\.\pipe\ohprev_test`
当本地命令通道，省掉 "socket is null" 刷屏）。

```powershell
node D:\dsj-open\harmonyos\run-artifacts\preview-harness.js 10565 D:\temp\ohos-try\app 25 pages/Setup
# 输出目录会落 frame1.bin；取其中 ff d8..ff d9 段即 JPEG
```

---

## 2. 我先把 Previewer 的参数摸清了（它没写文档）

`Previewer.exe` 的二进制里**没有**明文参数表，但报错会带参数名。
上游开源在 `openharmony/ide_previewer` 的 `util/CommandParser.cpp`（我下了源码对照）。
关键事实：

- `-j` 必填且必须是**已存在目录**；`-or`+`-cr` 必填；`-url` 必填且非空。
- `-pages` 走 `regex4Str = ^[a-zA-Z0-9-_./\s]+$` ⇒ **Windows 路径里的 `:`/`\` 会被拒**，
  传 `main_pages`（profile 名）即可（传绝对路径直接退出码 11）。
- `-or/-cr` 单边上限 3840。
- `-device` 支持 `phone/tablet/tv/car/2in1/wearable/default/liteWearable/smartVision`。
- `-s` 是**命名管道名**（Previewer 作为 client 连 `\\.\pipe\名字`，缺了不致命，只刷错误）。

DevEco 实际 spawn 的完整开关（对照 `ohosvscode/previewer-frontend` 的 `launcher.rs`）：
`-device -shape -or -cr -j -n -url -s -lws -sid -pm -projectID -arp -pages -ljPath -hsp`，
调试模式再加 `-d -p -abn -abp`。

---

## 3. 逐层卡点（这是最有价值的部分）

按顺序撞到的墙，以及每层怎么过的：

1. **没参数** → `[ERROR][CommandParser.cpp][IsAppPathValid] Launch -j parameters abnormal!`
   → 补 `-j/-or/-cr/-url` 过。

2. **`-j` 目录形态不对**：先把 `modules.abc` 放在 `app/` 根，**崩溃**（`0xc0000005` JS 引擎 AV）。
   上游 `ace_ability.cpp:InitEnv()` 把 asset 路径设为 `[assetPath, appResourcesPath, ...]`，
   Stage 非卡片**不加 `assetPath/ets`**，所以 `modules.abc` 就该在 `-j` 根目录。
   （另：之前那次崩可能是缺 `compileMode` 走了 FA 分支，见下。）

3. **`loader.json not found`** → 补 `-ljPath` + 同目录 `pkgContextInfo.json`
   （`StageContext::SetPkgContextInfo` 要求 `-ljPath` 的路径里含 `loader.json` 字样，
   同目录找 `pkgContextInfo.json`）。
   `loader.json` 必须有 `modulePathMap`/`harNameOhmMap`/`projectRootPath`/`hspResourcesMap`，
   缺一即 `Don't find some necessary node in loader.json`。

4. **页面按 FA 方式找 `pages/Setup.abc`**：
   `page_router_manager is creating page ... path: pages/Setup.js` → `find asset failed: pages/Setup.abc`。
   根因：`entry/src/main/module.json` **没有 `module.compileMode`**，
   引擎 `InitializeAppInfo()` 读到空/默认 → 不启用 esmodule 加载路径。
   补 `"compileMode":"esmodule"` 后，引擎改去找 `modules.abc`（好转）。

5. **`Cannot find module 'ets/pages/Setup' , which is application Entry Point`**：
   补了 `pkgContextInfo` 后变成
   `Cannot find module 'entry&entry/src/main/ets/pages/Setup&1.0.0'`。
   这是**记录名不匹配** —— 手搓 `modules.abc` 的记录名是 `entry/ets/pages/Setup`，
   而运行时要的是**归一化 ohmurl 记录名** `<包名>&<模块内完整路径>&<版本>`。

6. **`Input file is not esmodule`**：es2abc 清单里模块类型字段要写 **`esm`**（HAP 那份写的是 `commonjs`）。

7. 六条全过之后：`ExecuteModuleBuffer filename pages/Setup.abc` → 成功 → **首帧 111 KB（有内容）**。
   骤冷对照：修好前首帧恒为 40651 字节纯白。

---

## 4. 根因总结（手搓 HAP 为什么跑不起来）

`build.sh` 用的是 **ets-loader 的 webpack 后端**，它**不产生 esmodule 的记录名**；
而 `gen_abc_plugin.js`（rollup/hvigor 路径）里记录名是这么来的：

```js
this.recordName = getOhmUrlByFilepath(filePath, projectConfig, logger)   // ark_utils.js
```

`build.sh` 的 `make_abc_list.js` 自己拼了 `entry/ets/<rel>` 当记录名，
**既不是 `@bundle:` ohmurl，也不是归一化 ohmurl**。运行时（`libark_jsruntime.dll`）
用 ohmurl/归一化名去 `modules.abc` 里找记录，找不到 → "Entry Point" 报错。
再叠加 `module.json` 缺 `compileMode`、es2abc 模块类型写了 `commonjs` 两处。

也就是说：**`verify-app` 通过只证明「文件格式合法+签名有效」，不证明运行时会接受；
手搓的 `modules.abc` 记录名格式真的不对。**

---

## 5. 改了 `harmonyos/` 里的什么？

- **没有改动 `harmonyos/` 里任何已有源码**。
- 构建与实验全在副本 `D:\temp\ohos-try\proj` 里做（`robocopy /E`，排除 `build`）。
- 只在 `D:\dsj-open\harmonyos\` 下**新增**了：
  - `RUN-NOTES.md`（本文）
  - `run-artifacts\`（截图 + 复现脚本 + loader.json/pkgContextInfo.json）
- `entry-default-signed.hap` 原文件**未被覆盖**（副本里另生成了一份，产物字节数一致 133716）。

---

## 6. 还差什么 / 建议怎么修

要让**原 HAP 或新构建的 HAP 直接能跑**，需要动 `build.sh` 的构建方式（我没擅自改，列在这里）：

1. **记录名**：`modules.abc` 里每条记录名改成运行时期望的归一化 ohmurl 记录名
   `<包名>&<模块内完整路径>&<版本>`（实测形如 `entry&entry/src/main/ets/pages/Setup&1.0.0`）。
   正规做法是复用 `ets-loader/lib/ark_utils.js` 的
   `getNormalizedOhmUrlByFilepath` / `getOhmUrlByFilepath`，而不是手拼；
   或者干脆改走 **rollup 后端**（`previewer-frontend` 与 DevEco 都走它，能自动生成正确记录名）。
2. **es2abc 清单模块类型**：`commonjs` → `esm`（对 `src/main/ets/**` 的源文件）。
3. **`entry/src/main/module.json5`**：补 `module.compileMode = "esmodule"`（打包产物里要有）。
4. 加 `loader.json` + `pkgContextInfo.json`（多包/ohModule 解析；单模块也建议给）。
5. 真机侧：还要做**真机验证**（本次只到 Previewer；没连鸿蒙设备）。
   `hdc` 有，但没镜像/设备，路径 B（OpenHarmony QEMU x86_64）未尝试。

一句话：**「能不能跑」已经变成「能」** —— 前提是 `modules.abc` 记录名按 ohmurl 规范生成；
剩下的就是把上面 5 条固化进 `build.sh` 并上真机复验。

---

## 7. 附：产物清单

| 文件 | 说明 |
|---|---|
| `run-artifacts\setup-screen.jpg` | **成功渲染的界面截图**（Setup 页） |
| `run-artifacts\index-screen.jpg` | `pages/Index` 的帧（Web 壳，无网络=白屏，符合预期） |
| `run-artifacts\preview-harness.js` | 起命名管道 + spawn Previewer + 抓 WS 帧 |
| `run-artifacts\rebuild-abc.js` | 用指定记录名模板从 JS 重建 `modules.abc` |
| `run-artifacts\loader.json` / `pkgContextInfo.json` | 运行期解析配置 |
