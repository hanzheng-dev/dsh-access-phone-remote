/**
 * src/dsh/bridge.js —— 手机 → 电脑 dsh（DeepSeek Harness）的会话桥
 *
 * 用法: node src/dsh/bridge.js <文本> [搭便车图片路径]
 *
 * 由 hub 的 routes/chat.js 每来一条消息 spawn 一个进程（一次性），
 * 把手机的话注入电脑上正在跑的 dsh 会话，再把回复增量推回 hub：
 *
 *   手机 ──POST /api/chat──> hub ──spawn──> 本桥 ──HTTP RPC──> dsh (3080)
 *                                             └──POST /api/delta、/api/push──> hub ──SSE──> 手机
 *
 * 这座桥是从一个长期自用的实现里**裁剪**出来的：
 *   · 删掉了 QQ / NapCat / 语言闸 / Markdown 转 QQ / 分段发 QQ / 人格别名 / pins /
 *     op 搭便车等一整批"QQ 时代"的产物（手机不需要这些）。
 *   · 只保留"手机 ↔ dsh"这条链路：rpc 三级鉴权 / 共享会话跟随 / busy 锁 +
 *     心跳 + 探活 / session/prompt 注入 / hub 逐字流（(round,seq) 统一领号 +
 *     1500ms 静默窗口 + final 收尾）/ 停 / 会话切换 / 只读自检。
 *   · 所有私人路径改走 config（config.dsh.*），单用户（owner 固定 'owner'）。
 *
 * ⚠️ 与主 agent 的接口约定（routes/chat.js 已按此写好读写）：
 *   · 忙锁状态文件 = <config.absRoot>/dsh-state.json，
 *     结构 { busy:boolean, pid:number, since:number, sharedSid:string }。
 *   · 增量回传 = POST /api/delta {streamId, channel, text, seq, round, final}；
 *     工具播报 = POST /api/push {text, kind:'tool', seq, round, detail, detailImage}。
 *   · 入口参数只有 <文本>（原先的 <QQ> 参数已删）。
 *
 * ⚠️ 分两步走（任务书定的）：本期**只用 300ms 轮询**（第一步：完整回来就行），
 *    WebSocket 逐字流（dsh-live.js 那套 remote.mux + session/follow）留到第二步。
 *    轮询路径的正文已经走 hubDelta 推给 hub（每个 step 推一截 + 收尾权威替换），
 *    所以"逐字/一段一段"由 hub 与页面自己决定渲染节奏。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { config } = require('../config');

// ---------- 配置（全部来自 config.dsh，见 config.example.json） ----------
const dshCfg = config.dsh || {};
const OWNER = 'owner';                                    // 单用户：固定内部 id（原先的 QQ 号已删）
const BASE = dshCfg.base || 'http://127.0.0.1:3080';      // dsh web 服务地址
const HUB_BASE = 'http://127.0.0.1:' + (config.port || 3099);  // 本 hub（回传增量用）
const SHARED_CWD = dshCfg.cwd || '';                      // 共享会话的工作目录（留空=不传，用 dsh 默认）
const AGENT_PRESET = dshCfg.agentPreset || '';            // 留空=不传（开源用户不一定装了某预设）

// 忙锁状态文件：放在项目根（chat.js 的 busyNow() 也读这个路径/结构，别挪）
const STATE = path.join(config.absRoot || path.join(__dirname, '..', '..'), 'dsh-state.json');

// 本桥的日志（spawn 时 stdio:'ignore'，stdout 等于黑洞 ⇒ 必须落盘，出问题才查得到）
const LOG_FILE = path.join(__dirname, 'bridge.log');
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.rmSync(LOG_FILE, { force: true });
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (e) { /* 日志失败不能影响桥 */ }
}

const MAX_WAIT_MS = 2 * 60 * 60 * 1000;   // 单条最长等 2 小时
const STALE_MS = 10 * 60 * 1000;          // 10 分钟无进展判超时（防大命令被误断）
const BUSY_TTL_MS = 2 * 60 * 1000;        // busy 卡死 2 分钟自动清：上次桥被杀/崩没收尾时，别让后续消息排队
const POLL_MS = Number(process.env.DSH_BRIDGE_POLL || 300);   // 轮询间隔（第一步只用轮询）

/**
 * 注入时开头那行时间戳。
 *
 * 为什么要有：消息本身不带时间，模型只能靠猜 —— 生产版曾因此翻过车
 * （以为还在凌晨两点，其实已经是第二天早上八点，因为对话在模型眼里是"连续"的，
 * 中间隔了 6 小时它看不出来）。
 *
 * 输出形如：`🕐 2026-09-11 星期五 08:01`
 * 想关掉：环境变量 DSH_BRIDGE_TIMESTAMP=0
 */
function formatNowStamp() {
  const now = new Date();
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const p = (n) => String(n).padStart(2, '0');
  return `🕐 ${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${week} ${p(now.getHours())}:${p(now.getMinutes())}`;
}

