# 更新日志

本项目遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

---

## [1.0.0] - 2026-10-05

**首个版本。**

### 新增

**服务端**
- 消息推送 `/api/push` + SSE 实时流 `/api/events`
- 消息拉取 `/api/inbox`
- 文件传输：下载 `/api/file`、保存 `/api/file/save`、上传 `/api/upload`
- 位置服务：定位 `/api/loc`、搜附近 `/api/poi`、路线规划 `/api/route`（高德）
- 指令分发 `/api/run`（**白名单机制**，非任意命令执行）
- Token + Cookie 鉴权
- 心跳 `/api/ping`、版本 `/api/version`、指令列表 `/api/commands`
- 剪贴板搭便车（hitchhike）
- 静态服务：`/uploads` `/docs` `/shots` `/pages`
- **地址自动发现** `/api/addresses` —— 枚举本机可用地址，
  局域网优先，识别虚拟网卡（VirtualBox/VMware/WSL）
- **启动即在终端打印二维码** —— 手机扫一下就连上，不用开浏览器
- **环境自检** `node src/doctor.js` —— 12 项检查 + 建议 + 下一步

**前端**
- 上手引导（首次访问显示"下一步做什么"）
- 页面内二维码（**本地生成，零依赖、不联网**）
- 地址选择（多网卡时让用户挑）
- **内置帮助页** `/pages/help.html` —— 9 个常见问题的排查步骤
- 极简排版（无 emoji，强调文字层级）

**局域网零配置发现**
- 服务端每 3 秒广播 UDP 包（含端口 / 口令 / **完整地址列表 + 类型**）
- 手机 App 在同一 WiFi 下自动发现电脑 —— 连地址都不用填
- 广播内容带 `addresses` 字段是因为：本机可能有多张网卡（含虚拟网卡），
  广播来源 IP 不一定是手机能连的那个，要让客户端自己挑
- 可配置开关（`discovery.enabled`，默认开）；失败静默降级

**配置化动作（不用改代码就能加按钮）**
- `config.json` 里加一行即可：
  ```json
  { "customActions": { "enabled": true, "list": [
      { "id": "lock_screen", "label": "锁屏",
        "command": "rundll32.exe user32.dll,LockWorkStation" }
  ]}}
  ```
- 非法 id 自动规范化；缺字段的条目静默跳过；不覆盖内置指令
- **默认 `enabled: false`**（安全默认 —— 开了才执行）

**环境自检** `node src/doctor.js`
- 12 项检查：Node 版本 / 端口（能区分"本服务在跑"和"被别的程序占了"）/
  网络地址（局域网 / Tailscale / 虚拟网卡分别标注）/ 高德 key /
  目录写权限 / 前端资源完整性 / 依赖情况
- 输出「建议」与「下一步」

**内置帮助页** `/pages/help.html`
- 9 个常见问题的排查步骤（连不上 / 很慢 / 断线 / 收不到推送 /
  位置偏差 / 高德 key / 传文件报错 / 开机自启 / 想加功能）

**启动即见二维码**
- 服务端启动时在终端打印二维码（Unicode 半格字符渲染）
- 自动挑一个手机能连的地址（局域网优先），并列出其他可用地址

**优雅退出**
- 挂 SIGINT / SIGTERM / beforeExit：保存数据再退出（防 Ctrl+C 丢最近的改动）

****零依赖 QR 编码器**（`public/qr.js`）
- Byte mode + ECC L + 版本 1-9（最多 230 字节）
- 完整实现 Reed-Solomon 纠错、掩码选择、格式信息
- 用 Python `qrcode` 标准库**逐格交叉验证**（5 用例 × 8 掩码，全 0 差异）

**dsh 插件**
- Host half：服务生命周期管理、状态查询、配置读写、诊断信息
- Client half：设置页面板
- 零 npm 依赖

**Android 客户端**（`android/`）
- 全屏 WebView 壳 + 原生桥（定位 / 拍照 / 相册 / 文件）
- 系统通知（SSE 长连接 + 断线重连）
- 网页浮层（独立 WebView，自带 cookie）
- **首次配置页**（粘贴完整地址，自动解析出地址与口令）
- 手工构建链（不需要 Gradle / Android Studio）

**文档**
- `AGENTS.md` —— 给 AI 助手的部署剧本（含配置向导问答树）
- `docs/PITFALLS.md` —— **72 条实测坑**
- `docs/TROUBLESHOOT.md` —— 排障决策树
- `docs/ONBOARDING.md` —— 上手引导
- `docs/FOR-AI-EXTEND.md` —— 给 AI 的扩展指南
- `docs/ARCHITECTURE.md` —— 架构说明
- `docs/SECURITY.md` —— 安全说明

**测试**（64 项，全绿）
- `test/integration.mjs` —— 端到端集成（16 项）
- `test/transfer.mjs` —— 文件互传 + 安全边界（7 项）
- `test/qr-verify.mjs` —— QR 交叉验证（15 项）
- `test/discover-test.mjs` —— 局域网发现（7 项）
- `plugin/test/static.mjs` —— 插件静态检查（19 项）
- `test/stress.mjs` —— 压力测试（1639 条/秒，p99 18ms，0 丢失）

**检查工具**
- `scripts/preflight.mjs` —— 发布前检查（敏感扫描 + 测试 + 字段完整性）
- `scripts/lint-html.mjs` —— 前端静态检查（id 引用 / 死 API / 敏感信息）
- `scripts/lint-docs.mjs` —— 文档检查（死链 / 图片引用 / 坑数一致性）
- `scripts/stats.mjs` —— 项目统计

### 设计特点

- **零 npm 依赖** —— 只用 Node 内置模块
- **数据不出门** —— 服务端跑在用户自己电脑上
- **为 AI 设计** —— 文档面向 AI 助手，用户可以让自己的 AI 代劳

### 已知限制

- **Windows-only（部分）** —— `screenshot` / `show_desktop` 依赖 PowerShell + Win32
- **单用户** —— 没有多租户、没有用户系统
- **无 HTTPS** —— 依赖 Tailscale 或局域网
- **无数据库** —— JSON 文件存消息

### 源码规模

- 从 3493 行裁剪到 **1337 行**
- 删掉 45 个私人环境专用路由

---

## 计划中

- [ ] APK 客户端（WebView 壳 + 自动发现）
- [ ] 二维码显示（手机扫码访问）
- [ ] 跨平台支持（去 PowerShell 依赖）
- [ ] 更完整的插件设置页
