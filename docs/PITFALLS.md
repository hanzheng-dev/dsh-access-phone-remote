# PITFALLS · 实测坑清单

> **这份文件是给 AI 助手读的。** 当用户遇到问题时，先在这里查。
>
> **全部来自真实踩坑记录**（一手，非推测）。每条都标注了**症状 → 根因 → 解法**。
> 更新：2026-10-06 · 共 81 条

---

## 快速索引

| 用户说什么 | 查哪条 |
|---|---|
| 手机连不上电脑 | P1-P9, P53 |
| 能 ping 通 IP 但打不开网页 | **P10, P57** |
| 刚切网连不上 | **P12** |
| 传文件很慢 | P12, P13, P36 |
| 位置偏了 500 米 | **P15** |
| 报 `INVALID_USER_KEY` | P17 |
| 后台收不到通知 | P29, P54 |
| 开机不自动启动 | **P32** |
| 计划任务闪黑框 | **P48** |
| 编译 APK 报 NullPointerException | **P24** |
| 杀进程杀过头了 | P50 |
| 服务卡死不响应 | P51 |
| 局域网不通但 Tailscale 通 | **P53** |
| 插件装了但设置页没有那一页 | **P75, P76** |
| 装 `github:` 依赖连不上 GitHub | **P78** |
| 投稿 dsh 插件列表被 CI 拒 | **P79** |
| 提交推上去了但贡献图是空的 | **P80** |

---

# 一、手机联机（adb）

## P1 · 「无线调试」绑死 Wi-Fi

**症状**：Android 11+ 设置里的「无线调试」在移动网络下根本打不开；关 WiFi 就停。

**根因**：该开关绑死当前 Wi-Fi。

**解法**：USB 插一次 + `adb tcpip 5555` → adbd 监听**所有网卡**（`[::]:5555`），与网络解耦。

**代价**：手机重启后失效，要重跑。

---

## P2 · `adb tcpip 5555` 首次报 `error: closed`

**症状**：首次执行报 `error: closed`，设备转 `offline`。

**解法**：**重新开一次无线调试**即恢复，随后再执行成功。

**注意**：不是 ROM 禁止，别急着下结论。

---

## P3 · adbd 切 TCP 后 USB 设备显示 `offline`

**症状**：脚本报"没找到手机"，但线是插着的。

**根因**：过滤时只匹配 `\tdevice`。

**解法**：写成 `\t(device|offline)`。

---

## P4 · `adb devices` 只显示过期的 offline 条目

**症状**：过期的 `IP:5555 offline` 把 USB 设备整个藏住。

**解法**：`adb disconnect` + `adb kill-server` / `start-server`。

---

## P5 · push 中文路径失败

**症状**：`adb: error: cannot stat ...: No such file or directory`

**根因**：源路径带中文（或 Git Bash 的 `/c/...` 写法）。

**解法**：**先复制到纯英文路径**再 push。

---

## P6 · push 到相册 ≠ 立刻可见

**症状**：文件推到了 `/sdcard/DCIM/Camera/`，但相册里看不到。

**解法**：补一发媒体扫描广播：
```bash
adb shell "am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/DCIM/Camera/xxx.png"
```

---

## P7 · Git Bash 路径自动转换

**症状**：`adb pull /sdcard/...` 变成 `C:/Program Files/Git/sdcard/...`

**解法**：`MSYS_NO_PATHCONV=1`

---

## P8 · Android 11+ 无线调试端口是随机的

**症状**：写死 5555 必然连不上（实际端口如 38635）。

**解法**：`adb mdns services` 自动发现：
```
adb-<序列号>-XXXX  _adb-tls-connect._tcp  192.168.1.5:38635
```

---

## P9 · `.bat` 中文乱码

**解法**：**wrapper 用纯 ASCII**，中文全挪进 `.ps1`。

---

# 二、Tailscale

## P10 · ★ MagicDNS 把自己当 DNS → 手机上不了网

**症状**（三连）：
- `ping 100.100.100.100` → 通（2ms）
- `ping 222.66.251.8` → 通（23ms）
- `ping www.baidu.com` → **unknown host**
- **连带**：5G 掉回 LTE、微信扫不了共享单车

**根因**：手机 DNS = `100.100.100.100`（Tailscale 自己），而 MagicDNS 的 Resolvers 是"系统默认"→ **死循环**。

**解法**：Tailscale 应用 → **关掉「Use Tailscale DNS」**。

**⚠️ 诊断纪律**：测网络**必须分开测**「DNS 解析」和「IP 可达」。

---

## P11 · 白名单杀进程把自己通道杀了

**症状**：Tailscale 半死 —— 守护进程活着、前端 IPN 死了 → 网卡掉 `100.x`、状态 stopped。

