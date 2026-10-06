# dsh-access-phone-remote · HarmonyOS 客户端

鸿蒙 HarmonyOS（Stage 模型）薄壳客户端：**全屏 ArkWeb 壳 + 原生能力桥 + SSE 推送长连接**，
是安卓客户端 `android/` 的移植版。UI 仍全部在电脑端网页（`public/index.html`）。

---

## 一、这份源码的状态（先看这里）

> **已构建、已签名、验签通过 —— 但还没在任何设备上跑起来过。**
>
> | 环节 | 状态 |
> |---|---|
> | ArkTS 编译（`ets-loader` + `es2abc`） | ✅ 通过，产出合法字节码（`.abc` 头是 `PANDA`） |
> | 资源编译（`restool`）+ 打包（`app_packing_tool`） | ✅ 通过 |
> | 签名（`hap-sign-tool`，社区证书） | ✅ 通过，产物 133,716 B |
> | 验签（`verify-app`） | ✅ success |
> | **装到真机 / 模拟器上启动** | ❌ **没做过** |
>
> 所以：**构建链是通的，运行时接受度未知。**
> 已知的具体风险：`ets/modules.abc` 是由 4 个 webpack bundle 用 `--merge-abc`
> 合并成 4 个 record 的，**这种"多 record 单文件"能不能被 ArkTS 运行时正常加载，没验证过**。
> 这也是**没有发布预编译 HAP** 的原因 —— 见 `RUN-NOTES.md`（要跑起来的过程与结论都记在那里）。
>
> 另外，源码里有两条「准确度」线索可以帮你判读：
> - 需要对照的**安卓行为**逐条读过源码（`android/src/...`），能力清单见 `PORTING.md`；
> - 凡**拿不准**的地方，源码里都标了 `// ⚠️ 待验证：<不确定什么>`，并在下面「已知的未知项」汇总。

---

## 二、怎么把它跑起来

### 方式 A：命令行（`build.sh`，**不需要 IDE、不需要华为账号**）

这是本工程**实际用来出包**的方式。**全部工具都在公开 SDK 里**，匿名可下载：

```bash
# 1. 装 OpenHarmony SDK（3.15 GB，公开镜像，无需登录）
curl -O https://repo.huaweicloud.com/openharmony/os/7.0-Release/ohos-sdk-windows_linux-public.tar.gz
tar -xzf ohos-sdk-windows_linux-public.tar.gz -C D:/ohos        # 得到 D:/ohos/sdk

# 2. 出包（在 harmonyos/ 目录下）。⚠️ 要在 Git Bash 里跑 —— 脚本用 cygpath 转路径
bash build.sh
```

**依赖**：`node`、`java`（JDK，含 `keytool`）、以及 **Git Bash**（`cygpath`）。
SDK 里自带的 `node_modules` 够用，**不需要 `npm install`**。

**环境变量**（都可覆盖）：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `OHOS_SDK` | `D:/ohos/sdk` | 鸿蒙 SDK 根目录 |
| `WORK` | `./build` | 临时工作目录 |
| `OHOS_KEYSTORE_PASS` | `123456` | 社区签名库口令 |

**产物**：`harmonyos/entry-default-signed.hap`（gitignore 了，得自己构建）。

**签名用的是社区证书，不需要华为账号**：`OpenHarmony.p12`（口令就是公开的 `123456`）
+ `OpenHarmonyProfileRelease.pem` + `UnsgnedReleasedProfileTemplate.json`，三样都随 SDK 分发。

**流水线**（`build.sh` 里的 7 步，每一层都是公开工具；`hvigor` 只是个编排器）：

```
.ets ──ets-loader──► JS ──es2abc --merge-abc──► modules.abc ──┐
resources ──restool──► resources.index ───────────────────────┼─app_packing_tool.jar─► 未签名 .hap
                                                              ┘        └─hap-sign-tool.jar─► 签名 .hap
                                                                                └─verify-app─► success
```

**⚠️ 两个实测坑**（详见 `BUILD-NOTES.md`）：

- `es2abc` **只吃纯 JS**，喂带类型注解的 `.ets` 会直接 `SyntaxError` ——
  **类型剥离是 `ets-loader` 干的**，顺序别搞反。
