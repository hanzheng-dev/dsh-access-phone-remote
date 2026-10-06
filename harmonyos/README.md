# dsh-access-phone-remote · HarmonyOS 客户端

鸿蒙 HarmonyOS（Stage 模型）薄壳客户端：**全屏 ArkWeb 壳 + 原生能力桥 + SSE 推送长连接**，
是安卓客户端 `android/` 的移植版。UI 仍全部在电脑端网页（`public/index.html`）。

---

## 一、这份源码的状态（先看这里）

> **未编译、未运行、未验证。**
>
> 写这份源码的机器上**还没有鸿蒙 SDK**（主人正在别处下，约 3.15 GB，尚未就绪），
> 所以这里**一行 ArkTS 都没被编译过**，也没在真机/模拟器上跑过。
>
> 能做到的「准确」只到这一步：
> - 需要对照的**安卓行为**逐条读过源码（`android/src/...`），能力清单见 `PORTING.md`；
> - 用到的鸿蒙 API **尽量查了官方文档**并在源码注释里写了文档 URL；
> - 凡**拿不准**的地方，源码里都标了 `// ⚠️ 待验证：<不确定什么>`，并在下面「已知的未知项」汇总。
>
> 请把它当作**一份待编译的骨架**，别当作已验证的成品。

---

## 二、怎么把它跑起来

### 方式 A：DevEco Studio（推荐）

1. 安装 **DevEco Studio**（含 SDK Manager / hvigor）：
   https://developer.huawei.com/consumer/cn/download/
2. 首次启动按向导装 **HarmonyOS SDK**（SDK Manager → 勾选对应 API 版本）。
3. `File > Open` 打开本目录 `harmonyos/`，等待同步（会自动补 `hvigorw` 等 wrapper）。
4. 打开 `build-profile.json5`，把 `compatibleSdkVersion` / `runtimeOS` 改成**你实际装的 SDK 版本**
   （当前填的是 `5.0.0(12)`，见文件内注释）。
5. **签名**：`File > Project Structure > Signing Configs` → 勾「Automatically generate signature」，
   需要**登录华为开发者账号**（没有账号则只能在预览器/模拟器上跑，装真机必须签名）。
6. 连真机（开 USB 调试）或启动模拟器 → 点运行。或 `Build > Build HAP(s)/APP(s) > Build HAP(s)`。

### 方式 B：命令行（hvigorw）

```bash
# 在 harmonyos/ 目录下（首次需先用 DevEco 打开一次，生成 hvigor/ 与 hvigorw）
./hvigorw --mode module -p product=default assembleHap      # ⚠️ 待验证：参数名以你本机 hvigor 版本为准
```

- 产物通常在 `entry/build/default/outputs/default/entry-default-signed.hap`。
- ⚠️ 命令行签名同样要配好签名证书（`build-profile.json5 > signingConfigs`），
  或直接用 DevEco 的自动签名。
- 不使用 DevEco、只装 SDK + hvigor 的纯命令行方式**未在本机验证过**，以官方文档为准：
  https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/ide-hvigor

### 安装到手机

装好后首次启动会进「配置页」，把电脑上的完整地址粘进去（形如 `http://192.168.1.100:3099/?t=xxxx`）。

---

## 三、目录结构

```
harmonyos/
├── build-profile.json5          工程构建配置（⚠️ compatibleSdkVersion 要改成你的 SDK 版本）
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

2. **`compatibleSdkVersion` / `modelVersion`**：当前按 API 12（`5.0.0(12)`）填，
   必须与你实际安装的 SDK 一致，否则 hvigor 直接报版本错。

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
