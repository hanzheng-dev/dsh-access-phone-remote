// routes/chat.js —— 会话页（在手机上跟电脑里的 AI 对话）
//
// ⭐⭐ 核心认知：**手机只是中转**。模型、会话、推理、上下文全在电脑的 dsh 里，
//    手机不跑模型、不存会话。链路：
//
//      手机 ──POST /api/chat──> hub ──spawn──> 桥 ──HTTP RPC──> dsh
//                                              └──POST /api/delta──> hub ──SSE──> 手机
//
//    本文件只做 HTTP 那一层；跟 dsh 打交道的活在 src/dsh/bridge.js。
//
// 接口：
//   GET  /api/sessions   会话列表（**已过滤 dsh 的幽灵会话**）
//   GET  /api/busy       忙锁（"生成中"的唯一真相）
//   POST /api/chat       手机发一句话 → 起桥
//   POST /api/delta      桥回传增量（逐字 / 思考 / 收尾）
//   POST /api/stop       一点即停
//
// ⚠️ 受 config.dsh.enabled 控制：没开就一律 404，前端也据此隐藏入口。
//
// 本文件的 delta/stop 逻辑**逐段照搬生产版**（hub-server.js L2812 起 / L2512 / L3345 起）——
// 那些坑（迟到尾字、按 seq 切段、给旧段补 end、丢包窗口、PID 复用误杀）都是真金白银换来的，
// 重构它们没有任何好处。

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');
const { config } = require('../config');
const cost = require('../cost');
const {
  addMessage, addMessageCore, insertMessage, messages,
  streams, sseSend, json, readBody, log, saveStore, scheduleSave,
  pendingConsume, buildHitchPrefix,
} = require('../store');

const BRIDGE = path.join(__dirname, '..', 'dsh', 'bridge.js');
const ABORT_WINDOW_MS = 90 * 1000;      // 按停后的丢包窗口
const STREAM_IDLE_MS = 120 * 1000;      // 僵尸流：多久没动静就强制收尾

// ---------- 运行时状态 ----------
let abortUntil = 0;                     // 丢包窗口截止时间
let busyOverrideUntil = 0;              // 按停后的"强制不忙"窗口（照生产版）
let lastBridgePid = null;               // 最近一次起的桥（按停时要杀它）
const splitBase = new Map();            // messageId → 切段时旧消息的长度（final 只取后半截）
const recentFinal = new Map();          // streamId → {id, ts}（迟到的尾字往这条上追加）

function dshEnabled() {
  return !!(config.dsh && config.dsh.enabled);
}

function inAbortWindow() {
  return Date.now() < abortUntil;
}

/** 新回合开始 / 按停窗口结束时调：清掉丢包窗口与强制不忙窗口。
 *  ⚠️ 不清丢包窗口的后果（生产版踩过）：上一轮按过停 ⇒ 这一轮桥推的 delta 会被
 *  `/api/delta` 开头那句 `inAbortWindow()` 全丢掉 ⇒ 屏幕上什么都不出。 */
function clearAbortWindow() {
  abortUntil = 0;
  busyOverrideUntil = 0;
}

// ---------- 跟 dsh 说话 ----------

/** 调 dsh 的 HTTP RPC。格式是实测逆向出来的：
 *    POST /api/<method>
 *    { type:'client-request', rpcId, method, payload:{ args } }
 *  参数名有讲究：session/list 要包 {_request:{}}，其余是 {request:{...}}。 */
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

// ---------- 会话列表 ----------

