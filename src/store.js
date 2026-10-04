// store.js —— 共享核心：内存态 + 通用工具
//
// 为什么单独一个文件：push / file / server 都要读同一份 messages、SSE 客户端、
//   剪贴板搭便车队列，还要用同一套 HTTP 小工具（json / readBody / htmlVersion）。
//   若各文件各自持有，会 require 成环；集中在这里，各路由只 require 本文件。
//
// 本文件承载（从生产 `hub-server.js` 迁入并参数化）：
//   · 消息池 / SSE 客户端 / 流表
//   · loadStore / saveStore / scheduleSave / sortKey / cmpMsg / insertMessage / addMessage
//   · 剪贴板「搭便车」队列（pending.json）
//   · 通用工具：log / json / readBody / readBodyRaw / htmlVersion / fileRef
//
// ⚠️ 所有落盘路径一律来自 config（config.absRoot），本文件不出现任何绝对路径。

'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('./config');

// ---------- 运行期文件（根目录来自 config.root） ----------
const STORE_FILE = path.join(config.absRoot, 'messages.json');
const PENDING_FILE = path.join(config.absRoot, 'pending.json');

// ---------- 共享内存态 ----------
const messages = [];            // 消息池（按 (round, seq) 排序，权威顺序）
const sseClients = new Set();   // 在线 SSE 客户端
const streams = new Map();      // 流表（streamId -> messageId；供 /api/inbox 的 streaming 标记）
let nextId = 1;

let saveTimer = null;
let pending = [];               // 剪贴板搭便车队列

// ---------- 日志 ----------
// ⚠️ 只写 stdout：前台跑能看输出，后台跑由启动器重定向进文件（别在这里再写一遍文件，
//    否则会和重定向重复，看起来像"有两个进程在跑"）。
function log(msg) {
  const line = `[${new Date().toLocaleString('zh-CN')}] ${msg}`;
  console.log(line);
}

// ---------- 消息存储 ----------
function loadStore() {
  try {
    const j = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    const arr = Array.isArray(j.messages) ? j.messages : [];
    messages.length = 0;
    for (const m of arr) messages.push(m);
    nextId = j.nextId || (messages.length + 1);
  } catch (e) {
    messages.length = 0;
    nextId = 1;
  }
}
function saveStore() {
  try {
    fs.mkdirSync(config.absRoot, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify({ messages: messages.slice(-200), nextId }, null, 2), 'utf8');
  } catch (e) { log('保存失败: ' + e.message); }
}
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveStore(); }, 1000);
  if (saveTimer.unref) saveTimer.unref();
}

// 排序键 = (round, seq)：落地时间只作显示用，不再决定顺序；无 seq 的老消息按 ts 排。
function sortKey(m) {
  const round = (typeof m.round === 'number') ? m.round : m.ts;
  const seq = (typeof m.seq === 'number') ? m.seq : 0;
  return [round, seq, m.ts, m.id];
}
function cmpMsg(a, b) {
  const ka = sortKey(a), kb = sortKey(b);
  for (let i = 0; i < 4; i++) { if (ka[i] !== kb[i]) return ka[i] - kb[i]; }
  return 0;
}
/** 把一条消息插到它该在的位置（按 (round,seq)），而不是无脑 append。 */
function insertMessage(m) {
  if (typeof m.seq !== 'number') { messages.push(m); return; }
  let i = messages.length;
  while (i > 0 && cmpMsg(messages[i - 1], m) > 0) i--;
  messages.splice(i, 0, m);
}
function addMessageCore(from, text, kind = 'text', extra = {}) {
  const m = { id: nextId++, from, text, ts: Date.now(), kind, ...extra };
  insertMessage(m);
  if (messages.length > 300) messages.splice(0, messages.length - 300);
  saveStore();
  return m;
}
const addMessage = addMessageCore;   // 老名字继续可用