// ---------- dsh HTTP RPC（0.1.5-rc.1 新协议）----------
// 三处要点（升级后实测，动它没好处）：
//   1) 方法名改斜杠式：session/list、session/page、session/prompt …
//   2) payload 要包一层参数名：{args:{_request:{...}}}（list）或 {args:{request:{...}}}（其余）
//   3) /api/* 全部要签名 cookie 鉴权（裸请求 401 unauthorized）——见 src/dsh/auth.js
function rpcOnce(method, args, overrideHeaders) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      type: 'client-request',
      rpcId: `hub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      method,
      payload: { args }
    });
    const u = new URL(BASE);
    let authHeaders = overrideHeaders || {};
    if (!overrideHeaders) {
      try { authHeaders = require('./auth').rpcHeaders(); }
      catch (e) { log(`⚠ 鉴权头生成失败（按裸请求继续）：${e.message}`); }
    }
    const req = http.request({
      host: u.hostname, port: u.port || 80, path: `/api/${method}`, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, authHeaders),
      timeout: 15000
    }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* 保留 null */ }
        resolve({ status: res.statusCode, json, raw, method });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error(`dsh RPC 超时 (${method})`)); });
    req.write(body);
    req.end();
  });
}

// ---------- 鉴权 cookie 缓存（治 401 风暴）----------
//
// 生产版实测：每一次 RPC 都走完"磁盘密钥自签 → 401 → 重签（同一个密钥必然再 401）
// → 睡 400ms → 抓启动 token 换票 → 成功"，单次 600ms+、轮询间隔形同虚设。
// 根因：服务端**内存密钥**与磁盘 .credentials.yaml 的密钥**分家**，磁盘密钥签的一律 401；
// 而真正管用的（换票得到的）那张 cookie 从没被记住。修法：把换票得到的 cookie
// 缓存起来（内存 + 落盘、跨进程复用），后续直接命中：
//   命中 → 1 次 HTTP 直通；失效(401) → 重新换票。dsh 重启后缓存失效会自动重换、自愈。
const AUTH_CACHE_FILE = path.join(__dirname, '.auth-cookie.json');
const AUTH_CACHE_MAX_AGE_MS = 25 * 24 * 3600 * 1000;   // 服务端 cookie 默认 30 天，留 5 天余量
const AUTHORITY = dshCfg.authority || '127.0.0.1:3080';

function loadCachedCookie() {
  try {
    const j = JSON.parse(fs.readFileSync(AUTH_CACHE_FILE, 'utf8'));
    if (!j || !j.cookie || !j.savedAt) return null;
    if (Date.now() - j.savedAt > AUTH_CACHE_MAX_AGE_MS) return null;
    if (j.authority && j.authority !== AUTHORITY) return null;
    return j.cookie;
  } catch (e) { return null; }
}
function saveCachedCookie(cookie) {
  try {
    fs.writeFileSync(AUTH_CACHE_FILE, JSON.stringify({ cookie, savedAt: Date.now(), authority: AUTHORITY }), 'utf8');
  } catch (e) { /* 落盘失败只影响性能，不影响功能 */ }
}
const cookieHeaders = (cookie) => ({ Cookie: cookie, Host: AUTHORITY, 'Content-Type': 'application/json' });

// 本进程内一旦确认"磁盘密钥签的 cookie 必 401"，就不再浪费那一次往返
let diskSecretBroken = false;

/**
 * 鉴权顺序（命中缓存的正常路径只有 1 次 HTTP 请求）：
 *   ① 缓存 cookie 直通            ← 绝大多数调用走这条
 *   ② 磁盘密钥自签（没被标记失效时试一次）
 *   ③ 启动 token 换票 → 写缓存 → 直通   ← 治"内存密钥分家"，无需重启服务
 */
async function rpc(method, args) {
  const snip = (r) => JSON.stringify(String((r && r.raw) || '').slice(0, 60));

  // ① 缓存 cookie
  const cached = loadCachedCookie();
  if (cached) {
    const r = await rpcOnce(method, args, cookieHeaders(cached));
    if (r.status !== 401 && r.status !== 403) return r;
    log(`⚠ RPC ${method} 缓存 cookie 已失效（${r.status}）→ 重新换票`);
  }

  // ② 磁盘密钥自签
  if (!diskSecretBroken) {
    const r = await rpcOnce(method, args);
    if (r.status !== 401 && r.status !== 403) return r;
    log(`⚠ RPC ${method} 磁盘密钥 401 → 本进程改用换票路径（不再重试磁盘密钥）`);
    diskSecretBroken = true;
  }

  // ③ 换票
  try {
    const hdr = await require('./auth').rpcHeadersViaToken();
    saveCachedCookie(hdr.Cookie);
    const r3 = await rpcOnce(method, args, hdr);
    if (r3.status === 401 || r3.status === 403) {
      log(`❌ RPC ${method} 换票后仍 ${r3.status}（body=${snip(r3)}）`);
    }
    return r3;
  } catch (e) {
    log(`❌ RPC ${method} 换票失败：${e.message}`);
    return await rpcOnce(method, args);   // 兜底：最后再裸试一次
  }
}

function rpcValue(res) {
  if (!res || res.status !== 200 || !res.json) {
    const snip = res && res.raw ? ` body=${JSON.stringify(String(res.raw).slice(0, 80))}` : '';
    throw new Error(`dsh 响应异常 (${res && res.status}) [${res && res.method}]${snip}`);
  }
  const r = res.json.result;
  if (!r || r.ok === false) {
    const msg = r && r.error ? (r.error.message || r.error.code || '未知错误') : '空响应';
    throw new Error(`dsh: ${msg}`);
  }
  return r.value;
}

// 0.1.5 起 session/history 没了，改用 session/page：
//   需要 address + throughSeq（必须 ≤ 服务器当前 cursor，来自 session/list 的 projections.asOfSeq）
//   返回 records: [{type:'event', event:{type,seq,time,data}}]
async function fetchEvents(sid, maxMessages) {
  const lr = await rpc('session/list', { _request: {} });
  const lval = rpcValue(lr);
  const me = (lval.items || []).find((s) => s.sessionId === sid);
  const cursor = (me && me.projections && me.projections.asOfSeq) || 0;
  if (!cursor) return [];
  const pr = await rpc('session/page', {
    request: { address: { kind: 'session', sessionId: sid }, throughSeq: cursor, maxMessages: maxMessages || 300 }
  });
  const pval = rpcValue(pr);
  return (pval.records || []).map((r) => r.event || r).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────
// ⭐ hub 出口：真·逐字流（生产版 2026-09-17 主人点破的那个"豁然开朗"）
//
// 手机页面与 QQ 不同：它是我们自己的 WebView，没有理由"攒段 + 段间隔"。
// 所以桥每个增量立刻 POST /api/delta，由 hub 追加到同一条消息、再 SSE 推给页面。
//
// 两个必须做对的地方（做错了就是一堆乱码）：
//   ① **保序**：HTTP 并发发出去会乱序，字会乱跳 → 串成"单飞行 + 合并"队列
//   ② **收尾要 await**：main() 结束就 process.exit(0)，队列里没发完的尾字会丢
//      → 结尾 hubDelta(全文, {final:true}) + await hubDrain()
//
// ★ 三条通道：text（正文）/ reasoning（思考）/ tool（工具）
//   通道一变 → 关掉上一块、开一块新的 ⇒ 从上到下的顺序 = 真实生成顺序
// ★ 统一落地序号：正文/思考/工具/收尾全部领 `seq`（同一轮内严格递增），
//   hub 存下来、页面按 (轮次, seq) 排序渲染 —— 落地时间不再是排序依据。
// ─────────────────────────────────────────────────────────────
const HUB_STREAM = true;                // 裁剪版：hub 是唯一出口（原先靠 DSH_BRIDGE_SINK=hub 切换）
const STREAM_ID = `${process.pid}-${Date.now()}`;
let hubQueue = [];              // [{sid,ch,text,tool,...}] 待发增量（同一个 sid 的会合并成一次请求）
const hubFinal = {};            // sid -> 待发的收尾文本（'' = 只关流不替换）
const hubSidByCh = {};          // ch -> 当前开着的那一段的 sid
const hubPendingClose = {};     // ch -> {sid, timer} 已"排上待关"、静默窗口内还能复活的段
// sid -> {text}：每个正文段自己流出去的内容（收尾时当"强制重画"的载荷）
const hubTextSegById = {};

let HUB_SEQ = 0;
function nextSeq() { return ++HUB_SEQ; }
// 轮次标识：用桥的启动时间（同一条桥 = 同一轮）。跨轮按它排序。
const HUB_ROUND_TS = Date.now();
// 换通道后给上一段留的静默窗口：dsh 的字到我们这边是有延迟的，
// 立刻关段会把还在路上的字丢掉（生产版实测：一条回复开头少 14 个字）。
const HUB_SEG_QUIET_MS = 1500;
let hubCurCh = null;            // 最近用的通道（用来判断"换通道了"）
let hubSeq = 0;                 // 分段号
let hubTextSegs = 0;            // 正文被切成了几段（决定收尾时敢不敢用权威全文替换）
let hubSending = false;

async function hubPost(payload) {
  try {
    await fetch(HUB_BASE + '/api/delta', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
  } catch (e) { log('推 delta 失败: ' + e.message); }
}

async function hubPostPush(payload) {
  try {
    await fetch(HUB_BASE + '/api/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(payload),
    });
  } catch (e) { log('推工具播报失败: ' + e.message); }
}

async function hubPump() {
  if (hubSending) return;
  hubSending = true;
  try {
    for (;;) {
      if (hubQueue.length) {
        const head = hubQueue[0];
        // ⚠️ 工具事件必须**走同一条队列**：直连 /api/push 会和排队的增量抢跑，
        //    实测出现「思考 → 工具 → 正文」这种错序（工具插到了正文前面）。
        if (head.tool !== undefined) {
          hubQueue.shift();
          const payload = { text: String(head.tool).slice(0, 300), kind: 'tool', seq: head.seq, round: head.round };
          if (head.detail) payload.detail = head.detail;    // 完整参数，页面折叠着放
          if (head.image) payload.detailImage = head.image; // 看图时把图也带上（手机能一起看）
          await hubPostPush(payload);
          continue;
        }
        const sid = head.sid;
        const ch = head.ch;
        // ⚠️ 合并同一段的连续增量时，**序号要取第一条的** —— 合并后的文本就是从那个位置开始的
        const seq = head.seq;
        const round = head.round;
        let text = '';
        while (hubQueue.length && hubQueue[0].sid === sid) text += hubQueue.shift().text;
        await hubPost({ streamId: sid, channel: ch, text, seq, round });
        continue;
      }
      const sid = Object.keys(hubFinal)[0];
      if (sid === undefined) break;
      const fin = hubFinal[sid];
      delete hubFinal[sid];
      const ch = String(sid).split(':')[1] || 'text';
      await hubPost({ streamId: sid, channel: ch, text: fin.text, final: true, seq: fin.seq, round: fin.round });
    }
  } finally { hubSending = false; }
}

/** 推一个增量。opts.channel = text|reasoning|tool；opts.final = 收尾（用权威文本替换 / 空串=只关流） */
function hubDelta(text, opts = {}) {
  if (!HUB_STREAM) return;
  const ch = opts.channel || 'text';

  if (opts.final) {
    // ⚠️ 先把 sid 抓下来再 flush —— flush 会把它从 hubSidByCh 里摘掉
    const sid = hubSidByCh[ch] || (hubPendingClose[ch] && hubPendingClose[ch].sid);
    hubFlushPending(ch);
    if (sid) {
      let use = String(text || '');
      if (ch === 'text' && hubTextSegs > 1) {
        // 多段正文：不能灌权威全文（会跟前面那段重复），但也绝不能发空 final。
        // 页面渲染有 60ms 节流，最后几个字可能被吞掉后再没有新的 append 来触发重画；
        // 收尾的 replace 是"强制重画"的唯一机会 ⇒ 发"这一段自己流出去的内容"。
        use = String((hubTextSegById[sid] || {}).text || '');
      }
      hubFinalize(sid, use);
      delete hubSidByCh[ch];
    }
    hubPump();
    return;
  }

  if (!text) return;

  // ★★ 换通道时**不立刻关**上一段，给它一个"静默窗口"；窗口内来字就把那段**复活**接着写。
  //    窗口(1500ms)内没动静才真关。这样既不会截断，后来的内容该开新块还是开新块（顺序不乱）。
  if (hubPendingClose[ch]) {                    // 迟到的字：把待关的段复活
    clearTimeout(hubPendingClose[ch].timer);
    hubSidByCh[ch] = hubPendingClose[ch].sid;
    delete hubPendingClose[ch];
  }

  // 换行**也是 token**（模型吐 `\n\n` 时是一条独立增量），不能因为"是空白"就丢，
  // 否则正文里的换行没了 ⇒ `## 标题` / ```js 不在行首 ⇒ Markdown 整片渲染不出来。
  // 只有"要为它新开一段"时才允许丢掉纯空白（免得建出「思考 · 0 字」空盒子）。
  const needNewSeg = hubCurCh !== ch && !hubSidByCh[ch];
  if (!String(text).trim() && needNewSeg) return;
  if (needNewSeg) {                            // ★ 换通道 = 新开一块
    hubScheduleClose(hubCurCh);                // ← 只是"排上"，不立刻关
    hubSeq++;
    const sid = `${STREAM_ID}:${ch}:${hubSeq}`;
    hubSidByCh[ch] = sid;
    hubCurCh = ch;
    if (ch === 'text') hubTextSegs++;
  }
  const mySid = hubSidByCh[ch];
  if (ch === 'text') {
    if (!hubTextSegById[mySid]) hubTextSegById[mySid] = { text: '' };
    hubTextSegById[mySid].text += String(text);
  }
  hubQueue.push({ sid: mySid, ch, text: String(text), seq: nextSeq(), round: HUB_ROUND_TS });
  hubPump();
}