/**
 * ⭐ 扫磁盘拿"真实存在"的会话 id。
 *
 * dsh 有一份会话投影缓存（storages/session_projcache.json），**删会话时缓存不跟着清**
 * ⇒ session/list 会把早就删掉的会话照样吐出来（实测：磁盘 3 个、接口返回 6 个，
 * 多出来的连文件都没有）。
 *
 * 解法是"不信接口，信磁盘"：sessions/<分组>/<sessionId>/session.v3.jsonl.zstd 存在才算活的。
 * 好处是不用去逆向 dsh 那套目录编码规则（--D-ccd--、~542F~ 之类）。
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

function isAlive(pid) {
  try { process.kill(Number(pid), 0); return true; } catch (e) { return false; }
}

/**
 * ⭐ 这个 PID 到底是不是"我们的桥"？（防 PID 复用误杀）
 *
 * 生产版 2026-10-02 踩过：按停时按 PID 杀，而桥是 detached+unref 起的，
 * 跑完就走、PID 被系统回收再分配给别人 ⇒ 那一刀 SIGKILL 砍在**无辜进程**上，
 * 实证是把 hub 自己杀了（日志戛然而止，手机再也连不上）。
 *
 * 所以规则是：**查不到 / 不确定，一律不杀**。宁可停不掉，也不能杀错。
 *
 * ⚠️ 开源版的桥在 src/dsh/bridge.js（不含 "dsh-bridge" 字样），
 *    所以匹配式用 /dsh[\\/]bridge\.js/ 而不是原来的字符串包含。
 */
function isOurBridge(pid) {
  const n = Number(pid);
  if (!n || !Number.isFinite(n)) return { ok: false, why: 'PID 不合法' };
  if (n === process.pid) return { ok: false, why: '这是 hub 自己' };
  if (n === process.ppid) return { ok: false, why: '这是 hub 的父进程' };
  try {
    let cmdline = '';
    try {
      cmdline = execFileSync('powershell.exe',
        ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${n}").CommandLine`],
        { encoding: 'utf8', timeout: 4000, windowsHide: true });
    } catch (e1) {
      try {
        cmdline = execFileSync('wmic.exe', ['process', 'where', `ProcessId=${n}`, 'get', 'CommandLine'],
          { encoding: 'utf8', timeout: 3000, windowsHide: true });
      } catch (e2) { return { ok: false, why: '拿不到它的命令行（宁可不杀）' }; }
    }
    const s = String(cmdline || '');
    if (!s.trim()) return { ok: false, why: '命令行是空的（进程可能已走）' };
    if (/dsh[\\/]bridge\.js/i.test(s)) return { ok: true };
    return { ok: false, why: '它不是桥：' + s.trim().slice(0, 90) };
  } catch (e) {
    return { ok: false, why: '验明正身时出错：' + (e.message || e) };
  }
}

function busyNow() {
  const st = readBridgeState();
  if (!st || !st.busy) return { busy: false, since: 0, pid: 0 };
  if (!isAlive(st.pid)) {
    // 陈旧锁：桥被强杀时跑不到 finally，锁会留在文件里 ⇒ 必须靠 PID 探活自愈，
    // 否则页面永远卡在"生成中"。
    // ⚠️ 清锁时要**保留原有字段**（sharedSid / manualSwitchAt）——整份覆盖会把
    //    "手机跟的是哪个会话""显式切换保护期"一并冲掉。
    try {
      fs.writeFileSync(bridgeStatePath(),
        JSON.stringify(Object.assign({}, st, { busy: false, pid: 0, since: 0, stale: st.pid })), 'utf8');
    } catch (e) { /* 忽略 */ }
    log(`⚠ 忙锁陈旧（PID ${st.pid} 已不在）→ 自动清除`);
    return { busy: false, since: 0, pid: 0, staleCleared: st.pid };
  }
  return { busy: true, since: st.since || 0, pid: st.pid };
}

// ---------- 思考档位（features.effort）----------
//
// ⭐ 语义对齐 dsh：档位 = **每个会话自己的「模型座位」**（modelSelection），
//   读走 `session/list` 的投影，切走 `session/selectModel` —— 实时生效、不重启 dsh。
//   （settings.yaml 的 reasoningEffort 只是默认值，改它不生效 —— 生产版实测过。）
//
// ⚠️ 只能在会话**空闲**时切：DeepSeek 思考模式要求把上一条助手消息的 reasoning_content
//    原样回传（dsh-llm-deepseek 只在 reasoning 非空时才带这个字段）。一个回合跑到一半
//    从 high 切到 off（或反过来），下一步就会撞
//      `The reasoning_content in the thinking mode must be passed back to the API`
//    —— 生产版 2026-09-11 真栽过。所以忙时一律 409，绝不硬切。

const EFFORT_ALLOWED = ['off', 'low', 'high', 'max'];
let effortCache = { at: 0, value: null };   // GET 10 秒缓存（档位很少变，省一次 RPC）

