// routes/chat.js —— 会话页（在手机上跟电脑里的 AI 对话）
//
// ⭐⭐ 核心认知：**手机只是中转**。模型、会话、推理、上下文全在电脑的 dsh 里，
//    手机不跑模型、不存会话。链路：
//
//      手机 ──POST /api/chat──> hub ──spawn──> 桥 ──HTTP RPC──> dsh
//                                              └──POST /api/delta──> hub ──SSE──> 手机
//
//    本文件只做 HTTP 那一层；桥的事在 src/dsh/bridge.js。
//
// 接口：
//   GET  /api/sessions   会话列表（**已过滤掉 dsh 的幽灵会话**，见下）
//   GET  /api/busy       忙锁：现在有没有一轮正在跑（"生成中"的唯一真相）
//   POST /api/chat       手机发一句话 → 起桥
//   POST /api/delta      桥回传增量（逐字/思考/收尾）
//   POST /api/stop       一点即停
//
// ⚠️ 整个模块受 config.dsh.enabled 控制：没开就一律 404，
//    这样没装 dsh 的用户不会碰到任何相关入口（前端也据此隐藏按钮）。

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const { config } = require('../config');
const {
  addMessage, addMessageCore, insertMessage, messages,
  streams, sseSend, json, readBody, log,
} = require('../store');

const BRIDGE = path.join(__dirname, '..', 'dsh', 'bridge.js');

// ---------- 小工具 ----------

function dshEnabled() {
  return !!(config.dsh && config.dsh.enabled);
}

/** 调 dsh 的 HTTP RPC。格式（实测逆向出来的，动它没好处）：
 *    POST /api/<method>
 *    { type:'client-request', rpcId, method, payload:{ args } }
 *    参数名有讲究：session/list 要包 { _request:{} }，其余是 { request:{...} }
 */