**根因**：`@清除` 把 `tailscale-ipn.exe` 杀了（装在 `C:\Program Files\`）。

**教训**：**白名单式杀进程，必须把"自己赖以生存的通道"写进白名单**。

---

## P12 · ★ 刚切网有 1-2 分钟痛苦窗口

**症状**：从 WiFi 切到 4G 后连不上 / 极慢。

**根因**：**真的先走 DERP 中继**（`direct connection not established`，ping 380ms）。

**实测**：中继期 5MB 文件花 141 秒 = 0.035 MB/s；打洞成功后 IPv6 直连 40-43ms、0.69-0.70 MB/s。

**解法**：**等 1-2 分钟**，别急着传文件。

---

## P13 · 移动网 vs 局域网速度差 20-50 倍

| 场景 | 速度 |
|---|---|
| 局域网直连 | 19.9 MB/s |
| 走隧道 | 13.7 MB/s |
| 移动网 | 0.7 MB/s |

**推论**：1GB 文件在移动网要约 25 分钟。

---

## P14 · 手机后台被杀

**症状**：过一会儿就连不上。

**根因**：Tailscale 不在电池白名单。

**解法**（纯 adb）：
```bash
settings put secure always_on_vpn_app com.tailscale.ipn
settings put secure always_on_vpn_lockdown 0
dumpsys deviceidle whitelist +com.tailscale.ipn
```
**⚠️ 故意不开 lockdown** —— 开了 VPN 一挂就整机断网。

---

# 三、坐标系（最要命）

## P15 · ★ WGS84 / GCJ02 混用偏 ~500 米

**根因**：手机 GPS 给 **WGS84**；高德/百度用 **GCJ02**（火星坐标）。

**解法**：
- 定位时用标准算法把 WGS84→GCJ02 算好，一并上报
- 调高德 + 跳地图 App **一律用 GCJ02**
- 高德 `place`/`direction` 返回的坐标**本身就是 GCJ02** → 直接喂，无需再转
- 跳百度 URI 带 `coord_type=gcj02` 让百度自己换算

---

## P16 · `/api/route` 的 lat/lng 顺序

**坑**：`flat/flng` 是**分开**的；`from/to` 是 `lat,lng`，内部翻成高德的 `lng,lat`。

**教训**：**别把顺序弄反**。

---

## P17 · 高德有三类 key

| key | 用途 |
|---|---|
| **Web服务** | 后端 REST |
| **Web端 JS API** | 页面嵌地图（需 `jsSecurityCode`） |
| **Android** | 原生 SDK（本项目没用） |

**坑**：JS API key 有 referer/域名限制，报 `INVALID_USER_KEY` → 去控制台加白。

---

## P18 · 定位精度

**坑**：HyperOS 首次点定位默认可能只给"大致位置" → 精度公里级。

**解法**：选「精确」并开 GPS。

---

# 四、WebView / 前端

## P19 · 老浏览器缺 `Iterator`

**症状**：整页停在 "Failed to load plugins"。

**根因**：手机自带浏览器缺全局 `Iterator`（Chromium 122 / 2024 才引入）。

**解法**：对 HTML 注入垫片（补空 `Iterator.prototype`）。

**验证手段**：无头 Chromium `addInitScript` 删掉 `Iterator` 复现。

---

## P20 · 反代崩溃（ECONNRESET 未处理）

**症状**：客户端中途断开 → 整个代理进程被带走。

**解法**：加 `req/res/socket` error + `clientError` + `uncaughtException/unhandledRejection`。

---

## P21 · WebView 冷启动慢

**解法**：
- `onCreate` 里 `postDelayed` 预建一个 `about:blank` 空 WebView
- ⚠️ 必须**异步建**（主线程建会卡启动）
- ⭐ 用 `applicationContext`（静态持有不泄漏 Activity）
- 打开时**领养**静态那个；关闭**不 destroy**

**验收**：第二次点 = 秒开。

---

## P41 · CSS 优先级坑（深色主题）

**坑**：`html.dark .pdot`（0,2,1）优先级**高于** `.pdot.on`（0,2,0）→ 深色下永远显示灰。

**解法**：补 `html.dark .pdot.on`。

---

## P45 · APK 全屏黑边

**根因**：`targetSdk=33 << 35` → 系统仍走兼容模式。

**解法**：加 `setStatusBarContrastEnforced(false)`、shortEdges（挖孔屏）。

---

# 五、APK 构建（手工链）

## P22 · ★ PowerShell 里内联 JS/Node 脚本 = 转义地狱

**症状**：用 `powershell -Command "node -e \"...\""` 这种写法改文件，
反复遇到：
- `Invalid string escape`
- `Expected ')', got '<eof>'`
- `参数列表中缺少参数`
- `-replace 运算符后只能跟两个元素，而不是 4`

**根因**：**三层转义叠加** —— PowerShell 的双引号解析 → Node 的字符串字面量 → 正则/JSON 自己的转义。
任何一层少一个反斜杠，整条命令就废。

**解法**（按可靠性排序）：
1. ⭐ **写成一个脚本文件再执行**（最稳）
   ```bash
   # 别这样：
   node -e "const fs=require('fs');fs.writeFileSync('a.txt','\n')"
   # 这样：
   # 先写 _tmp.js，再 node _tmp.js，用完删掉
   ```
2. **用文件编辑工具**（write / edit）代替命令行改文件
3. 实在要内联：**用单引号包 PowerShell 字符串**，且 JS 里**只用单引号**
4. 用 `--%` 或 `--%`（PowerShell 的停止解析符）也很脆，不推荐

**判据**：如果同一条命令你试了两次还没过 —— **停下来，改成写文件**。
继续调转义只会浪费时间。

---

## P23 · ★ `.gitignore` 不会追溯已经跟踪的文件

**症状**：给某个文件加了 `.gitignore` 规则，但 `git status` 里它**还在**，还是会被提交。

**根因**：`.gitignore` **只对"未跟踪"的文件生效**。
一个文件一旦被 `git add` 过，加规则不会自动把它移出去。

**解法**：
```bash
git rm --cached <文件>        # 从索引里移除（保留磁盘文件）
# 然后确认 .gitignore 里有规则
git status                    # 应该看不到了
```

**一次实测**：
写了个看门狗脚本 `docs/op-watch-v3.js`，加了 v1/v2 的忽略规则但**漏了 v3**，
结果它进了仓库 —— 直到发布前检查里那 8 个"命中"才暴露出来。

**教训**：**加了一类文件的忽略规则后，回头验证一遍**（`git check-ignore -v <文件>`）。

---

## P24 · ★★ d8 在 JDK 24 上遇到「匿名内部类」必崩

**症状**：
```
java.lang.NullPointerException: Cannot invoke "String.length()" because "<parameter1>" is null
   at com.android.tools.r8.graph.u2.<init>