function stripSid(s) {
  return String(s || '').replace(/^session-/, '');
}

/** 桥当前跟的会话（手机正在用的那个）—— 切档位优先切它。 */
function currentSessionId() {
  const st = readBridgeState();
  return (st && st.sharedSid) ? stripSid(st.sharedSid) : '';
}

/** 挑要切/读的会话：优先桥的共享会话，其次「磁盘上真实存在」的最近会话。 */
function pickEffortTarget(items) {
  const want = currentSessionId();
  if (want) {
    const hit = (items || []).find((x) => stripSid(x && x.sessionId) === want);
    if (hit) return hit;
  }
  const live = liveSessionIds();
  const usable = (items || []).filter((x) =>
    x && x.sessionId && live.has(stripSid(x.sessionId)) &&
    !/session-title|subagent/.test(x.kind || ''));
  if (!usable.length) return null;
  return usable.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
}

/** 多帧 zstd：dsh 的会话日志是「每次 flush 追一帧」，得按 magic 切开逐帧解（照生产版）。 */
function readLogText(file) {
  const buf = fs.readFileSync(file);
  const frames = [];
  let start = 0;
  for (let i = 0; i + 4 <= buf.length; i += 1) {
    if (buf[i] === 0x28 && buf[i + 1] === 0xb5 && buf[i + 2] === 0x2f && buf[i + 3] === 0xfd && i > start) {
      try {
        frames.push(zlib.zstdDecompressSync(buf.subarray(start, i)));
        start = i;
      } catch (e) { /* 压缩数据里恰好出现 magic */ }
    }
  }
  if (start < buf.length) {
    try { frames.push(zlib.zstdDecompressSync(buf.subarray(start))); } catch (e) { /* 半帧：忽略 */ }
  }
  return Buffer.concat(frames).toString('utf8');
}

/** 兜底：会话列表投影里没给 modelSelection 时，翻会话日志找最后一条 model/selection。 */
function lastSelectionFromLog(sessionId) {
  let home = '';
  try { home = require('../dsh/auth').resolveDshHome(); } catch (e) { return null; }
  if (!home || !sessionId) return null;
  const stack = [path.join(home, 'sessions')];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = path.join(dir, entry.name);
      if (stripSid(entry.name) !== sessionId) { stack.push(full); continue; }
      const file = path.join(full, 'session.v3.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      let found = null;
      for (const line of readLogText(file).split('\n')) {
        if (!line.includes('"model/selection"')) continue;
        try { found = JSON.parse(line).data; } catch (e) { /* 半行 */ }
      }
      if (found) return found;
    }
  }
  return null;
}

/** 读一个会话当前的模型座位（优先投影，兜底翻日志）。读不到返回 null。 */
function readSelection(item) {
  let cur = item && item.projections && item.projections.values && item.projections.values.modelSelection;
  cur = cur && cur.next ? cur.next : cur;
  if (!cur || !cur.provider || !cur.model) cur = lastSelectionFromLog(stripSid(item && item.sessionId));
  if (!cur || !cur.provider || !cur.model) return null;
  return cur;
}

async function fetchSessionItems() {
  const r = await dshRpc('session/list', { _request: {} });
  if (r.status !== 200 || !r.json) return null;
  return (r.json.result && r.json.result.value && r.json.result.value.items) || [];
}

// ---------- 停 ----------

/** 把所有开着的流立刻收尾（页面上的闪烁光标 /「生成中…」马上消失）。 */
function closeAllStreamsNow(why) {
  let n = 0;
  for (const [sid, id] of Array.from(streams.entries())) {
    streams.delete(sid);
    try { sseSend({ type: 'end', id }); } catch (e) { /* 忽略 */ }
    n++;
  }
  if (n) log(`🛑 收尾 ${n} 条流（${why}）`);
  return n;
}