/** 排一个"收尾"进发送队列。带上序号 —— 落地顺序靠它，不靠落地时间。 */
function hubFinalize(sid, text) {
  if (!sid) return;
  hubFinal[sid] = { text: String(text || ''), seq: nextSeq(), round: HUB_ROUND_TS };
}

/** 把某通道的段"排上待关"：静默窗口内没有新字才真关 */
function hubScheduleClose(ch) {
  if (!ch) return;
  hubFlushPending(ch);                          // 同通道若已有待关的，先真关掉
  const sid = hubSidByCh[ch];
  if (!sid) return;
  delete hubSidByCh[ch];
  const timer = setTimeout(() => {
    delete hubPendingClose[ch];
    hubFinalize(sid, '');                       // 空 final = 只关流、不替换内容
    hubPump();
  }, HUB_SEG_QUIET_MS);
  if (timer.unref) timer.unref();
  hubPendingClose[ch] = { sid, timer };
}

/** 立刻把某通道（或全部）的待关段真关掉 */
function hubFlushPending(ch) {
  const keys = ch ? [ch] : Object.keys(hubPendingClose);
  for (const k of keys) {
    const p = hubPendingClose[k];
    if (!p) continue;
    clearTimeout(p.timer);
    delete hubPendingClose[k];
    hubFinalize(p.sid, '');
  }
  if (keys.length) hubPump();
}

/** 把所有还开着的段都关掉（异常/超时路径用，防止页面一直显示"思考中…"） */
function hubCloseAll() {
  if (!HUB_STREAM) return;
  hubFlushPending();                       // 待关的段先真关（窗口里的字已经收完了）
  for (const ch of Object.keys(hubSidByCh)) {
    hubFinalize(hubSidByCh[ch], '');
    delete hubSidByCh[ch];
  }
  hubCurCh = null;
  hubPump();
}

/** 把这一批工具调用的**完整信息**拼成可展开的正文（页面折叠着放）。
 *  一层 JSON 缩进看起来更舒服，比一行 squeezed 的摘要信息量大得多。 */
function hubToolDetail(items) {
  if (!Array.isArray(items) || !items.length) return '';
  const parts = [];
  for (const it of items) {
    const name = (it && it.name) || '工具';
    let a = it && it.arguments;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { /* 不是 JSON 就原样 */ } }
    let body = '';
    if (a != null) {
      if (typeof a === 'object') { try { body = JSON.stringify(a, null, 2); } catch (e) { body = String(a); } }
      else body = String(a);
    }
    parts.push('▶ ' + name + (body ? '\n' + body : ''));
  }
  return parts.join('\n\n').slice(0, 4000);
}

/** 工具调用里凡是**看图片**的，把那张图拷到 hub 的 shots 目录 ⇒ 页面就能在折叠块里显示，
 *  手机和电脑上看的是**同一张图**。判据：参数里有 file_path/path/image*，且扩展名是图片。
 *  找不到就返回 null，不影响别的。 */
let hubImgSeq = 0;
function hubToolImage(items) {
  if (!Array.isArray(items)) return null;
  for (const it of items) {
    let a = it && it.arguments;
    if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { /* 原样 */ } }
    if (!a || typeof a !== 'object') continue;
    const p = a.file_path || a.path || a.image_path || a.image || a.file;
    if (!p || typeof p !== 'string') continue;
    if (!/\.(png|jpe?g|webp|gif)$/i.test(p)) continue;
    try {
      if (!fs.existsSync(p)) continue;
      const ext = p.slice(p.lastIndexOf('.')).toLowerCase();
      const name = `toolimg-${process.pid}-${++hubImgSeq}${ext}`;
      fs.mkdirSync(config.shotsPath, { recursive: true });
      fs.copyFileSync(p, path.join(config.shotsPath, name));
      return '/shots/' + name;
    } catch (e) { log('拷贝工具图片失败: ' + e.message); }
  }
  return null;
}

/** 工具播报：一行短摘要 + 可展开的完整参数（+ 看图时把图也带上）。
 *  ⚠️ 必须排进同一条队列（见 hubPump）—— 直连会和增量抢跑，导致工具插到正文前面。 */
function hubTool(line, items) {
  if (!HUB_STREAM || !line) return;
  hubScheduleClose(hubCurCh);              // ← 排上待关，不立刻关（同 hubDelta 的理由）
  hubCurCh = 'tool';
  hubQueue.push({ tool: String(line), detail: hubToolDetail(items), image: hubToolImage(items), seq: nextSeq(), round: HUB_ROUND_TS });
  hubPump();
}

/** 等队列发完 —— 收尾 / 退出前**必须** await，否则尾字丢。 */
async function hubDrain() {
  if (!HUB_STREAM) return;
  hubPump();
  const t0 = Date.now();
  while ((hubSending || hubQueue.length || Object.keys(hubFinal).length) && Date.now() - t0 < 5000) {
    await new Promise((r) => setTimeout(r, 15));
  }
}

// ---------- 工具调用播报（照搬生产版：一段一行，节流 + 去重 + 封顶） ----------
// 关掉的办法：环境变量 DSH_BRIDGE_TOOL_NOTIFY=0
const TOOL_NOTIFY = process.env.DSH_BRIDGE_TOOL_NOTIFY !== '0';

const TOOL_LABEL = {
  read: '读文件', write: '写文件', edit: '改文件', read_image: '看图',
  grep: '搜内容', glob: '找文件', ls: '列目录', pwsh: '跑命令', bash: '跑命令',
  skill: '载入技能', subagent: '派子任务', subagent_fork: '派子任务',
  workflow: '跑工作流', ralph: '跑循环', todo_write: '记待办',
  ask_user_question: '问你', create_goal: '建目标', update_goal: '更新目标',
  web_search: '搜网页', get_goal: '看目标', job_output: '读后台任务'
};

