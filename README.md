# dsh-access-phone-remote

**在手机上跟你电脑里的 AI 对话，顺便遥控这台电脑。**

数据全部留在你自己电脑上，**零 npm 依赖** —— 只用 Node 内置模块。

---

## 这是什么

一句话：**手机连回你自己的电脑。**

值得说的只有三件事。推送、传文件、位置、按按钮那些是这类软件的常规配置，
放进来只是为了说明它是个完整的遥控台，不占篇幅。

### 一、在手机上接着电脑的 AI 聊

电脑上跑着 dsh（DeepSeek Harness），手机打开就是**那段对话的下一句**。
**模型、会话、上下文、工具全在电脑里 —— 手机只是块屏幕。**

而且它**干活的过程你看得见**：回复逐字蹦出来，思考过程折叠在旁边
（标题实时显示「思考中 · N 字」），工具调用每个一行摘要、展开是完整参数。
**不是等十分钟然后砸给你一大段。**

- 嫌它想太多或想太少？**思考档位**在手机上直接切（off / high / max）
- 一个回合太久？**一点就停** —— 发送和停是两个独立按钮，不会误点

> 默认关闭。`config.json` 里把 `dsh.enabled` 改成 `true` 并配好 `dsh.base`，页面才出现入口。
> 没装 dsh 就跳过这段，其余功能照常。

### 二、搭便车：图和话一起到

手机上拍的照、传的文件**不是立刻发出去的**，先放进一个待发队列。
你紧接着发下一条消息时，它自动挂在那条消息上一起送给 AI。

所以是：**拍完照直接打字，图和人话一起到** —— 不用"先发图、再补一句话"。
（队列里每条只活 3 分钟，过期丢弃。）

### 三、不用配 IP，不用记地址