function sseSend(obj) {
  if (!sseClients.size) return;
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of Array.from(sseClients)) {
    try { c.write(line); } catch (e) { sseClients.delete(c); }
  }
}

// ---------- 剪贴板「搭便车」队列（见生产版详细注释） ----------
//   检测到剪贴板变化 ⇒ POST /api/push 带 hitchhike ⇒ 入队；
//   下一条用户消息拼进正文前缀并清空。每条只活 3 分钟。
const PENDING_TTL_MS = 3 * 60 * 1000;
const PENDING_MAX = 50;

function loadPending() {
  try {
    const j = JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8'));
    pending = Array.isArray(j) ? j : [];
  } catch (e) { pending = []; }
  prunePending();
}
function savePending() {
  try {
    fs.writeFileSync(PENDING_FILE, JSON.stringify(pending.slice(-PENDING_MAX), null, 1), 'utf8');
  } catch (e) { log('pending.json 写失败: ' + e.message); }
}
function prunePending() {
  const now = Date.now();
  const n = pending.length;
  pending = pending.filter((x) => x && typeof x.ts === 'number' && now - x.ts <= PENDING_TTL_MS);
  if (pending.length > PENDING_MAX) pending = pending.slice(-PENDING_MAX);
  return n - pending.length;
}
/** 上传/拉取的图片也进搭便车队列（只对图片后缀入队，只写路径不附图）。 */
function addPendingImg(url, name) {
  try {
    const u = String(url || '');
    if (!/^\/(uploads|shots)\/[\w.\-]+\.(png|jpe?g|gif|webp|bmp)$/i.test(u)) return;
    addPending({ kind: 'image', image: u, name: name || path.basename(u) });
    log(`🚗 搭便车入队(图): ${u}`);
  } catch (e) { /* 入队失败绝不能影响上传本身 */ }
}
function addPending(item) {
  const type = item && (item.type || item.kind);
  if (type !== 'text' && type !== 'image') return;
  const now = Date.now();
  prunePending();
  if (type === 'text') {
    const t = String(item.text || '');
    if (!t.trim()) return;
    if (pending.some((x) => x.kind === 'text' && x.text === t)) return;
    pending.push({ ts: now, kind: 'text', text: t.slice(0, 4000) });
  } else {
    const url = /^\/(uploads|shots)\/[\w.\-]+$/i.test(String(item.image || item.url || '')) ? String(item.image || item.url) : null;
    if (!url) return;
    const fp = path.join(config.absRoot, url.replace(/^\//, ''));
    let sz = 0;
    try { sz = fs.statSync(fp).size; } catch (e) { sz = 0; }
    if (!(sz > 0 && sz <= 20 * 1024 * 1024)) { log(`⚠ 搭便车图片被拒（${sz}B）: ${url}`); return; }
    if (pending.some((x) => x.kind === 'image' && x.path === fp)) return;
    pending.push({ ts: now, kind: 'image', path: fp, url, name: String(item.name || path.basename(fp)).slice(0, 120) });
  }
  while (pending.length > PENDING_MAX) pending.shift();
  savePending();
}
/** 消费队列：过滤过期 + 清空，返回可拼的条目和过期条数。 */
function pendingConsume() {
  const expired = prunePending();
  const items = pending;
  pending = [];
  savePending();
  return { items, expired };
}
/** 把队列拼成正文前缀： 【复制内容】a / b / c 与 【新图】/uploads/x.jpg */
function buildHitchPrefix(items) {
  const texts = items.filter((x) => x.kind === 'text' && x.text);
  const imgs = items.filter((x) => x.kind === 'image' && (x.url || x.path));
  const lines = [];
  if (texts.length) {
    let joined = texts.map((x) => x.text).join(' / ');
    const total = joined.length;
    if (joined.length > 500) joined = joined.slice(0, 500) + '…（共 ' + total + ' 字）';
    lines.push('【复制内容】' + joined);
  }
  for (const x of imgs) lines.push('【新图】' + (x.url || x.path));
  return { prefix: lines.length ? lines.join('\n') + '\n' : '', imgPath: '', nText: texts.length, nImg: imgs.length };
}

// ---------- HTTP 通用工具 ----------
// 老坑：Buffer 隐式 toString 按 TCP 分片解码，汉字会被切成乱码 U+FFFD。
//   ⇒ 先收 Buffer，结尾一次性解码。
function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { chunks.push(c); n += c.length; if (n > 2e6) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}
/** 二进制版（上传文件用）：不能 toString('utf8')，否则破坏二进制。 */
function readBodyRaw(req, maxBytes) {
  const cap = maxBytes || 20 * 1024 * 1024;
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    req.on('data', (c) => { chunks.push(c); n += c.length; if (n > cap) req.destroy(); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}
function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    // 接口响应一律不许缓存（否则 WebView 会缓存，页面自检读到旧版本号）。
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'Pragma': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Length': Buffer.byteLength(s),
  });
  res.end(s);
}

/** 页面版本号（public/index.html 的 mtime + 大小）：页面据此自动重载。 */
function htmlVersion() {
  try {
    const st = fs.statSync(path.join(config.projectRoot, 'public', 'index.html'));
    return Math.round(st.mtimeMs) + '-' + st.size;
  } catch (e) { return '0'; }
}

// ---------- 附件路径校验（/api/push 与 /api/file 共用同一份） ----------
function isUnderDir(fp, dir) {
  const a = path.resolve(fp).toLowerCase();
  const b = path.resolve(dir).toLowerCase();
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
}
/** 允许读写的目录：config.allowDirs + uploads/shots/docs（运行期目录）。 */
function isAllowedDir(fp) {
  const dirs = [].concat(config.allowDirPaths || [], [config.uploadsPath, config.shotsPath, config.docsPath]);
  return dirs.some((d) => d && isUnderDir(fp, d));
}
// 只拦"防手滑"的两条：可执行文件、敏感文件名 —— 不拦目录（目录由 allowDirs 管）。
const BLOCKED_EXEC_RE = /\.(exe|bat|cmd|ps1|vbs|scr|msi|jar|apk|com|pif|hta|dll|sys)$/i;
const BLOCKED_NAME_RE = /密码|api\.txt|credential|secret|token/i;
const FILE_MAX_BYTES = 50 * 1024 * 1024;
/** 校验一个绝对路径能否当附件：目录 + 后缀 + 文件名 + 大小，通过返回指针。 */
function fileRef(fpIn) {
  const fp = String(fpIn || '');
  if (!fp) return null;
  const okDir = isAllowedDir(fp);
  const okExt = !BLOCKED_EXEC_RE.test(fp);
  const okName = !BLOCKED_NAME_RE.test(fp);
  let sz = 0;
  try { sz = fs.statSync(fp).size; } catch (e) { sz = 0; }
  if (okDir && okExt && okName && sz > 0 && sz <= FILE_MAX_BYTES) {
    return { path: fp, name: path.basename(fp), size: sz };
  }
  return null;
}

// 启动时载入队列（消息池由 server.js 在 listen 前显式 loadStore）
loadPending();
const _pendingSweep = setInterval(() => { if (prunePending()) savePending(); }, 60 * 1000);
if (_pendingSweep.unref) _pendingSweep.unref();

module.exports = {
  // 状态
  messages, sseClients, streams,
  // 存储
  loadStore, saveStore, scheduleSave, sortKey, cmpMsg, insertMessage, addMessageCore, addMessage, sseSend,
  // 搭便车
  addPending, addPendingImg, pendingConsume, buildHitchPrefix,
  // 工具
  log, readBody, readBodyRaw, json, htmlVersion,
  fileRef, isAllowedDir,
  // 常量（供路由复用）
  FILE_MAX_BYTES,
};