function squeeze(s, n) {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function formatToolLine(name, argsRaw) {
  let a = {};
  try { a = typeof argsRaw === 'string' ? JSON.parse(argsRaw || '{}') : (argsRaw || {}); } catch (e) { a = {}; }
  const label = TOOL_LABEL[name] || name || '工具';
  let detail = '';
  switch (name) {
    case 'pwsh':
    case 'bash':
      detail = a.description || a.command; break;
    case 'grep':
      detail = [a.pattern ? '/' + squeeze(a.pattern, 34) + '/' : '', a.path ? '@ ' + a.path : ''].filter(Boolean).join(' '); break;
    case 'glob':
      detail = [a.pattern, a.path ? '@ ' + a.path : ''].filter(Boolean).join(' '); break;
    case 'skill':
      detail = a.name; break;
    case 'todo_write':
      detail = (a.todos || []).map((t) => t.content).join(' / '); break;
    case 'subagent':
    case 'subagent_fork':
      detail = a.description; break;
    default:
      detail = a.file_path || a.filePath || a.path || a.dir || a.description || a.query || a.objective || a.command || '';
  }
  if (!detail) detail = argsRaw;
  detail = squeeze(detail, 70);
  // 兜底：别把一整坨 JSON 甩给手机
  if (/^[[{]/.test(detail)) detail = '（参数略）';
  return `🔧 ${label}${detail ? '：' + detail : ''}`;
}

// ---------- 播报节流（生产版 9/10 定稿：① 同批折叠 ② 行间隔 ③ 一轮封顶） ----------
const TOOL_NOTIFY_GAP_MS = Number(process.env.DSH_BRIDGE_TOOL_GAP_MS || 2500);
const TOOL_NOTIFY_MAX = Number(process.env.DSH_BRIDGE_TOOL_MAX || 6);

function createToolNarrator(options = {}) {
  const gapMs = options.gapMs ?? TOOL_NOTIFY_GAP_MS;
  const maxLines = options.maxLines ?? TOOL_NOTIFY_MAX;
  const clock = options.clock ?? (() => Date.now());
  let lastAt = 0;
  let emitted = 0;
  let calls = 0;
  /**
   * 这一轮**已经发过的所有行**（不是"上一条"）。
   * 单变量只挡得住**连续**重复（A A A），挡不住**交替**重复（A B A B A B）——
   * 一轮几十步的活儿，同一条命令反复跑（查状态、重试、分页读）是常态，所以按"整轮去重"。
   */
  const seenLines = new Set();
  const labelCounts = new Map();

  return {
    take(items) {
      if (!Array.isArray(items) || items.length === 0) return null;
      calls += items.length;
      for (const item of items) {
        const label = TOOL_LABEL[item.name] || item.name || '工具';
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1);
      }
      if (emitted >= maxLines) return null;
      const now = clock();
      if (emitted > 0 && now - lastAt < gapMs) return null;
      let text;
      if (items.length === 1) {
        text = formatToolLine(items[0].name, items[0].arguments);
      } else {
        const counts = new Map();
        for (const item of items) {
          const label = TOOL_LABEL[item.name] || item.name || '工具';
          counts.set(label, (counts.get(label) || 0) + 1);
        }
        text = '🔧 ' + [...counts].map(([label, n]) => (n > 1 ? `${label}×${n}` : label)).join('、');
      }
      // 这一轮发过的那条就不再发（重复的只计数，最后并进收尾统计）
      if (seenLines.has(text)) return null;
      seenLines.add(text);
      lastAt = now;
      emitted += 1;
      return text;
    },
    /** 收尾用：总共几次、都花在哪些工具上 */
    summary() {
      const top = [...labelCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([label, n]) => (n > 1 ? `${label}×${n}` : label))
        .join('、');
      return { calls, emitted, top };
    },
    totalCalls() { return calls; },
    lines() { return emitted; },
  };
}

// ---------- 状态持久化（对接 chat.js：busy/pid/since/sharedSid） ----------
const EMPTY_STATE = { busy: false, pid: 0, since: 0, sharedSid: '' };
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE, 'utf8'));
    return Object.assign({}, EMPTY_STATE, j || {});
  } catch (e) { return Object.assign({}, EMPTY_STATE); }
}
function saveState(s) {
  // ★ 原子写（temp + rename）：停会**直接 kill 桥进程**，万一正好杀在写一半，
  //   状态文件被截断；而 loadState 的 catch 是静默的 → 会话绑定丢了很难查。
  const tmp = STATE + '.tmp';
  try {
    fs.mkdirSync(path.dirname(STATE), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(s), 'utf8');
    fs.renameSync(tmp, STATE);
  } catch (e) {
    try { fs.writeFileSync(STATE, JSON.stringify(s), 'utf8'); } catch (e2) { /* 真写不进去就算了 */ }
  }
}

/** 清"已经死了的"忙锁：占锁进程不在了就立刻清，不用干等 2 分钟。
 *  事故背景：按「停」→ 桥被强杀 → 跑不到 finally，忙锁留在文件里 →
 *  后面的消息看到"忙"就排队；而没有桥在跑时没有人会去跑 staleBusy ⇒ 锁一直堵着。 */
function staleBusy(st) {
  if (!st.busy) return false;
  const expired = Date.now() - (Number(st.since) || 0) > BUSY_TTL_MS;
  let dead = false;
  const pid = Number(st.pid) || 0;
  if (pid) {
    try { process.kill(pid, 0); } catch (e) { dead = true; }   // 信号 0 = 只探活，不真发信号
  }
  if (expired || dead || !pid) {
    st.busy = false; st.pid = 0; st.since = 0;
    log(`🔓 清掉死锁（占锁进程 ${pid || '(无)'}${dead ? ' 已不在' : ''}${expired ? '，且已超时' : ''}）`);
    return true;
  }
  return false;
}

/**
 * "手机跟电脑同一个会话"就是这个函数。
 * 规则（自动跟随优先，不定死）：
 *   1. 优先跟随「当前活动会话」= running 的会话；多个 running 取最近更新；
 *      没有 running 时，跟随最近更新且非空白(blank=false)的会话。
 *      这样在电脑网页开新会话/切会话后，手机自动跟到新会话，不用手动 pin。
 *   2. 都没有候选 → 回退已持久化的 sharedSid（校验有效才用）。
 *   3. 都没有 → 新建一个共享会话（cwd = config.dsh.cwd）。
 *
 * ⭐ 显式切换优先（生产版踩过的 bug：「切过去，发的消息还是你」）：
 *   显式切换过（@会话 <id>）⇒ 打时间戳 st.manualSwitchAt ⇒ 6 小时内"跟随网页"不再覆盖；
 *   到点后恢复自动跟随（这样电脑网页开新会话时，手机照样能跟上）。
 */
async function ensureSharedSession(st) {
  const MANUAL_SWITCH_HOLD_MS = 6 * 60 * 60 * 1000;   // 6 小时
  const holdUntil = (Number(st.manualSwitchAt) || 0) + MANUAL_SWITCH_HOLD_MS;
  const holding = Number(st.manualSwitchAt) > 0 && Date.now() < holdUntil;
  // 1) 自动跟随当前活动会话（优先 running，其次最近更新的非空白会话）
  let activeSid = null;
  try {
    const lr = await rpc('session/list', { _request: {} });
    const lval = rpcValue(lr);
    // ⚠️ 必须排除子代理会话（origin='subagent'）。
    //    它们不接受外部注入 —— dsh 会回 `session "..." is owned by subagent routing`，
    //    而派子代理时它恰好是「running 里 updatedAt 最大」的那个 ⇒ 一旦被选上，
    //    主人的手机就会整条链路报错（2026-10-06 真实事故）。
    const items = (lval.items || []).filter((s) => s && s.sessionId && s.origin !== 'subagent');
    if (items.length) {
      const running = items.filter((s) => s.running);
      const pool = running.length ? running : items.filter((s) => !s.blank);
      if (pool.length) {
        pool.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        activeSid = pool[0].sessionId;
      }
    }
  } catch (e) { activeSid = null; }

  if (activeSid && !holding) {
    if (st.sharedSid && st.sharedSid !== activeSid) log(`跟随网页当前会话 ${st.sharedSid} -> ${activeSid}，自动切换`);
    st.sharedSid = activeSid;
    saveState(st);
    return activeSid;
  }
  // ⭐ 显式切换保护期内：**不跟随网页**，用显式切的
  if (holding && st.sharedSid) {
    if (activeSid && activeSid !== st.sharedSid) {
      log(`⏸ 显式切换保护中（剩 ${Math.ceil((holdUntil - Date.now()) / 60000)} 分钟）⇒ 忽略网页当前会话 ${activeSid}，仍用 ${st.sharedSid}`);
    }
    return st.sharedSid;
  }

  // 2) 没有候选 → 回退已持久化的 sharedSid（校验有效）
  if (st.sharedSid) {
    let listed = false;
    let exists = false;
    try {
      const lr = await rpc('session/list', { _request: {} });
      const lval = rpcValue(lr);
      listed = true;
      exists = (lval.items || []).some((s) => s.sessionId === st.sharedSid);
    } catch (e) { listed = false; }
    if (exists) return st.sharedSid;
    if (listed) {
      st.sharedSid = null;   // 列表拉到了、会话确实没了 → 才清
    } else {
      // 只是这一下拉不到（超时/忙/鉴权抖动）：保留，别清空状态去重建会话
      log(`session/list 暂时失败，保留 sharedSid=${st.sharedSid}，等下次重试`);
      return st.sharedSid;
    }
  }

  // 3) 都没有 → 新建一个共享会话
  //   cwd / preset 留空时**不传**（让 dsh 用默认）——开源用户不一定装了某个预设。
  const createReq = {};
  if (SHARED_CWD) createReq.cwd = SHARED_CWD;
  if (AGENT_PRESET) createReq.agentPreset = AGENT_PRESET;
  const res = await rpc('session/create', { request: createReq });
  const val = rpcValue(res);
  const newsid = val.sessionId;
  if (!newsid) throw new Error('建共享会话失败');
  // 尝试切模型（生产版写死 deepseek-official/deepseek-v4-flash）。
  // ⚠️ 开源环境不一定有这个 provider ⇒ 失败只记日志、继续用默认模型（不阻断对话）。
  try {
    const sm = await rpc('session/selectModel', {
      request: {
        sessionId: newsid,
        provider: dshCfg.provider || 'deepseek-official',
        model: dshCfg.model || 'deepseek-v4-flash',
        reasoningEffort: dshCfg.reasoningEffort || 'high'
      }
    });
    rpcValue(sm);
  } catch (e) {
    log(`新建会话后切模型失败（继续用 dsh 默认模型）：${e.message}`);
  }
  st.sharedSid = newsid;
  saveState(st);
  log(`新建共享 dsh 会话 ${newsid}`);
  await new Promise((r) => setTimeout(r, 1500));
  return newsid;
}

