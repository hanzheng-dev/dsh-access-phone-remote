/**
 * src/dsh/live.js —— 订阅 dsh 会话的**实时助手流**（逐字），给 hub 桥用
 *
 * 这段协议逻辑是从一个长期自用的实现里**原样搬过来的**，一字未改。
 *
 * ⚠️ 为什么需要它（生产版 2026-09-13 排查结论）：
 *   桥靠轮询 `session/list` + `session/page` 取事件，而 dsh 的事件是**整条落盘**的
 *   （一个 step 结束时才有一条完整 `assistant/message`）⇒ 纯聊天要等整段回复生成完
 *   才到桥，做不到边生成边显示。
 *
 * ✅ 真正的逐字流在 WebSocket 上：
 *   连接  ws://<host>:<port>/api/remote.mux          （cookie 鉴权，同 RPC）
 *   发送  { type:'open', streamId, endpoint:'session/follow',
 *           payload:{ args:{ request:{
 *             address:{ kind:'session', sessionId },
 *             assistantStream: true,          ← 关键开关，不开就只有 durable 事件
 *             maxMessages: 200 } } } }
 *   收到  { type:'item', streamId, value }   value.type ∈ { snapshot | event | assistant-stream }
 *         · snapshot          → 开场快照（records / cursor / assistantStream 基线）
 *         · event             → durable 事件（tool/call、turn/end…，等价于轮询拿到的）
 *         · assistant-stream  → 实时帧 frame.type ∈ { start | chunk | end }
 *             frame.chunk.type === 'text-delta'      → 正文增量   ★要的就是这个
 *             frame.chunk.type === 'reasoning-delta' → 思考增量
 *   另有压缩批式编码 text-chunks / reasoning-chunks（含 time0 + dt[] + texts[]），一并展开。
 *
 * 降级设计（开源环境不一定装了 ws）：
 *   ws 模块查找顺序 = config.dsh.wsPath → dsh home 附近的 node_modules/ws → require('ws')；
 *   全失败 ⇒ open() 同步回调 onError（原因写清），桥据此降级为「仅轮询」，
 *   功能照常（回复最终完整到达），只是不再逐字。
 *
 * 用法：
 *   const live = require('./live');
 *   const h = live.open({ sessionId, baseSeq, onEvent, onTextDelta, onReasoningDelta,
 *                         onAttemptStart, onAttemptEnd, onError });
 *   h.close();
 */
'use strict';

const fs = require('fs');
const path = require('path');

function dshCfg() {
  try {
    return (require('../config').config || {}).dsh || {};
  } catch (e) { return {}; }
}

/** dsh 数据目录（优先 config.dsh.home，其次 DSH_HOME 环境变量）。 */
function resolveDshHome() {
  const fromCfg = dshCfg().home;
  if (fromCfg) return fromCfg;
  return process.env.DSH_HOME || '';
}

// ---------- ws 模块查找（三级；全失败 = 仅轮询降级） ----------
//   ① config.dsh.wsPath（用户明确指路，最可靠）
//   ② dsh home 附近的 node_modules/ws：
//        <home>/node_modules/ws、
//        <home 的父目录>/node_modules/ws（“同级”）、
//        以及 dsh 官方布局的兄弟目录（home 为 xxx-home 时，程序目录是 xxx）
//   ③ require('ws')（碰运气：全局安装/父级 node_modules）
let WebSocketImpl = null;
let wsSource = '';
let wsLastError = null;

function wsCandidates() {
  const out = [];
  const c = dshCfg();
  if (c.wsPath) out.push(c.wsPath);
  const home = resolveDshHome();
  if (home) {
    out.push(path.join(home, 'node_modules', 'ws'));
    out.push(path.join(path.dirname(home), 'node_modules', 'ws'));
    const base = path.basename(home);
    if (/-home$/.test(base)) {
      out.push(path.join(path.dirname(home), base.slice(0, -'-home'.length), 'node_modules', 'ws'));
    }
  }
  out.push('ws');
  return out;
}

