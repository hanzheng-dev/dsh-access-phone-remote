# 上手引导

> 装完之后该怎么用。**用户看这份，AI 也看这份。**

---

## 你刚装完，现在在哪

```
✅ 服务端已装好
❓ 还差：让手机能连上
❓ 可选：位置功能、APK、开机自启
```

**跟着下面走，5 分钟能通。**

---

## 第 1 步：启动服务（1 分钟）

```bash
cd <项目目录>
node src/server.js
```

**你会看到**：
```
🔐 已生成新的访问 token -> <项目目录>/.hub-token
本机: http://127.0.0.1:3099/
```

**⚠️ 记下那个 token** —— 手机访问要用。

**⚠️ 如果关掉终端服务就没了** → 见下面"让它常驻"。

---

## 第 2 步：让手机连上（2 分钟）

### 选 A：只在家里用（最简单）

**在电脑上查内网 IP**：
```bash
ipconfig
```
找 `IPv4 地址`，形如 `192.168.1.100`。

**手机浏览器打开**：
```
http://192.168.1.100:3099/?t=<你的token>
```

**⚠️ 打不开？** 大概率是防火墙：
```bash
# 管理员运行
netsh advfirewall firewall add rule name="dsj" dir=in action=allow protocol=TCP localport=3099
```

### 选 B：在外面也能用（Tailscale）

1. 电脑和手机**都装 Tailscale**，登录**同一个账号**
2. 电脑上查 Tailscale IP：
   ```bash
   tailscale ip -4
   ```
3. 手机打开：
   ```
   http://100.x.x.x:3099/?t=<你的token>
   ```

**⚠️ 三个必踩的坑**：
| 坑 | 症状 | 解法 |
|---|---|---|
| Tailscale 抢 DNS | 能 ping 通但打不开域名 | 关掉「Use Tailscale DNS」 |
| 刚切网 | 1-2 分钟连不上 | 等一下 |
| 手机后台被杀 | 过一会就断 | 加电池白名单 |

---

## 第 3 步：验证通了（30 秒）

**手机上应该看到一个控制台页面。**

**试一下推送**：电脑上执行
```bash
node -e "
const http=require('http');
const body=JSON.stringify({text:'测试：如果你手机收到这条，说明通了！'});
const r=http.request({hostname:'127.0.0.1',port:3099,path:'/api/push',method:'POST',
  headers:{'Content-Type':'application/json','Content-Length':body.length}},res=>console.log(res.statusCode));
r.write(body); r.end();
"
```

**手机页面应该出现这条消息。**

---

## 第 4 步：让它常驻（可选，但强烈建议）

**问题**：前面那样起的服务，**终端一关就死了**。

**解法**（Windows 计划任务）：
```bash
schtasks /Create /TN "dsj-open" /TR "node D:\path\to\src\server.js" /SC ONLOGON /RL HIGHEST /F
```

**⚠️ 千万不要**：
- 用 `start` 或 `nohup` 后台运行（会随终端死）
- 用 `.bat` 且**是 LF 换行**（整个脚本会静默失效）

---

## 第 5 步：配置你的第一个指令（可选）

**默认的指令**：`status` / `screenshot` / `show_desktop` / `stop`

**加一个自己的**：编辑 `src/commands.js`，在 `COMMANDS` 数组里加：
```javascript
{
  id: 'hello',
  label: '打个招呼',
  group: '控制',
  run: async () => ({ ok: true, text: '你好！' })
}
```
**存盘 → 重启服务 → 页面上就多一个按钮。**

---

## 第 6 步：位置功能（可选）

**需要高德 key**：
1. 去 https://lbs.amap.com/ 注册
2. 创建应用，**申请两个 key**：
   - **Web 服务**（后端用）
   - **Web 端 JS API**（页面用）
3. 填进 `config.json`：
   ```json
   {
     "amap": {
       "webKey": "你的Web服务key",
       "jsKey": "你的JS API key",
       "jsSecurityCode": "你的安全密钥"
     }
   }
   ```

**⚠️ 位置偏 500 米？** 那是坐标系问题（WGS84 vs GCJ02），项目已处理，但如果你改了代码要注意。

---

## 第 7 步：APK（可选，体验更好）

**为什么装 APK**：
- 有系统通知（不是网页提示）
- 有后台保活
- 体验像原生 App

**怎么装**：
```bash
adb install dsj-open.apk
```

**⚠️ 装完要**：
1. 允许通知权限（Android 13+ 必须**主动允许**）
2. 加入电池白名单（否则后台被杀）

---

## 常见"然后呢"

| 你想 | 怎么做 |
|---|---|
| **看服务状态** | 页面上点「状态」，或 `curl 127.0.0.1:3099/api/ping` |
| **改端口** | 改 `config.json` 的 `port` |
| **换 token** | 删掉 `.hub-token`，重启服务 |
| **加白名单目录** | 改 `config.json` 的 `allowDirs` |
| **看日志** | 服务端的终端输出 |
| **出问题了** | 看 `docs/TROUBLESHOOT.md` |

---

## 你的 AI 能帮你什么

**如果你在用 dsh / Claude / ChatGPT 等 AI 助手**：

> **把这个项目的 `AGENTS.md` 和 `docs/PITFALLS.md` 丢给它。**
>
> 它就能：
> - 带你一步步部署
> - 判断你的环境缺什么
> - 遇到报错时查坑清单解决

**这份文档和 `AGENTS.md` 的分工**：
- **本文** = 用户视角（我要干什么）
- **`AGENTS.md`** = AI 视角（我该问什么、怎么判断）
- **`docs/TROUBLESHOOT.md`** = 排障决策树（出错了怎么查）

---

## 检查清单

装完之后，对照一下：

- [ ] 服务能起来
- [ ] 本机能访问 `http://127.0.0.1:3099/`
- [ ] 手机能访问
- [ ] 推送能收到
- [ ] （可选）开机自启配好
- [ ] （可选）位置功能配好
- [ ] （可选）APK 装好

**全打勾 = 装完了。**