function dshRpc(method, args, timeoutMs = 15000) {
  const auth = require('../dsh/auth');
  return new Promise((resolve) => {
    let headers;
    try {
      headers = auth.rpcHeaders();
    } catch (e) {
      return resolve({ status: 0, error: '鉴权头生成失败: ' + e.message });
    }
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: `hub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload: { args: args || {} },
    });
    const u = new URL(config.dsh.base || 'http://127.0.0.1:3080');
    const req = http.request({
      host: u.hostname,
      port: u.port || 3080,
      path: `/api/${method}`,
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        headers
      ),
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let j = null;
        try { j = JSON.parse(raw); } catch (e) { /* 保持 null */ }
        resolve({ status: res.statusCode, json: j, raw });
      });
    });
    req.on('error', (e) => resolve({ status: 0, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, error: '超时' }); });
    req.write(body);
    req.end();
  });
}

/**
 * ⭐ 扫磁盘，拿到"真实存在"的会话 id 集合。
 *
 * 为什么需要它：dsh 有一份会话投影缓存（storages/session_projcache.json），
 * **删会话时缓存不跟着清** ⇒ session/list 会把早就删掉的会话照样吐出来
 * （实测：磁盘上 3 个，接口返回 6 个，多出来的 3 个连文件都没有）。
 *
 * 解法是"不信接口，信磁盘"：sessions/<分组>/<sessionId>/session.v3.jsonl.zstd
 * 存在才算活会话。好处是不用去逆向 dsh 那套目录编码规则（--D-ccd--、~542F~ 之类）。
 */
function liveSessionIds() {
  const ids = new Set();
  let home = '';
  try {
    home = require('../dsh/auth').resolveDshHome();
  } catch (e) { return ids; }
  if (!home) return ids;

  const base = path.join(home, 'sessions');
  let groups = [];
  try { groups = fs.readdirSync(base); } catch (e) { return ids; }

  for (const g of groups) {
    const gp = path.join(base, g);
    let st;
    try { st = fs.statSync(gp); } catch (e) { continue; }
    if (!st.isDirectory()) continue;
    let subs = [];
    try { subs = fs.readdirSync(gp); } catch (e) { continue; }
    for (const sid of subs) {
      if (fs.existsSync(path.join(gp, sid, 'session.v3.jsonl.zstd'))) {
        ids.add(sid.replace(/^session-/, ''));
      }
    }
  }
  return ids;
}

/** 把 dsh 的会话条目转成给手机的瘦身结构（别把 projections 那一大坨全送过去）。 */
function slimSession(x) {
  const pv = (x && x.projections && x.projections.values) || {};
  const tu = pv.tokenUsage || {};
  return {
    id: String(x.sessionId || '').replace(/^session-/, ''),
    title: pv.title || '',
    cwd: x.cwd || '',
    running: !!x.running,
    blank: !!x.blank,
    updatedAt: x.updatedAt || 0,
    tokens: {
      in: tu.uncachedInputTokens || 0,
      out: tu.outputTokens || 0,
      cacheRead: tu.cacheReadTokens || 0,
    },
    turns: (pv.sessionStats && pv.sessionStats.turns) || 0,
  };
}

// ---------- 桥的忙锁 ----------
// 桥每跑一轮会写 state 文件。这里读它 + 探活 PID：
// 桥被强杀时跑不到 finally，锁会留在文件里 ⇒ 必须靠 PID 探活自愈，
// 否则页面会永远显示"生成中"。
function bridgeStatePath() {
  return path.join(config.absRoot || path.join(__dirname, '..', '..'), 'dsh-state.json');
}

function readBridgeState() {
  try {
    return JSON.parse(fs.readFileSync(bridgeStatePath(), 'utf8'));
  } catch (e) {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';   // 存在但没权限 == 活着
  }
}

function busyNow() {
  const st = readBridgeState();
  if (!st || !st.busy) return { busy: false, since: 0, pid: 0 };
  const alive = pidAlive(st.pid);
  if (!alive) {
    // 陈旧锁：清掉，别让页面卡在"生成中"
    try {
      fs.writeFileSync(bridgeStatePath(), JSON.stringify({ busy: false, pid: 0, stale: st.pid }), 'utf8');
    } catch (e) { /* 忽略 */ }
    log(`⚠ 忙锁陈旧（PID ${st.pid} 已不在）→ 自动清除`);
    return { busy: false, since: 0, pid: 0, staleCleared: st.pid };
  }
  return { busy: true, since: st.since || 0, pid: st.pid };
}

// ---------- 已停用的丢包窗口 ----------
// 点了"停"之后，桥可能还有几个包在路上。这段窗口内直接丢弃，
// 免得停了之后屏幕上还在冒字。（生产版踩过的坑，照搬）
let abortUntil = 0;

// ---------- 路由 ----------

async function handle(req, res, url, p) {
  if (!p.startsWith('/api/sessions') && !p.startsWith('/api/busy') &&
      !p.startsWith('/api/chat') && !p.startsWith('/api/delta') &&
      !p.startsWith('/api/stop')) {
    return false;
  }

  // 没开 dsh 就当这些接口不存在
  if (!dshEnabled()) {
    if (p === '/api/sessions' || p === '/api/busy') {
      return json(res, 404, { ok: false, error: '会话功能未启用（config.json 里设 dsh.enabled = true）' });
    }
    return json(res, 404, { ok: false, error: '会话功能未启用' });
  }

  // ---------- 会话列表 ----------
  if (p === '/api/sessions' && req.method === 'GET') {
    const r = await dshRpc('session/list', { _request: {} });
    if (r.status !== 200 || !r.json) {
      return json(res, 502, { ok: false, error: 'dsh 没应答：' + (r.error || ('HTTP ' + r.status)) });
    }
    const all = (r.json.result && r.json.result.value && r.json.result.value.items) || [];
    const live = liveSessionIds();
    const sessions = all
      .filter((x) => live.has(String(x.sessionId || '').replace(/^session-/, '')))
      .map(slimSession)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    const ghosts = all.length - sessions.length;
    if (ghosts > 0) log(`会话列表：dsh 返回 ${all.length} 个，过滤掉 ${ghosts} 个已删除的幽灵`);

    const st = readBridgeState();
    return json(res, 200, {
      ok: true,
      current: (st && st.sharedSid) || '',
      sessions,
      filteredGhosts: ghosts,
    });
  }

  // ---------- 忙锁 ----------
  if (p === '/api/busy' && req.method === 'GET') {
    const b = busyNow();
    return json(res, 200, Object.assign({ ok: true }, b));
  }

  // ---------- 发消息 / 回传 / 停：等桥就绪后再启用 ----------
  // （M1 的桥由 op 在裁，接口先占好位，桥到位就能用）
  if (p === '/api/chat' || p === '/api/delta' || p === '/api/stop') {
    if (!fs.existsSync(BRIDGE)) {
      return json(res, 503, { ok: false, error: '桥还没就绪（src/dsh/bridge.js 尚未生成）' });
    }
  }

  return false;
}

function register(server, cfg) {
  server.addRoute(handle);
}

module.exports = { register, dshRpc, liveSessionIds, slimSession, busyNow, bridgeStatePath };
