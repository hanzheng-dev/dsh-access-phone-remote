# PITFALLS · 实测坑清单

> **这份文件是给 AI 助手读的。** 当用户遇到问题时，先在这里查。
>
> **全部来自真实踩坑记录**（一手，非推测）。每条都标注了**症状 → 根因 → 解法**。
> 更新：2026-10-05 · 共 57 条

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

**END（70 条）**