// ─────────────────────────────────────────────────────────────
// 停 —— 立刻中断当前正在跑的回合
//
// 只有整条消息就是它（可带结尾标点）才算："停 ✅ 停！ ✅ @停 ✅ stop ✅"；
// "停一下 / 车停了 / 停下来" 这些是正常说话，不能误中断。
//
// 原理：调 dsh 的 session/cancel，服务端会中止 LLM 流 + 杀掉在跑的工具。
// 另外要把"占着忙锁的那个桥进程"也杀掉 —— 生产版踩过：光 cancel 不够，
// 桥进程还活着、还跟着会话推，下一条消息又开新桥 ⇒ 两个桥同跟一个会话 ⇒ 消息推两遍。
// ─────────────────────────────────────────────────────────────
const STOP_RE = /^@?\s*(停|停止|停下|中止|中断|别说了|别弄了|不要了|算了|别干了|stop|abort|cancel)\s*[。！!～~.]?$/i;

/**
 * 杀掉"正占着忙锁的那个桥进程"。
 *
 * 安全闸：只杀命令行里**确实含 src/dsh/bridge.js** 的进程；对不上就放弃，绝不误杀。
 * （生产版曾用 `CommandLine -match 'dsh-bridge.js'` 的形式，教训：PID 复用会误杀别的进程。）
 */
