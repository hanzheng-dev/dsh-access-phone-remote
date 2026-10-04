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

**零依赖 QR 编码器**（`public/qr.js`）
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
- `docs/PITFALLS.md` —— **70 条实测坑**
- `docs/TROUBLESHOOT.md` —— 排障决策树
- `docs/ONBOARDING.md` —— 上手引导
- `docs/FOR-AI-EXTEND.md` —— 给 AI 的扩展指南
- `docs/ARCHITECTURE.md` —— 架构说明
- `docs/SECURITY.md` —— 安全说明

**测试**（50 项，全绿）
- `test/integration.mjs` —— 端到端集成（16 项）
- `test/qr-verify.mjs` —— QR 交叉验证（15 项）
- `plugin/test/static.mjs` —— 插件静态检查（19 项）
- `scripts/preflight.mjs` —— 发布前检查（敏感扫描 + 测试 + 字段完整性）

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