服务端每 3 秒在局域网广播一次，手机 App 自动发现电脑 —— **连地址都不用填**。
出门在外装 [Tailscale](https://tailscale.com/)（免费），两边登同一账号就能连回来，
不用公网 IP、不用端口映射。

---

**常规的那部分**：电脑上的任务跑完推你手机、双向传文件、搜附近看路线、
一键截图/显示桌面 —— 外加**你自己加的命令**（改 `config.json` 就能加按钮，不用动代码）。

**跟云服务不同**：所有数据留在这台电脑上，不经过任何第三方。

---

## 截图

<p align="center">
  <img src="docs/images/screenshot-chat.png" width="230" alt="在手机上跟电脑里的 AI 对话">
  <img src="docs/images/screenshot-home.png" width="230" alt="主页抽屉：传文件 / 位置 / 截图 / 自定义按钮">
  <img src="docs/images/screenshot-help.png" width="230" alt="内置帮助">
</p>

<p align="center"><sub>会话页（在手机上跟电脑里的 AI 对话） · 主页抽屉（传文件 / 位置 / 截图） · 内置帮助</sub></p>

---

## 给 AI 用的部署向导

**如果你在用 Claude / ChatGPT / Cursor 等 AI 助手帮你部署**：

> **把这个仓库里的 `AGENTS.md` 丢给你的 AI，让它带你做。**
>
> 那是一份**专门写给 AI 读的部署剧本** —— 它会一步步问你环境、判断分支、处理报错。

**这是本项目最特别的地方**：不是让你读文档，是让你**叫 AI 来读**。

---

## 快速开始（人类版）

```bash
# 1. 需要 Node.js 18+
node --version

# 2. 起服务
node src/server.js

# 3. 终端里会直接出现一个二维码 —— 手机扫一下就连上了
#    （也会打印地址，形如 http://192.168.1.100:3099/?t=<token>）
```

**启动后的终端长这样**：

```
[07:41:49] ===== dsh-access-phone-remote 启动，监听 0.0.0.0:3099，功能 5 个 =====
[07:41:49] 本机: http://127.0.0.1:3099/
[07:41:49] 手机访问: http://192.168.1.100:3099/

  手机扫这个（或复制上面那行）:

    █▀▀▀▀▀█ ▄█ ▄▄▄▀▄  █▀▀▀▀▀█
    █ ███ █ ▄█▀█ ▄▀ ▀ █ ███ █
    ...（二维码）

[07:41:49] 其他可用地址: 100.64.1.20(tailscale)  192.168.56.1(virtual)
```

**地址会自动挑**：局域网 IP 优先（不用装任何东西），Tailscale 次之，
虚拟网卡（VirtualBox 等）会标注出来 —— 因为**手机连不上虚拟网卡**。

**局域网内零配置**：服务端会持续发 UDP 广播（每 3 秒一次），
配套的手机 App 在同一 WiFi 下能**自动发现电脑**，连地址都不用填。
（不想要这个？`config.json` 里把 `discovery.enabled` 设为 `false`。）

**手机在外面也能访问** → 用 [Tailscale](https://tailscale.com/)（免费）。

**先自检一下环境**（可选但推荐）：

```bash
node src/doctor.js      # 或 npm run doctor
```

它会告诉你：Node 版本够不够、端口通不通、网络地址有哪些、
高德 key 配了没、缺什么、下一步做什么。

**详细步骤**：
- 给 AI：`AGENTS.md`
- 给人：`docs/ARCHITECTURE.md`
- **遇到问题**：`docs/TROUBLESHOOT.md`（按症状走决策树）
- **坑清单**：`docs/PITFALLS.md`（**81 条实测坑**）

---

## 为什么值得一看

### 1. 有一个「给 AI 的说明书」

`AGENTS.md` 不是代码风格指南 —— 是**部署剧本**。

**设计意图**：用户不需要读懂技术细节，**让用户自己的 AI 去读懂**。出了问题，用户的 AI 就地解决，不依赖作者支持。

### 2. `docs/PITFALLS.md` 是两个月踩出来的

**81 条真实坑**，每条都有**症状 → 根因 → 解法**：

- `adb tcpip 5555` vs Android「无线调试」的本质区别
- Tailscale MagicDNS 把自己当 DNS → 手机上不了网
- WGS84/GCJ02 混用偏 500 米
- `.bat` 用 LF 换行 → 整个自启链从没跑过
- 计划任务闪黑框，`-WindowStyle Hidden` 救不了
- d8 在 JDK 24 上遇到匿名内部类必崩
- …

**这些不是查文档能查到的，是踩出来的。**

### 3. Windows-only MVP

核心功能跨平台，但 `screenshot` / `show_desktop` 依赖 Win32。

---

## 架构

```
手机（浏览器 / WebView APK）
        │
        │ HTTP（局域网 或 Tailscale）
        ▼
电脑：Node 服务（零依赖）
   ├─ /api/chat  /api/sessions  /api/busy
   │  /api/delta /api/stop      /api/effort   会话页：跟电脑里的 AI 接着聊
   ├─ /api/push  /api/inbox     /api/events   推送（含 SSE 实时流）
   ├─ /api/file  /api/upload                  文件读 / 下载 / 写回 / 上传
   ├─ /api/loc   /api/poi       /api/route    定位 / 附近搜索 / 路径规划
   ├─ /api/run  /api/commands                 指令分发（白名单）
   └─ /api/addresses /api/features /api/ping  地址列举 / 功能开关 / 健康检查
        │
        ├──────────────► 你电脑上的 dsh（DeepSeek Harness）  ← 会话页注入这条
        │
        └──────────────► 你电脑上的其它东西（截图 / 文件 / 桌面）
```

**服务端零 npm 依赖** —— 只用 Node 内置模块。

---

## 文档

| 文件 | 给谁 | 内容 |
|---|---|---|
| **`AGENTS.md`** | **AI** | **部署剧本（核心）** |
| `docs/PITFALLS.md` | 都行 | **81 条实测坑** |
| `docs/TROUBLESHOOT.md` | AI | 排障决策树（按症状走） |
| `docs/ONBOARDING.md` | 人 | 上手引导 |
| `docs/FOR-AI-EXTEND.md` | AI | 扩展指南（**含「不改代码加功能」**） |
| `docs/ARCHITECTURE.md` | 人 | 架构说明 |
| `docs/SECURITY.md` | 人 | 安全说明 |
| [`android/README.md`](android/README.md) | 人 | 安卓客户端（APK）—— 构建与配置 |
| `llms.txt` | AI 爬虫 | 索引 |

---

## 安全

- **服务只在你自己的网络里**（局域网 / Tailscale）
- **鉴权**：访问 token（首次启动自动生成）
- **指令白名单**：只能执行预设动作，不能执行任意命令
- **⚠️ 不要暴露到公网**（除非你清楚风险）

详见 `docs/SECURITY.md`。

---

## 许可

MIT

---

## 状态

**早期项目（MVP）**。核心功能可用，文档持续完善。

**如果你在使用中遇到问题** —— 先看 `docs/PITFALLS.md`，或者**把你的 AI 叫来**，让它读 `AGENTS.md`。