function killBusyBridge() {
  const st0 = loadState();
  const pid = Number(st0.pid) || 0;
  if (!pid) return 0;
  // ★ 不管杀成没杀成，锁都要清掉。被强杀的桥跑不到它的 finally ⇒
  //   它留下的忙锁没人收 ⇒ 后面每条消息都在排队。
  const clearLock = () => {
    try {
      const st = loadState();
      st.busy = false; st.pid = 0; st.since = 0;
      saveState(st);
      log('🔓 已清掉忙锁');
    } catch (e) { log('清忙锁失败: ' + e.message); }
  };
  // 占锁的就是我自己 —— 不能自杀，也不能清锁（我还在跑，锁是我的）
  if (pid === process.pid) return 0;
  let cmdline = '';
  try {
    cmdline = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`],
      { encoding: 'utf8', timeout: 8000 });
  } catch (e) {
    log(`查不到占锁的桥 PID ${pid}（应该已经退出了）`);
    clearLock();   // ★ 进程都没了，锁必须清
    return 0;
  }
  // ⚠️ 必须验明命令行含 `dsh/bridge.js`（正反斜杠都认），否则 PID 复用会误杀别的进程
  if (!/dsh[\\/]bridge\.js/i.test(cmdline)) {
    log(`⚠ 占锁 PID ${pid} 命令行不含 dsh/bridge.js，拒绝杀：${String(cmdline).slice(0, 100)}`);
    clearLock();   // ★ 那这个锁本来就是脏的，清掉
    return 0;
  }
  try {
    process.kill(pid);
    log(`✔ 已杀掉占锁的桥进程 PID ${pid}`);
    clearLock();   // ★★ 关键：杀了就得清锁
    return pid;
  } catch (e) {
    log(`杀桥 PID ${pid} 失败: ${e.message}`);
    clearLock();   // ★ 杀不掉也得把锁清了，否则一直堵
    return 0;
  }
}

async function handleStop() {
  const st = loadState();
  // 找目标会话：优先桥记录的共享会话，其次当前 running 的
  let target = st.sharedSid || null;
  let running = [];
  try {
    const lr = await rpc('session/list', { _request: {} });
    const lval = rpcValue(lr);
    // ⚠️ 必须排除子代理会话（origin='subagent'）。
    //    它们不接受外部注入 —— dsh 会回 `session "..." is owned by subagent routing`，
    //    而派子代理时它恰好是「running 里 updatedAt 最大」的那个 ⇒ 一旦被选上，
    //    主人的手机就会整条链路报错（2026-10-06 真实事故）。
    const items = (lval.items || []).filter((s) => s && s.sessionId && s.origin !== 'subagent');
    running = items.filter((s) => s.running);
    if (!target || !items.some((s) => s.sessionId === target)) {
      if (running.length) {
        running.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        target = running[0].sessionId;
      }
    }
  } catch (e) { /* 拉不到列表就用兜底的 target */ }

  if (!target) { log('停：没找到会话（可能本来就没在干活）'); return; }

  let ok = false;
  try {
    await rpc('session/cancel', { request: { sessionId: target } });
    ok = true;
  } catch (e) { log(`停失败: ${e.message}`); }

  const killedPid = killBusyBridge();
  const st2 = loadState();
  st2.busy = false; st2.pid = 0; st2.since = 0;
  saveState(st2);

  const wasRunning = running.some((s) => s.sessionId === target);
  log(`收到中断指令 → cancel 会话 ${target}${wasRunning ? '（当时在跑）' : '（当时空闲）'}${ok ? '' : '（cancel 没发出去）'}${killedPid ? ' 且杀掉桥 ' + killedPid : ''}`);
}

// ─────────────────────────────────────────────────────────────
// @会话 <sessionId> —— 直接按 id 切会话（手机页面「会话切换器」用）
//   · 兼容带/不带 `session-` 前缀两种写法（页面拿到的 id 通常不带前缀）
//   · 显式切换 ⇒ 写 st.manualSwitchAt：6 小时内不被"跟随网页"覆盖
//   逻辑与生产版一致，只是目标来自 id 而不是别名（人格别名已裁剪）。
// ─────────────────────────────────────────────────────────────
const SESSION_SWITCH_RE = /^@?\s*(?:会话|切会话|切到|switch)\s+([0-9a-zA-Z-]{6,})$/;

async function handleSessionSwitch(rawText) {
  const m = SESSION_SWITCH_RE.exec(String(rawText || '').trim());
  if (!m) return false;
  const want = m[1];
  const wantFull = /^session-/.test(want) ? want : 'session-' + want;
  let target = wantFull;
  let title = '';
  try {
    const res = await rpc('session/list', { _request: {} });
    const val = rpcValue(res);
    const items = ((val && val.items) || []).filter((s) => s && s.sessionId);
    const hit = items.find((s) => s.sessionId === want || s.sessionId === wantFull);
    if (hit) { target = hit.sessionId; title = hit.title || hit.name || ''; }
    else {
      const pre = items.filter((s) => s.sessionId === (`session-` + want) || s.sessionId.startsWith(want));
      if (pre.length === 1) { target = pre[0].sessionId; title = pre[0].title || pre[0].name || ''; }
      else if (pre.length > 1) {
        log(`切会话：有 ${pre.length} 个会话以「${want}」开头，放弃`);
        return true;
      } else {
        log(`切会话：没找到会话「${want}」`);
        return true;
      }
    }
  } catch (e) {
    log(`切会话时拉列表失败（直接按给定 id 切）：${e.message}`);
  }

  const st = loadState();
  const before = st.sharedSid || '(无)';
  st.sharedSid = target;
  st.manualSwitchAt = Date.now();          // ⭐ 显式切换 ⇒ 打时间戳（6 小时内不被"跟随网页"覆盖）
  saveState(st);

  log(`切会话：${before} → ${target}${title ? ' 「' + title + '」' : ''}`);
  return true;
}

// ─────────────────────────────────────────────────────────────
// ---------- 实时逐字流句柄（第二步；防僵尸桥） ----------
// ⚠️ 为什么句柄要提到模块级：`liveHandle.close()` 只写在正常分支里的话，
//    超时/异常路径的 WebSocket 会一直开着 → Node 事件循环被它撑住 → 进程赖着不死
//    → 变成继续接收会话增量的"僵尸桥"（生产版踩过：看起来像"两个会话在同时回"）。
// 修法：句柄放模块级，任何退出路径都关；main 结束后强制 process.exit()。
let LIVE_HANDLE = null;
let LIVE_STOPPED = false;
function closeLive() {
  LIVE_STOPPED = true;
  if (LIVE_HANDLE) { try { LIVE_HANDLE.close(); } catch (e) {} LIVE_HANDLE = null; }
}
// 一键退回轮询：环境变量 DSH_BRIDGE_LIVE=0，或在 bridge 目录放 `.live-off` 文件
const LIVE_OFF_FILE = path.join(__dirname, '.live-off');
const LIVE_ENABLED = process.env.DSH_BRIDGE_LIVE !== '0' && !fs.existsSync(LIVE_OFF_FILE);

// ---------- 主流程 ----------
async function main() {
  const text = (process.argv[2] || '').trim();
  // ★ 搭便车图片（可选，hub /api/chat 传第 2 个参数）——
  //   剪贴板队列里的图，作为 image block 一起发给 dsh。
  const hitchImg = (process.argv[3] || '').trim();
  if (!text) { log('用法: node src/dsh/bridge.js <文本> [图片路径]'); process.exit(1); }

  // === 「停」中断指令：最高优先级，跳过 busy 排队，立刻执行 ===
  if (STOP_RE.test(text)) {
    log(`收到中断指令「${text}」`);
    await handleStop().catch((e) => log(`handleStop 异常: ${e.message}`));
    return;
  }

  // === @会话 <id> 切换（纯指令，不进对话历史）===
  try {
    if (await handleSessionSwitch(text)) return;
  } catch (e) { log(`handleSessionSwitch 异常（忽略，继续正常对话）: ${e.message}`); }

  let st = loadState();

  // ⚠️ 只清「真死的」：桥活着 → busy 时间戳新鲜（心跳）→ 照常排队；
  //    桥被杀/崩 → 心跳停 → staleBusy 立刻清（探活 PID）。
  if (staleBusy(st)) { saveState(st); log('清除残留 busy（占锁进程已死）'); }

  // busy 排队（单用户：手机在上一轮没结束时又发了一条）
  let waited = 0;
  while (st.busy) {
    await new Promise((r) => setTimeout(r, 2000));
    waited += 2000;
    st = loadState();
    if (staleBusy(st)) saveState(st);
    if (waited > 5 * 60 * 1000) {
      log('排队超时（5分钟），本轮放弃');
      return;
    }
  }

  // dsh 在线检查（走 rpc 包装：401/403 会自动重签 cookie 重试一次）
  try {
    const res = await rpc('session/list', { _request: {} });
    const val = rpcValue(res);
    if (!val) throw new Error('dsh 未响应');
  } catch (e) {
    log(`dsh 不在线/鉴权失败: ${e.message}`);
    return;
  }

  st.busy = true;
  st.pid = process.pid;         // ★ 记下"是哪个进程占着锁" —— 停要靠它把这条桥也杀掉
  st.since = Date.now();
  saveState(st);
  // ⚠️ 心跳：跑的过程中每 10 秒刷新一次 busy 时间戳。
  //    没有它的话，一个长回合会让时间戳停在开场，2 分钟后被 staleBusy 误判成"僵尸"，
  //    下一条消息就会把锁删掉再开一个桥 ⇒ 两个桥同跟一个会话、回复推两遍。
  const busyHB = setInterval(() => {
    try {
      const s2 = loadState();
      s2.busy = true;
      s2.since = Date.now();
      s2.pid = process.pid;
      saveState(s2);
    } catch (e) { /* 心跳失败不影响主流程 */ }
  }, 10000);
  if (busyHB.unref) busyHB.unref();

  let sid = st.sharedSid;
  try {
    // === 共享会话：自动跟随网页当前会话（手机↔网页同一份对话）===
    sid = await ensureSharedSession(st);
    saveState(st);
    log(`使用共享 dsh 会话 ${sid}`);

    // ⚠️ 竞态修复（生产版真踩）：只在「确实卡死」时才 cancel —— running=true 且
    //    距上次更新超过 STUCK_MS。正常排队就让它排队，由 busy 机制串行化即可。
    const STUCK_MS = 3 * 60 * 1000;
    try {
      const lr = await rpc('session/list', { _request: {} });
      const lval = rpcValue(lr);
      const me = (lval.items || []).find((s) => s.sessionId === sid);
      if (me && me.running) {
        const idleMs = Date.now() - (me.updatedAt || 0);
        if (idleMs > STUCK_MS) {
          log(`会话 running 已 ${Math.round(idleMs / 1000)}s 无更新 → 判定卡死，cancel 后重来`);
          await rpc('session/cancel', { request: { sessionId: sid } }).catch(() => {});
          await new Promise((r) => setTimeout(r, 500));
        } else {
          log(`会话正在跑（${Math.round(idleMs / 1000)}s 前有更新），让本轮自然结束，不打断`);
        }
      }
    } catch (e) { log(`running 状态检查失败（忽略，不 cancel）: ${e.message}`); }

    // 记录当前最大 seq / turn 作为基线
    let baseSeq = 0;
    let baseTurn = 0;
    try {
      const evts = await fetchEvents(sid);
      if (evts.length) {
        baseSeq = Math.max(...evts.map((e) => e.seq || 0));
        baseTurn = Math.max(...evts.map((e) => (e.data && e.data.turn) || 0));
      }
    } catch (e) { baseSeq = 0; baseTurn = 0; }

    // 注入
    // 【时间戳】把"现在几点、星期几"写进正文开头，模型才知道时间（想关：DSH_BRIDGE_TIMESTAMP=0）。
    const stamp = process.env.DSH_BRIDGE_TIMESTAMP === '0' ? '' : formatNowStamp();
    const injectText = (stamp ? stamp + '\n' : '') + text;
    // ★ 搭便车图片（argv[3]，可选）——content 里加 image block，
    //   格式来自 dsh 的 session/prompt schema：{ type:'image', mediaType, data(base64), name? }。
    const promptContent = [{ type: 'text', text: injectText }];
    if (hitchImg) {
      try {
        const ext = path.extname(hitchImg).toLowerCase();
        const mediaType = ext === '.png' ? 'image/png'
          : (ext === '.webp' ? 'image/webp' : (ext === '.gif' ? 'image/gif' : 'image/jpeg'));
        const buf = fs.readFileSync(hitchImg);
        if (buf.length > 0 && buf.length <= 6 * 1024 * 1024) {
          promptContent.push({ type: 'image', mediaType, data: buf.toString('base64'), name: path.basename(hitchImg) });
          log(`🖼 搭便车附图: ${path.basename(hitchImg)} (${buf.length}B)`);
        } else {
          log(`🖼 搭便车图片过大/空，跳过: ${hitchImg} (${buf.length}B)`);
        }
      } catch (e) { log('🖼 搭便车附图失败: ' + e.message); }
    }
    // 注入是唯一"写"操作，也是 401 唯一咬到的地方 → 最多试 3 轮（每轮内部还会重签 cookie 重试一次）
    let inj = null;
    const backoff = [500, 1500, 3000];
    for (let attempt = 1; attempt <= 3; attempt++) {
      inj = await rpc('session/prompt', {
        request: {
          requestId: `hub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId: sid,
          mode: 'queue',
          content: promptContent,
          clientTimeZone: 'Asia/Shanghai'
        }
      });
      if (inj.status === 200) break;
      log(`注入第 ${attempt}/3 次被拒（${inj.status}），${backoff[attempt - 1]}ms 后重试`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, backoff[attempt - 1]));
    }
    rpcValue(inj); // 抛错则注入失败
    const injectAt = Date.now();

    // 轮询回复
    const deadline = Date.now() + MAX_WAIT_MS;
    let lastActive = Date.now();
    let streamedLen = 0;          // 已经从轮询路径推出去的字符数
    let reasonedLen = 0;          // 已经从轮询路径推出去的思考字符数（正文有去重、思考以前没有 ⇒ 重复推送）
    let done = false;
    const narrator = createToolNarrator();

    // 抢轮补丁：注入时若电脑网页正好在跑一轮，别把"那一轮"的 turn/end 当成本次回复收尾
    // → 只认"注入之后新开的那一轮"（事件带 data.turn）；30 秒都没等到新轮（注入被并进当轮）退回旧行为。
    const isNewTurn = (e) => ((e.data && e.data.turn) || 0) > baseTurn;
    let sawNewTurn = false;
    let filterNewTurn = true;
    const TURN_GRACE_MS = 30 * 1000;

    // ---------- 实时逐字流（第二步：WebSocket）----------
    // 轮询只能拿到「每个 step 一条完整消息」⇒ 纯聊天要等整段生成完才到桥。
    // 真正的 token 级流在 ws://.../api/remote.mux（session/follow + assistantStream:true），
    // 见 src/dsh/live.js 顶部注释。
    //
    // ⚠️ 只做加法，不动原有逻辑：
    //   · 流连不上/没装 ws ⇒ onError 记一条日志后降级「仅轮询」，行为与改动前完全一致；
    //   · liveOn=true 时正文由实时流负责，轮询路径的 flushText 直接 return（不重复）；
    //   · 收尾统一用 durable 权威全文 final 替换一次（HUB 模式**不"补尾"**，
    //     生产版踩过 liveSentChars 恒 0 ⇒ 把整篇正文当残句重发的坑）。
    let liveBuf = '';          // 实时累积的正文
    let liveOn = false;        // 实时流已送出过正文 ⇒ 轮询路径不再发正文
    let liveReasonOn = false;  // 实时流已送出过思考 ⇒ 轮询路径不再发思考
    // ★ 实时路径已经报过的 tool/call（按事件的 seq 去重）—— 轮询那条路要跳过它们，
    //   否则同一个工具会报两遍（live 的 onEvent 会立即 hubTool）。
    const liveToolSeqs = new Set();
    try {
      if (!LIVE_ENABLED) throw new Error('DSH_BRIDGE_LIVE=0 或存在 .live-off，按配置退回轮询');
      const liveMod = require('./live');
      LIVE_HANDLE = liveMod.open({
        sessionId: sid,
        baseSeq,
        // 工具调用：实时事件里一出现就报（比轮询早），并记下 seq 供轮询去重
        onEvent(e) {
          try {
            if (!e || e.type !== 'tool/call' || !TOOL_NOTIFY) return;
            const items = [{ name: e.data && e.data.name, arguments: e.data && e.data.arguments }];
            const line = narrator.take(items);
            if (!line) return;                  // 没生成出来 ⇒ 不登记，交给轮询那条路补报
            if (e.seq != null) liveToolSeqs.add(e.seq);
            hubTool(line, items);
          } catch (err) { /* 出错就交给轮询兜底 */ }
        },
        onTextDelta(txt) {
          if (!txt || LIVE_STOPPED) return;    // 本轮已收尾：迟到/泄漏的帧一律丢弃
          liveOn = true;
          liveBuf += txt;
          hubDelta(txt, { channel: 'text' });  // 一个 token 直接蹦出去，不攒段
        },
        // 思考增量 → 页面上的「思考」折叠块（实时流才有；轮询路径是兜底）
        onReasoningDelta(txt) {
          if (!txt || LIVE_STOPPED) return;
          liveReasonOn = true;
          hubDelta(txt, { channel: 'reasoning' });
        },
        onError(e) { log('实时流异常（自动退回轮询）：' + (e && e.message || e)); closeLive(); }
      });
      if (LIVE_HANDLE && LIVE_HANDLE.failed) {
        // open() 同步失败路径（onError 已记日志）：句柄是空壳，清掉避免误以为还有流
        LIVE_HANDLE = null;
      } else {
        // ⚠️ 不能拿 isActive() 判断成败：WebSocket 的 open 是异步的，
        //    刚 open() 返回时还没连上（isActive=false），误判会把句柄清掉 ⇒
        //    closeLive() 关不了它 + 日志也不写"已启用"。
        log('实时逐字流已启用（WS 连接中）');
      }
    } catch (e) {
      log('实时流未启用（退回轮询）：' + (e && e.message || e));
      LIVE_HANDLE = null;
    }

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      let newEvts = [];
      try {
        const evts = await fetchEvents(sid);
        const rawNew = evts.filter((e) => e.seq > baseSeq);
        if (!sawNewTurn) {
          if (rawNew.some(isNewTurn)) sawNewTurn = true;
          else if (Date.now() - injectAt > TURN_GRACE_MS) {
            sawNewTurn = true;
            filterNewTurn = false;
            log('注入未开新轮（可能被并进当轮），30s 后按旧行为继续');
          }
        }
        newEvts = sawNewTurn ? (filterNewTurn ? rawNew.filter(isNewTurn) : rawNew) : [];
      } catch (e) { continue; }

      if (newEvts.length) {
        lastActive = Date.now();
        // ⚠️ fetchEvents 每次都把 `seq > baseSeq` 的**全部事件**重新读一遍 ——
        //    freshText / durableBuf 必须**每轮一起重建**，否则同样的 step 文本会**再叠一遍**
        //    → 雪球式膨胀 → 收尾时切出一大坨重复内容（生产版实锤的 bug）。
        let freshText = '';
        let freshReason = '';   // 本轮的思考文本（每轮重建，配 reasonedLen 去重）
        let durableBuf = '';
        const flushText = () => {
          if (liveOn) return;   // ★ 正文已交给实时流，轮询路径不再发，避免重复
          const t = freshText.trim();
          if (t && t.length > streamedLen) {
            const fresh = t.slice(streamedLen);
            streamedLen = t.length;
            // ⭐ hub 出口：不攒段、不转纯文本 —— 增量直接推给 hub（页面自己渲染 Markdown）
            hubDelta(fresh, { channel: 'text' });
          }
        };
        // 工具播报先攒着，等文本要出去时再按序发出（narrator 负责折叠/节流/封顶）
        const pendingTools = [];
        const flushTools = () => {
          if (pendingTools.length === 0) return;
          const items = pendingTools.splice(0, pendingTools.length);
          const line = narrator.take(items);
          if (!line) return;
          // ⭐ hub：把**完整的工具名 + 完整参数**一起发过去（页面能折叠）
          hubTool(line, items);
        };
        for (const e of newEvts) {
          if (e.type === 'tool/call' && TOOL_NOTIFY) {
            flushText();
            // ★ 实时路径已经报过这个工具（按事件的 seq 认）⇒ 跳过，别报两遍
            if (e.seq != null && liveToolSeqs.has(e.seq)) continue;
            pendingTools.push({ name: e.data?.name, arguments: e.data?.arguments });
          } else if (e.type === 'assistant/message') {
            flushTools();
            for (const b of (e.data?.message?.content || [])) {
              if (b.type === 'text') { freshText += b.text; durableBuf += b.text; }
              // ⭐ 思考增量：轮询路径拿得到就发（页面渲染成默认折叠的「思考」块）。
              //   ⚠️ fetchEvents 每轮会把旧事件重读一遍 ⇒ 必须像正文一样按累计长度去重
              //   （正文有 streamedLen，思考原来没有 ⇒ 同一个思考块每轮重推一次）。
              //   实时流已送过思考（liveReasonOn）时，轮询不再重复发。
              else if (b.type === 'reasoning' && b.text) {
                freshReason += b.text;
                if (!liveOn && !liveReasonOn) {
                  const rr = freshReason.trim();
                  if (rr.length > reasonedLen) {
                    hubDelta(rr.slice(reasonedLen), { channel: 'reasoning' });
                    reasonedLen = rr.length;
                  }
                }
              }
            }
          }
        }
        flushTools();
        const reply = freshText.trim();
        // ⚠️ 必须带 !liveOn：正文已由实时流发过时，这里再推一次就会重复
        //   （mock 修好后实测：正文变成「你好，你好，这是…」）
        if (!liveOn && reply && reply.length > streamedLen) {
          const fresh = reply.slice(streamedLen);
          streamedLen = reply.length;
          hubDelta(fresh, { channel: 'text' });
        }
        // 回合结束
        if (newEvts.some((e) => e.type === 'turn/end')) {
          closeLive();   // ★ 回合一到就关流（僵尸桥的根治点）
          // ⭐ hub 收尾：用【权威全文】**替换**一次，防止增量里有缺失/错序。
          //   ⚠️ HUB 模式**不做"补尾"** —— 正文已由实时流逐 token 发过；
          //      生产版曾在收尾补 liveSentChars 的差值，而那个值在 HUB 模式恒 0，
          //      结果把整篇正文当残句重发一遍（全文重复）。这里直接 final 替换即可。
          //   ⚠️ 必须 await hubDrain() —— main() 结束就 process.exit(0)，队列没发完的尾字会丢。
          const full = durableBuf || liveBuf || freshText || '';
          hubDelta(full, { final: true });   // 关掉正文那段；只有一段时用权威全文替换
          hubCloseAll();                     // 思考/工具段一并关掉
          await hubDrain();
          log(`收尾：权威全文 ${full.length} 字（实时流累计 ${liveBuf.length} 字）`);
          done = true;
          break;
        }
      } else if (Date.now() - lastActive > STALE_MS) {
        log('会话无进展，判超时');
        break;
      }
    }

    if (!done) {
      log('处理超时');
      await rpc('session/cancel', { request: { sessionId: sid } }).catch(() => {});
      return;
    }
  } catch (e) {
    log(`出错: ${e.message}`);
    if (sid) await rpc('session/cancel', { request: { sessionId: sid } }).catch(() => {});
  } finally {
    // ★ 兜底：超时、异常、提前 return 也一定关掉实时流，绝不留下僵尸桥
    closeLive();
    try { clearInterval(busyHB); } catch (e) {}
    // 异常/超时路径也要把逐字流关掉，否则 hub 那边会一直挂着一条没收尾的消息。
    // 发一个**空全文**的 final = 只关流、不覆盖已流的正文（hub 侧有 guard）。
    hubCloseAll();
    await hubDrain();
    const st3 = loadState();
    st3.busy = false; st3.pid = 0; st3.since = 0;
    saveState(st3);
  }
}

