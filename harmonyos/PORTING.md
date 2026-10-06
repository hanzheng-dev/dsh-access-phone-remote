# 安卓 → 鸿蒙 移植对照表

> **本工程未编译、未运行验证**（本机没有鸿蒙 SDK）。下表「状态」是**代码对照/API 对齐**的结论，
> 不代表能在设备上跑通。凡 API 拿不准处，源码里都写了 `// ⚠️ 待验证`。
>
> 安卓行号基于 `android/src/io/github/hanzhengdev/phoneaccess/` 下这几个文件当前版本。

| # | 能力 | 安卓实现（文件:行） | 鸿蒙对应 | 鸿蒙 API | 文档 URL | 状态 |
|---|---|---|---|---|---|---|
| 1 | 全屏 Web 壳 | `MainActivity.java:1123`（startMain） | `entry/.../pages/Index.ets` | `Web` 组件 + `webview.WebviewController` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web | 已对照实现 |
| 2 | 首次配置页 | `MainActivity.java:969`（buildConfigView）/ `:1084`（submitConfig） | `pages/Setup.ets` | `TextInput` + `@ohos.data.preferences` | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/app-configuration-file | 已对照实现 |
| 3 | 地址容错解析 | `MainActivity.java:951`（parseConfig） | `common/Store.ets`（parseConfig） | 纯字符串解析 | — | 已对照实现 |
| 4 | JS 桥 `DsNative` | `MainActivity.java:181`（DsNative 内部类） | `bridge/DsNative.ets` + `bridge/NativeOps.ets` | `.javaScriptProxy({object,name,methodList,controller})` | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/web-in-page-app-function-invoking | 已对照实现 |
| 5 | 拍照 | `MainActivity.java:402`（startCamera）/`:782`（handleImage） | `NativeOps.takePhoto()` | `@ohos.multimedia.cameraPicker.pick` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-cameraPicker | 已对照实现（⚠️ 未编译：`saveUri`/`PickerResult` 字段待核） |
| 6 | 相册选择 | `MainActivity.java:457`（startPicker） | `NativeOps.pickPhoto()` | `photoAccessHelper.PhotoViewPicker` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-photoAccessHelper | 已对照实现（⚠️ 未编译：`file://media/…` 能否 `fs.openSync` 待核） |
| 7 | 上传 + 推送 | `MainActivity.java:813`（sendToHub）/`:827`（uploadBytes）/`:861`（pushImage） | `NativeOps.uploadAndPush()` + `common/Http.ets` | `@ohos.net.http`（multipart，手写 boundary） | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-http | 已对照实现 |
| 8 | 定位（按需） | `MainActivity.java:487`（requestLocation）/`:504`（startLocating）/`:594`（postLocation） | `NativeOps.getLocation()` | `@ohos.geoLocationManager.getCurrentLocation` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-geoLocationManager | 已对照实现（⚠️ 未编译：权限/枚举名与后台定位策略待核） |
| 9 | WGS84→GCJ02 | `MainActivity.java:670-703` | `NativeOps.wgs84ToGcj02()` | 纯算法 | — | 已对照实现 |
| 10 | 用地图打开 / 导航 | `MainActivity.java:629`（startGeo）/`:645`（startNav） | `NativeOps.openGeo()/openNav()` | `Want{action:viewData, uri, entities}` + `context.startAbility` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-app-ability-want | **部分**（⚠️ 鸿蒙没有统一的 `geo:` / `androidamap://` 约定，能否唤起地图 App 取决于装机应用，需实测） |
| 11 | 状态栏图标黑白同步 | `MainActivity.java:99`（EDGE_JS）/`:385`（applyBarIcons） | `Index.ets`（EDGE_JS）+ `NativeOps.setBarIcons()` | `window.setWindowSystemBarProperties` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-window-Window | **部分**（⚠️ 逻辑照搬，颜色映射是否生效需实测） |
| 12 | 全屏/沉浸式 | `MainActivity.java:357`（setupEdgeToEdge） | `EntryAbility.ets` | `window.setWindowLayoutFullScreen(true)` | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/window-immersive | 已对照实现 |
| 13 | SSE 长连接 + 系统通知 | `NotifyService.java`（整篇） | `service/NotifyService.ets` | `http.requestInStream` + `@ohos.notificationManager` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-http | 已对照实现（⚠️ 未编译） |
| 14 | 后台保活 | `AndroidManifest.xml:76`（foregroundServiceType=dataSync）+ `NotifyService.java:143`（startForeground） | `NotifyService.begin()` | `@ohos.resourceschedule.backgroundTaskManager.startBackgroundRunning(context, BackgroundMode.DATA_TRANSFER, wantAgent)` | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/continuous-task | **部分**（⚠️ 鸿蒙 `ServiceExtensionAbility` 只对系统应用开放，三方应用只能用长时任务；DATA_TRANSFER「10 分钟不更新进度会被取消」是否影响本用法未验证） |
| 15 | 断线补发 | `NotifyService.java:426`（catchUpMissed） | `NotifyService.catchUpMissed()` | `http.request` GET `/api/inbox?since=` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-http | 已对照实现 |
| 16 | 心跳看门狗 / 最长寿命 | `NotifyService.java:93-106`、`:403`（beatLoop） | `NotifyService.beatTick()` | `setInterval` + `HttpRequest.destroy()` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-http | 已对照实现 |
| 17 | 分级提示（alert/normal/silent） | `NotifyService.java:335`（isSunflower）/`:357`（levelOf） | `NotifyService.levelOf()` | 同安卓逻辑 | — | 已对照实现 |
| 18 | 通知渠道 | `NotifyService.java:182`（createChannels） | `common/Notify.ets` | `notificationManager.addSlot(SlotType.…)`（用系统渠道类型，非自建渠道） | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-notificationManager | **部分**（⚠️ `SOCIAL_COMMUNICATION` 是否确实弹横幅+震动取决于系统/权限） |
| 19 | 通知权限申请 | `MainActivity.java:1208` | `Notify.init()` | `notificationManager.requestEnableNotification(context)` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-notificationManager | 已对照实现 |
| 20 | 网页浮层 | `WebActivity.java`（整篇） | `pages/WebOverlay.ets` | `Web` 组件（独立页面）+ 圆角卡片 + 遮罩 | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web | 已对照实现 |
| 21 | 浮层 Cookie 持久 | `WebActivity.java:451` | `WebOverlay.aboutToAppear()` | `webview.WebCookieManager.putAcceptCookieEnabled` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-webview-WebCookieManager | 已对照实现 |
| 22 | 浮层默认首页（搜索+2 快捷） | `WebActivity.java:146`（HOME_HTML） | `WebOverlay.HOME_HTML` | `WebviewController.loadData` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-apis-webview-WebviewController | 已对照实现 |
| 23 | `target=_blank` / `window.open` | `WebActivity.java:252`（onCreateWindow） | `Index.onWindowNew` | `Web.onWindowNew` + `ControllerHandler.setWebController(null)` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web-events | 已对照实现 |
| 24 | `<input type=file>` | `MainActivity.java:161`（onShowFileChooser）/`:705` | `Index.onShowFileSelector` | `Web.onShowFileSelector` + `picker.DocumentViewPicker` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/arkts-basic-components-web-events | **部分**（⚠️ 用文档选择器代替安卓的 `FileChooserParams.createIntent`，行为不完全一致） |
| 25 | 接收电脑推来的文件 | `FileReceiver.java` | `common/FileReceiver.ets` | `http.request(ARRAY_BUFFER)` + `@ohos.file.fs` | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-file-fs | **部分**（⚠️ 只存**应用沙箱**，不能写公共相册/下载；点通知打开 App 而非打开文件） |
| 26 | 文件通知可点开 | `FileReceiver.java:319`（notifyDone）/`:369`（openPending） | `FileReceiver` → `Notify.publish` | `notificationManager.publish`（无文件打开 wantAgent） | https://developer.huawei.com/consumer/cn/doc/harmonyos-references/js-apis-notificationManager | **部分**（点击只回到 App；未做 `fileUri` + `viewData` 打开文件） |
| 27 | 重新配置入口 | `MainActivity.java:1239`（onKeyDown MENU）/`:214`（reconfigure 桥） | `NativeOps.reconfigure()` + 主页「⚙ 配置」 | `router.pushUrl('pages/Setup')` | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/arkts-routing | 已对照实现 |
| 28 | 开机自启 | `BootReceiver.java` | — | 静态订阅（`staticSubscriber`） | https://developer.huawei.com/consumer/cn/doc/harmonyos-guides/common-event-static-subscription | **未做**：官方文档标题即「静态订阅公共事件（仅对系统应用开放）」，**三方应用拿不到 BOOT_COMPLETED**，无法移植 |
| 29 | 浮层 WebView 预热 | `WebActivity.java:68-131`（preheat/takeWarm） | — | — | — | **未做**：鸿蒙页面冷启动短，且没有等价的「常驻 WebView 复用」模型；如需可后续优化 |
| 30 | 老设备菜单键 | `MainActivity.java:1239` | — | — | — | **未做**：鸿蒙手机没有实体菜单键，无对应入口 |