for (const spec of wsCandidates()) {
  try {
    // eslint-disable-next-line global-require
    WebSocketImpl = require(spec);
    wsSource = spec;
    break;
  } catch (e) { wsLastError = e; }
}

// ---------- MUX_URL：由 config.dsh.base 推导 ----------
//   http://127.0.0.1:3080  →  ws://127.0.0.1:3080/api/remote.mux
//   （环境变量 DSH_BRIDGE_WS 可显式覆盖，排障用）
function muxUrl() {
  if (process.env.DSH_BRIDGE_WS) return process.env.DSH_BRIDGE_WS;
  const base = dshCfg().base || 'http://127.0.0.1:3080';
  try {
    const u = new URL(base);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}/api/remote.mux`;
  } catch (e) {
    return 'ws://127.0.0.1:3080/api/remote.mux';
  }
}

const AUTH_CACHE_FILE = path.join(__dirname, '.auth-cookie.json');
const AUTH_CACHE_MAX_AGE_MS = 25 * 24 * 3600 * 1000;   // 与服务端 cookie 30 天配套（同桥）

/** 取 cookie：优先桥的落盘缓存（换票得到的），回退现签。 */
function resolveCookie() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_CACHE_FILE, 'utf8'));
    const authority = dshCfg().authority || '127.0.0.1:3080';
    if (j && j.cookie && j.savedAt && Date.now() - j.savedAt <= AUTH_CACHE_MAX_AGE_MS &&
        (!j.authority || j.authority === authority)) {
      return j.cookie;
    }
  } catch (e) { /* 没缓存/坏了 → 回退现签 */ }
  try { return require('./auth').rpcHeaders().Cookie; } catch (e) { return null; }
}

/** 把一帧 chunk 展开成若干 {type,text}（兼容单条与批式编码）。 */
function expandChunk(chunk) {
  if (!chunk || typeof chunk !== 'object') return [];
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') {
    return [{ type: chunk.type, text: String(chunk.text || '') }];
  }
  // 批式：{type:'text-chunks', index, time0, dt:[], texts:[]}
  if (chunk.type === 'text-chunks' || chunk.type === 'reasoning-chunks') {
    const kind = chunk.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta';
    return (chunk.texts || []).map((t) => ({ type: kind, text: String(t || '') }));
  }
  return [];
}

/**
 * 打开实时流。
 * @param {object} o
 * @param {string} o.sessionId
 * @param {number} [o.baseSeq]        起始 seq（snapshot 之前的 durable 事件不回调）
 * @param {function} o.onEvent        (event) => void            durable 事件（含 tool/call、turn/end）
 * @param {function} o.onTextDelta    (text) => void             正文增量
 * @param {function} [o.onReasoningDelta] (text) => void         思考增量
 * @param {function} [o.onAttemptStart] () => void               新一轮生成开始
 * @param {function} [o.onAttemptEnd]   () => void               本轮生成结束
 * @param {function} [o.onError]      (err) => void
 * @returns {{close:function, isActive:function}}
 */
function open(o) {
  const state = { ws: null, closed: false, active: false, streamId: 'live-' + Date.now() };

  if (!WebSocketImpl) {
    const tried = wsCandidates().join('、');
    o.onError && o.onError(new Error(
      `dsh-live: 找不到 ws 模块（依次试过：${tried}）→ 降级为仅轮询（可在 config.dsh.wsPath 指定 ws 路径）`));
    return { close() {}, isActive: () => false, failed: true };
  }
  const cookie = resolveCookie();
  if (!cookie) {
    o.onError && o.onError(new Error('dsh-live: 拿不到鉴权 cookie → 降级为仅轮询（检查 dsh.home / 启动日志）'));
    return { close() {}, isActive: () => false, failed: true };
  }

  let ws;
  try {
    const authority = dshCfg().authority || '127.0.0.1:3080';
    ws = new WebSocketImpl(muxUrl(), { headers: { Cookie: cookie, Host: authority } });
  } catch (e) {
    o.onError && o.onError(e);
    return { close() {}, isActive: () => false, failed: true };
  }
  state.ws = ws;
  let lastRevision = -1;      // 当前 attempt 已处理的最后 revision（去重用）
  let curAttempt = null;

  ws.on('open', () => {
    state.active = true;
    ws.send(JSON.stringify({
      type: 'open',
      streamId: state.streamId,
      endpoint: 'session/follow',
      payload: {
        args: {
          request: {
            address: { kind: 'session', sessionId: o.sessionId },
            assistantStream: true,
            maxMessages: 200
          }
        }
      }
    }));
  });

  ws.on('message', (raw) => {
    let j;
    try { j = JSON.parse(raw.toString()); } catch (e) { return; }
    if (j.type === 'error') { o.onError && o.onError(new Error('dsh-live: ' + JSON.stringify(j.error))); return; }
    if (j.type !== 'item') return;
    const v = j.value || {};

    if (v.type === 'snapshot') {
      // 快照里若带 assistantStream 基线（断线重连中途接上），把已生成内容当增量补出来
      const base = v.assistantStream;
      if (base && Array.isArray(base.stream)) {
        for (const rec of base.stream) {
          const member = rec && rec.chunk ? rec.chunk : rec;
          for (const c of expandChunk(member)) {
            if (c.type === 'text-delta') o.onTextDelta && o.onTextDelta(c.text);
            else if (c.type === 'reasoning-delta') o.onReasoningDelta && o.onReasoningDelta(c.text);
          }
        }
      }
      return;
    }

    if (v.type === 'event') {
      const e = v.event || {};
      // 只回调本次注入之后的事件
      if (o.baseSeq !== undefined && typeof e.seq === 'number' && e.seq <= o.baseSeq) return;
      o.onEvent && o.onEvent(e);
      return;
    }

    if (v.type === 'assistant-stream') {
      const f = v.frame || {};
      if (f.type === 'start') {
        // 新 attempt：重置去重游标
        curAttempt = f.attemptId || '(未知)';
        lastRevision = -1;
        o.onAttemptStart && o.onAttemptStart(f);
        return;
      }
      if (f.type === 'end') { o.onAttemptEnd && o.onAttemptEnd(f); return; }
      if (f.type === 'chunk') {
        // ★ 按 revision 去重：帧自带单调递增的 revision，
        //   万一重连/重放把同一帧再送一遍，这里直接丢掉 —— 重复内容是这个桥踩过的坑。
        const rev = typeof f.revision === 'number' ? f.revision : null;
        const aid = f.attemptId || curAttempt;
        if (rev !== null) {
          if (aid !== curAttempt) { curAttempt = aid; lastRevision = -1; }
          if (rev <= lastRevision) return;   // 老帧，丢弃
          lastRevision = rev;
        }
        for (const c of expandChunk(f.chunk)) {
          if (c.type === 'text-delta') o.onTextDelta && o.onTextDelta(c.text);
          else if (c.type === 'reasoning-delta') o.onReasoningDelta && o.onReasoningDelta(c.text);
        }
      }
    }
  });

  ws.on('error', (e) => { state.active = false; o.onError && o.onError(e); });
  ws.on('close', () => { state.active = false; });

  return {
    close() {
      state.closed = true;
      state.active = false;
      try { ws.close(); } catch (e) {}
    },
    isActive: () => state.active && !state.closed
  };
}

module.exports = {
  open,
  expandChunk,
  // 供 --selftest / 排障用
  resolveWebSocket: () => WebSocketImpl,
  wsSource: () => wsSource,
  wsLastError: () => wsLastError,
  wsCandidates,
  muxUrl,
  resolveCookie,
};