```

**最小复现**：`class T { Runnable r = new Runnable(){...}; }` → 崩；去掉匿名类就正常。

**根因**：匿名类的 `InnerClasses.inner_name` 为 null，R8 8.2.2（build-tools r34）在 JDK 24 下没接住。

**解法**：**源码里一个匿名内部类都不留**，全改具名嵌套类。

**无效尝试**：`--release 8` 降字节码到 52（一样崩）。

**来源**：栽了两次。

---

## P25 · Windows 工具不认 MSYS 路径

**解法**：转成 `D:/...`；**这时加 `MSYS_NO_PATHCONV=1` 反而坏事**。

---

## P26 · `keytool` 不在 PATH

**解法**：用全路径 `C:\Program Files\Java\jdk-24\bin\keytool.exe`。

---

## P27 · 手工构建工具链来源

**没有 Android SDK 时**：
- `build-tools_r34-windows.zip`(58MB) + `platform-33_r02.zip`(67MB)
- **国内可达**：`https://mirrors.cloud.tencent.com/AndroidSDK/`

**七步链**：
```
aapt2 link → javac --release 8 → d8 → 7z 塞 classes.dex
→ zipalign -p 4 → keytool 造密钥 → apksigner sign
```

---

## P28 · `pm grant` 立刻执行不生效

**解法**：**再执行一次**；装完必须回读 `dumpsys package` 确认。

---

## P29 · ★ APK 后台收不到通知（SSE 读超时）

**症状**：APK 退出后 / 切到别的 app 后收不到通知。

**根因**：`setReadTimeout(0)`（永不超时）→ 连接后台静默变半死，`readLine()` **永远阻塞** —— 不抛异常、不重连，前台服务看着还在跑，**其实早就聋了**。

**铁证**：logcat 里「距上次收数据 50345ms」，而 hub 每 15 秒发 ping。

**解法**：`setReadTimeout(0)` → **45000ms**（3 次 ping 收不到即判死重连）。

**残留**：进程会被 HyperOS 杀掉再 `START_STICKY` 拉起 → **最坏瞎 15 分钟**。

---

## P30 · APK 全屏 WebView 套壳的取舍

**决策**：APK 是**全屏 WebView 套壳** → **改 UI 只改服务器上的 HTML，不用重装 APK**。

---

# 六、Windows 启动与进程

## P31 · ★ 进程挂在会话作业树下 → abort 陪葬

**症状**：起的服务"好好的"，用户一中断就没了。

**根因**：`Start-Process` / `nohup &` 起的进程挂在**当前 shell 会话作业树**下。

**解法**：用 `schtasks /Create /SC ONCE /RL HIGHEST /F` + `schtasks /Run`，**脱离作业树**。

**配套**：临时任务用完要 `schtasks /Delete`。

---

## P32 · ★★ `.bat` 是 LF 换行 → 整个脚本从没跑过

**症状**：开机自启链从没执行过。

**根因**：`.bat` 是 **LF 换行**（不是 CRLF）→ `cmd.exe` 解析错乱 → `set LOG=...` 被吞 → 第一条命令就失败。

**铁证**：它第一步该写的日志文件不存在；转 CRLF 后立刻生成。

**解法**：转 **CRLF + 纯 ASCII**（中文注释全改英文）。

---

## P33 · `.ps1` 的 here-string 里写中文

**解法**：**here-string 必须全 ASCII**。

---

## P34 · Git Bash `cp` 把 CRLF 转 LF

**症状**：`.bat` 闪退、`.ps1` 报 `Missing closing '}'`。

**解法**：`.bat` 存 **CRLF**，`.ps1` 存 **UTF-8 BOM + CRLF**。

---

## P35 · VM 里传脚本用 base64

**坑**：`guestcontrol copyto` + `-File` 会静默失败。

**解法**：改用 **base64 `-EncodedCommand`**。

---

## P47 · 检查脚本扫到自己（自指问题）

**症状**：写了个"敏感信息扫描"脚本，跑起来**报自己命中敏感信息**。

**根因**：**模式表本身含那些字符串**。
比如 `SECRETS = [/<推送口令>/, ...]` —— 脚本文件里当然有 `<推送口令>`。

**解法**：**扫描时跳过检查脚本自己**：
```javascript
const isCheckerItself =
  /scripts\/preflight\.mjs$/.test(f) ||
  /scripts\/lint-html\.mjs$/.test(f) ||
  /plugin\/test\/static\.mjs$/.test(f);
if (isCheckerItself) continue;
```

**同类问题**：任何"扫描器扫自己"都会遇到 —— 病毒扫描器、linter、密钥检测工具都一样。

**⚠️ 但别矫枉过正**：白名单要**精确到文件**，不能整个目录跳过，
否则真出问题的地方也被放过了。

---

## P48 · ★★ 计划任务闪黑框（`-WindowStyle Hidden` 救不了）

**症状**：计划任务每 1 分钟闪一次黑框。

**根因**：Windows **先把 conhost 控制台窗口建出来**，PowerShell 才拿到参数去隐藏它 → **窗口已经闪完了**。

**正解**：**拿 GUI 子系统程序当外壳** —— 写 `.vbs`：
```vbs
sh.Run "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""xxx.ps1""", 0, False
```
`wscript.exe` 是 GUI 子系统、**不分配控制台** → 彻底无窗口。

**改任务**：`Set-ScheduledTask -Action (New-ScheduledTaskAction -Execute 'wscript.exe' -Argument '"xxx.vbs"')`

---

## P49 · 看门狗判据 `-match 'IP'` 会漏判

**坑**：`-match '100.64.1.21:5555'` —— **只要"出现"就算在线**，但设备可能是 `offline`。

**解法**：**必须匹配 `IP\s+device`** 才算好。

---

## P51 · 提权杀进程不阻塞 HTTP

**坑**：`Start-Process -Verb RunAs -Wait` 能提权但**阻塞整个 HTTP 响应**。