/** 同步那一半：立丢包窗口 + 收流 + 广播不忙。必须**立刻返回**（别让按停卡住）。 */
function stopAllNow(why) {
  const t0 = Date.now();
  // ① 先立丢包窗口（先立！这样后面任何迟到的 delta 都进不来）+ 强制不忙窗口
  abortUntil = Date.now() + ABORT_WINDOW_MS;
  busyOverrideUntil = Date.now() + ABORT_WINDOW_MS;
  // ② 所有开着的流立刻收尾
  const n = closeAllStreamsNow(why);
  // ③ 告诉所有页面"不忙了"（不等下一次 /api/busy 轮询）
  try { sseSend({ type: 'busy', busy: false, stopped: true }); } catch (e) { /* 忽略 */ }
  const ms = Date.now() - t0;
  log(`🛑 激进停止：收尾 ${n} 条流 + 立 ${ABORT_WINDOW_MS / 1000}s 丢包窗口（同步耗时 ${ms}ms）`);
  return { n, ms };
}

/**
 * 异步那一半（丢后台，绝不挡 HTTP 返回）：
 *   ① 直连 dsh(3080) 调 session/cancel —— 这才是"真的停住我"
 *      ⚠️ **不走桥**！桥正忙时它的 rpc 要排队，那正是老实现慢的原因
 *   ② 兜底：杀掉"正忙的那条桥"（验明正身之后）
 * 两件都做，缺一不可：光杀桥 dsh 还在生成；光 cancel 桥还在推。
 */
async function stopDshTurn() {
  const st = readBridgeState();
  const sid = st ? (st.sharedSid || null) : null;
  if (sid) {
    try {
      const r = await Promise.race([
        dshRpc('session/cancel', { request: { sessionId: 'session-' + sid.replace(/^session-/, '') } }, 2500),
        new Promise((res) => setTimeout(() => res({ status: -1, raw: 'timeout(2.5s)' }), 2600)),
      ]);
      log(`🛑 cancel(${String(sid).slice(0, 18)}) → ${r.status} ${String(r.raw || '').slice(0, 60)}`);
    } catch (e) { log('🛑 cancel 异常: ' + e.message); }
  } else {
    log('🛑 拿不到会话 id（状态文件里没有）⇒ 只杀桥');
  }

  const pid = (lastBridgePid && isAlive(lastBridgePid)) ? lastBridgePid : (st && st.pid) || null;
  const verdict = isOurBridge(pid);
  if (pid && verdict.ok) {
    try { process.kill(Number(pid), 'SIGKILL'); log(`🛑 杀掉正忙的桥 PID ${pid}`); }
    catch (e) { log(`🛑 桥 PID ${pid} 杀不掉（${e.code || e.message}）`); }
    lastBridgePid = null;
  } else if (pid) {
    log(`🛑 拒绝杀 PID ${pid}：${verdict.why}（防 PID 复用误杀）`);
    lastBridgePid = null;
  } else {
    log('🛑 没找到活着的桥（可能已经收工）');
  }
}

// ---------- 僵尸流清理 ----------
// 桥被「停」杀掉时 finally 不执行 ⇒ hub 这边的 streams 记录永远留着
// ⇒ 页面永远显示「生成中…」+ 闪烁光标。每 30 秒扫一次，超时的当场收尾。
const sweep = setInterval(() => {
  const now = Date.now();
  let n = 0;
  for (const [sid, id] of Array.from(streams.entries())) {
    const m = messages.find((x) => x.id === id);
    if (!m) { streams.delete(sid); continue; }
    if (now - (m.ts || 0) > STREAM_IDLE_MS) {
      streams.delete(sid);
      try { sseSend({ type: 'end', id }); } catch (e) { /* 忽略 */ }
      n++;
    }
  }
  if (n) { saveStore(); log(`🧹 清理 ${n} 条超时没收尾的流（多半是桥被「停」杀了）`); }
}, 30000);
if (sweep.unref) sweep.unref();

// ---------- 路由 ----------