// ---------- 播报节流自检（假时钟，不联网不发消息）----------
function selftestNarration() {
  const results = [];
  const check = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    results.push({ name, ok, actual, expected });
  };

  // ① 单次调用保留明细
  {
    const n = createToolNarrator({ gapMs: 2500, maxLines: 6, clock: () => 0 });
    check('单次调用保留明细', n.take([{ name: 'read', arguments: { file_path: 'D:\\a.txt' } }]), '🔧 读文件：D:\\a.txt');
    check('单次调用计数', n.totalCalls(), 1);
  }
  // ② 同一批多次调用折叠成一行
  {
    const n = createToolNarrator({ gapMs: 2500, maxLines: 6, clock: () => 0 });
    check('同批折叠成一行', n.take([
      { name: 'read', arguments: {} },
      { name: 'read', arguments: {} },
      { name: 'grep', arguments: {} },
    ]), '🔧 读文件×2、搜内容');
    check('同批只发一行', n.lines(), 1);
  }
  // ③ 行与行之间的间隔节流（间隔内只计数）
  {
    let t = 0;
    const n = createToolNarrator({ gapMs: 2500, maxLines: 6, clock: () => t });
    const first = n.take([{ name: 'read', arguments: { file_path: 'x' } }]);
    t = 500;
    const tooSoon = n.take([{ name: 'grep', arguments: { pattern: 'y' } }]);
    t = 3000;
    const later = n.take([{ name: 'grep', arguments: { pattern: 'y' } }]);
    check('节流：第一行照发', first !== null, true);
    check('节流：间隔内不发', tooSoon, null);
    check('节流：过了间隔再发', later, '🔧 搜内容：/y/');
    check('节流：被压掉的仍计数', n.totalCalls(), 3);
  }
  // ④ 每轮封顶（超出的只计数）
  {
    let t = 0;
    const n = createToolNarrator({ gapMs: 0, maxLines: 3, clock: () => t });
    for (let i = 0; i < 10; i += 1) {
      t = i * 1000;
      n.take([{ name: 'bash', arguments: { description: `step ${i}` } }]);
    }
    check('封顶：一轮最多 3 行', n.lines(), 3);
    check('封顶：计数不漏', n.totalCalls(), 10);
  }
  // ⑤ 交替重复 A B A B → 只发前两条
  {
    let t = 0;
    const n = createToolNarrator({ gapMs: 0, maxLines: 6, clock: () => t });
    const a = { name: 'bash', arguments: { description: 'Locate the launcher' } };
    const b = { name: 'bash', arguments: { description: 'Check if running and read launcher' } };
    const out = [];
    for (const item of [a, b, a, b, a, b]) {
      t += 3000;
      out.push(n.take([item]) !== null);
    }
    check('交替重复：只发前两条', out, [true, true, false, false, false, false]);
    check('交替重复：计数不漏', n.totalCalls(), 6);
  }
  // ⑥ 收尾统计（并进「回复完毕」）
  {
    let t = 0;
    const n = createToolNarrator({ gapMs: 0, maxLines: 6, clock: () => t });
    for (let i = 0; i < 5; i += 1) {
      t = i * 1000;
      n.take([{ name: 'bash', arguments: { description: `step ${i}` } }]);
    }
    t = 9000;
    n.take([{ name: 'read', arguments: { file_path: 'x' } }]);
    check('统计：总次数', n.summary().calls, 6);
    check('统计：主要工具', n.summary().top, '跑命令×5、读文件');
  }

  const failed = results.filter((r) => !r.ok);
  for (const r of results) {
    console.log(`${r.ok ? '✅' : '❌'} ${r.name}${r.ok ? '' : `  期望 ${JSON.stringify(r.expected)} / 实得 ${JSON.stringify(r.actual)}`}`);
  }
  console.log(failed.length === 0
    ? `NARRATION SELFTEST PASS（${results.length} 项）`
    : `NARRATION SELFTEST FAIL（${failed.length}/${results.length}）`);
  if (failed.length > 0) process.exit(1);
}