**解法**：**`Start-Process taskkill -Verb RunAs`，关键是【不加 `-Wait`】**。

---

## P52 · 服务没对外监听

**坑**：配置里 `listen: false` → 只绑 `127.0.0.1`，**压根没对外开放**。

**连带**：改了配置但**没写进文件**（mtime 是旧的 → 以为加过，其实没生效）。

---

## P53 · ★ Windows 网络位置「公用」拦所有入站

**症状**：手机 ping 局域网 IP **100% 丢包**，但 ping **Tailscale IP 通**。

**解法**：加防火墙规则（TCP 入站，Private+Public）。

**诊断价值**：**"局域网不通但 Tailscale 通" = 防火墙问题，不是网络问题**。

---

## P56 · `lanIp()` 取错网卡

**坑**：取到了 VirtualBox 的 `192.168.56.1` 而不是真实 WLAN。

---

# 七、其他

## P36 · 单连接 vs 并发测速差异

| 场景 | 单连接 | 4 并发 |
|---|---|---|
| Wi-Fi | 28.78 MB/s | 36.36 MB/s（1.26×） |
| 移动数据 | 0.10 MB/s | 1.06 MB/s（**10×**） |

**结论**：移动网下瓶颈在**单连接/无线调度**，不在服务器。

---

## P37 · `nohup ... &` 起的服务随会话退出

**解法**：用计划任务或真正的后台方式。

---

## P38 · USB 调试与 MTP 可以并存

**破除误解**：以前以为"传文件必须关调试" → **错的**。

**连带真相**：断的是 **adbd**；**重开 USB 调试 → 5555 自动回来**（`service.adb.tcp.port` 持久化），不需要插线。

---

## P39 · 计划任务 vs bash 起进程

**主人原话**：「**这种功能怎么可以用临时文件**」

**教训**：**常驻进程必须用计划任务起**。

**验证**：任务起后**进程父 ≠ 启动它的那个 PID**。

---

## P40 · Clash Verge GUI 会自动开系统代理

**坑**：只要开 `clash-verge.exe`（GUI），系统代理就被打开 → 所有流量走代理。

**正确姿势**：**只起内核 `verge-mihomo.exe`**（`-d` 配置目录 + `-f` 配置文件）。

**附带**：改 `clash-verge.yaml` 会被 GUI 启动时覆盖；要改基础模板 `config.yaml`。

---

## P42 · 数据库膨胀

**实例**：`opencode.db` 涨到 **5.07 GB** → serve 变卡。

**解法**：**停 watch 后**删库（+wal/shm）+ 清 tool-output + 清 log。

**警告**：删前必须停 watch（它每 10 秒轮询，否则 "being used by another process"）。

---

## P43 · `if (id) return id` 永不自愈

**坑**：缓存的会话 id 已被删，但 `if (id) return id` → 永不自愈。

**解法**：**先探活再用** —— `GET` 探一下：200 保留 / 404 重建 / **网络错误保留旧 id**。

**通用教训**：**缓存的 id 要先探活**。

---

## P44 · Git Bash curl 发中文变 GBK

**解法**：改用 Node fetch + `charset=utf-8`。

---

## P46 · 文件注入白名单的"防手滑"

**仍拦的**：
- 可执行文件（`.exe/.bat/.cmd/.ps1/.vbs/.msi/.apk/.jar/.dll…`）
- 文件名带 `密码|secret|token|credential`

---

## P50 · ★ "黑名单式扫全表"杀进程 = 灾难

**症状**：**一按 209 个进程全灭** —— 隧道断 + AI 全家死 + 桌面壳崩。

**主人原话**：「一按就全没了，后台只剩蓝牙和usb了，**安全屋直接炸平了**」

**解法**：**规则判定 + 先预览再确认**。

---

## P54 · Android 13+ 通知权限必须主动请求

**坑**：**光在 manifest 里写权限不够**，必须 **app 主动调 `requestPermissions()`**。

---

## P55 · 换默认浏览器（不需要 root）

```bash
adb shell cmd role add-role-holder android.app.role.BROWSER com.android.chrome
```

---

## P57 · 直连 IP 通、域名不通 → 先查 DNS

**诊断纪律**：`ping 1.1.1.1` 和 `ping www.baidu.com` **两个都做**。

**价值**：瞬间区分"网络断"和"DNS 坏"。

---

## P58 · 电脑上有多个 adb

**坑**：`AppData\Local\adb\platform-tools` 与 `AppData\Local\Android\platform-tools` **是两个 adb**；配对是后者建立的，前者 `adb devices` **看不到设备**。

**解法**：启动时**自动挑"真能看见设备"的那个**。

**连带**：adb 服务端重启后无线传输会丢，要用 mDNS 名重连。

---

## P59 · 大文件吞吐远高于小文件

**实测**：
- 小文件批（777 个 / 1.0GB）：**5.07 MB/s**
- 大文件批（>20MB）：**30-32 MB/s**

**根因**：小文件是**每文件两三趟 adb 往返**的开销。

**推论**：传大量小文件时，先打包再传。

---

## P60 · 局域网直连比 Tailscale 隧道快 45%

| 通道 | 速度 |
|---|---|
| 局域网直连 `192.168.1.101:5555` | **19.9 MB/s** |
| Tailscale 隧道 | 13.7 MB/s |

**解法**：脚本里**优先局域网 IPv4，排除 `100.64` / `10` CGNAT 段**。

---

## P61 · `schtasks /SC ONCE /ST <刚才的时间>` 会立刻触发

**坑**：创建任务时如果 `/ST` 是过去的时间，**立刻自己触发一次** → 叠加手动 `/Run` 会跑两批。

---

## P62 · `schtasks /End` 杀不掉里面的 node

**坑**：`schtasks /End` **只杀 cmd 壳**，里面的 node 变孤儿继续跑。

