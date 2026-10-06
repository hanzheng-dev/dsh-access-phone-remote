// routes/cost.js —— 余额 + 本轮花费
//
//   GET /api/cost  →  { ok, turnCNY, turnUSD, calls, peak,
//                       balance, balanceText, balanceTotal, balanceStale }
//
// 两件事拼在一起（对应手机上「生成中…」上面那一行）：
//   · **本轮花费** —— 从「本轮起点」游标读到现在的 usage，按官方峰谷价折算（见 src/cost.js）
//   · **余额**     —— DeepSeek 的账户余额，**5 分钟缓存**
//
// ⚠️ 移植时改掉的一处（原实现的问题）：
//   生产版把 key 的来源**硬编码**成 `D:\ccd\config\api.txt` —— 那是个私人路径。
//   这里改成：配置项 → 环境变量 → 可选的文件。都没有就**不查余额**，
//   页面会降级成「余额 --」（这是设计好的降级，不是坏了）。
//
// ⚠️ 缓存策略是踩过坑的（生产版 2026-09-18 修过）：
//   **只缓存成功**。失败时不能把失败结果当有效缓存存 5 分钟 ——
//   那样一次网络抖动 = 接下来 5 分钟一直显示失败，而且每次都被缓存命中、连重试都没有。
//   失败只做 20 秒退避，并且**保留上一次成功的值**（宁可用旧数字，也别显示 null）。

const fs = require('fs');
const path = require('path');
const { config } = require('../config');
const { json } = require('../store');
const cost = require('../cost');

const BAL_OK_TTL = 5 * 60 * 1000;      // 成功：缓存 5 分钟
const BAL_FAIL_TTL = 20 * 1000;        // 失败：只退避 20 秒（不覆盖旧的成功值）
const BAL_TIMEOUT_MS = 12000;          // DeepSeek 那个接口偶尔很慢

let balanceCache = null;

/** 从配置/环境/文件里取 DeepSeek key；取不到返回空串（= 不查余额） */
function resolveBalanceKey() {
  const c = (config.cost || {});
  if (c.balanceKey) return String(c.balanceKey).trim();
  if (process.env.DEEPSEEK_API_KEY) return String(process.env.DEEPSEEK_API_KEY).trim();
  if (c.balanceKeyFile) {
    try {
      const t = fs.readFileSync(path.resolve(c.balanceKeyFile), 'utf8');
      const m = t.match(/sk-[A-Za-z0-9_-]{20,}/);
      if (m) return m[0];
    } catch (e) { /* 读不到就算了 */ }
  }
  return '';
}

/**
 * 查一次余额，按上面的缓存策略更新 balanceCache。
 * @returns {Promise<{num:number|null, text:string|null, stale?:boolean}>}
 */
async function refreshBalance() {
  const key = resolveBalanceKey();
  if (!key) return { num: null, text: null };

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), BAL_TIMEOUT_MS);
  let num = null, text = '';
  try {
    const res = await fetch('https://api.deepseek.com/user/balance', {
      headers: { Authorization: 'Bearer ' + key },
      signal: ac.signal,
    });
    const j = await res.json();
    const infos = Array.isArray(j.balance_infos) ? j.balance_infos : [];
    // ⚠️ 官方接口返回 CNY + USD 两条，**顺序随机** ——
    //    按币种找，别取 [0]（生产版踩过：拿到 USD 的 0.00 就显示 0 元）
    const cny = infos.find((x) => String(x.currency || '').toUpperCase() === 'CNY') || infos[0] || {};
    num = Number(cny.total_balance);
    if (!isFinite(num)) num = null;
    if (num != null) {
      const granted = Number(cny.granted_balance) || 0;
      const topped = Number(cny.topped_up_balance) || 0;
      text = '💰 DeepSeek 余额\n可用: ¥' + num.toFixed(2)
        + '\n充值: ¥' + topped.toFixed(2) + '\n赠送: ¥' + granted.toFixed(2);
    } else {
      text = '余额查询返回了无法解析的内容';
    }
  } catch (e) {
    text = '查询失败: ' + (e && e.name === 'AbortError' ? '超时 ' + (BAL_TIMEOUT_MS / 1000) + 's' : (e && e.message) || '未知错误');
  } finally {
    clearTimeout(timer);
  }

  const ok = num != null;
  if (ok) {
    balanceCache = { at: Date.now(), ok: true, text: text.slice(0, 200), num };
  } else if (!balanceCache || balanceCache.ok !== true) {
    balanceCache = { at: Date.now(), ok: false, text: text.slice(0, 200), num: null };
  } else {
    // 失败但有旧的成功值 ⇒ 保留旧值，只把时间戳往后挪（免得每 4 秒重试把服务拖住）
    balanceCache = { at: Date.now(), ok: true, text: balanceCache.text, num: balanceCache.num, stale: true };
  }
  return balanceCache;
}

/** 按缓存策略拿余额（命中就返回，不命中才去查） */
async function getBalance() {
  if (!resolveBalanceKey()) return { num: null, text: null };
  const age = balanceCache ? Date.now() - balanceCache.at : Infinity;
  const fresh = balanceCache && balanceCache.ok === true && age < BAL_OK_TTL;
  const backoff = balanceCache && balanceCache.ok === false && age < BAL_FAIL_TTL;
  if (fresh || backoff) return balanceCache;
  return refreshBalance();
}

function register(server) {
  server.addRoute(async (req, res, url, p) => {
    if (p !== '/api/cost' || req.method !== 'GET') return false;

    let turn = null;
    const from = cost.getTurnStart();
    // 游标为 0 说明"还没开始过任何一轮" —— 当 0，别去解整个会话文件
    if (from > 0) {
      try { turn = cost.readSince(from); } catch (e) { turn = null; }
    }

    let bal = null;
    try { bal = await getBalance(); } catch (e) { /* 拿不到就退化成只显示花费 */ }

    const c = (config.cost || {});
    return json(res, 200, {
      ok: true,
      turnCNY: turn ? Number(turn.cny.toFixed(4)) : null,
      turnUSD: turn ? Number(turn.usd.toFixed(4)) : null,
      calls: turn ? turn.calls : 0,
      peak: turn ? turn.peak : false,
      balance: bal ? bal.num : null,
      balanceText: bal ? bal.text : null,
      balanceStale: !!(bal && bal.stale),
      balanceTotal: Number(c.total) > 0 ? Number(c.total) : 300,
      zstdOk: cost.ZSTD_OK,
    });
  });
}

module.exports = { register, getBalance, resolveBalanceKey };