- `@ohos/hvigor` 在**任何公开仓库都是 404**（npm 官方源 / 华为云 npm 镜像 / ohpm 官方仓库都查过），
  它只随 DevEco 分发。**所以别去找它，直接手搓链** —— 这正是 `build.sh` 在做的事。

### 方式 B：DevEco Studio（可选，但**要登录华为账号**）

只有你想要图形化预览器 / 调试器时才需要它：

1. 安装 DevEco Studio（含 SDK Manager / hvigor）：
   https://developer.huawei.com/consumer/cn/download/ —— **下载即需登录华为开发者账号**。
2. `File > Open` 打开本目录 `harmonyos/`，等待同步（会自动补 `hvigorw` 等 wrapper）。
3. 签名：`File > Project Structure > Signing Configs` → 勾「Automatically generate signature」，
   同样要账号。
4. 连真机（开 USB 调试）或启动模拟器 → 点运行。或 `Build > Build HAP(s)`。

> **别装 `winget` 上那个 `Huawei.DevEco`** —— 版本 `3.1.0.501` 是 2023 年的，
> 面向老鸿蒙（HarmonyOS 3.x，还兼容安卓 APK），**打不了纯血鸿蒙的 HAP**，白占几 GB。

### 安装到手机

```bash
# hdc 随 SDK 分发：<SDK>/tc/toolchains/hdc.exe
hdc install entry-default-signed.hap
```

装好后首次启动会进「配置页」，把电脑上的完整地址粘进去（形如 `http://192.168.1.100:3099/?t=xxxx`）。

---

## 三、目录结构

```
harmonyos/
├── build.sh                     ★ 手工构建链（方式 A）：ets-loader → es2abc → restool → 打包 → 签名，共 7 步
├── BUILD-NOTES.md               构建链的实测记录（每步产物长什么样、踩过哪些坑）
├── RUN-NOTES.md                 「想让它跑起来」的记录：预览器 / 模拟器试到哪一步、卡在哪
├── build-profile.json5          工程构建配置（**只给 hvigor / DevEco 用，build.sh 不读它**）
├── oh-package.json5             工程依赖
├── hvigorfile.ts                工程级 hvigor 脚本
├── AppScope/
│   ├── app.json5                bundleName / 版本 / 图标 / 名称
│   └── resources/base/
│       ├── element/string.json
│       └── media/app_icon.png
├── entry/
│   ├── build-profile.json5
│   ├── hvigorfile.ts
│   ├── oh-package.json5
│   └── src/main/
│       ├── module.json5         权限 / 长时任务 / 入口 Ability
│       ├── resources/base/
│       │   ├── element/{string,color}.json
│       │   ├── media/app_icon.png
│       │   └── profile/main_pages.json
│       └── ets/
│           ├── entryability/EntryAbility.ets   入口：读配置 + 沉浸式 + 起长连接
│           ├── pages/Index.ets                 全屏 Web 壳（主界面）
│           ├── pages/Setup.ets                 首次配置页
│           ├── pages/WebOverlay.ets            内置网页浮层（独立 Web + Cookie 持久）
│           ├── service/NotifyService.ets       SSE 长连接 + 长时任务 + 断线补发 + 心跳
│           ├── bridge/DsNative.ets             JS 桥（方法名与安卓一致）
│           ├── bridge/NativeOps.ets            桥方法的具体实现
│           ├── bridge/NativeCtx.ets            桥用到的全局引用
│           └── common/
│               ├── Store.ets                   地址/口令存储与解析
│               ├── Http.ets                    原生 HTTP（GET/POST/multipart 上传）
│               ├── Notify.ets                  系统通知（分级）
│               └── FileReceiver.ets            接收电脑推来的文件
└── PORTING.md                   安卓 → 鸿蒙 逐条对照表（先读它）
```

---

## 四、已知的未知项（拿不准，请编译/实测时核对）

按风险从高到低：

1. **后台保活（最大不确定）**：鸿蒙三方应用不能用 `ServiceExtensionAbility`，
   本工程改用**长时任务** `backgroundTaskManager.startBackgroundRunning(..., BackgroundMode.DATA_TRANSFER, ...)`。
   官方对 DATA_TRANSFER 注明「进度长时间（>10 分钟）不更新会被取消」。这条是否会让「一直挂着收消息」被判失败，
   **没验证**。若被系统掐，替代路线是接入 **Push Kit**（云推送），但那要改电脑端。
   - 源码：`service/NotifyService.ets`；文档：https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/continuous-task

