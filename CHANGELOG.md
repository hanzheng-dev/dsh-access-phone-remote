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

**dsh 插件**
- Host half：服务生命周期管理、状态查询、配置读写、诊断信息
- Client half：设置页面板
- 零 npm 依赖

**文档**
- `AGENTS.md` —— 给 AI 助手的部署剧本
- `docs/PITFALLS.md` —— **69 条实测坑**
- `docs/TROUBLESHOOT.md` —— 排障决策树
- `docs/ONBOARDING.md` —— 上手引导
- `docs/FOR-AI-EXTEND.md` —— 给 AI 的扩展指南
- `docs/ARCHITECTURE.md` —— 架构说明
- `docs/SECURITY.md` —— 安全说明

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