**教训**：**长任务要盯进程，别只看任务状态**。

---

## P63 · 测速不能拿阿里云镜像当基准

**坑**：阿里云镜像**每连接掐在 0.85 MB/s**（8 线程才 6.8 MB/s）→ 误判"家里千兆网坏了"。

**正确基准**：腾讯云 15.8 MB/s、华为云 13.5 MB/s。

---

## P64 · Termux `run-as` 不带环境变量

**坑**：`run-as com.termux` **不带 PATH/HOME** → `pkg: command not found`。

**解法**：手动 `env PATH=…/usr/bin HOME=…`。

**连带**：Termux 重启后 sshd 不自启 → 在 `~/.bashrc` 挂自愈脚本。

---

## P65 · 反斜杠在文件里被多加一层

**症状**：匹配串运行时多了一层反斜杠 → PowerShell 里**一个都没匹配上**。

**根因**：
- PowerShell `-like` 里 `\` 是**字面量**（转义符是反引号）→ `*st-window\\profile*` 命中 0
- 当正则用时 `\\` 表示"字面反斜杠"，但真实命令行那里是 `-` → 命中 0

**教训**：**凡是"要交给 PowerShell 的匹配串，一律别用反斜杠"** —— 用 `*` 跨过。

**验证手法**：**不要靠肉眼看文件里有几个反斜杠**（cat/grep 显示的层数本身也会被转义骗）。用 node 把常量的**真实值**打出来（`JSON.stringify`），再拿真实值去**真实进程上数命中数**。

---

## P66 · ★「失败静默吞掉 + 照样收尾」是最坑的写法

**症状**：用户按按钮"没反应"，电脑上什么都没发生。

**根因**：`try { ... } catch (Throwable) { }` 静默吞掉异常，**然后不管成没成都把 App 关掉**。

**后果**：用户看到的"没反应"和"真没执行"**长得一模一样** → 白查半小时。

**解法**：
- 地址**挨个试**（当前地址 → 上次成功的 → 固定候选）
- **失败要说话**：把原因摆到屏幕上，**并且不关 App**；只有成功才收尾

**来源**：`2026-09-14-手机关按钮两轮排查.md`

---

## P67 · 隐藏窗口起的服务，日志全丢

**坑**：隐藏窗口起的进程，`console` 输出**全丢** → 出问题查不到。

**解法**：**日志落盘**（自动清空超 512KB；只记事件和长度、不记内容）。

**价值**：这次排查**全靠中转日志**才定位到"请求根本没出手机"。

---

## P68 · 公开 `android.jar` 缺隐藏 API

**坑**：`ProxyConfig` / `ProxyController` 是**隐藏 API**，公开 `android.jar` 里没有。

**解法**：自带 `libs/androidx-webkit-1.12.1-classes.jar`，加进 `build.sh` 的 classpath。

---

## P69 · 代理只绑 Tailscale IP = 安全边界

**做法**：Clash 配置 `allow-lan: true` + `bind-address: <Tailscale IP>`

**效果**：**只监听 Tailscale 地址**，局域网 `192.168.x` 连不上 → 天然的安全边界。

---

## P70 · ★ headless 截图的 `--window-size` 不可靠（会骗你）

**症状**：用 `--headless=new --window-size=400,900 --screenshot=...` 截图，
内容**右侧被裁掉**（按钮只显示一半、状态文字缺角）——
看起来像「页面在窄屏下溢出」。

**根因**：**headless 模式下 `--window-size` 与实际渲染视口不一致**
（截图区域的宽度 ≠ 布局用的视口宽度）。所以看到的是"窗口的一角"，不是"页面的溢出"。

**⭐ 怎么区分「页面真溢出」和「截图被裁」**：

| | 页面真溢出 | 截图被裁（本坑） |
|---|---|---|
| 换**大**视口截图 | 还是溢出（固定宽度元素） | **布局自适应、完全正常** |
| 表现 | 出现水平滚动条 | 图片边界之外还有内容 |

**一次实测**：同一个页面，
- `--window-size=400` → 右侧裁掉，像溢出
- `--window-size=800` → 布局自适应、按钮变宽、文字完整居中 ⇒ **页面没问题**

**解法**：
1. **别只看一张窄截图就断定溢出** —— 至少再用大视口截一张对比
2. 想验证响应式，用**多个宽度**（400 / 800 / 1200）各截一张
3. 必要时改用 CDP（Chrome DevTools Protocol）的 `Emulation.setDeviceMetricsOverride`
   来固定视口，那才是准的

**教训**：**验收工具的不可靠，会伪装成产品的 bug。**
先在工具层面排除，再去改代码。

---

## P71 · ★ 发布前检查脚本自己成了泄漏源

**症状**：`preflight` 报「敏感信息 0 命中」，看着一切正常。
直到把仓库导出成一份干净副本、逐文件搜真实口令 ——
**在检查脚本自己里面**搜到了，一字不差。

**根因**：
- 三个检查脚本（`preflight.mjs` / `lint-html.mjs` / 插件静态测试）为了"知道要检测什么"，
  把真实特征值（口令、QQ 号、Tailscale IP、私有目录名）**硬编码在源码里**
- 而这三个脚本是要进公开仓库的 —— 等于**把要防的东西印在了门上**
- 更隐蔽的是：为了让扫描通过，脚本里还加了「跳过检查脚本自己」的逻辑，
  亲手把唯一的报警器蒙上了
- 注释里甚至写着"这些不是真实凭证" —— 而那个口令当时**仍然有效**

**解法**：
1. 真实值挪到 `scripts/.secrets.json`（已 gitignore），仓库里只留 `secrets.example.json` 空模板
2. 加载器找不到本地清单时**跳过并明确标注**，而不是假装通过
3. 拆掉"跳过自己"的逻辑 —— 脚本里没有特征值了，它就该被自己扫

**教训**：**安全工具本身也是攻击面。**
"我把扫描器写好了"不等于"我扫干净了" —— 要再问一句：
**这个扫描器自己，会不会正是那个最脏的文件？**

---

## P72 · 一个带尾空格的目录，让每条 git 命令都报警告

**症状**：
- 每次 `git status` 都先吐一行 `warning: could not open directory '.shot-run /'`
- `Get-ChildItem` 明明能列出这个目录，`Remove-Item` 却删不掉
- 警告本身无害，但它污染了所有 git 输出，还会**掩盖真正的警告**

**根因**：
- 测试环境创建目录时名字末尾带了个空格（`.shot-run `）
- Windows 的 Win32 路径 API 会**静默吃掉尾部空格**，所以按普通路径永远定位不到它
- git 直接读 NTFS 目录项，看得见；PowerShell 走 Win32 API，摸不着

**解法**：
1. ⭐ **长路径前缀**（实测唯一可靠的）：
   ```powershell
   Remove-Item -LiteralPath "\\?\D:\path\.shot-run " -Recurse -Force
   ```
   `\\?\` 让系统**跳过 Win32 路径规范化**，尾空格才得以保留
2. ⚠️ **别信**「`Get-ChildItem -Force` 拿对象 + `-LiteralPath $_.FullName` 删」——
   **实测会"报成功但没删掉"**（内部仍要过一次 Win32 规范化）。
   这个假成功特别坑：你以为删干净了，下次 `git status` 发现警告还在。

**补充**：删之前先看看里面是什么。本例里躺着测试生成的 `messages.json`
—— 说明它是某次测试把工作目录设成了这个名字，**不是凭空出现的**，
而是"删不掉"造成的长期残留。

**教训**：**Windows 上「看得见但摸不着」的文件是真实存在的。**
遇到删不掉的路径，先怀疑名字里有没有 Windows 不容许的字符（尾空格、尾点）；
删完要**再确认一次**，别信那句"成功"。

---

## P73 · ★ 判断只做一次，后面全错（浮层代理那个 bug）

**症状**（原话）："下面的知乎点得有反应，上面的 GitHub 就没有。"
搜索正常、国内站正常，**只有被墙站点了没反应**。

**根因**：代理**只在「打开浮层」那一刻判断一次**：

```java
void setupProxy() {
    if (!needProxy(pageUrl)) { loadOnce(); return; }   // pageUrl = 打开浮层时的地址
    ...
}
```

首页打开时 `pageUrl` 是 `null` ⇒ 判为「直连」，之后 WebView 内部跳转
（点搜索结果、点站内链接）**完全不重新判断**。于是从首页点进 github.com 时，
`needProxy()` 里明明写着 github.com 要走代理 —— 但那次判断早就过去了。

**为什么极难定位**：
- 国内站和搜索都正常 ⇒ 容易误判成「链接点不动」（WebView 多窗口问题，P74）
- 也会误判成「代理挂了」—— 而实测代理好好的（200 OK / 0.16 秒）
- 日志里那行 `直连加载（不走代理）: null` 是唯一线索

**解法**：把判断挪到**每次导航**，并用一个状态字段记住当前挂没挂代理：

```java
static class WebClient extends WebViewClient {
    public boolean shouldOverrideUrlLoading(WebView v, String url) {
        if (act.switchProxyFor(url)) return true;   // 该走代理就走，该直连就直连
        v.loadUrl(url);
        return true;
    }
}
```

**验证方式**：看日志里有没有 `切到代理: https://github.com/`。
**有这行才算真通了** —— 不要靠"应该好了"收工。

