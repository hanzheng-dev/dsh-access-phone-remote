/**
 * src/dsh/auth.js —— 给 dsh web 的 /api/* 提供鉴权 cookie
 *
 * 这是从生产版（dsh-hub/bridge/dsh-auth.js）**裁剪参数化**而来，
 * 算法逻辑一字未改 —— 那套是实测逆向出来的，动它没有好处。
 *
 * 背景：dsh 的 web 加了鉴权。启动时会打印 `http://127.0.0.1:3080/?token=xxx`，
 *   浏览器拿这个 token 换一张签名 cookie，之后所有 /api/* 都要带着它，否则 401。
 *
 * 两条取票路（互为备份）：
 *   路 1（快，默认）：读 <DSH_HOME>/.credentials.yaml 里持久化的签名密钥，自己签一张。
 *        cookie 名 dsh-auth-<b64url(sha256(authority))>，
 *        值     v1.<b64url(JSON payload)>.<b64url(HMAC-SHA256(secret, body))>
 *   路 2（稳，401 时兜底）：从 dsh web 的启动日志里抓 ?token=xxx，
 *        向 GET /?token=xxx 换一张新 cookie。
 *
 *   为什么必须有路 2：实测服务进程**内存里的密钥会和磁盘密钥文件分家**
 *   （同一客户端先成功后固定 401，重签多少次都没用，重启 dsh 才恢复）。
 *   换票是服务端用它当前内存密钥签发的，对"分家"天然有效，且不用重启。
 *
 * 与生产版的区别：所有私人路径都去掉了，改成 config 指定 + 自动探测。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

// ---------- 配置（延迟读取，避免和 config.js 循环依赖） ----------
function cfg() {
  try {
    return require('../config').config;
  } catch (e) {
    return {};
  }
}

function dshCfg() {
  const c = cfg();
  return (c && c.dsh) || {};
}

/**
 * 找出 dsh 的数据目录（里面要有 .credentials.yaml）。
 *
 * 顺序：config.dsh.home → 环境变量 DSH_HOME → 常见位置 → 放弃
 * ⚠️ 不扫全盘：那太慢，而且用户机器上的目录结构千奇百怪。找不到就明确报错，
 *    让人去 config.json 里填一行 —— 比猜错地方然后 401 强。
 */
function resolveDshHome() {
  const fromCfg = dshCfg().home;
  const candidates = [
    fromCfg,
    process.env.DSH_HOME,
    path.join(process.env.USERPROFILE || process.env.HOME || '', '.dsh'),
  ].filter(Boolean);

  for (const dir of candidates) {
    try {
      if (fs.existsSync(path.join(dir, '.credentials.yaml'))) return dir;
    } catch (e) { /* 读不到就试下一个 */ }
  }
  // 一个都没有：返回第一个候选（后续 readSecret 会抛错，由调用方决定怎么办）
  return candidates[0] || '';
}

const RECORD_KEY = 'client-connection/browser-session';
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = 29 * DAY_MS;          // 必须 < 服务端 cookieMaxAgeDays（默认 30 天）

function credPath() {
  const h = resolveDshHome();
  return h ? path.join(h, '.credentials.yaml') : '';
}

function authority() {
  return dshCfg().authority || '127.0.0.1:3080';
}

/**
 * dsh web 启动日志候选（换票兜底要从里面抓 token）。
 * 按 mtime 新→旧挑，取第一个含 token 的文件的**最后一个** token。
 *
 * 顺序：config.dsh.webLog → DSH_HOME 下的 *.log → DSH_HOME 同级 *.log
 */
function logCandidates() {
  const out = [];
  const fromCfg = dshCfg().webLog;
  if (fromCfg) out.push(fromCfg);

  const home = resolveDshHome();
  // home 自己 + home 的父目录，找最近改动的几个 .log
  const dirs = [home, home ? path.dirname(home) : ''].filter(Boolean);
  for (const d of dirs) {
    try {
      const files = fs.readdirSync(d)
        .filter((f) => /\.log$/i.test(f))
        .map((f) => {
          const p = path.join(d, f);
          try { return { p, t: fs.statSync(p).mtimeMs }; } catch (e) { return null; }
        })
        .filter(Boolean)
        .sort((a, b) => b.t - a.t)
        .slice(0, 5)
        .map((x) => x.p);
      out.push(...files);
    } catch (e) { /* 目录读不到就跳过 */ }
  }

  return out.filter(Boolean);
}

