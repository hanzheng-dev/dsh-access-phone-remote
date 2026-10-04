# 贡献指南

**欢迎贡献。** 但在动手之前，请先读这份。

---

## 最重要的一条

> **改代码之前，先读 `docs/PITFALLS.md`。**

那 70 条坑是**真金白银换来的**（两个月、无数次踩坑）。不读就改，大概率重踩。

**几个例子**：
- 改 Windows 启动脚本？先看 P32（LF 换行）和 P48（闪黑框）
- 改 APK？先看 P24（d8 崩溃）
- 改位置功能？先看 P15（坐标系）
- 加网络功能？先看 P31（进程树）

---

## 开发环境

```sh
git clone <仓库地址>
cd dsj-open
node src/server.js
```

**不需要 `npm install`** —— 本项目零依赖。

**要求**：Node.js >= 20

---

## 项目结构

```
src/
├── server.js       入口：组装路由 + listen
├── config.js       配置加载
├── store.js        共享状态（谁都能 require）
├── commands.js     指令白名单
└── routes/
    ├── auth.js     鉴权
    ├── push.js     /api/push /api/inbox /api/events
    ├── file.js     /api/file /api/upload + 静态
    └── loc.js      /api/loc /api/poi /api/route

plugin/             dsh 插件（host + client half）
public/             前端页面
docs/               文档
```

---

## 改代码的规矩

### 1. 不要引入 npm 依赖

**"零依赖"是本项目的核心卖点之一。**

如果你觉得非加不可，**先在 issue 里讨论**。

### 2. 所有路径必须走 config

**不要硬编码路径。** 生产版的教训就是到处是硬编码。

```javascript
// ❌ 错
const dir = 'D:\\my-folder'

// ✅ 对
const dir = config.uploadsPath
```

### 3. 别删"看起来没用"的代码

有些代码是**为了兼容性或边界情况**留的。

删之前先 `grep` 一下有没有引用。

### 4. 一次只做一件事

**不要在一个 PR 里混好几件事。** 那样没法 review。

---

## 提交前必做

### 语法检查

```sh
npm run check
```

（它会遍历 `src/**/*.js` 做 `node --check`）

### 敏感信息扫描

**确保没有提交敏感信息**：

```sh
git diff --cached | grep -E "token|password|secret|100\.|192\.168"
```

**⚠️ 绝对不要提交**：
- `config.json`
- `.hub-token`
- 你的内网 IP / Tailscale IP
- 任何密码、token

**这些都已经在 `.gitignore` 里了，但改文件时要小心。**

### 测一下能不能加载

```sh
node -e "require('./src/server.js'); console.log('OK')"
```

**不应该启动监听**（`server.js` 有 `require.main === module` 守卫）。

---

## 提 PR

### PR 标题格式

```
fix: 修 xxx          （修 bug）
feat: 加 xxx         （新功能）
docs: 改 xxx         （文档）
refactor: 重构 xxx   （重构）
```

### PR 描述里写

1. **改了什么**
2. **为什么改**
3. **怎么测的**
4. **有没有踩到 PITFALLS 里的坑**

---

## 提 issue

### Bug 报告

**请附上**：
- 你的环境（系统版本、Node 版本）
- 完整的报错文本
- 做了什么操作导致的
- **`docs/PITFALLS.md` 里查过了吗**

### 功能建议

**请说明**：
- 你想解决什么问题（不是"我想要个 xxx 功能"）
- 现在的做法是什么、为什么不满意

---

## 如果你发现了一个新坑

**太好了 —— 这正是本项目最需要的东西。**

**请提 PR 往 `docs/PITFALLS.md` 加一条**，格式：

```markdown
## P<下一个编号> · <一句话描述>

**症状**：用户看到什么

**根因**：为什么

**解法**：怎么修

**来源**：（可选）哪个 issue / PR
```

**带"症状 → 根因 → 解法"的坑，比什么都值钱。**

---

## 给 AI 助手的贡献

**如果你是一个 AI 助手，正在帮用户改这个项目**：

1. **先读 `docs/FOR-AI-EXTEND.md`** —— 那里面有加功能的流程
2. **改之前读 `docs/PITFALLS.md`**
3. **改完按上面的"提交前必做"验证**

---

## 许可

贡献的代码将按 MIT 协议发布。