**教训**：**任何「打开时判定一次」的状态，都撑不过页面内的后续导航。**
缓存状态一旦和真实页面脱节，症状会伪装成完全不相干的问题。

---

## P74 · WebView 里 `target="_blank"` 的链接点了没反应

**症状**：网页里有一部分链接**点了毫无反应** —— 不跳转、不报错、不弹窗。
但同一页面的**输入框、搜索框一切正常**。

**根因**：Android WebView 默认 `setSupportMultipleWindows(false)` ⇒
`target="_blank"` 和 `window.open()` 开出来的新窗口被**静默丢弃**。

**最快的判据**：**页内 JS 好用、链接点不动**。
搜索走 JS（不经过导航），链接走导航 —— 这个对比一出来就能定位。

**解法**：

```java
s.setSupportMultipleWindows(true);
s.setJavaScriptCanOpenWindowsAutomatically(true);

// WebChromeClient 里接住新窗口
@Override
public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
    WebView probe = new WebView(view.getContext());
    probe.setWebViewClient(new WindowCatcher(view));   // 具名类！匿名内部类会让 d8 崩
    ((WebView.WebViewTransport) resultMsg.obj).setWebView(probe);
    resultMsg.sendToTarget();
    return true;
}
```

`WindowCatcher` 接住目标地址后转回**主 WebView** 加载（返回键历史保持连续），随即 `destroy()` 探针。

**教训**：**「点了没反应」是症状，不是原因。**
同一个症状底下可能叠着好几层 —— 本例就是两个独立 bug 叠在一起：
先修好了 P74，页面**仍然**点不动，才挖出 P73。
别在第一个假设上收工。


---

# 八、dsh 插件与上架发布（2026-10-06 新增）

这一节是「把这套东西做成一个 dsh 插件、再投到 awesome-dsh-plugin 列表」时踩出来的。
**共同特征：全是静默失败** —— 没有报错、没有崩溃、CI 全绿，只是东西不出现。

## P75 · ★ dsh 客户端半必须是 `__ModuleLoader__` 包壳，裸 ESM 等于没写

**症状**：插件装上了，`package.json` 里 `dsh.client` 也声明了，但设置页里
**根本没有那一页**。控制台不报错、dsh 不报错、静态检查全过。

