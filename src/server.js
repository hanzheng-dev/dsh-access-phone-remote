// server.js —— 入口：请求预处理 + 通用小路由 + 路由挂载 + listen
//
// 组装（各模块职责见文件头注释）：
//   config.js            配置读取（config.json + 环境变量覆盖）
//   store.js             共享内存态（messages / sseClients / streams / pending）+ HTTP 小工具
//   commands.js          5 条指令
//   routes/auth.js       鉴权（checkAuth / 登录页 / token）
//   routes/push.js       /api/events · /api/inbox · /api/push
//   routes/file.js       /api/file · /api/file/save · /api/upload + 静态资源
//   routes/loc.js        /api/loc · /api/nav-config · /api/poi · /api/route
//
// ⚠️ 可加载性：本文件在 require() 时**只建 server、不 listen**。
//    只有 `node src/server.js`（require.main === module）才真正监听端口。
//    ⇒ 自动化测试可以 `require('./src/server.js')` 拿到 server 做冒烟，不占用生产端口。

'use strict';

const http = require('http');
const { config } = require('./config');
const { COMMANDS } = require('./commands');
const {
  messages, addMessage, json, readBody, log, loadStore, htmlVersion, saveStore,
} = require('./store');
const auth = require('./routes/auth');
const loc = require('./routes/loc');
const push = require('./routes/push');
const file = require('./routes/file');
const addresses = require('./routes/addresses');
const chat = require('./routes/chat');
const costRoute = require('./routes/cost');
const cost = require('./cost');
const { printTerminalQR } = require('./terminal-qr');
const discover = require('./discover');

// 启动时载入消息池（读盘，不监听；不存在则空池）
loadStore();

// ---------- 路由表 ----------
// 各路由模块通过 server.addRoute(fn) 挂进来；fn(req,res,url,p) 返回 true = 已处理。
const routes = [];

function createServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // 非浏览器请求记录（脚本 / 程序打的接口，便于排查）
    {
      const ua = String(req.headers['user-agent'] || '');
      const isBrowser = /Mozilla\/5\.0|AppleWebKit|Chrome|Safari|Firefox|Edg\//i.test(ua);
      if (!isBrowser) {
        const ip = String((req.socket && req.socket.remoteAddress) || '').replace('::ffff:', '');
        const side = (ip === '127.0.0.1' || ip === '::1') ? '本机' : '远程';
        log(`🔌 非浏览器请求: ${req.method} ${p} 来自 ${ip}(${side}) UA=${ua.slice(0, 60) || '(空)'}`);
      }
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      });
      return res.end();
    }

    try {
      // 鉴权（OPTIONS / /api/ping / 回环 / Cookie / ?t= / X-Auth / 口令页 全在 auth 模块里）
      // ⚠️ checkAuth 返回 false 表示"它已经把响应写完了" ⇒ 必须立刻 return，不能再写。
      if (!auth.checkAuth(req, res, url, p)) return;

      // ---------- 通用小路由（不依赖具体业务模块） ----------
      if (p === '/api/ping') {
        // product 字段用来区分「本服务」和「别的 hub」—— 自检脚本靠它判断
        return json(res, 200, {
          ok: true, product: 'dsh-access-phone-remote', service: 'hub', version: 2, ts: Date.now(),
        });
      }
      if (p === '/favicon.ico') {                                  // 浏览器自动请求，别留 404
        res.writeHead(204);
        return res.end();
      }
      if (p === '/api/version') {                                  // 页面自检用：变了就自动重载
        return json(res, 200, { ok: true, version: htmlVersion() });
      }
      if (p === '/api/features' && req.method === 'GET') {         // 功能开关（config.features）
        // 前端启动时读它决定各入口显不显示；页面优先用注入的 window.__DSJ_FEATURES__，
        // 没有全局时再走这个接口（两种对接方式都兼容）。
        // 默认全 false ⇒ 页面行为不变、关掉的功能连入口都不出现。
        return json(res, 200, { ok: true, features: config.features || {} });
      }
      if (p === '/api/commands') {                                 // 指令列表（给前端画界面）
        const list = COMMANDS.map((c) => ({
          id: c.id, label: c.label, group: c.group,
          desc: c.desc, confirm: !!c.confirm,
        }));
        return json(res, 200, { ok: true, commands: list });
      }

      // 执行指令（stop 走 commands.js 的占位实现，不再特判）
      if (p === '/api/run' && req.method === 'POST') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const id = String(body.id || '');
        const cmd = COMMANDS.find((c) => c.id === id);
        if (!cmd) return json(res, 400, { ok: false, text: '未知指令: ' + id });
        log(`▶ 执行 ${id}`);
        try {
          const r = await cmd.run(body.payload || {});
          log(`  ${r.ok ? '✓' : '✗'} ${String(r.text).slice(0, 80)}`);
          addMessage('pc', r.text, 'result', r.image ? { image: r.image } : {});
          return json(res, 200, { ok: r.ok, text: r.text, image: r.image || null });
        } catch (e) {
          log('  ✗ 异常: ' + e.message);
          return json(res, 500, { ok: false, text: '执行出错: ' + e.message });
        }
      }

      // ---------- 业务路由（按注册顺序，命中即 return） ----------
      for (const route of routes) {
        if (await route(req, res, url, p)) return;
      }

      // ---------- 后端状态页（给电脑看） ----------
      if (p === '/status-page') {
        const html = `<!doctype html><meta charset="utf-8"><title>dsh-access-phone-remote · 电脑端</title>
<style>
body{font-family:system-ui,-apple-system;background:#111;color:#ddd;padding:24px;line-height:1.8;max-width:720px}
h1{font-size:19px;font-weight:600;letter-spacing:.5px}
.ok{color:#4ade80}.dim{color:#888}
.card{border:1px solid #333;border-radius:10px;padding:14px 16px;margin:12px 0}
code{background:#1c1c1c;border:1px solid #2a2a2a;padding:1px 6px;border-radius:4px;font-size:12px}
</style>
<h1>📱 dsh-access-phone-remote · 电脑端服务</h1>
<p class="ok">● 运行中　<span class="dim">监听 ${config.listenHost}:${config.port}</span></p>
<div class="card">
<p>功能数：<b>${COMMANDS.length}</b>　消息数：${messages.length}</p>
<p class="dim">健康检查：<code>/api/ping</code></p>
</div>
<div class="card">
<p class="dim">接口</p>
<p><code>/api/ping</code> <code>/api/commands</code> <code>/api/run</code> <code>/api/inbox</code> <code>/api/push</code> <code>/api/file</code> <code>/api/loc</code></p>
</div>`;
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(html);
      }

      return json(res, 404, { ok: false, error: 'not found' });
    } catch (e) {
      log('请求出错: ' + e.message);
      // 兜底：响应头若已发出，绝不能再写一次（再写会 throw，进程会退出）
      if (res.headersSent) { try { res.end(); } catch (_) { /* ignore */ } return; }
      return json(res, 500, { ok: false, error: e.message });
    }
  });

  // 路由模块用这个把处理函数挂进路由表
  server.addRoute = (fn) => { routes.push(fn); return server; };
  return server;
}

const server = createServer();

// 挂载业务路由
loc.register(server, config);
push.register(server, config);
file.register(server, config);
addresses.register(server, config);
// 会话页（在手机上跟电脑的 AI 对话）—— 受 config.dsh.enabled 控制，
// 没开时它的全部接口一律 404，前端也据此隐藏入口。
chat.register(server, config);
// 余额 / 花费（对话页「生成中…」上面那一行）
costRoute.register(server);