function encodeBase64Url(value) {
  return Buffer.from(value).toString('base64')
    .replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}

// ---------- 路 1：磁盘密钥自签 ----------
function readSecret() {
  const p = credPath();
  if (!p) throw new Error('dsh-auth: 找不到 dsh 数据目录（请在 config.json 里设置 dsh.home）');
  const raw = fs.readFileSync(p, 'utf8');
  const at = raw.indexOf(RECORD_KEY);
  if (at === -1) throw new Error(`dsh-auth: ${p} 里没有 ${RECORD_KEY} 记录`);
  const m = /secret:\s*([A-Za-z0-9_-]+)/.exec(raw.slice(at));
  if (!m) throw new Error('dsh-auth: 记录里没有 secret 字段');
  const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  if (secret.byteLength !== 32) {
    throw new Error(`dsh-auth: secret 长度异常（${secret.byteLength} 字节，期望 32）`);
  }
  return secret;
}

function cookieName(auth) {
  return 'dsh-auth-' + encodeBase64Url(crypto.createHash('sha256').update(auth).digest());
}

function mint(secret) {
  const auth = authority();
  const issuedAt = Date.now();
  const expiresAt = issuedAt + TTL_MS;
  const payload = { version: 1, authority: auth, issuedAt, expiresAt };
  const body = encodeBase64Url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = encodeBase64Url(crypto.createHmac('sha256', secret).update(body).digest());
  return { name: cookieName(auth), value: `v1.${body}.${sig}` };
}

/**
 * 每次调用现读密钥、现签。
 * 桥是每条消息一个进程，这点开销可忽略；好处是密钥轮换能自动跟上。
 */
function rpcHeaders() {
  const auth = authority();
  const { name, value } = mint(readSecret());
  return {
    Cookie: `${name}=${value}`,
    Host: auth,
    'Content-Type': 'application/json',
  };
}

// ---------- 路 2：启动 token 换票 ----------
/** 从 dsh web 的启动日志里抓最近一次的 ?token=xxx。 */
function readLaunchToken() {
  for (const f of logCandidates()) {
    try {
      const txt = fs.readFileSync(f, 'utf8');
      const ms = [...txt.matchAll(/127\.0\.0\.1:(\d+)\/\?token=([A-Za-z0-9_-]+)/g)];
      if (ms.length) return { token: ms[ms.length - 1][2], port: Number(ms[ms.length - 1][1]), from: f };
    } catch (e) { /* 读不到就换下一个 */ }
  }
  return null;
}

/** 用启动 token 换一张服务端当前内存密钥签发的 cookie，返回 "名字=值"。 */
function exchangeTokenForCookie(token, port) {
  const auth = authority();
  const usePort = port || Number(auth.split(':')[1] || 3080);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: usePort,
      path: '/?token=' + token,
      method: 'GET',
      headers: { Host: auth, Accept: 'text/html' },
    }, (res) => {
      res.resume();
      const sc = res.headers['set-cookie'];
      if (res.statusCode !== 303 && res.statusCode !== 302) {
        return reject(new Error(`换票失败：HTTP ${res.statusCode}（期望 303 重定向）`));
      }
      if (!sc || !sc.length) return reject(new Error('换票失败：响应没有 set-cookie'));
      resolve(String(sc[0]).split(';')[0]);
    });
    req.on('error', reject);
    req.setTimeout(10000, () => req.destroy(new Error('换票超时')));
    req.end();
  });
}

/** 异步：抓 token → 换票 → 返回可用头。失败时抛错（调用方自行回退）。 */
async function rpcHeadersViaToken() {
  const found = readLaunchToken();
  if (!found) throw new Error('找不到 dsh web 的启动 token（检查 config.dsh.webLog 是否指向启动日志）');
  const cookie = await exchangeTokenForCookie(found.token, found.port);
  return {
    Cookie: cookie,
    Host: authority(),
    'Content-Type': 'application/json',
  };
}

module.exports = {
  rpcHeaders,
  rpcHeadersViaToken,
  readSecret,
  readLaunchToken,
  mint,
  cookieName,
  resolveDshHome,
  credPath,
  authority,
  logCandidates,
  // 兼容生产版命名（方便从那边搬代码时少改几处）
  get DSH_HOME() { return resolveDshHome(); },
  get CRED_PATH() { return credPath(); },
  get AUTHORITY() { return authority(); },
};
