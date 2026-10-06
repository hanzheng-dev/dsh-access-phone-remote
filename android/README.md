# dsh-access-phone-remote · Android 客户端

dsh-access-phone-remote 的安卓客户端：**全屏 WebView 套壳 + 原生增强**。

- 页面 UI 全在电脑端（改 UI 不用重装 APK）
- 首次启动填一次地址（含口令），之后自动连
- 原生增强：系统通知（SSE 长连接 + 断线补发）、拍照 / 相册直发、GPS 定位、
  网页浮层（带 Cookie）、真全屏状态栏适配、**接收电脑推来的文件（自动存相册/下载）**

> 服务端在仓库根目录（`node src/server.js`），本目录只是手机端。

---

## 一、构建（不需要 Android Studio / Gradle）

**平台**：Windows + Git Bash（本构建链用的是 `aapt2.exe` 等 Windows 工具）

### 前置清单

| # | 需要什么 | 用途 | 怎么装 |
|---|---|---|---|
| 1 | **JDK 17+** | `javac` / `java` / `keytool` | 装完确认 `keytool` 在 PATH（否则构建时用 `KEYTOOL=…` 指定） |
| 2 | **Node.js 18+** | 只跑 `make-icons.js` 生成图标 | https://nodejs.org |
| 3 | **7-Zip** | 把 `classes.dex` 塞进 APK | 装完确认 `7z` 在 PATH（或用 `SEVENZ=…` 指定） |
| 4 | **Android SDK** | `build-tools` + `platform` | 见下 |
| 5 | （可选）adb | 连着手机时构建完自动安装 | Android SDK platform-tools |

**Android SDK 获取**（只需两样东西，不用装整个 Studio）：

- 官网手动下载：
  - build-tools: https://developer.android.com/tools/releases/build-tools
  - platform: https://developer.android.com/tools/releases/platforms （取 android.jar，建议 API 33）
- 或用命令行 `sdkmanager`：

  ```bash
  sdkmanager "build-tools;34.0.0" "platforms;android-33"
  ```

### 构建

> ⚠️ `build.sh` **不内置 SDK 路径** —— 没设置会直接报错并提示怎么设置
> （或直接编辑脚本顶部的 `BT` / `AJAR` 两行）。

```bash
cd android

export ANDROID_BT=/c/sdk/build-tools/34.0.0        # build-tools 目录
export ANDROID_JAR=/c/sdk/platforms/android-33/android.jar
bash build.sh
```

也可以一行传进去：

```bash
ANDROID_BT=/c/sdk/build-tools/34.0.0 \
ANDROID_JAR=/c/sdk/platforms/android-33/android.jar \
bash build.sh
```

产物：

| 文件 | 说明 |
|---|---|
| `dsh-access-phone-remote.apk` | 装到手机的安装包（本目录下） |
| `dsjiang.keystore` | 首次构建自动生成的签名密钥（**别提交到仓库**；发正式版请换成自己的） |
| `build/` | 中间产物（可随时删） |

### 安装

```bash
adb install -r dsh-access-phone-remote.apk
```

或者把 `dsh-access-phone-remote.apk` 传到手机（微信/网盘/数据线都行）手动点击安装。
⚠️ 如果手机上已装过旧版、且签名密钥不同，需要先卸载旧版。

---

## 二、首次配置（贴一次地址就行）

App 第一次启动会显示配置页，**把电脑上的访问地址整条粘进去**即可：

```
http://192.168.1.100:3099/?t=xxxxxxxx
```

App 会自动拆开：

| 部分 | 从哪来 | 示例 |
|---|---|---|
| **服务地址** | 协议 + 主机 + 端口 | `http://192.168.1.100:3099` |
| **口令** | URL 里的 `?t=` 参数 | `xxxxxxxx` |

**地址怎么获得**：