## 一句话总结

- **已对照实现**：Web 壳、配置页、JS 桥（8 个方法名与参数逐个对齐）、拍照/相册/上传、定位与 GCJ02、SSE 长连接 + 统一通知 + 断线补发 + 心跳看门狗、网页浮层与 Cookie、`target=_blank`、`<input type=file>`（部分）、状态栏同步（部分）。
- **部分**：地图/导航（鸿蒙无统一 scheme）、后台保活（只能用长时任务，非系统 Service）、文件落盘（只能沙箱）、通知渠道（用系统渠道类型）。
- **未做**：开机自启（系统应用专属）、浮层预热、菜单键入口。

## 最大的两个结构性差异（务必先知道）

1. **后台服务**：安卓 `ServiceExtensionAbility` 等价物（`type: "service"`）**仅系统应用可用**；三方应用做常驻长期连接只能用**长时任务**（`backgroundTaskManager`，通知栏会挂一条与任务绑定的通知，用户删掉它任务即停）。本工程已按长时任务实现，但该用法在 DATA_TRANSFER 类型下是否会被系统判为「进度长期不更新」而取消，**未验证**。
2. **开机自启**：鸿蒙的静态订阅（拿 `BOOT_COMPLETED`）**只对系统应用开放**，三方应用做不到，故 `BootReceiver` 未移植。