async function handle(req, res, url, p) {
  const mine = p === '/api/sessions' || p === '/api/busy' || p === '/api/chat' ||
               p === '/api/delta' || p === '/api/stop' || p === '/api/effort';
  if (!mine) return false;

  if (!dshEnabled()) {
    return json(res, 404, {
      ok: false,
      error: '会话功能未启用（config.json 里设 dsh.enabled = true 并配好 dsh）',
    }), true;
  }

  // ---------- 会话列表 ----------
  if (p === '/api/sessions' && req.method === 'GET') {
    const r = await dshRpc('session/list', { _request: {} });
    if (r.status !== 200 || !r.json) {
      return json(res, 502, { ok: false, error: 'dsh 没应答：' + (r.error || ('HTTP ' + r.status)) }), true;
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
    }), true;
  }

  // ---------- 忙锁 ----------
  if (p === '/api/busy' && req.method === 'GET') {
    // 按停之后 90 秒内一律报"不忙"：不等桥的状态文件更新 / 桥进程真的死掉，
    // 页面的发送/停按钮**立刻**复位（照生产版 busyOverrideUntil）。
    if (Date.now() < busyOverrideUntil) {
      return json(res, 200, { ok: true, busy: false, stopped: true }), true;
    }
    return json(res, 200, Object.assign({ ok: true }, busyNow())), true;
  }

  // ---------- 思考档位：读 ----------
  if (p === '/api/effort' && req.method === 'GET') {
    const now = Date.now();
    if (effortCache.value && now - effortCache.at < 10000) {
      return json(res, 200, { ok: true, value: effortCache.value, allowed: EFFORT_ALLOWED, cached: true }), true;
    }
    const items = await fetchSessionItems();
    if (!items) return json(res, 200, { ok: true, value: null, allowed: EFFORT_ALLOWED, error: 'dsh 没应答' }), true;
    const target = pickEffortTarget(items);
    const cur = target ? readSelection(target) : null;
    const value = (cur && cur.reasoningEffort) || null;
    if (value) effortCache = { at: now, value };
    return json(res, 200, {
      ok: true, value, allowed: EFFORT_ALLOWED,
      session: target ? stripSid(target.sessionId) : '',
    }), true;
  }

  // ---------- 思考档位：切 ----------
  if (p === '/api/effort' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const v = String(body.value || '').trim();
    if (EFFORT_ALLOWED.indexOf(v) < 0) {
      return json(res, 400, { ok: false, error: '不认识的档位：' + v }), true;
    }
    // 忙时绝不硬切（见文件上方注释：思考模式丢了 reasoning_content 会把这一轮搞坏）
    if (busyNow().busy) {
      return json(res, 409, { ok: false, error: '我正在跑，等这一轮完了再切' }), true;
    }

    const items = await fetchSessionItems();
    if (!items) return json(res, 502, { ok: false, error: 'dsh 没应答' }), true;
    const target = pickEffortTarget(items);
    if (!target) return json(res, 404, { ok: false, error: '找不到可切换的会话' }), true;
    if (target.running) {
      return json(res, 409, { ok: false, error: '会话正在跑，等这一轮完了再切（切档位会把这一轮搞坏）' }), true;
    }
    const cur = readSelection(target);
    if (!cur) return json(res, 500, { ok: false, error: '读不到当前模型座位（投影和日志都没有）' }), true;

    const sid = 'session-' + stripSid(target.sessionId);
    const sr = await dshRpc('session/selectModel', {
      request: { sessionId: sid, provider: cur.provider, model: cur.model, reasoningEffort: v },
    }, 15000);
    if (sr.status !== 200) {
      return json(res, 500, { ok: false, error: 'dsh 切换失败：' + (sr.error || ('HTTP ' + sr.status)) }), true;
    }

    // 切完回读真实座位 —— 这才是"生效"的证明（不信任刚才写的值）
    const items2 = await fetchSessionItems();
    const t2 = items2 ? pickEffortTarget(items2) : null;
    const cur2 = t2 ? readSelection(t2) : null;
    const value = (cur2 && cur2.reasoningEffort) || v;
    effortCache = { at: Date.now(), value };
    log(`🎚 思考档位 → ${value}（会话 ${stripSid(target.sessionId).slice(0, 18)}，session/selectModel）`);
    return json(res, 200, { ok: true, value }), true;
  }

  // ---------- 发消息：起桥 ----------
  if (p === '/api/chat' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    let text = String(body.text || '').trim();
    if (!text) return json(res, 400, { ok: false, error: '空消息' }), true;

    // 静默消息（照生产版）：只落消息池、**不 spawn 桥**。
    // 前端交互按钮里"一个确定的动作"就是这个语义（点了不惊动 AI），
    // 不拦的话每个静默点击都会起一条完整 AI 回合。
    if (body.silent) {
      addMessage('phone', text, 'chat');
      log(`🤫 静默消息（不起桥）: ${text.slice(0, 60)}`);
      return json(res, 200, { ok: true, silent: true }), true;
    }

    if (!fs.existsSync(BRIDGE)) {
      return json(res, 503, { ok: false, error: '桥不存在（src/dsh/bridge.js）' }), true;
    }

    // ★ 搭便车（剪贴板/上传队列）：正文前缀拼【复制内容】/【新图】，
    //   第一张待发图的**绝对路径**作为桥的 argv[3]（桥会读文件、塞 image block 给模型）。
    //   ⚠️ @ 开头的指令（@会话 等）不消费队列，留给真正的对话消息。
    let hitchImgPath = '';
    if (!/^@/.test(text)) {
      const { items: hitch, expired } = pendingConsume();
      const hp = buildHitchPrefix(hitch);
      if (hp.prefix) {
        text = hp.prefix + text;
        log(`🎒 搭便车：文本×${hp.nText} 图×${hp.nImg}${expired ? '（另有 ' + expired + ' 条过期）' : ''}`);
      } else if (expired) {
        log(`🎒 搭便车：${expired} 条已过期（>3 分钟），未拼`);
      }
      const imgItem = hitch.find((x) => x.kind === 'image' && x.path && fs.existsSync(x.path));
      if (imgItem) hitchImgPath = imgItem.path;
    }

    addMessage('phone', text, 'chat');
    log(`💬 对话: ${text.slice(0, 60)}${hitchImgPath ? ' [附图 ' + path.basename(hitchImgPath) + ']' : ''}`);

    // ⭐ 新回合开始 ⇒ 清掉上一轮按停留下的丢包窗口 —— 否则本轮的 delta 会被全丢，
    //    屏幕上什么都不会出（生产版踩过的坑，见 clearAbortWindow 注释）。
    clearAbortWindow();

    // ⭐ 新回合开始 ⇒ 记下「本轮花钱从哪个字节算起」（供 /api/cost 用）。
    //    放在 spawn 之前：桥一起来就会往会话文件里写，游标必须在那之前定格。
    try { cost.markTurnStart(); } catch (e) { /* 记不上就算不出本轮花费，不影响对话 */ }

    try {
      const child = spawn(process.execPath, [BRIDGE, text, hitchImgPath], {
        cwd: path.dirname(BRIDGE),
        env: Object.assign({}, process.env, {
          DSH_BRIDGE_SINK: 'hub',
          DSJ_HUB_PORT: String(config.port),
          DSJ_HUB_TOKEN: config.authToken || '',
          DSH_HOME: (config.dsh && config.dsh.home) || process.env.DSH_HOME || '',
        }),
        detached: true,       // 脱离本进程作业树：abort / 重启 hub 都不带走它
        stdio: 'ignore',
        windowsHide: true,
      });
      lastBridgePid = child.pid || null;
      child.unref();
      log(`🌉 起桥 PID ${lastBridgePid}`);
    } catch (e) {
      log('  ✗ 起桥失败: ' + e.message);
      return json(res, 500, { ok: false, error: '起桥失败: ' + e.message }), true;
    }
    return json(res, 200, { ok: true }), true;
  }

  // ---------- 增量回传（逐字 / 思考 / 收尾）----------
  // 这段是逐段照搬生产版的（含三个坑的修法）：
  //   · 迟到尾字：刚收尾的流又来字 ⇒ 追加到原消息，**别新建**（新建的等不到 end = 不灭的光标）
  //   · 按 seq 切段：这条 delta 的号越过了排在它后面的消息 ⇒ 它属于那之后 ⇒ 另起一条
  //   · 切段时必须给旧消息补 end（漏了 = 旧消息永远停在"生成中"）
  if (p === '/api/delta' && req.method === 'POST') {
    const body = JSON.parse((await readBody(req)) || '{}');
    const sid = String(body.streamId || '');
    if (inAbortWindow()) return json(res, 200, { ok: true, dropped: 'aborted' }), true;

    const text = String(body.text || '');
    const channel = String(body.channel || 'text');
    const kind = channel === 'text' ? 'chat' : channel;
    const isFinal = !!body.final;
    const seq = (typeof body.seq === 'number') ? body.seq : undefined;
    const round = (typeof body.round === 'number') ? body.round : undefined;
    if (!sid) return json(res, 400, { ok: false, error: '缺 streamId' }), true;

    let id = streams.get(sid);

    if (isFinal) {
      if (id != null) {
        const m = messages.find((x) => x.id === id);
        // ⚠️ 只有给了**非空**全文才替换：空 final 是桥的"只关流"信号，
        //    不 guard 的话会把已经流出去的一大段字**清空**。
        if (m && text) {
          const base = splitBase.get(id) || 0;
          const t2 = base > 0 ? text.slice(base) : text;
          m.text = t2; m.ts = Date.now();
          sseSend({ type: 'replace', id, text: t2 });
        }
        sseSend({ type: 'end', id });
      } else if (text) {
        const m = addMessageCore('pc', text, kind, { streamId: sid, seq, round });
        id = m.id;
        sseSend({ type: 'new', msg: m });
        sseSend({ type: 'end', id });
      }
      if (id != null) {
        recentFinal.set(sid, { id, ts: Date.now() });
        const cutoff = Date.now() - 60000;
        for (const [k, v] of recentFinal) { if (v.ts < cutoff) recentFinal.delete(k); }
      }
      streams.delete(sid);
      saveStore();                                  // 收尾必须落盘
      if (channel === 'text') log(`⇢ 逐字收尾 ${text.length} 字（id=${id}）`);
      return json(res, 200, { ok: true, id }), true;
    }

    if (!text) return json(res, 200, { ok: true, id: id == null ? null : id }), true;

    if (id == null) {
      // 刚收尾过的流：这是**迟到的尾巴字** ⇒ 追加到那条已收尾的消息
      const fin = recentFinal.get(sid);
      if (fin) {
        const mf = messages.find((x) => x.id === fin.id);
        if (mf) {
          mf.text += text; mf.ts = Date.now();
          sseSend({ type: 'append', id: mf.id, text });
          return json(res, 200, { ok: true, id: mf.id, late: true }), true;
        }
      }
      const m = addMessageCore('pc', text, kind, { streamId: sid, seq, round });
      streams.set(sid, m.id);
      sseSend({ type: 'new', msg: m });
      return json(res, 200, { ok: true, id: m.id }), true;
    }

    // 按 seq 切段
    {
      const idx = messages.findIndex((x) => x.id === id);
      const next = idx >= 0 ? messages[idx + 1] : null;
      if (next && typeof seq === 'number' && typeof next.seq === 'number' && seq > next.seq) {
        const prevLen = (messages[idx] && messages[idx].text) ? messages[idx].text.length : 0;
        sseSend({ type: 'end', id });               // 旧那条不再长了，必须补 end
        const m2 = addMessageCore('pc', text, kind, { streamId: sid, seq, round });
        streams.set(sid, m2.id);
        splitBase.set(m2.id, prevLen);
        sseSend({ type: 'new', msg: m2 });
        log(`✂ 正文切段（本段 seq=${seq} 越过下一条 seq=${next.seq}，切走 ${prevLen} 字）→ 新消息 ${m2.id}`);
        return json(res, 200, { ok: true, id: m2.id, split: true }), true;
      }
    }

    const m = messages.find((x) => x.id === id);
    if (m) {
      m.text += text;
      m.ts = Date.now();
      scheduleSave();
      sseSend({ type: 'append', id, text });
    }
    return json(res, 200, { ok: true, id }), true;
  }

  // ---------- 停 ----------
  if (p === '/api/stop' && req.method === 'POST') {
    const whoIp = String((req.socket && req.socket.remoteAddress) || '').replace('::ffff:', '');
    const whoUa = String(req.headers['user-agent'] || '').slice(0, 70);
    log(`⏹ /api/stop 来自 ${whoIp} UA=${whoUa}`);
    const r = stopAllNow('按了停（/api/stop）');
    json(res, 200, { ok: true, ended: r.n, ms: r.ms });
    stopDshTurn().catch(() => {});
    return true;
  }

  return false;
}

function register(server, cfg) {
  server.addRoute(handle);
}

module.exports = {
  register, dshRpc, liveSessionIds, slimSession, busyNow,
  bridgeStatePath, stopAllNow, stopDshTurn, isOurBridge, closeAllStreamsNow,
};