// ---------- 只读自检（不注入、不取消、不发消息；只走 session/list + session/page）----------
async function selftest() {
  const lr = await rpc('session/list', { _request: {} });
  const lval = rpcValue(lr);
  const items = lval.items || [];
  console.log(`✅ session/list OK：${items.length} 个会话`);
  const byTime = (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0);
  const running = items.filter((s) => s.running).sort(byTime);
  const target = running[0] || items.filter((s) => !s.blank).sort(byTime)[0];
  if (!target) throw new Error('没有任何会话可选');
  console.log(`   活动会话：${target.sessionId}（running=${target.running}）`);
  const evts = await fetchEvents(target.sessionId, 5);
  console.log(`✅ session/page OK：拿到 ${evts.length} 条事件`);
  const last = evts[evts.length - 1];
  if (last) console.log(`   末条：seq=${last.seq} type=${last.type} turn=${last.data && last.data.turn}`);
  const tool = evts.filter((e) => e.type === 'tool/call').pop();
  if (tool) console.log(`   播报样例 → ${formatToolLine(tool.data && tool.data.name, tool.data && tool.data.arguments)}`);

  console.log(`   POLL_MS=${POLL_MS}  STATE=${STATE}`);

  // ---------- live 模块可用性（第二步；只报告，不阻断） ----------
  try {
    const live = require('./live');
    const wsImpl = live.resolveWebSocket();
    if (wsImpl) {
      console.log(`✅ live：ws 模块可用（来源 ${live.wsSource()}）`);
    } else {
      // 降级不阻断：把"为什么没逐字"写清楚，用户能自己修（config.dsh.wsPath）
      const reason = live.wsLastError() ? live.wsLastError().message : '未知';
      console.log('⚠ live：ws 模块不可用 → 仅轮询降级');
      console.log(`   查找顺序：${live.wsCandidates().join(' → ')}`);
      console.log(`   最后错误：${reason}`);
    }
    let cookie = null;
    try { cookie = live.resolveCookie(); } catch (e) { cookie = null; }
    console.log(cookie
      ? '✅ live：鉴权 cookie 拿得到（换票缓存 / 现签）'
      : '⚠ live：拿不到鉴权 cookie（dsh 未启动或 dsh.home 未配好）→ 仅轮询');
    console.log(`   MUX_URL=${live.muxUrl()}`);
  } catch (e) {
    console.log('⚠ live 模块检查失败（不影响功能）：' + e.message);
  }

  console.log('SELFTEST PASS');
}

if (require.main === module) {
  if (process.argv[2] === '--selftest') {
    selftest().catch((e) => { console.error('SELFTEST FAIL: ' + e.message); process.exit(1); });
  } else if (process.argv[2] === '--selftest-narration') {
    selftestNarration();
  } else if (process.argv[2] === '--list-sessions') {
    // ★ 只读：输出**纯 JSON**（放在最后一行）= 当前会话 + 最近的会话列表。
    //   不注入、不发消息、不花 token —— 只读一次 session/list。
    //   （开源版 hub 的 /api/sessions 由 chat.js 自己实现；这个入口留给脚本/排障用。）
    (async () => {
      const st = loadState();
      const cur = st.sharedSid || '';
      let sessions = [];
      try {
        const res = await rpc('session/list', { _request: {} });
        const val = rpcValue(res);
        const items = (val && val.items) || [];
        sessions = items
          .filter((s) => s && s.sessionId)
          .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
          .slice(0, 25)
          .map((s) => {
            // ⚠️ 标题不在第一层，藏在 projections.values.title；
            //   dsh 有时给占位符「Insufficient context for session title」，
            //   那就退而用最后一轮的 prompt/response 当标签（实测比 id 好认得多）。
            const pv = (s.projections && s.projections.values) || {};
            let title = String(pv.title || '').trim();
            if (!title || /insufficient context for session title/i.test(title)) {
              const to = Array.isArray(pv.turnOutline) ? pv.turnOutline[pv.turnOutline.length - 1] : null;
              title = to ? String(to.prompt || to.response || '').trim().slice(0, 40) : '';
            }
            if (!title) title = s.sessionId.slice(0, 18);
            return { sid: s.sessionId, title, running: !!s.running, updatedAt: s.updatedAt || 0 };
          });
      } catch (e) { /* 拉不到就只给空列表 */ }
      console.log(JSON.stringify({ ok: true, current: cur, sessions }));
      process.exit(0);
    })().catch((e) => { console.error('list-sessions 失败: ' + e.message); process.exit(1); });
  } else {
    // ★ main 结束后强制退出：实时流的 WebSocket 会撑住事件循环，
    //   不显式退出的话进程会赖着不死 → 变成继续推消息的"僵尸桥"。
    main()
      .then(() => { closeLive(); process.exit(0); })
      .catch((e) => { try { closeLive(); } catch (x) {} console.error('桥异常退出: ' + (e && e.message)); process.exit(1); });
  }
} else {
  module.exports = {
    formatToolLine, createToolNarrator, rpc, rpcValue, fetchEvents,
    killBusyBridge, ensureSharedSession, handleStop, handleSessionSwitch,
    hubDelta, hubDrain, hubTool, hubCloseAll,
    closeLive,
    streamId: () => STREAM_ID,
    statePath: () => STATE,
  };
}