// ⭐ 把 sessions 目录告诉 cost.js —— **不要硬编码**，跟着配置走。
//   config.dsh.home 留空时走自动探测（跟桥用的是同一套 resolveDshHome）。
try {
  const dshHome = config.dsh.home || require('./dsh/auth').resolveDshHome();
  if (dshHome) cost.setSessRoot(require('path').join(dshHome, 'sessions'));
} catch (e) { /* 探测不到就算了：花费会显示 0，不影响其它功能 */ }

// ⚠️ 启动时先把「本轮起点」游标对到**现在** —— 否则它是 0，
//    readSince(0) 会把整个会话文件解一遍，页面看到「本次 ¥104」这种历史总花费的假数字。
try { cost.markTurnStart(); } catch (e) { /* 忽略 */ }

module.exports = { server, config };

// ⛔ 只有直接运行时才监听；被 require（自动化测试）时不占端口。
if (require.main === module) {
  server.listen(config.port, config.listenHost, () => {
    log(`===== dsh-access-phone-remote 启动，监听 ${config.listenHost}:${config.port}，功能 ${COMMANDS.length} 个 =====`);
    log(`本机: http://127.0.0.1:${config.port}/`);

    // ---- 给手机用的地址 + 终端二维码 ----
    // 挑一个手机能连的地址（局域网优先），直接把二维码打在终端里，省得开浏览器
    try {
      const list = addresses.listAddresses();
      const best = list.find((a) => a.kind === 'lan') || list.find((a) => a.kind !== 'loopback');
      const token = (() => {
        try { return fs.readFileSync(config.tokenFile, 'utf8').trim(); } catch { return ''; }
      })();

      if (best) {
        const url = `http://${best.ip}:${config.port}/` + (token ? `?t=${token}` : '');
        log(`手机访问: ${url}`);
        process.stdout.write('\n  手机扫这个（或复制上面那行）:\n\n');
        printTerminalQR(url);
        if (list.length > 1) {
          const others = list.filter((a) => a.ip !== best.ip).map((a) => `${a.ip}(${a.kind})`).join('  ');
          log(`其他可用地址: ${others}`);
        }
      } else {
        log('⚠️ 没找到可给手机用的地址（可能只有回环）');
      }
    } catch (e) {
      log(`（二维码生成失败，不影响使用: ${e.message}）`);
      log(`页面首次访问带口令: http://<地址>:${config.port}/?t=<token>（见 .hub-token）`);
    }

    // ---- 局域网自动发现（UDP 广播）----
    // 手机 App 在同一 WiFi 下能自动找到本机，省去手输地址
    try {
      const dc = config.discovery || {};
      if (dc.enabled !== false) {
        const r = discover.start(config, { intervalMs: dc.intervalMs });
        if (r.started) {
          log(`局域网自动发现: 已开启（UDP 广播 ${r.port}，每 ${(dc.intervalMs || 3000) / 1000}s 一次）`);
        } else {
          log(`局域网自动发现: 未启用（${r.reason}）`);
        }
        process.on('exit', () => r.stop());
      } else {
        log('局域网自动发现: 配置里关掉了');
      }
    } catch (e) {
      log(`（自动发现启动失败，不影响使用: ${e.message}）`);
    }
  });

  // ---- 优雅退出 ----
  // store 的保存有 1 秒防抖（scheduleSave），如果不处理信号，
  // 在这 1 秒内被 Ctrl+C / kill 会丢掉最近的改动。这里补上。
  let exiting = false;
  const gracefulExit = (sig) => {
    if (exiting) return;
    exiting = true;
    try {
      saveStore();
      log(`收到 ${sig}，已保存数据，退出`);
    } catch (e) {
      log(`退出时保存失败: ${e.message}`);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => gracefulExit('SIGINT'));
  process.on('SIGTERM', () => gracefulExit('SIGTERM'));
  // 兜底：正常退出路径也存一次（不含 SIGKILL —— 那个拦不住）
  process.on('beforeExit', () => {
    if (!exiting) { try { saveStore(); } catch { } }
  });
}