**根因**：dsh 浏览器侧**只认** `window.__ModuleLoader__.load({ id, factory })` 这个包壳
（与 tsdown 产物同构）。写成 `export function apply()` 的裸 ES module 文件
**不会被当作模块加载** —— 它不是"加载失败"，是"根本没被尝试加载"。

**解法**：照真实已装插件的形状写。权威参照：
`<DSH_HOME>/profiles/web/node_modules/dsh-session-delete/src/client.js`

```js
window.__ModuleLoader__.load({
  id: 'your-plugin-id',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')
    const h = React.createElement
    // ... 定义 apply(ctx)
    exports.apply = apply
    exports.inject = ['slots']
    return module.exports          // ← 必须返回
  },
})
```

**槽位注册**（设置页加一页）：

```js
ctx.effect(() =>
  ctx.slots.inject('settings.section', () =>
    ctx.slots.register(
      { name: 'settings.section', id: 'your-plugin-id', order: 30, label: () => '你的页名' },
      YourComponent,
    ),
  ),
)
```

**教训**：**「静默失效」比报错难查十倍。**
一个语法正确、字段齐全、测试全绿的插件包，可以完全不工作而没有任何提示。

---

## P76 · `exports["./client"]` 漏了，形状对了也进不了浏览器图

**症状**：客户端半已经按 P75 写成包壳了，**还是不加载**。

**根因**：dsh 靠 `package.json` 的 `exports["./client"]` 找客户端入口。
只声明 `dsh.client.platform` 是不够的 —— 那条只说明"有客户端半"，
`exports` 才说明"它在哪个文件"。

**解法**：

```json
"exports": {
  ".": "./src/index.js",
  "./client": "./src/client.js",
  "./package.json": "./package.json"
}
```

三个真实插件（`dsh-session-delete` / `dsh-unrestricted` / `dshmarket`）
的 `exports` **全都带 `"./client"`**。

**教训**：**「该有的字段」要对着真实产物抄，不要靠推断。**
`dsh.client` 和 `exports["./client"]` 只差一行，效果是"完全不工作"和"正常工作"。

---

## P77 · `dsh plugin add` 装 monorepo 子目录，必须写 `#path:/<子目录>`

**症状**：仓库根是独立应用、插件在 `plugin/` 子目录。
装上去的是**根包**，不是插件（根包里没有 `dsh.bundle`）。

**根因**：`dsh plugin add` 只是把参数**原样转给 pnpm**
（`@deepseek-ai/dsh/lib/plugin-*.js` 的 `runPlugin`，只有 `./` `../` 会被
`anchorPathSpec` 改写）。`github:owner/repo` 指向仓库根。

**解法**：用 pnpm 的 git 子目录语法：

```sh
dsh plugin --profile web add github:owner/repo#path:/plugin
```

实测（pnpm 11.22.0）装出来的确实是子目录包，含 `cordis.patch.yml` 和 `dsh.bundle`。

**顺带**：awesome-dsh-plugin 列表里的安装命令就是这么生成的
（`scripts/build-site.mjs`）：
```js
? `dsh plugin --profile web add github:${e.repo}#path:/${e.sub}`
: `dsh plugin --profile web add github:${e.repo}`
```

**教训**：**「不支持」这个结论要验证到源码级。**
之前因为一次安装失败就认定"dsh 不支持子目录"，于是多建了一个仓库来放插件 ——
实际上只是少写了 `#path:/`。

---

## P78 · pnpm 解析 git 依赖不读 `.npmrc` 的 proxy（curl 能通 ≠ git 能通）

**症状**：`npm ci` 走代理一切正常，但 `pnpm add github:owner/repo` 报：

```
[ERR_PNPM_GIT_RESOLVE_FAILED] ... git ls-remote failed:
fatal: unable to access 'https://github.com/owner/repo.git/':
Failed to connect to github.com port 443
```

**根因**：pnpm 解析 git 依赖时**起的是 git 进程**。
而 **git 不读 Windows 系统代理**，也**不读 `.npmrc` 的 `proxy`/`https-proxy`**。

**解法**（任选）：

```sh
git config http.proxy  http://127.0.0.1:7897     # 给 git 自己配
git config https.proxy http://127.0.0.1:7897
# 或只对当前进程生效：
$env:HTTP_PROXY="http://127.0.0.1:7897"; $env:HTTPS_PROXY="http://127.0.0.1:7897"
```

`git push` 报 `Recv failure: Connection was reset` 是同一个根因。

**教训**：**代理是分层的。**
浏览器、curl、npm、pnpm、git 各自读各自的配置，**一个通不代表另一个通**。
排"连不上"的时候，先问"这是哪个进程在连"。

---

## P79 · ★ awesome-dsh-plugin 的投稿方式已经改成 `data/plugins/*.yml`

**症状**：照着几个月前的文档，在 README 的插件列表里加了一行，提 PR。
CI 判失败。

**根因**：列表早就改成**一个插件一个 YAML 文件**了，两份 README 由
`scripts/generate-readme.mjs` 从 `data/plugins/*.yml` **生成**。
理由是以前所有人往同一处追加，**合并一个 PR 就撞掉下一个**。

CI 里有一道专门的门（`.github/workflows/pr-check.yml`）：

> **A generated README row that lists nothing is not a submission**
> —— 只改了 README 里的插件行、却没动 `data/plugins/` 下任何文件 → **直接失败**

**解法**：新增 `data/plugins/<owner>__<repo>.yml`。

```yaml
url: https://github.com/owner/repo/tree/main/plugin    # monorepo 子包要指到子目录
name: owner/repo#plugin
category: remote
description:
  en: '...只说功能、不带营销词、且必须与代码一致...'
  zh: '...可选...'
```

文件名规则：monorepo 子包是 `owner__repo--<子目录，斜杠换成短横>.yml`。
**不要手工改 README** —— 让它自己生成。

