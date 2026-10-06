// src/cost.js —— 算「这一轮 AI 回合花了多少钱」
//
// 数据来源：dsh 的会话文件
//   <DSH_HOME>/sessions/<cwd-slug>/<session-id>/session.v3.jsonl.zstd
//   · **多帧 zstd**，magic `28 B5 2F FD`，要切帧逐段解
//   · 过滤 `assistant/message` 事件，字段
//     `inputTokens` / `outputTokens` / `cacheReadTokens`
//     ⚠️ `uncachedInputTokens` 是编的、`cacheWriteTokens` 恒 0 —— 别用
//
// ⭐ 关键设计：**不做"全程累计"**，只做"从某一刻到现在" ——
//   每轮开始记一个**字节偏移**，之后只解那之后的新帧 ⇒ 又快又不用维护全局游标。
//
// ⚠️ 移植说明：原实现把 sessions 目录**硬编码**成 `D:\dsh-new-home\sessions`。
//    开源版必须跟着配置走（`config.dsh.home`），否则别人的机器上恒报 0。
// ⚠️ `zlib.zstdDecompressSync` 要 Node 22+。低版本直接降级成"算不出来"，
//    不能让整个接口挂掉（本项目 engines 写的是 >=18）。

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const USD2CNY = 7.1;

/** deepseek-flash 官方价（每百万 token，USD）：峰 / 平 */
const PRICE = {
  hit: { peak: 0.006, off: 0.003 },
  miss: { peak: 0.3, off: 0.15 },
  out: { peak: 1.2, off: 0.6 },
};

/** 高峰：北京 09:00-12:00 / 14:00-18:00（工作日）= UTC 01:00-04:00 / 06:00-10:00 */
function isPeak(d) {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const h = d.getUTCHours() + d.getUTCMinutes() / 60;
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** 能不能解 zstd（Node 22+ 才有原生实现） */
const ZSTD_OK = typeof zlib.zstdDecompressSync === 'function';

/**
 * dsh 的 sessions 根目录 —— **跟着配置走，不硬编码**。
 * 由 server 在启动时注入（`cost.setSessRoot()`）；没注入就用默认的 ~/.dsh。
 */
let SESS_ROOT = path.join(process.env.DSH_HOME || path.join(require('os').homedir(), '.dsh'), 'sessions');

/** 由 server.js 在加载配置后调用 */
function setSessRoot(p) {
  if (p) SESS_ROOT = p;
}

/** 找「当前正在写的那个会话文件」：sessions 下 mtime 最新的 *.jsonl.zstd */
function currentSessionFile() {
  let best = null, bestT = 0;
  let dirs = [];
  try { dirs = fs.readdirSync(SESS_ROOT, { withFileTypes: true }); } catch (e) { return null; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const p = path.join(SESS_ROOT, d.name);
    let subs = [];
    try { subs = fs.readdirSync(p, { withFileTypes: true }); } catch (e) { continue; }
    for (const s of subs) {
      if (!s.isDirectory()) continue;
      const sp = path.join(p, s.name);
      let files = [];
      try { files = fs.readdirSync(sp); } catch (e) { continue; }
      for (const f of files) {
        if (!/\.jsonl\.zstd$/.test(f)) continue;
        const fp = path.join(sp, f);
        try {
          const st = fs.statSync(fp);
          if (st.mtimeMs > bestT) { bestT = st.mtimeMs; best = fp; }
        } catch (e) { /* 忽略 */ }
      }
    }
  }
  return best;
}

/**
 * 从 `fromOffset` 字节处读到文件末尾，累加这段时间里的 usage。
 * @returns {{file:string|null, from:number, to:number, calls:number, hit:number, miss:number,
 *            out:number, usd:number, cny:number, peak:boolean}}
 */
function readSince(fromOffset) {
  const file = currentSessionFile();
  const out = { file, from: fromOffset || 0, to: 0, calls: 0, hit: 0, miss: 0, out: 0, usd: 0, cny: 0, peak: isPeak(new Date()) };
  if (!file || !ZSTD_OK) return out;

  let size = 0;
  try { size = fs.statSync(file).size; } catch (e) { return out; }
  const from = (typeof fromOffset === 'number' && fromOffset > 0 && fromOffset <= size) ? fromOffset : 0;
  out.to = size;

  let buf;
  try {
    // 只读 from 之后的那一段（整文件读 50MB 太蠢）
    const fd = fs.openSync(file, 'r');
    buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    fs.closeSync(fd);
  } catch (e) { return out; }

  // 切帧：从 from 处开始，逐个子串解压
  const cuts = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) >= 0) { cuts.push(i); i += 4; }
  if (!cuts.length) return out;

  for (let k = 0; k < cuts.length; k++) {
    const st = cuts[k];
    const en = (k + 1 < cuts.length) ? cuts[k + 1] : buf.length;
    let text;
    try { text = zlib.zstdDecompressSync(buf.subarray(st, en)).toString('utf8'); } catch (e) { continue; }
    for (const line of text.split('\n')) {
      if (!line || line.charCodeAt(0) !== 123) continue;   // 只处理以 { 开头的行，省一次 JSON.parse
      if (line.indexOf('assistant/message') < 0) continue;
      let obj; try { obj = JSON.parse(line); } catch (e) { continue; }
      if (!obj || obj.type !== 'assistant/message') continue;
      const u = (obj.data && obj.data.usage) || obj.usage;
      if (!u) continue;
      out.calls++;
      out.hit += Number(u.cacheReadTokens) || 0;
      out.miss += Number(u.inputTokens) || 0;
      out.out += Number(u.outputTokens) || 0;
    }
  }

  const p = out.peak ? 'peak' : 'off';
  out.usd = (out.hit / 1e6) * PRICE.hit[p] + (out.miss / 1e6) * PRICE.miss[p] + (out.out / 1e6) * PRICE.out[p];
  out.cny = out.usd * USD2CNY;
  return out;
}

/** 当前会话文件的大小（= 现在这一刻的"游标"） */
function nowOffset() {
  const f = currentSessionFile();
  if (!f) return 0;
  try { return fs.statSync(f).size; } catch (e) { return 0; }
}

// ---------- 「本轮起点」游标 ----------
//
// ⚠️ 这里有个**必须做对**的地方：游标初值不能是 0。
//    否则 `readSince(0)` 会把**整个会话文件**（几十 MB）解出来算一遍，
//    页面会看到「本次 ¥104」这种吓人的假数字 —— 那是历史总花费，不是这一轮。
//    所以：进程启动时先对到"现在"，每轮发消息时再对一次。
let turnStartOffset = 0;

/** 把本轮起点对到"现在"。server 启动时 + 每次发消息前各调一次。 */
function markTurnStart() {
  turnStartOffset = nowOffset();
  return turnStartOffset;
}

function getTurnStart() {
  return turnStartOffset;
}

module.exports = {
  readSince, nowOffset, currentSessionFile, isPeak, setSessRoot,
  markTurnStart, getTurnStart, ZSTD_OK, PRICE, USD2CNY,
};
