# 架构说明

> 面向人类读者。AI 助手请看 `AGENTS.md` 和 `PITFALLS.md`。

---

## 一张图

```
┌─────────────────────────────────────┐
│  手机                                │
│  ┌───────────────────────────────┐  │
│  │ 浏览器 / WebView APK           │  │
│  │  · 页面（HTML/CSS/JS）         │  │
│  │  · 定位（原生桥）              │  │
│  │  · 推送接收（SSE）             │  │
│  └───────────────────────────────┘  │
└──────────────┬──────────────────────┘
               │
               │ HTTP
               │ （局域网 或 Tailscale 隧道）
               │
┌──────────────▼──────────────────────┐
│  电脑                                │
│  ┌───────────────────────────────┐  │
│  │ Node 服务（零依赖）            │  │
│  │                                │  │
│  │  server.js      入口 + 挂载    │  │
│  │  ├─ routes/auth 鉴权           │  │
│  │  ├─ routes/push 推送/SSE       │  │
│  │  ├─ routes/file 文件/静态      │  │
│  │  └─ routes/loc  位置           │  │
│  │  store.js       共享内存态     │  │
│  │  commands.js    指令白名单     │  │
│  │  config.js      配置加载       │  │
│  └───────────────────────────────┘  │
│                                     │
│  数据落地：                          │
│  · messages.json（消息）            │
│  · uploads/（上传）                 │
│  · shots/（截图）                   │
│  · .hub-token（访问令牌）           │
└─────────────────────────────────────┘
```

---

## 关键设计决策

### 1. 为什么服务端跑在用户电脑上

**数据不出门**。

用云服务的话，用户的推送内容、文件、位置都要经过第三方服务器。自建的话，**这些数据只在他自己的硬盘上**。

**这不是技术选择，是价值选择。**

### 2. 为什么手机端是个网页

**改 UI 不用重装 APK。**

APK 只是个 WebView 壳，加载服务端提供的页面。**改页面 = 改服务器上的一个 HTML 文件**，用户刷新就生效。

**代价**：断网时页面打不开（但本来也需要联网）。

### 3. 为什么零 npm 依赖

**只用 Node 内置模块**（`http`、`fs`、`path`、`crypto`、`child_process`）。

**好处**：
- `npm install` 都不用跑
- 没有供应链攻击面
- 没有依赖地狱
- 部署 = 复制文件 + `node src/server.js`

**代价**：要自己写一些轮子（路由、SSE）。

### 4. 为什么用 token 而不是账号密码

**单用户场景**。

这是给**一个人**（或一个家庭）用的服务，不是多租户产品。所以：
- 首次启动自动生成随机 token
- 访问 `/?t=<token>` 种一个长期 cookie
- 之后凭 cookie 访问

**没有注册、没有登录页、没有密码找回。**

### 5. 为什么指令是白名单

`/api/run` 只能执行 `commands.js` 里**登记过的动作**。

**不是"任意命令执行"** —— 手机发的是**动作名**（如 `screenshot`），不是命令字符串。

**这是安全的关键**：即使 token 泄露，攻击者也只能调用预设好的那几个动作。

---

## 数据流

### 推送流程

```
某处产生事件
   │
   │ POST /api/push
   ▼
服务端收到
   ├─ 存入内存（messages 数组）
   ├─ 落盘（messages.json）
   └─ 通过 SSE 推给所有在线客户端
        │
        ▼
      手机收到 → 显示 / 震动 / 横幅
```

**SSE（Server-Sent Events）** 是单向的服务器→客户端推送，比 WebSocket 简单，足够用。

### 文件传输流程

**上传（手机 → 电脑）**：
```
手机选文件 → POST /api/upload（multipart）→ 存到 uploads/
```

**下载（电脑 → 手机）**：
```
消息里带 file 字段 → 手机点开 → GET /api/file?path=xxx
```

**⚠️ 安全**：文件路径有白名单（`allowDirs`），且有防路径穿越（拦 `..`）。

### 位置流程