**还要知道的几条 CI 门**：

| 门 | 内容 |
|---|---|
| 条目数 | 一个 PR **最多 3 条** |
| `dsh.bundle` | 从**条目 url 对应的那个 `package.json`** 取（所以 url 指哪很关键） |
| **仓库年龄** | **满 1 天**。这条不用重开 PR —— `regate.yml` 每 6 小时重跑，到点自己变绿 |
| fork 陈旧 | 删掉超过 2 个既有条目文件 → 判 fork 太旧 |
| 扩展名 / 路径 | 必须正好是 `data/plugins/*.yml`，放错层级会被**静默跳过**（其它检查全绿） |

**教训**：**「照文档做」之前，先确认文档还是不是当前的。**
对上游仓库，**源码（CI 脚本）比 CONTRIBUTING 的示例更权威** ——
示例会滞后，CI 不会。

---

## P80 · ★ GitHub 贡献图不认自造邮箱（提交推上去了，格子一片空白）

**症状**：53 次提交全部推上去了，仓库里都看得到，
但 **GitHub 个人主页的贡献图一片空白**。

**根因**：commit 的 **author email 必须关联到 GitHub 账号**，才会被计入贡献图。
本机 git 没配 `user.email` 时，git 会按 `用户名@主机名` 自动造一个 ——
比如 `dsj-open@local`。这种邮箱**永远不关联任何账号**。

**怎么验证**（不用猜，API 直接告诉你）：

```sh
GET https://api.github.com/repos/<owner>/<repo>/commits
```

每条提交里，`commit.author.email` 是提交里写的邮箱，
**`author.login` 是 GitHub 匹配到的账号** —— 匹配不上时 `author` 字段整个是 `null`。

实测：

```
hanzheng-dev@users.noreply.github.com  → author.login = hanzheng-dev   ✅
dsj-open@local                         → author.login = (null)          ❌
```

**解法**：全量改写历史署名后强推。

```sh
git config --local user.name  "hanzheng-dev"
git config --local user.email "hanzheng-dev@users.noreply.github.com"

FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter '
  export GIT_AUTHOR_NAME="hanzheng-dev"
  export GIT_AUTHOR_EMAIL="hanzheng-dev@users.noreply.github.com"
  export GIT_COMMITTER_NAME="hanzheng-dev"
  export GIT_COMMITTER_EMAIL="hanzheng-dev@users.noreply.github.com"
' HEAD

git push --force-with-lease origin main
```

**⚠️ 强推会改写历史** —— 先记下旧 HEAD 备用；仓库已经被别人 fork/clone 过就要慎重。

**教训**：**"推上去了"和"算你的"是两件事。**
`git log` 里名字对不代表 GitHub 认；只有 `author.login` 有值才算。

## P81 · ★ 桥「跟随网页当前会话」会把主人的手机切进子代理会话

**症状**：手机上发消息，回一句
`❌ 出错：dsh: session "…" is owned by subagent routing`，**之后每条都这样**。
而电脑上网页一切正常 —— 因为网页根本没走桥。

**根因**：桥的 `ensureSharedSession()` 会**无条件跟随「dsh 网页当前会话」**：

```js
const pool = running.length ? running : items.filter((s) => !s.blank);
pool.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
activeSid = pool[0].sessionId;        // ← 只问"谁最活跃"
...
st.sharedSid = activeSid;             // ← 无条件覆盖
```

而**子代理会话在 `session/list` 里就是一条普通会话**。
派子代理的那一刻，它正好是「running 里 `updatedAt` 最大」的那个
⇒ 桥上钩，把主人的手机切进子代理。

子代理会话由 dsh 的 subagent routing 独占
（`session.header.origin === 'subagent'`），**不接受外部注入**，
所以从那以后主人的每条消息都被拒。

**日志铁证**（一条就够定案）：

```
22:15:52  QQ <QQ> 使用共享 dsh 会话 session-b6958f8c-…      ← 一直好好的
22:30:19  跟随网页当前会话 session-b6958f8c-… -> 9b44a43c-…，@dsh 自动切换
22:30:19  QQ <QQ> 出错: dsh: session "9b44a43c-…" is owned by subagent routing
22:31:56  QQ <QQ> 出错: dsh: session "9b44a43c-…" is owned by subagent routing
```

**解法**：选会话时排除子代理。`session/list` 的条目带 `origin` 字段
（普通会话**没有**这个字段，子代理会话是 `origin: 'subagent'`）：

```js
const items = (lval.items || []).filter((s) => s && s.sessionId && s.origin !== 'subagent');
```

`handleStop()` 里找「取消目标」时有一份同样的 filter，**要一起改**。

**已经切坏了怎么手动救**：改 `dsh-bridge-state.json`，
把 `sharedSid` 和 `sessions["<QQ>"]` 指回正确的会话 id：

```json
{"sessions":{"<QQ>":"session-<正确的>"},"sharedSid":"session-<正确的>", ...}
```

`hub /api/sessions` 返回的 `current` 字段就是它，改完立刻能核对。

**教训**：

- **「自动跟随」这类隐式选择，范围要从"我能不能用它"来定，不是从"它活不活跃"来定。**
  这段代码问的是"哪个会话最活跃"，而它真正需要的是
  "哪个会话**可以接收我的注入**" —— 两个问题不一样，差的就是子代理。
- **症状是"静默 + 持续"**：只有一条切换日志，之后每条消息都失败，
  而且电脑网页完全正常 ⇒ 很容易误判成"桥没了"或"dsh 挂了"。
- **同一份语义写了两遍，就一定会漏一个。**
  hub 的 `/api/sessions` 早就有 `!/session-title|subagent/.test(x.kind || '')` 这个过滤，
  桥里没有 —— 发现这种不对称时，先问"哪边是对的"，然后把两边对齐。
---

**END（81 条）**