1. **口令**：服务端启动日志里有（形如 `http://<地址>:3099/?t=<token>`），也可以看项目根目录的 `.hub-token` 文件
2. **主机**：
   - 只在**家里 WiFi** 用 → `ipconfig` 找 `IPv4 地址`（`192.168.x.x`）
   - 在外面（4G/5G）也要用 → 装 Tailscale，`tailscale ip -4` 得到 `100.x.x.x`
3. 拼成上面那种地址，**整条复制粘贴**到 App 里，点「连接」

**容错**（随便哪种写法都行）：

- 没带 `?t=` → 口令留空（服务端没开口令时照常可用）
- 带 `#` 锚点或其它参数 → 只取 `t`
- 地址末尾多余的 `/` → 自动规范化
- 没写 `http://` → 自动补上
- 填了 `127.0.0.1` / `localhost` 会**被拒绝**——那是电脑自己，手机连不上

---

## 三、重新配置（地址变了怎么办）

三个入口，任选：

| 入口 | 怎么用 |
|---|---|
| **⚙ 配置 按钮** | 主页打不开时（地址变了 / 服务没开），右上角自动浮出，点它改 |
| **菜单键** | 老设备上有实体菜单键：按一下打开配置页 |
| **JS 桥** | 网页里执行 `window.DsNative.reconfigure()`（给页面集成用） |

配置页会预填当前地址，改完点「连接」即时生效（地址变了不用重装 APK）。

---

## 四、常见问题

| 症状 | 原因 / 解法 |
|---|---|
| 主页打不开、右上角出现「⚙ 配置」 | 地址不对 / 服务没开 / 手机和电脑不在同一网络 → 点 ⚙ 改地址；查电脑防火墙是否放了 3099 端口 |
| 一进就跳回登录页 | 口令不对 → 重新复制带 `?t=` 的完整地址 |
| 收不到系统通知 | 系统设置里给 App 开通知权限 + 电池白名单（国产 ROM 尤其要） |
| 电脑推来的文件没存进相册/下载 | ①电脑端升级到最新版（旧版没有文件下载接口，App 会提示"请升级电脑端"）②Android 13+ 给通知权限、Android 9 及以下给存储权限 ③通知栏会写"接收失败：原因" |
| 构建报 `找不到 aapt2 / android.jar` | 设置 `ANDROID_BT` / `ANDROID_JAR`（见构建节） |
| 构建报 `找不到 7z / keytool` | 装 7-Zip / JDK 并加入 PATH，或用 `SEVENZ=…` / `KEYTOOL=…` 指定 |
| `d8` 崩 `NullPointerException` | 踩了 JDK24 + 匿名内部类的坑 → 本工程**禁止匿名内部类**，改代码时保持具名嵌套类（见 `docs/PITFALLS.md` P24） |

---

## 五、安全说明

- **口令只存在手机本地**（`SharedPreferences`，App 私有目录），不经过任何第三方
- 首次进站用 `/?t=口令` 换 180 天 Cookie，之后原生请求走 `X-Auth` 头
- `dsjiang.keystore`（签名密钥）和 `dsh-access-phone-remote.apk` 都不要提交到仓库（已在本目录 `.gitignore` 里）

---

## 六、目录结构

```
android/
├── AndroidManifest.xml
├── build.sh                 # 手工构建链（aapt2 → javac → d8 → 7z → zipalign → 签名）
├── make-icons.js            # 零依赖生成 App 图标到 res/
├── res/                     # 图标资源（由 make-icons.js 生成）
└── src/io/github/hanzhengdev/phoneaccess/
    ├── MainActivity.java    # 主界面：WebView 壳 + 首次配置页 + JS 桥
    ├── NotifyService.java   # 前台服务：SSE 通知（断线补发 + 心跳看门狗）
    ├── FileReceiver.java    # 接收电脑推来的文件：下载 → 相册/下载目录 → 通知可点开
    ├── FileProviderMini.java # 自写极简 FileProvider（Android 9 及以下打开已存文件用）
    ├── WebActivity.java     # 网页浮层（持久 Cookie）
    └── BootReceiver.java    # 开机自启通知服务
```
