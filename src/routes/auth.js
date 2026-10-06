// routes/auth.js —— 鉴权：口令页 / token / Cookie
//
// 做法（对手机最省事）：
//   ① token 存 <root>/.hub-token（留空则首次自动生成 24 字节随机串，见 config.ensureAuthToken）
//   ② 手机首次访问 http://<地址>:<port>/?t=<token> ⇒ 服务端种一个 180 天 Cookie
//   ③ 之后书签不带参数也能进；手机原生请求可带 X-Auth 头
//   ⚠️ 放行：OPTIONS（CORS 预检）、/api/ping（健康检查）、本机回环（127.0.0.1 / ::1）
//
// 由 server.js 在请求预处理阶段直接调用 checkAuth()；本模块不注册路由。

'use strict';

const { config, ensureAuthToken } = require('../config');

// 启动时取一次 token（config 里有就用；否则读/生成 <root>/.hub-token）。
let HUB_TOKEN = '';
try {
  HUB_TOKEN = ensureAuthToken() || '';
} catch (e) {
  HUB_TOKEN = '';   // 降级为「放行」，别把用户锁在外面
}

const AUTH_COOKIE = 'dsj_auth';

function getToken() { return HUB_TOKEN; }

function getCookie(req, name) {
  const c = req.headers.cookie || '';
  const m = c.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

function sendLoginPage(res) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>dsh-access-phone-remote</title>'
    + '<body style="font-family:system-ui;padding:2em;background:#14130f;color:#eee;line-height:1.7;margin:0">'
    + '<div style="max-width:420px;margin:8vh auto 0">'
    + '<h2 style="margin:0 0 .4em">dsh-access-phone-remote</h2>'
    + '<p style="color:#aaa;margin:0 0 1.2em">请输入口令</p>'
    + '<form method="GET" action="/api/auth" style="display:flex;gap:8px">'
    + '<input name="pwd" type="password" autofocus autocomplete="current-password" '
    + 'style="flex:1;padding:12px;border-radius:10px;border:1px solid #3a382f;background:#201f1a;color:#eee;font-size:16px">'
    + '<button type="submit" style="padding:12px 20px;border-radius:10px;border:0;background:#ffc98a;color:#2a2419;font-size:16px;font-weight:600">进入</button>'
    + '</form>'
    + '<p style="color:#6b675c;font-size:.85em;margin-top:1.2em">记住 180 天，之后不用再输</p>'
    + '</div></body>');
}

// 返回 true = 放行；false = 本函数已写完响应，调用方必须立刻 return。
// ⚠️ 凡是"已写响应"的分支一律 return false —— 曾因 return res.end()（返回 res 真值）
//    被外层误判为放行，导致 ERR_HTTP_HEADERS_SENT 连锁、进程退出。
function checkAuth(req, res, url, p) {
  if (p === '/api/ping') return true;               // 健康检查
  if (req.method === 'OPTIONS') return true;        // CORS 预检

  // 本机回环放行（同机脚本调接口用）
  const ra = req.socket.remoteAddress || '';
  if (ra === '127.0.0.1' || ra === '::1' || ra === '::ffff:127.0.0.1') return true;

  // token 没配出来 ⇒ 降级放行
  if (!HUB_TOKEN) return true;

  // 1) URL 带 token（?t=）⇒ 种 Cookie（180 天）后放行
  const qt = url.searchParams.get('t') || '';
  if (qt && qt === HUB_TOKEN) {
    res.setHeader('Set-Cookie',
      AUTH_COOKIE + '=' + encodeURIComponent(HUB_TOKEN) + '; Path=/; Max-Age=15552000; SameSite=Lax');
    return true;
  }

  // 2) Cookie 对 ⇒ 放行
  if (getCookie(req, AUTH_COOKIE) === HUB_TOKEN) return true;

  // 2.4) 原生请求带 X-Auth 头 ⇒ 放行（与 Cookie 同权）
  if (req.headers['x-auth'] === HUB_TOKEN) return true;

  // 2.5) 网页口令输入框：GET /api/auth?pwd=… ⇒ 种 Cookie 后跳回 /
  if (p === '/api/auth') {
    const pwd = url.searchParams.get('pwd') || '';
    if (pwd === HUB_TOKEN) {
      res.writeHead(302, {
        'Set-Cookie': AUTH_COOKIE + '=' + encodeURIComponent(HUB_TOKEN) + '; Path=/; Max-Age=15552000; SameSite=Lax',
        'Location': '/',
        'Cache-Control': 'no-store',
      });
      res.end();
      return false;
    }
    sendLoginPage(res);
    return false;
  }

  // 3) 其它未授权请求 ⇒ 给输入框页面
  sendLoginPage(res);
  return false;
}

module.exports = { checkAuth, sendLoginPage, getCookie, getToken, AUTH_COOKIE };