2. **`compatibleSdkVersion` / `modelVersion`**：只在**走 DevEco / hvigor** 时才要紧，必须与你装的 SDK 一致，
   否则 hvigor 直接报版本错。走 `build.sh` 的话它**不读 `build-profile.json5`**，
   SDK 版本只由 `OHOS_SDK` 指向哪个目录决定。

3. **相机 / 相册**：
   - 拍照用 `cameraPicker.pick` + `PickerProfile.saveUri`（写入应用沙箱文件）。
     `saveUri` 传 `fileUri.getUriFromPath(path)` 是否被接受、`PickerResult.resultCode==0` 判成功是否正确，**待验证**。
   - 相册返回的 `file://media/...` URI 直接用 `fs.openSync` 读取是否可行，**待验证**；
     不行则要改成 `photoAccessHelper.getAssets` 拿 fd。

4. **长时任务 API 重载**：`startBackgroundRunning` 有多个重载（单枚举 / `string[]` / `ContinuousTaskRequest`）。
   本工程用单枚举 `BackgroundMode.DATA_TRANSFER`；若你的 SDK 只认 `string[]`（`['dataTransfer']`）需改。
   `backgroundTaskManager.on/off('continuousTaskCancel')` 是 API 15+；低版本会走 catch 跳过。

5. **定位**：`geoLocationManager.SingleLocationRequest` 的字段（`locatingPriority` / `locatingTimeoutMs`）
   与枚举 `LocatingPriority.PRIORITY_ACCURACY` 按较新文档写；部分 SDK 用旧的
   `priority` / `timeoutMs` / `LocationRequestPriority.ACCURACY_PRIORITY`，需按你的 SDK 核对。

6. **地图 / 导航**：`openGeo` / `openNav` 用 `Want{action:'ohos.want.action.viewData', uri:'geo:…'}`
   / `'androidamap://…'` / `'baidumap://…'`。鸿蒙是否认这些 scheme、桌面是否装了对应地图 App，**待实测**。

7. **状态栏图标颜色**：`setBarIcons` 用 `window.setWindowSystemBarProperties({statusBarContentColor,...})`；
   页面侧 `EDGE_JS` 照搬安卓，注入与回调链路是否如预期，**待实测**。

8. **通知**：用系统渠道类型 `SlotType.SOCIAL_COMMUNICATION`（重要）/ `SERVICE_INFORMATION`（普通）
   代替安卓自建渠道；`NotificationRequest.content.normal` 结构与 `notificationSlotType` 字段名按文档写，**待验证**。
   弹横幅+震动同样受系统通知开关影响。

9. **接收文件**：只存**应用沙箱** `filesDir/dsh-access-phone-remote/`，**没写进系统相册/下载**，
   通知点击也只回到 App（不是打开文件）。要做成安卓那样需要 `photoAccessHelper` 写媒体库 + 申请权限，
   本次**未做**（见 `PORTING.md` #25/#26）。

10. **`getContext(this)`**：`Setup.ets` / `Index.ets` 用它取 UIAbilityContext，
    该接口在新版本已标记废弃（建议 `this.getUIContext().getHostContext()`），但通常仍可用。

11. **开机自启**：**明确做不到**。鸿蒙静态订阅（`staticSubscriber`）只对系统应用开放，
    三方应用拿不到 `BOOT_COMPLETED`，故未实现。

---

## 五、安全说明

- 口令只存在手机本地（`@ohos.data.preferences` 的应用私有目录），不经过任何第三方。
- 首次进站用 `/?t=口令` 换 Cookie；原生请求走 `X-Auth` 头。
- 本目录不含任何签名证书、密钥或口令。

## 六、和安卓端的一致性

网页侧调用的方法名必须与安卓完全一致，否则 `window.DsNative.*` 会静默失效。本工程注入的对象名统一为
`DsNative`，方法列表：`takePhoto / pickPhoto / openWeb / setBarIcons / getLocation / openGeo / openNav / reconfigure`
（对应 `android/src/io/github/hanzhengdev/phoneaccess/MainActivity.java` 的 `DsNative` 内部类）。