```
手机定位（WGS84）
   │
   │ 转成 GCJ02（关键！见 PITFALLS P15）
   ▼
POST /api/loc
   │
   ▼
服务端存内存（不落盘）
   │
   ├─ GET /api/poi?q=xxx    → 调高德 place/around
   └─ GET /api/route?mode=x → 调高德 direction/*
```

**⚠️ 高德 key 需要用户自己申请**（见 AGENTS.md 第 4 步）。

### 鉴权流程

```
首次：
  手机访问 /?t=<token>
     │
     ▼
  服务端验证 token → 种 cookie（长期）
     │
     ▼
  重定向到干净的 /

之后：
  手机带 cookie 访问 → 服务端验 cookie 签名 → 放行

例外：
  回环地址（127.0.0.1）免鉴权 —— 方便本机脚本调用
```

---

## 目录结构

```
dsh-access-phone-remote/
├── README.md           给人类
├── AGENTS.md           给 AI（部署剧本）
├── llms.txt            给 AI 爬虫
├── package.json
├── config.example.json
├── LICENSE
├── .gitignore
│
├── src/
│   ├── server.js       入口：组装路由 + listen
│   ├── config.js       配置加载（含环境变量覆盖）
│   ├── store.js        共享内存态
│   ├── commands.js     指令白名单
│   └── routes/
│       ├── auth.js     鉴权 + 登录页
│       ├── push.js     /api/push /api/inbox /api/events
│       ├── file.js     /api/file /api/upload + 静态服务
│       └── loc.js      /api/loc /api/poi /api/route
│
├── public/
│   └── index.html      前端页面
│
└── docs/
    ├── PITFALLS.md     ★ 88 条实测坑
    ├── ARCHITECTURE.md 本文件
    └── SECURITY.md     安全说明
```

---

## 配置项

```json
{
  "port": 3099,
  "listenHost": "0.0.0.0",
  "root": ".",
  "authToken": "",
  "allowDirs": ["./data"],
  "uploadsDir": "./uploads",
  "shotsDir": "./shots",
  "docsDir": "./docs",
  "amap": {
    "webKey": "",
    "jsKey": "",
    "jsSecurityCode": ""
  }
}
```

| 字段 | 说明 |
|---|---|
| `port` | 监听端口 |
| `listenHost` | 监听地址（`0.0.0.0` = 所有网卡） |
| `root` | 运行期数据根（store / token / 日志） |
| `authToken` | 留空 → 首次启动自动生成 |
| `allowDirs` | 文件传输白名单目录 |
| `amap.*` | 高德 key（位置功能需要） |

**环境变量可覆盖**：`HUB_PORT` / `HUB_HOST` / `HUB_ROOT` / `HUB_TOKEN` / `AMAP_WEB_KEY`

---

## 扩展点

### 加一个新指令

1. 在 `src/commands.js` 的 `COMMANDS` 数组里加一项：
   ```javascript
   {
     id: 'my_action',
     label: '我的动作',
     group: '控制',
     run: async (payload) => {
       // 做点什么
       return { ok: true, text: '完成' };
     }
   }
   ```
2. 前端会**自动**渲染出按钮（因为它读 `/api/commands`）

**不需要改路由、不需要改前端。**

### 加一个新 API

1. 在 `src/routes/` 下选一个合适的文件（或新建）
2. 写 `register(server, config)` 函数
3. 在 `server.js` 里挂载

### 换地图服务

`src/routes/loc.js` 里调高德的地方，换成别的服务商即可（注意坐标系转换）。

---

## 已知限制

| 限制 | 说明 |
|---|---|
| **Windows-only 部分** | `screenshot` / `show_desktop` 依赖 PowerShell + Win32 |
| **单用户** | 没有多租户、没有用户系统 |
| **无 HTTPS** | 依赖 Tailscale 或局域网；公网暴露需自己加 TLS |
| **内存态** | 消息在内存里，重启会从 `messages.json` 恢复，但 SSE 连接会断 |
| **无数据库** | 用 JSON 文件存消息，适合单用户，不适合大规模 |

---

## 相关文档

- **`docs/PITFALLS.md`** — 88 条实测坑（**遇到问题先看这个**）
- **`docs/SECURITY.md`** — 安全说明
- **`AGENTS.md`** — 给 AI 的部署剧本
